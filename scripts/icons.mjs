// Erzeugt die App-Icons (PNG) aus einem SVG-Motiv: blauer Grund, weisse Flugbahn, gelbe Sonne
// (angelehnt an das Favicon in index.html).
//
//   node scripts/icons.mjs
//
// Braucht Playwright mit Chromium (lokal oder global installiert, z. B.
// `npm i -g playwright && npx playwright install chromium`). Die erzeugten Dateien liegen in
// public/icons/ und sind eingecheckt; das Skript ist nur nötig, wenn sich das Motiv ändert.

import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'public', 'icons');

async function loadPlaywright() {
  try {
    return await import('playwright');
  } catch {
    // global installiertes Playwright (ESM kennt NODE_PATH nicht)
    const globalRoot = execSync('npm root -g').toString().trim();
    return createRequire(join(globalRoot, 'noop.js'))('playwright');
  }
}

/**
 * Motiv im 512er-Raster. `scale` verkleinert die Flugbahn um die Mitte
 * (maskable: alles muss im Kreis mit 40 % Radius liegen).
 */
function svg({ size, rounded, scale }) {
  const r = rounded ? 112 : 0;
  // Flugbahn wie im Favicon (32er-Raster × 16), um die Mitte skaliert
  const t = `translate(256 256) scale(${scale}) translate(-256 -256)`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 512 512">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#5aa2ff"/>
      <stop offset="0.55" stop-color="#2b6fe0"/>
      <stop offset="1" stop-color="#1a4fb8"/>
    </linearGradient>
    <radialGradient id="shine" cx="0.3" cy="0.05" r="0.75">
      <stop offset="0" stop-color="#fff" stop-opacity="0.32"/>
      <stop offset="1" stop-color="#fff" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="glow" cx="0.5" cy="0.5" r="0.5">
      <stop offset="0.35" stop-color="#ffd04a" stop-opacity="0.55"/>
      <stop offset="1" stop-color="#ffd04a" stop-opacity="0"/>
    </radialGradient>
    <filter id="soft" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="6" stdDeviation="8" flood-color="#0b2a66" flood-opacity="0.35"/>
    </filter>
  </defs>
  <rect width="512" height="512" rx="${r}" fill="url(#bg)"/>
  <rect width="512" height="512" rx="${r}" fill="url(#shine)"/>
  <g transform="${t}">
    <circle cx="424" cy="150" r="104" fill="url(#glow)"/>
    <path d="M80 368c80-16 96-160 176-176s96 96 176-48" fill="none" stroke="#fff" stroke-width="44" stroke-linecap="round" filter="url(#soft)"/>
    <circle cx="80" cy="368" r="30" fill="#fff" filter="url(#soft)"/>
    <circle cx="424" cy="150" r="52" fill="#ffd04a" filter="url(#soft)"/>
  </g>
</svg>`;
}

const ICONS = [
  { file: 'icon-192.png', size: 192, rounded: true, scale: 0.86 },
  { file: 'icon-512.png', size: 512, rounded: true, scale: 0.86 },
  // maskable: vollflächig, Motiv innerhalb der Safe Zone (Kreis mit 40 % Radius)
  { file: 'icon-512-maskable.png', size: 512, rounded: false, scale: 0.66 },
  // iOS rundet selbst ab und mag keine Transparenz
  { file: 'apple-touch-icon.png', size: 180, rounded: false, scale: 0.8 },
];

const { chromium } = await loadPlaywright();
const browser = await chromium.launch();
const page = await browser.newPage({ deviceScaleFactor: 1 });
await mkdir(out, { recursive: true });
for (const ic of ICONS) {
  await page.setViewportSize({ width: ic.size, height: ic.size });
  await page.setContent(`<html><body style="margin:0;background:transparent">${svg(ic)}</body></html>`);
  const png = await page.locator('svg').screenshot({ omitBackground: true });
  await writeFile(join(out, ic.file), png);
  console.log('geschrieben', ic.file);
}
await writeFile(join(out, 'icon.svg'), svg({ size: 512, rounded: true, scale: 0.86 }).replace(' width="512" height="512"', '') + '\n');
await browser.close();
