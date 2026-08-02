/**
 * Does the preview match the exported video?
 *
 * The preview approximates libass in the browser; the export is libass itself. Any
 * divergence in caption size, colour or position is a bug the user sees as "the download
 * looks different from what I set up". This measures both at the same timestamp.
 */
import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

const WEB = 'http://localhost:5173';
const API = 'http://localhost:8787';
const OUT = path.resolve('e2e/shots');
const FFMPEG =
  process.env.FFMPEG_PATH ??
  `${process.env.LOCALAPPDATA}\\Microsoft\\WinGet\\Packages\\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\\ffmpeg-8.1.2-full_build\\bin\\ffmpeg.exe`;

const AT = 4.9;

const { projects } = await (await fetch(`${API}/local/projects`)).json();
const done = projects.find((p) => p.status === 'done');
if (!done) throw new Error('no completed project');

await fs.mkdir(OUT, { recursive: true });

// --- rendered frame ----------------------------------------------------------------
const renderedPath = path.join(OUT, 'cmp-rendered.png');
await new Promise((resolve, reject) => {
  const p = spawn(
    FFMPEG,
    ['-hide_banner', '-nostdin', '-y', '-ss', String(AT),
     '-i', `apps/worker/data/${done.id}/out.mp4`, '-frames:v', '1', renderedPath],
    { windowsHide: true },
  );
  p.on('error', reject);
  p.on('close', (c) => (c === 0 ? resolve() : reject(new Error(`ffmpeg ${c}`))));
});

// --- preview overlay geometry ---------------------------------------------------------
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
await page.goto(`${WEB}/project/${done.id}`, { waitUntil: 'networkidle' });
await page.waitForTimeout(1500);

const liveBtn = page.getByRole('button', { name: 'Live', exact: true });
if (await liveBtn.count()) await liveBtn.first().click();
await page.getByRole('button', { name: 'Clean', exact: true }).click();
await page.evaluate((t) => {
  const v = document.querySelector('video');
  if (v) {
    v.pause();
    v.currentTime = t;
  }
}, AT);
await page.waitForTimeout(900);

const preview = await page.evaluate(() => {
  const block = document.querySelector('[data-caption-block]');
  const frame = document.querySelector('[data-preview-frame]');
  if (!block || !frame) return null;
  const b = block.getBoundingClientRect();
  const f = frame.getBoundingClientRect();
  const word = block.querySelector('[data-word]');
  const cs = word ? getComputedStyle(word) : null;
  return {
    // Normalised so it can be compared against a differently-sized video frame.
    centerX: (b.left + b.width / 2 - f.left) / f.width,
    centerY: (b.top + b.height / 2 - f.top) / f.height,
    widthFrac: b.width / f.width,
    fontPct: cs ? (parseFloat(cs.fontSize) / f.height) * 100 : null,
    color: cs?.color ?? null,
    text: block.textContent?.trim() ?? '',
  };
});

await page.locator('[data-preview-frame]').first().screenshot({ path: path.join(OUT, 'cmp-preview.png') });
await browser.close();

// --- what the renderer was told to do -------------------------------------------------
const { project } = await (await fetch(`${API}/local/projects/${done.id}`)).json();
const { presets } = await (await fetch(`${API}/presets`)).json();
const base = presets.find((p) => p.id === project.stylePreset) ?? presets[0];
const style = { ...base, ...(project.styleOverrides ?? {}) };

console.log(`comparing at ${AT}s\n`);
console.log('preview overlay');
console.log(`  centre        ${preview.centerX.toFixed(3)}, ${preview.centerY.toFixed(3)}`);
console.log(`  width         ${(preview.widthFrac * 100).toFixed(1)}% of frame`);
console.log(`  font size     ${preview.fontPct?.toFixed(2)}% of height`);
console.log(`  colour        ${preview.color}`);
console.log(`  text          ${JSON.stringify(preview.text)}`);

console.log('\nstyle the renderer used');
console.log(`  positionX/Y   ${style.positionX.toFixed(3)}, ${style.positionY.toFixed(3)}`);
console.log(`  fontSizePct   ${style.fontSizePct}`);
console.log(`  textColor     ${style.textColor}   accent ${style.accentColor}`);

const dx = Math.abs(preview.centerX - style.positionX);
const dy = Math.abs(preview.centerY - style.positionY);
console.log('\ndeltas');
console.log(`  position      dx ${(dx * 100).toFixed(1)}%  dy ${(dy * 100).toFixed(1)}%  ${dx < 0.02 && dy < 0.02 ? 'OK' : 'MISMATCH'}`);
console.log(`\nframes -> ${renderedPath}\n         ${path.join(OUT, 'cmp-preview.png')}`);
