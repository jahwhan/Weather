// Kurzer Satz zur Wetterlage, aus den Stundendaten erzeugt.
// z. B. "Ab 15 Uhr Regen. Böen bis 45 km/h."

import { describe, precipKindFor } from '../weather/conditions';
import { hourOf, t0 } from './format';

export interface SummaryHour {
  time: number;
  temp: number;
  code: number;
  precip: number;
  snowfall: number | null;
  cloud: number;
  windGust: number | null;
  precipProb?: number | null;
  isDay?: boolean | null;
}

const WORD: Record<string, string> = {
  rain: 'Regen',
  drizzle: 'Nieselregen',
  snow: 'Schnee',
  sleet: 'Schneeregen',
  hail: 'Hagel',
};

function wetWord(h: SummaryHour): string | null {
  const c = describe(h.code);
  const kind = precipKindFor(h.code, h.temp, h.snowfall, h.precip);
  const wet = h.precip >= 0.15 || ((h.precipProb ?? 0) >= 55 && c.precip !== 'none');
  if (!wet) return null;
  if (c.thunder) return 'Gewitter';
  return WORD[kind === 'none' ? c.precip : kind] ?? 'Niederschlag';
}

const at = (ms: number, off: number) => `${hourOf(ms, off)} Uhr`;

/**
 * hours: ab jetzt aufsteigend (erste Stunde = jetzt), mindestens einige Stunden.
 * todayMax: Höchstwert des heutigen Tages (optional)
 */
export function summarize(hours: SummaryHour[], utcOffsetSec: number, todayMax?: number | null, tonightMin?: number | null): string {
  if (!hours.length) return '';
  const next = hours.slice(0, 13);
  const parts: string[] = [];
  const now = next[0];
  const nowWord = wetWord(now);

  if (nowWord) {
    let end = -1;
    for (let i = 1; i < next.length - 1; i++) {
      if (!wetWord(next[i]) && !wetWord(next[i + 1])) {
        end = i;
        break;
      }
    }
    parts.push(end > 0 ? `${nowWord} bis etwa ${at(next[end].time, utcOffsetSec)}, danach trockener.` : `${nowWord} in den nächsten Stunden.`);
  } else {
    let first = -1;
    for (let i = 1; i < next.length; i++) {
      if (wetWord(next[i])) {
        first = i;
        break;
      }
    }
    if (first > 0) {
      const w = wetWord(next[first])!;
      parts.push(first === 1 ? `Bald ${w}.` : `Ab ${at(next[first].time, utcOffsetSec)} ${w}.`);
    } else {
      const fogNow = describe(now.code).fog;
      const clouds = next.map((h) => h.cloud);
      const mean = clouds.reduce((a, b) => a + b, 0) / clouds.length;
      const night = now.isDay === false;
      if (fogNow) parts.push('Nebel, sonst trocken.');
      else if (mean < 25) parts.push(night ? 'Klar und trocken.' : 'Trocken und meist sonnig.');
      else if (mean < 65) parts.push('Trocken, wechselnd bewölkt.');
      else parts.push('Trocken und meist bewölkt.');
    }
  }

  const gust = Math.max(0, ...next.map((h) => h.windGust ?? 0));
  if (gust >= 40) parts.push(`Böen bis ${Math.round(gust / 5) * 5} km/h.`);

  const hourNow = hourOf(now.time, utcOffsetSec);
  if (parts.length < 2) {
    if (todayMax != null && hourNow < 15) parts.push(`Höchstwert ${t0(todayMax)}°.`);
    else if (tonightMin != null) parts.push(`In der Nacht bis ${t0(tonightMin)}°.`);
  }
  return parts.join(' ');
}
