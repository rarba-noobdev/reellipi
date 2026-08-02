/**
 * Visual and behavioural inspection harness.
 *
 * Drives the real app in Chromium and asserts the things tsc cannot see: word spacing,
 * caption placement, drag behaviour, transport controls, and that display-only
 * transforms (punctuation stripping) do not leak into the exported sidecars.
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

  const live = page.getByRole('button', { name: 'Live', exact: true });
  if (await live.count()) await live.first().click();
  await page.waitForTimeout(400);

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

    const info = await page.evaluate(() => {
      const line = document.querySelector('[data-caption-line]');
      if (!line) return null;
      const spans = [...line.querySelectorAll('[data-word]')];
      const gaps = [];
      for (let i = 1; i < spans.length; i++) {
        gaps.push(
          Math.round((spans[i].getBoundingClientRect().left - spans[i - 1].getBoundingClientRect().right) * 10) / 10,
        );
      }
      return { count: spans.length, gaps, text: line.textContent };
    });

    if (info?.gaps.length) {
      const min = Math.min(...info.gaps);
      check('words are visually separated', min > 1.5, `min gap ${min}px across ${info.count} words`);
    } else {
      check('words are visually separated', true, 'single-word cue, nothing to separate');
    }

    // Display-only punctuation stripping must not eat mid-word characters.
    check(
      'caption text is not empty',
      Boolean(info?.text?.trim()),
      JSON.stringify(info?.text ?? ''),
    );

    // Caption must stay inside the frame; overflow means auto-fit failed.
    const fits = await page.evaluate(() => {
      const block = document.querySelector('[data-caption-block]');
      const frame = document.querySelector('[data-preview-frame]');
      if (!block || !frame) return null;
      const b = block.getBoundingClientRect();
      const f = frame.getBoundingClientRect();
      return { overflowLeft: f.left - b.left, overflowRight: b.right - f.right };
    });
    check(
      'caption fits inside the frame',
      fits !== null && fits.overflowLeft <= 1 && fits.overflowRight <= 1,
      fits ? `L${Math.round(fits.overflowLeft)} R${Math.round(fits.overflowRight)}` : 'not measured',
    );
  }

  console.log('\n# transport');
  const seek = page.getByRole('slider', { name: 'Seek' }).first();
  check('seek control present', (await seek.count()) > 0);
  if (await seek.count()) {
    const box = await seek.boundingBox();
    const before = await page.evaluate(() => document.querySelector('video')?.currentTime ?? 0);
    if (box) {
      await page.mouse.click(box.x + box.width * 0.75, box.y + box.height / 2);
      await page.waitForTimeout(400);
    }
    const after = await page.evaluate(() => document.querySelector('video')?.currentTime ?? 0);
    check('clicking the scrubber seeks', Math.abs(after - before) > 1, `${before.toFixed(1)}s -> ${after.toFixed(1)}s`);
  }

  const playBtn = page.getByRole('button', { name: /^(Play|Pause)$/ }).first();
  check('play control present and visible', (await playBtn.count()) > 0 && (await playBtn.isVisible()));
  if (await playBtn.count()) {
    await playBtn.click();
    await page.waitForTimeout(600);
    const playing = await page.evaluate(() => {
      const v = document.querySelector('video');
      return v ? !v.paused : false;
    });
    check('play button starts playback', playing);
    await playBtn.click();
  }

  console.log('\n# drag to move');
  // The transport test left playback wherever it seeked to, which may sit between cues.
  // Return to a known cue so there is something to grab.
  await page.evaluate(() => {
    const v = document.querySelector('video');
    if (v) {
      v.pause();
      v.currentTime = 5;
    }
  });
  await page.waitForTimeout(600);
  if (hasCaption && (await caption.count())) {
    const before = await caption.boundingBox();
    if (before) {
      await page.mouse.move(before.x + before.width / 2, before.y + before.height / 2);
      await page.mouse.down();
      await page.mouse.move(before.x + before.width / 2 - 60, before.y + before.height / 2 - 120, { steps: 12 });
      await page.mouse.up();
      await page.waitForTimeout(300);
      const after = await caption.boundingBox();
      const moved = after && (Math.abs(after.y - before.y) > 40 || Math.abs(after.x - before.x) > 20);
      check('caption drags to a new position', Boolean(moved));
      await page.screenshot({ path: path.join(OUT, '04-after-drag.png'), fullPage: true });
    }
  }

  console.log('\n# scrub control');
  await page.getByRole('button', { name: 'Type', exact: true }).click();
  await page.waitForTimeout(300);
  const sizeScrub = page.getByRole('slider', { name: 'Size' }).first();
  if (await sizeScrub.count()) {
    const box = await sizeScrub.boundingBox();
    const read = () =>
      page.evaluate(() => {
        const el = document.querySelector('[role="slider"][aria-label="Size"]');
        return el ? Number(el.getAttribute('aria-valuenow')) : null;
      });
    const v0 = await read();
    if (box) {
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width / 2 + 80, box.y + box.height / 2, { steps: 10 });
      await page.mouse.up();
    }
    const v1 = await read();
    check('scrub control changes value on drag', v0 !== null && v1 !== null && v1 !== v0, `${v0} -> ${v1}`);
  } else {
    check('scrub control changes value on drag', false, 'control not found');
  }
  await page.screenshot({ path: path.join(OUT, '05-type-panel.png'), fullPage: true });

  console.log('\n# colour panel');
  await page.getByRole('button', { name: 'Colour', exact: true }).click();
  await page.waitForTimeout(300);
  check('palette match button present', (await page.getByRole('button', { name: 'Match' }).count()) > 0);
  check('keyword emphasis control present', (await page.getByRole('button', { name: 'Fill', exact: true }).count()) > 0);
  await page.screenshot({ path: path.join(OUT, '07-colour-panel.png'), fullPage: true });

  console.log('\n# timing panel');
  await page.getByRole('button', { name: 'Timing', exact: true }).click();
  await page.waitForTimeout(300);
  check('caption offset control present', (await page.getByRole('slider', { name: 'Caption offset' }).count()) > 0);
  check('min duration control present', (await page.getByRole('slider', { name: 'Min duration' }).count()) > 0);
  await page.screenshot({ path: path.join(OUT, '06-timing-panel.png'), fullPage: true });

  console.log('\n# exports keep punctuation');
  const srt = await (await fetch(`${API}/local/projects/${done.id}/file/out.srt`)).text();
  const ass = await (await fetch(`${API}/local/projects/${done.id}/file/out.ass`)).text();
  const srtHasStops = /[.!?]\s*\n/.test(srt);
  const assDialogue = ass.split('\n').filter((l) => l.startsWith('Dialogue')).join('\n');
  const assHasStops = /[a-z]\.(\{|\s|$)/m.test(assDialogue);
  check('SRT keeps sentence punctuation', srtHasStops);
  check('burned-in ASS drops it', !assHasStops);

  console.log('\n# console');
  const noisy = errors.filter((e) => !/favicon|DevTools/i.test(e));
  check('no console errors', noisy.length === 0, noisy.slice(0, 2).join(' | '));

  await browser.close();

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) {
    console.log('\nFAILURES:');
    for (const f of failed) console.log(`  - ${f.name}${f.detail ? ` (${f.detail})` : ''}`);
    process.exitCode = 1;
  }
  console.log(`screenshots -> ${OUT}`);
};

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
