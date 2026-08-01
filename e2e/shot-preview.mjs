/** Capture the preview frame alone, in each preview mode. */
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
const page = await browser.newPage({ viewport: { width: 1500, height: 1000 }, deviceScaleFactor: 2 });

await page.goto(`${WEB}/project/${done.id}`, { waitUntil: 'networkidle' });
await page.waitForTimeout(1500);

// Live overlay, so captions are DOM nodes rather than baked pixels.
const live = page.getByRole('button', { name: 'Live', exact: true });
if (await live.count()) await live.first().click();
await page.evaluate(() => {
  const v = document.querySelector('video');
  if (v) v.currentTime = 5;
});
await page.waitForTimeout(800);

const frame = page.locator('[data-preview-frame]').first();
for (const mode of ['Instagram', 'Safe area', 'Clean']) {
  await page.getByRole('button', { name: mode, exact: true }).click();
  await page.waitForTimeout(500);
  const file = path.join(OUT, `preview-${mode.toLowerCase().replace(/\s+/g, '-')}.png`);
  await frame.screenshot({ path: file });
  console.log(`  ${mode} -> ${file}`);
}

await browser.close();
