// Kompakte Live-Wetterzeile an der aktuellen Position (während des Flyovers).

import type { Env } from '../env';
import { describe } from '../weather/conditions';
import type { WeatherSample } from '../weather/types';
import type { CompactData } from './weatherPanel';
import { n1s } from './format';

export { escapeHtml } from './format';

export function localTime(ms: number, offsetSec: number, withDay = false): string {
  const d = new Date(ms + offsetSec * 1000);
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  if (!withDay) return `${hh}:${mm}`;
  const days = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];
  return `${days[d.getUTCDay()]} ${hh}:${mm}`;
}

export interface LiveContext {
  place: string;
  utcOffsetSec: number;
  /** true = aktuelles Wetter, false = Vorhersage */
  live: boolean;
}

/** Daten für die kompakte Zeile aus dem Zustand an der aktuellen Position. */
export function liveCompact(env: Env, s: WeatherSample, ctx: LiveContext): CompactData {
  const night = env.sunAlt < -0.8;
  const cond = describe(s.code, night);
  const bits: string[] = [cond.label];
  if (env.precipKind !== 'none' && env.precipRate >= 0.1) bits.push(`${n1s(env.precipRate)} mm/h`);
  if (s.windGust != null && s.windGust >= 35) bits.push(`Böen ${Math.round(s.windGust)} km/h`);
  else if (s.windSpeed >= 15) bits.push(`Wind ${Math.round(s.windSpeed)} km/h`);
  bits.push(localTime(env.time, ctx.utcOffsetSec, !ctx.live));
  return {
    place: ctx.place,
    temp: s.temp,
    code: s.code,
    night,
    line: bits.join(' · '),
    badge: ctx.live ? { kind: 'live', text: 'Live' } : { kind: 'forecast', text: 'Prognose' },
  };
}
