/**
 * Viewport screenshots (not fullPage).
 *
 * fullPage renders position:sticky elements at their scrolled offset, which makes a
 * correct sticky layout look shattered. Anything judging layout must use the viewport.
 */
import { chromium } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';

const WEB = 'http://localhost:5173';
const API = 'http://localhost:8787';
const OUT = path.resolve('e2e/shots');

const { projects } = await (await fetch(`${API}/local/projects`)).json();
const done = projects.find((p) => p.status === 'done');
if (!done) throw new Error('no completed project');

await fs.mkdir(OUT, { recursive: true });
const browser = await chromium.launch();

for (const [label, width, height] of [
  ['xl', 1680, 1000],
  ['lg', 1200, 900],
  ['sm', 860, 1000],
]) {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
  await page.goto(`${WEB}/project/${done.id}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);
  await page.evaluate(() => {
    const v = document.querySelector('video');
    if (v) v.currentTime = 5;
  });
  await page.waitForTimeout(700);

  await page.screenshot({ path: path.join(OUT, `vp-${label}.png`) });

  // Report the real geometry so overlap is measurable, not eyeballed.
  const geo = await page.evaluate(() => {
    const pick = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
    };
    return { preview: pick('[data-preview-frame]'), editor: pick('[data-style-editor]') };
  });
  const p = geo.preview;
  const e = geo.editor;
  // Boxes only truly overlap if they intersect on BOTH axes. Comparing x-ranges alone
  // reports a stacked (single-column) layout as broken.
  const overlapX = p && e ? Math.min(p.x + p.w, e.x + e.w) - Math.max(p.x, e.x) : 0;
  const overlapY = p && e ? Math.min(p.y + p.h, e.y + e.h) - Math.max(p.y, e.y) : 0;
  const overlaps = overlapX > 1 && overlapY > 1;
  console.log(
    `  ${label} ${width}px  preview ${p ? `${p.w}x${p.h}@${p.x},${p.y}` : 'none'}  ` +
      `editor ${e ? `${e.w}x${e.h}@${e.x},${e.y}` : 'none'}  ` +
      `${overlaps ? `OVERLAP ${Math.round(overlapX)}x${Math.round(overlapY)}px` : 'no overlap'}`,
  );
  await page.close();
}

await browser.close();
