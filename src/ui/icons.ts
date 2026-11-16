// Eigene Symbole als Inline-SVG.
// Wettersymbole: gefüllt und dezent mehrfarbig (Farben über CSS-Klassen ic-*, damit Hell/Dunkel passt).
// Bedienelemente: Strichzeichnung in currentColor.

import type { IconKind } from '../weather/conditions';

// ------------------------------------------------------------ Bausteine Wetter (viewBox 32×32)

const r1 = (v: number) => Math.round(v * 10) / 10;

function sunShape(cx: number, cy: number, r: number, rayIn: number, rayOut: number): string {
  const rays = Array.from({ length: 8 }, (_, i) => {
    const a = (i * Math.PI) / 4;
    return `M${r1(cx + Math.cos(a) * rayIn)} ${r1(cy + Math.sin(a) * rayIn)}L${r1(cx + Math.cos(a) * rayOut)} ${r1(cy + Math.sin(a) * rayOut)}`;
  }).join('');
  return `<path class="ic-ray" d="${rays}"/><circle class="ic-sun" cx="${cx}" cy="${cy}" r="${r}"/>`;
}

function moonShape(cx: number, cy: number, r: number): string {
  // Sichel: Vollkreis minus versetzter Kreis
  const ox = r * 0.62;
  const oy = -r * 0.38;
  const R = r * 0.86;
  // Schnittpunkte grob über Kreisbögen darstellen
  return `<path class="ic-moon" d="M${r1(cx + r * 0.25)} ${r1(cy - r * 0.97)}A${r} ${r} 0 1 0 ${r1(cx + r * 0.98)} ${r1(cy + r * 0.2)}A${R} ${R} 0 0 1 ${r1(cx + r * 0.25)} ${r1(cy - r * 0.97)}Z"/>` +
    `<circle class="ic-star" cx="${r1(cx + ox + 4)}" cy="${r1(cy + oy - 3)}" r="0.9"/>`;
}

/** Wolke aus Kreisen: x/y = linke untere Ecke der Grundlinie, w = Breite */
function cloudShape(x: number, y: number, w: number, cls = 'ic-cloud'): string {
  const s = w / 22;
  const c = (cx: number, cy: number, r: number) => `<circle cx="${r1(x + cx * s)}" cy="${r1(y + cy * s)}" r="${r1(r * s)}"/>`;
  return `<g class="${cls}">${c(4.6, -4.6, 4.6)}${c(10.4, -8.2, 6.6)}${c(17, -5.4, 5)}<rect x="${r1(x + 4.6 * s)}" y="${r1(y - 7 * s)}" width="${r1(12.6 * s)}" height="${r1(7 * s)}"/></g>`;
}

const drops = (n: number, y: number, len: number, cls = 'ic-rain') => {
  const d = Array.from({ length: n }, (_, i) => {
    const x = 10.5 + i * (11 / Math.max(1, n - 1));
    return `M${r1(x)} ${y}l-1.6 ${len}`;
  }).join('');
  return `<path class="${cls}" d="${d}"/>`;
};

const flakes = (n: number, y: number) =>
  Array.from({ length: n }, (_, i) => {
    const x = 10 + i * (12 / Math.max(1, n - 1));
    const yy = y + (i % 2) * 3.2;
    return `<g class="ic-snow" transform="translate(${r1(x)} ${r1(yy)})"><path d="M0-1.9V1.9M-1.65-.95 1.65.95M-1.65.95 1.65-.95"/></g>`;
  }).join('');

const svg = (body: string, cls = 'wx-icon', label?: string) =>
  `<svg class="${cls}" viewBox="0 0 32 32" ${label ? `role="img" aria-label="${label}"` : 'aria-hidden="true"'}>${body}</svg>`;

