/**
 * Visual inspection harness.
 *
 * Drives the real app in Chromium, captures screenshots and asserts the things that are
 * easy to get wrong in CSS and impossible to catch with tsc — word spacing, caption
 * placement, drag behaviour.
 *
 *   node e2e/inspect.mjs
 */
import { chromium } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';

const WEB = 'http://localhost:5173';
const API = 'http://localhost:8787';
const OUT = path.resolve('e2e/shots');

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass, detail });
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

const run = async () => {
  await fs.mkdir(OUT, { recursive: true });
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });

  const errors = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(String(e)));

  console.log('\n# dashboard');
  await page.goto(WEB, { waitUntil: 'networkidle' });
  await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(OUT, '01-dashboard.png'), fullPage: true });
  check('dashboard renders heading', await page.locator('h1').first().isVisible());

  // Jump straight to a finished project.
  const { projects } = await (await fetch(`${API}/local/projects`)).json();
  const done = projects.find((p) => p.status === 'done');
  if (!done) {
    console.log('No completed project — upload one first.');
    await browser.close();
    return;
  }

  console.log('\n# project page');
  await page.goto(`${WEB}/project/${done.id}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);

  // Switch to the live overlay so captions are DOM nodes we can measure.
  const live = page.getByRole('button', { name: 'Live', exact: true });
  if (await live.count()) await live.first().click();
  await page.waitForTimeout(400);

  // Nudge playback so a cue is on screen.
  await page.evaluate(() => {
    const v = document.querySelector('video');
    if (v) v.currentTime = 5;
  });
  await page.waitForTimeout(700);
  await page.screenshot({ path: path.join(OUT, '02-project.png'), fullPage: true });

  console.log('\n# caption overlay');
  const caption = page.locator('[data-caption-block]').first();
  const hasCaption = (await caption.count()) > 0;
  check('caption overlay present', hasCaption);

  if (hasCaption) {
    await caption.screenshot({ path: path.join(OUT, '03-caption.png') }).catch(() => {});

    // The real bug: inline-block eats trailing whitespace, so words ran together.
    const gaps = await page.evaluate(() => {
      const line = document.querySelector('[data-caption-line]');
      if (!line) return null;
      const spans = [...line.querySelectorAll('[data-word]')];
      if (spans.length < 2) return { count: spans.length, gaps: [] };
      const out = [];
      for (let i = 1; i < spans.length; i++) {
        const prev = spans[i - 1].getBoundingClientRect();
        const cur = spans[i].getBoundingClientRect();
        out.push(Math.round((cur.left - prev.right) * 10) / 10);
      }
      return { count: spans.length, gaps: out, text: line.textContent };
    });

    if (gaps && gaps.gaps.length) {
      const min = Math.min(...gaps.gaps);
      check('words are visually separated', min > 1.5, `min gap ${min}px across ${gaps.count} words`);
      console.log(`     text: ${JSON.stringify(gaps.text)}`);
    } else {
      check('words are visually separated', false, 'only one word on the line');
    }
  }

  console.log('\n# drag to move');
  if (hasCaption) {
    const before = await caption.boundingBox();
    const frame = await page.locator('[data-preview-frame]').first().boundingBox();
    if (before && frame) {
      await page.mouse.move(before.x + before.width / 2, before.y + before.height / 2);
      await page.mouse.down();
      await page.mouse.move(before.x + before.width / 2 - 60, before.y + before.height / 2 - 120, { steps: 12 });
      await page.mouse.up();
      await page.waitForTimeout(300);
      const after = await caption.boundingBox();
      const moved = after && (Math.abs(after.y - before.y) > 40 || Math.abs(after.x - before.x) > 20);
      check('caption drags to a new position', Boolean(moved),
        after ? `moved ${Math.round(after.x - before.x)},${Math.round(after.y - before.y)}px` : 'no box');
      await page.screenshot({ path: path.join(OUT, '04-after-drag.png'), fullPage: true });
    }
  }

  console.log('\n# scrub control');
  await page.getByRole('button', { name: 'Type', exact: true }).click();
  await page.waitForTimeout(300);
  const scrub = page.getByRole('slider', { name: 'Size' }).first();
  if (await scrub.count()) {
    const box = await scrub.boundingBox();
    const readValue = () => page.evaluate(() => {
      const el = document.querySelector('[role="slider"][aria-label="Size"]');
      return el ? Number(el.getAttribute('aria-valuenow')) : null;
    });
    const v0 = await readValue();
    if (box) {
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width / 2 + 80, box.y + box.height / 2, { steps: 10 });
      await page.mouse.up();
    }
    const v1 = await readValue();
    check('scrub control changes value on drag', v0 !== null && v1 !== null && v1 !== v0, `${v0} -> ${v1}`);
  } else {
    check('scrub control changes value on drag', false, 'control not found');
  }
  await page.screenshot({ path: path.join(OUT, '05-type-panel.png'), fullPage: true });

  console.log('\n# timing panel');
  await page.getByRole('button', { name: 'Timing', exact: true }).click();
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(OUT, '06-timing-panel.png'), fullPage: true });
  check('timing offset control present',
    (await page.getByRole('slider', { name: 'Caption offset' }).count()) > 0);

  console.log('\n# console');
  const noisy = errors.filter((e) => !/favicon|DevTools/i.test(e));
  check('no console errors', noisy.length === 0, noisy.slice(0, 3).join(' | '));

  await browser.close();

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  console.log(`screenshots -> ${OUT}`);
  if (failed.length) process.exitCode = 1;
};

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
