// Screenshots the live app in each map look (?map=…), dark and light, on a
// phone-sized screen, plus a 2×2 grid per colour scheme for picking one.
// Run by .github/workflows/map-preview.yml: node map-preview.mjs <url> <outDir>

import { mkdirSync, readFileSync } from 'node:fs';
import { chromium } from 'playwright';

const [url = 'https://parking-locator.excel-capital.workers.dev', out = 'map-preview'] = process.argv.slice(2);
const LOOKS = [
  ['standard', '1. Standard (now)'],
  ['clean', '2. Clean'],
  ['satellite', '3. Satellite'],
  ['3d', '4. 3D'],
];
mkdirSync(out, { recursive: true });
const browser = await chromium.launch();

for (const scheme of ['dark', 'light']) {
  const shots = [];
  for (const [look, label] of LOOKS) {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, colorScheme: scheme, isMobile: true, hasTouch: true });
    const page = await ctx.newPage();
    await page.goto(`${url}/?map=${look}`, { waitUntil: 'load' });
    await page.waitForTimeout(9000); // tiles, then the car framing animation
    const file = `${out}/${look}-${scheme}.png`;
    await page.screenshot({ path: file });
    shots.push({ file, label });
    await ctx.close();
  }
  const cells = shots
    .map(
      (s) =>
        `<figure><figcaption>${s.label}</figcaption><img src="data:image/png;base64,${readFileSync(s.file).toString('base64')}"></figure>`,
    )
    .join('');
  const page = await browser.newPage({ viewport: { width: 2 * 390 + 3 * 28, height: 400 }, deviceScaleFactor: 2 });
  await page.setContent(`<style>
    body { margin: 0; padding: 28px; display: grid; grid-template-columns: 390px 390px; gap: 28px;
      background: ${scheme === 'dark' ? '#000' : '#f2f2f7'}; color: ${scheme === 'dark' ? '#fff' : '#000'}; font: 700 24px system-ui, sans-serif; }
    figure { margin: 0; } figcaption { margin-bottom: 10px; } img { width: 390px; border-radius: 28px; display: block; }
  </style>${cells}`);
  await page.screenshot({ path: `${out}/options-${scheme}.png`, fullPage: true });
  await page.close();
}

await browser.close();