/** Wettersymbol für einen Zustand. `size` als CSS-Klasse: wx-icon (Standard), wx-icon-s, wx-icon-l. */
export function weatherIcon(kind: IconKind, night: boolean, cls = 'wx-icon'): string {
  const orb = (cx: number, cy: number, k: number) => (night ? moonShape(cx, cy, 6.4 * k) : sunShape(cx, cy, 5.4 * k, 8 * k, 10.6 * k));
  let body = '';
  switch (kind) {
    case 'clear':
      body = night ? moonShape(16, 16, 9.5) : sunShape(16, 16, 6.4, 9.6, 13);
      break;
    case 'partly':
      body = `${orb(12, 12, 0.85)}${cloudShape(7, 26, 22)}`;
      break;
    case 'cloudy':
      body = `${cloudShape(10, 18.5, 18, 'ic-cloud-back')}${cloudShape(4, 26, 22)}`;
      break;
    case 'fog':
      body = `${cloudShape(5, 19, 22)}<path class="ic-fog" d="M6 23.5h20M9 27.5h14"/>`;
      break;
    case 'drizzle':
      body = `${cloudShape(5, 20, 22)}${drops(3, 23.5, 3.2, 'ic-rain ic-thin')}`;
      break;
    case 'rain':
      body = `${cloudShape(5, 20, 22, 'ic-cloud ic-cloud-wet')}${drops(4, 23.5, 5.5)}`;
      break;
    case 'snow':
      body = `${cloudShape(5, 20, 22)}${flakes(3, 24.5)}`;
      break;
    case 'sleet':
      body = `${cloudShape(5, 20, 22)}${drops(2, 23.5, 5)}${flakes(2, 25.5).replace(/translate\((\d+)/g, (_m, x) => `translate(${Number(x) + 3}`)}`;
      break;
    case 'thunder':
      body = `${cloudShape(5, 19, 22, 'ic-cloud ic-cloud-wet')}<path class="ic-bolt" d="M17.6 17.5l-5 7.3h3.6l-2 6 6.2-8.2h-3.7l2.4-5.1z"/>`;
      break;
  }
  return svg(body, cls);
}

/** Wind-Symbol (für starke Böen in der Stundenleiste) */
export function windIcon(cls = 'wx-icon'): string {
  return svg(`<path class="ic-wind" d="M4 12h14.5a3.5 3.5 0 1 0-3.4-4.3M4 17h20a3.5 3.5 0 1 1-3.4 4.3M4 22h9"/>`, cls);
}

/** Sonnenauf- bzw. -untergang */
export function sunEventIcon(rise: boolean, cls = 'wx-icon'): string {
  const arrow = rise ? 'M16 3.5v6M13 6.3l3-2.9 3 2.9' : 'M16 3.5v6M13 6.7l3 2.9 3-2.9';
  return svg(
    `<path class="ic-ray" d="M6.5 17.5l1.8 1.1M25.5 17.5l-1.8 1.1M10.3 12.4l1.2 1.6M21.7 12.4l-1.2 1.6"/>` +
      `<path class="ic-sun" d="M9.5 22a6.5 6.5 0 0 1 13 0z"/>` +
      `<path class="ic-horizon" d="M4 22.5h24M8 26.5h16"/>` +
      `<path class="ic-arrow" d="${arrow}"/>`,
    cls,
  );
}

// ------------------------------------------------------------ Bedienelemente (viewBox 24×24)

const UI: Record<string, string> = {
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.4 15.4 20 20"/>',
  play: '<path class="fill" d="M8 5.6v12.8c0 .9 1 1.4 1.7.9l9.6-6.4c.6-.4.6-1.4 0-1.8L9.7 4.7C9 4.2 8 4.7 8 5.6z"/>',
  pause: '<rect class="fill" x="6.5" y="5" width="4" height="14" rx="1.3"/><rect class="fill" x="13.5" y="5" width="4" height="14" rx="1.3"/>',
  chat: '<path d="M4.5 11.2c0-3.9 3.4-6.7 7.5-6.7s7.5 2.8 7.5 6.7-3.4 6.7-7.5 6.7c-.9 0-1.8-.1-2.6-.4L5.6 19.2l1-3.4c-1.3-1.2-2.1-2.8-2.1-4.6z"/><path d="M8.8 11.3h.01M12 11.3h.01M15.2 11.3h.01" stroke-width="2.2"/>',
  sliders: '<path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2.2"/><circle cx="9" cy="17" r="2.2"/>',
  pin: '<path d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11z"/><circle cx="12" cy="10" r="2.3"/>',
  close: '<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>',
  clock: '<circle cx="12" cy="12" r="8"/><path d="M12 7.5V12l3 2"/>',
  route: '<circle cx="6" cy="18" r="2.2"/><circle cx="18" cy="6" r="2.2"/><path d="M8.2 18H15a3 3 0 0 0 0-6H9a3 3 0 0 1 0-6h6.8"/>',
  car: '<path d="M5 16.5v-3.2l1.7-4.6A2 2 0 0 1 8.6 7.4h6.8a2 2 0 0 1 1.9 1.3l1.7 4.6v3.2"/><rect x="4" y="13" width="16" height="4.5" rx="1.6"/><path d="M6.5 17.5v1.5M17.5 17.5v1.5M7.6 15.2h.01M16.4 15.2h.01" stroke-width="2"/>',
  transit: '<rect x="6" y="3.8" width="12" height="13" rx="3"/><path d="M6 11h12M9.2 14.2h.01M14.8 14.2h.01" /><path d="M8.5 20.2l1.6-3.4M15.5 20.2l-1.6-3.4M10 6.6h4"/>',
  bike: '<circle cx="6.3" cy="15.8" r="3.6"/><circle cx="17.7" cy="15.8" r="3.6"/><path d="M6.3 15.8l3.4-6.4h5.2l2.8 6.4M9.7 9.4l2.6 6.4h-6M13.2 6.8h2.3"/>',
  foot: '<circle cx="13" cy="4.6" r="1.8"/><path d="M10.4 21l2-6.2-2.3-2.4.9-4.1 3.2 2.8 2.6.7M12.4 14.8l2.4 2.4.8 3.8M11 8.3 8 9.6l-1.1 3"/>',
  flight: '<path d="M10.6 13.4 4 11.7l1.4-1.4 7.3.4 3.7-3.8c.8-.8 2.2-1 2.7-.5s.3 1.9-.5 2.7l-3.8 3.7.4 7.3-1.4 1.4-1.7-6.6-3.1 3.1.1 2.3-1 1-1.3-2.9-2.9-1.3 1-1 2.3.1z"/>',
  chevron: '<path d="M9 6l6 6-6 6"/>',
  chevronDown: '<path d="M6 9l6 6 6-6"/>',
  refresh: '<path d="M19 12a7 7 0 1 1-2.05-4.95"/><path d="M19.4 4.6v3.6h-3.6"/>',
  location: '<path d="M4.5 11.2 19.5 4.5l-6.7 15-1.6-6.7z"/>',
  drop: '<path d="M12 3.6s5.8 6.3 5.8 10.4a5.8 5.8 0 0 1-11.6 0C6.2 9.9 12 3.6 12 3.6z"/>',
  eye: '<path d="M2.8 12s3.4-6 9.2-6 9.2 6 9.2 6-3.4 6-9.2 6-9.2-6-9.2-6z"/><circle cx="12" cy="12" r="2.8"/>',
  gauge: '<path d="M4.2 16.5a8.5 8.5 0 1 1 15.6 0"/><path d="M12 13.5l3.5-4"/><circle cx="12" cy="14" r="1.2" class="fill"/>',
  thermo: '<path d="M10 14.3V5.5a2 2 0 0 1 4 0v8.8a4 4 0 1 1-4 0z"/><path d="M12 10.5v6"/>',
  humidity: '<path d="M12 3.6s5.8 6.3 5.8 10.4a5.8 5.8 0 0 1-11.6 0C6.2 9.9 12 3.6 12 3.6z"/><path d="M9.5 15.5l5-5M10 11h.01M14 15h.01" stroke-width="1.6"/>',
  uv: '<circle cx="12" cy="12" r="3.8"/><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6 7 7M17 17l1.4 1.4M5.6 18.4 7 17M17 7l1.4-1.4"/>',
  sunrise: '<path d="M6 17a6 6 0 0 1 12 0M3 17h18M12 4v4M9.8 6.2 12 4l2.2 2.2M5 10.5l1.3 1M19 10.5l-1.3 1"/>',
  wind: '<path d="M3.5 9.5h10a2.6 2.6 0 1 0-2.5-3.3M3.5 14h14a2.6 2.6 0 1 1-2.5 3.3M3.5 18.5h6"/>',
  rain: '<path d="M7 14.5a4.5 4.5 0 0 1 .8-8.9 5.5 5.5 0 0 1 10.4 1.8 3.6 3.6 0 0 1-.7 7.1"/><path d="M9 17.5l-1 2.5M13 16.5l-1.4 3.5M16.6 17.5l-1 2.5"/>',
  snowflake: '<path d="M12 3v18M4.2 7.5l15.6 9M4.2 16.5l15.6-9M9.6 4.6 12 6.8l2.4-2.2M9.6 19.4 12 17.2l2.4 2.2"/>',
  mountain: '<path d="M2.5 19.5 9 8.5l3.4 5.3 2.3-3.4 6.8 9.1z"/><path d="M7.3 11.4 9 12.6l1.6-1.4"/>',
  freezing: '<path d="M2.5 19.5 9 8.5l3.4 5.3 2.3-3.4 6.8 9.1z"/><path d="M2.5 12.5h19" stroke-dasharray="2 2"/>',
  warn: '<path d="M10.3 4.6 3.2 17.4A2 2 0 0 0 5 20.4h14a2 2 0 0 0 1.8-3L13.7 4.6a2 2 0 0 0-3.4 0z"/><path d="M12 9.5v4.2M12 16.8h.01"/>',
  station: '<path d="M12 11v10M8.5 21h7"/><circle cx="12" cy="9" r="2"/><path d="M8.2 5.2a5.4 5.4 0 0 0 0 7.6M15.8 5.2a5.4 5.4 0 0 1 0 7.6M5.6 2.8a9 9 0 0 0 0 12.4M18.4 2.8a9 9 0 0 1 0 12.4"/>',
  info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5.5M12 7.8h.01"/>',
  calendar: '<rect x="4" y="5.5" width="16" height="14.5" rx="3"/><path d="M4 10h16M8.5 3.5v3.5M15.5 3.5v3.5"/>',
  arrowUp: '<path d="M12 19V5M6.5 10.5 12 5l5.5 5.5"/>',
  arrowDown: '<path d="M12 5v14M6.5 13.5 12 19l5.5-5.5"/>',
  external: '<path d="M14 4.5h5.5V10M19.5 4.5 11 13M17 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2h4"/>',
  layers: '<path d="M12 4 3.5 8.5 12 13l8.5-4.5zM3.5 12.5 12 17l8.5-4.5M3.5 16.5 12 21l8.5-4.5"/>',
  sparkle: '<path d="M12 3.5l1.9 5.1 5.1 1.9-5.1 1.9-1.9 5.1-1.9-5.1L5 10.5l5.1-1.9z"/><path d="M18.5 16.5l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z"/>',
};

export type UiIconName = keyof typeof UI;

export function uiIcon(name: string, cls = 'ui-icon'): string {
  return `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true">${UI[name] ?? ''}</svg>`;
}

/** Freundliche kleine Illustration für Leer- und Fehlerzustände (ca. 96×72). */
export function illustration(kind: 'offline' | 'search' | 'empty'): string {
  const base =
    `<ellipse class="il-ground" cx="48" cy="64" rx="34" ry="4"/>` +
    `<g class="ic-cloud"><circle cx="34" cy="40" r="11"/><circle cx="50" cy="31" r="15"/><circle cx="66" cy="41" r="10"/><rect x="34" y="36" width="32" height="15" rx="2"/><rect x="23" y="40" width="54" height="11" rx="5.5"/></g>`;
  const face = `<circle class="il-face" cx="44" cy="40" r="1.6"/><circle class="il-face" cx="56" cy="40" r="1.6"/>`;
  if (kind === 'offline') {
    // Wolke mit kleinem Stecker, leicht betrübt
    return `<svg class="illu" viewBox="0 0 96 72" aria-hidden="true">${base}<path class="il-line" d="M50 51v5M45 56h10M47.5 56v4M52.5 56v4"/>${face}<path class="il-line" d="M45.5 46.5c2.6-1.8 6.4-1.8 9 0"/></svg>`;
  }
  if (kind === 'search') {
    return `<svg class="illu" viewBox="0 0 96 72" aria-hidden="true">${base}${face}<path class="il-line" d="M46 45c2.4 1.6 5.6 1.6 8 0"/><circle class="il-lens" cx="72" cy="24" r="8"/><path class="il-line" d="M77.8 29.8 83 35"/></svg>`;
  }
  return `<svg class="illu" viewBox="0 0 96 72" aria-hidden="true"><g transform="translate(62 4)">${sunShape(10, 10, 6, 9, 12.5)}</g>${base}${face}<path class="il-line" d="M46 45c2.4 1.6 5.6 1.6 8 0"/></svg>`;
}

/** App-Zeichen (Kurve mit Sonne), eigenes Motiv */
export function brandMark(cls = 'brand-mark'): string {
  return `<svg class="${cls}" viewBox="0 0 32 32" aria-hidden="true"><path d="M4 23c5-1 7-10 12-11s7 5 12-3" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"/><circle cx="24.5" cy="8.5" r="3.4" class="ic-sun"/></svg>`;
}
