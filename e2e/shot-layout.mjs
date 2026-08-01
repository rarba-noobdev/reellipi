/** Capture the project page at several widths to check the responsive grid. */
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
  ['xl', 1680, 1050],
  ['lg', 1280, 900],
  ['sm', 900, 1000],
]) {
  const page = await browser.newPage({ viewport: { width, height } });
  await page.goto(`${WEB}/project/${done.id}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1400);
  await page.evaluate(() => {
    const v = document.querySelector('video');
    if (v) v.currentTime = 5;
  });
  await page.waitForTimeout(600);

  const preview = await page.locator('[data-preview-frame]').first().boundingBox();
  console.log(`  ${label} ${width}px -> preview ${Math.round(preview?.width ?? 0)}x${Math.round(preview?.height ?? 0)}`);
  await page.screenshot({ path: path.join(OUT, `layout-${label}.png`), fullPage: true });
  await page.close();
}

await browser.close();
