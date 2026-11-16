// Wettersymbole als Inline-SVG (Strichzeichnung, 48×48).

import type { IconKind } from '../weather/conditions';

const SUN = '#ffd36b';
const CLOUD = '#dfe5ee';
const CLOUD_DARK = '#9aa6b8';
const RAIN = '#5fb0ff';
const SNOW = '#ffffff';
const BOLT = '#ffe066';
const MOON = '#e9e6d6';

const sun = (cx = 24, cy = 24, r = 8) => {
  const rays = Array.from({ length: 8 }, (_, i) => {
    const a = (i * Math.PI) / 4;
    const x1 = cx + Math.cos(a) * (r + 4);
    const y1 = cy + Math.sin(a) * (r + 4);
    const x2 = cx + Math.cos(a) * (r + 8);
    const y2 = cy + Math.sin(a) * (r + 8);
    return `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}"/>`;
  }).join('');
  return `<g stroke="${SUN}" stroke-width="2.4" stroke-linecap="round" fill="none"><circle cx="${cx}" cy="${cy}" r="${r}" fill="${SUN}" fill-opacity="0.25"/>${rays}</g>`;
};

const moon = (cx = 24, cy = 22, r = 10) =>
  `<path d="M${cx + r * 0.3} ${cy - r} a${r} ${r} 0 1 0 ${r * 0.75} ${r * 1.55} a${r * 0.8} ${r * 0.8} 0 1 1 ${-r * 0.75} ${-r * 1.55}z" fill="${MOON}" fill-opacity="0.9"/>`;

const cloud = (dark = false, dy = 0) =>
  `<path transform="translate(0 ${dy})" d="M14 34h21a7 7 0 0 0 0-14 10 10 0 0 0-19-2 8 8 0 0 0-2 16z" fill="${dark ? CLOUD_DARK : CLOUD}" fill-opacity="${dark ? 0.85 : 0.92}" stroke="${dark ? '#6c7789' : '#ffffff'}" stroke-width="1.2" stroke-opacity="0.6"/>`;

const drops = (color: string, n: number, len: number, w = 2.2) =>
  Array.from({ length: n }, (_, i) => {
    const x = 16 + i * (18 / Math.max(1, n - 1));
    return `<line x1="${x}" y1="38" x2="${x - 2.5}" y2="${38 + len}" stroke="${color}" stroke-width="${w}" stroke-linecap="round"/>`;
  }).join('');

const flakes = (n: number) =>
  Array.from({ length: n }, (_, i) => {
    const x = 16 + i * (16 / Math.max(1, n - 1));
    const y = 41 + (i % 2) * 3;
    return `<circle cx="${x}" cy="${y}" r="2" fill="${SNOW}"/>`;
  }).join('');

export function weatherIcon(kind: IconKind, night: boolean): string {
  let body = '';
  switch (kind) {
    case 'clear':
      body = night ? moon(24, 24, 11) : sun();
      break;
    case 'partly':
      body = `<g transform="translate(6 -6) scale(0.75)">${night ? moon() : sun()}</g>${cloud(false, 4)}`;
      break;
    case 'cloudy':
      body = `<g transform="translate(6 -5) scale(0.8)">${cloud(true)}</g>${cloud(false, 3)}`;
      break;
    case 'fog':
      body = `${cloud(false, -4)}<g stroke="${CLOUD}" stroke-width="2.4" stroke-linecap="round" opacity="0.85"><line x1="10" y1="36" x2="38" y2="36"/><line x1="14" y1="41" x2="34" y2="41"/></g>`;
      break;
    case 'drizzle':
      body = `${cloud(false, -4)}${drops(RAIN, 4, 3, 1.8)}`;
      break;
    case 'rain':
      body = `${cloud(true, -4)}${drops(RAIN, 4, 7)}`;
      break;
    case 'snow':
      body = `${cloud(false, -4)}${flakes(4)}`;
      break;
    case 'sleet':
      body = `${cloud(false, -4)}${drops(RAIN, 2, 6)}<circle cx="21" cy="42" r="2" fill="${SNOW}"/><circle cx="30" cy="44" r="2" fill="${SNOW}"/>`;
      break;
    case 'thunder':
      body = `${cloud(true, -5)}<path d="M25 30l-6 9h5l-3 8 9-11h-5l3-6z" fill="${BOLT}" stroke="#fff4b0" stroke-width="0.8"/>`;
      break;
  }
  return `<svg class="wx-icon" viewBox="0 0 48 48" aria-hidden="true">${body}</svg>`;
}
