// Gipfelwetter: Open-Meteo am Gipfel (mit Höhenkorrektur und 72 h Rückblick),
// Rückfall MET Norway (ohne Vergangenheit).

import type { Peak } from './peaks.ts';
import type { MountainHour } from './assess.ts';

export interface MountainWeather {
  hourly: MountainHour[];
  /** liegen die letzten 72 h vor? (MET Norway: nein) */
  pastKnown: boolean;
  source: 'open-meteo' | 'met-no';
  model: string | null;
  fetchedAt: number;
}

const HOURLY = [
  'temperature_2m',
  'apparent_temperature',
  'precipitation',
  'rain',
  'snowfall',
  'weather_code',
  'cloud_cover',
  'cloud_cover_low',
  'visibility',
  'wind_speed_10m',
  'wind_gusts_10m',
  'freezing_level_height',
  'cape',
  'relative_humidity_2m',
  'is_day',
  'wind_speed_850hPa',
  'wind_speed_700hPa',
  'wind_speed_600hPa',
  'wind_speed_500hPa',
];

/** Druckflächen mit typischer Höhe (Standardatmosphäre, Alpen). */
const LEVELS: [hPa: number, height: number][] = [
  [850, 1500],
  [700, 3000],
  [600, 4200],
  [500, 5600],
];

/** Wind in Gipfelhöhe aus den Druckflächen linear interpolieren; unter 1500 m: null. */
export function windAtAltitude(elevation: number, byLevel: Record<number, number | null>): number | null {
  if (elevation < 1500) return null;
  for (let i = 0; i < LEVELS.length - 1; i++) {
    const [p0, h0] = LEVELS[i];
    const [p1, h1] = LEVELS[i + 1];
    if (elevation <= h1) {
      const a = byLevel[p0];
      const b = byLevel[p1];
      if (a == null) return b ?? null;
      if (b == null) return a;
      const t = Math.max(0, Math.min(1, (elevation - h0) / (h1 - h0)));
      return a + (b - a) * t;
    }
  }
  return byLevel[500] ?? byLevel[600] ?? null;
}

type Arr = (number | null)[] | undefined;

interface OmJson {
  hourly?: Record<string, Arr> & { time?: (number | string)[] };
  error?: boolean;
  reason?: string;
}

function num(a: Arr, i: number): number | null {
  const v = a?.[i];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** Open-Meteo-Antwort (timeformat unixtime oder iso8601 mit timezone) → Stundenwerte. */
export function parseOpenMeteo(json: unknown, elevation: number): MountainHour[] {
  const h = (json as OmJson)?.hourly;
  if (!h || !Array.isArray(h.time)) throw new Error('Open-Meteo: keine Stundenwerte');
  const offset = Number((json as { utc_offset_seconds?: number }).utc_offset_seconds ?? 0);
  const out: MountainHour[] = [];
  for (let i = 0; i < h.time.length; i++) {
    const tv = h.time[i];
    // ISO-Zeit ohne Zone ist Ortszeit → mit utc_offset_seconds korrigieren
    const time = typeof tv === 'number' ? tv * 1000 : Date.parse(`${tv}Z`) - offset * 1000;
    const temp = num(h.temperature_2m, i);
    if (temp == null || !Number.isFinite(time)) continue;
    const isDay = num(h.is_day, i);
    out.push({
      time,
      temp,
      precip: num(h.precipitation, i) ?? 0,
      snowfall: num(h.snowfall, i) ?? 0,
      code: num(h.weather_code, i) ?? 0,
      cloud: num(h.cloud_cover, i) ?? 0,
      cloudLow: num(h.cloud_cover_low, i),
      visibility: num(h.visibility, i),
      wind: num(h.wind_speed_10m, i) ?? 0,
      gust: num(h.wind_gusts_10m, i),
      windAlt: windAtAltitude(elevation, {
        850: num(h.wind_speed_850hPa, i),
        700: num(h.wind_speed_700hPa, i),
        600: num(h.wind_speed_600hPa, i),
        500: num(h.wind_speed_500hPa, i),
      }),
      freezingLevel: num(h.freezing_level_height, i),
      cape: num(h.cape, i),
      isDay: isDay == null ? null : isDay > 0,
    });
  }
  if (!out.length) throw new Error('Open-Meteo: leere Zeitreihe');
  return out;
}

/** MET-Symbol → WMO-Code (grob, reicht für die Einschätzung). */
export function metSymbolToCode(symbol: string | undefined): number {
  if (!symbol) return 0;
  const s = symbol.replace(/_(day|night|polartwilight)$/, '');
  if (s.includes('thunder')) return s.includes('heavy') ? 99 : 95;
  if (s === 'fog') return 45;
  if (s.includes('sleet')) return s.includes('showers') ? 83 : 68;
  if (s.includes('snow')) return s.includes('heavy') ? 75 : s.includes('light') ? 71 : s.includes('showers') ? 85 : 73;
  if (s.includes('rain')) {
    if (s.includes('showers')) return s.includes('heavy') ? 82 : s.includes('light') ? 80 : 81;
    return s.includes('heavy') ? 65 : s.includes('light') ? 61 : 63;
  }
  if (s === 'clearsky') return 0;
  if (s === 'fair') return 1;
  if (s === 'partlycloudy') return 2;
  if (s === 'cloudy') return 3;
  return 0;
}

interface MetJson {
  properties?: {
    timeseries?: {
      time: string;
      data: {
        instant: { details: Record<string, number | undefined> };
        next_1_hours?: { summary: { symbol_code: string }; details: { precipitation_amount?: number } };
        next_6_hours?: { summary: { symbol_code: string }; details: { precipitation_amount?: number } };
      };
    }[];
  };
}

/** MET Norway locationforecast/complete → Stundenwerte (nur Prognose). */
export function parseMetNo(json: unknown): MountainHour[] {
  const ts = (json as MetJson)?.properties?.timeseries;
  if (!Array.isArray(ts)) throw new Error('MET Norway: keine Zeitreihe');
  const out: MountainHour[] = [];
  for (const e of ts) {
    const d = e.data.instant.details;
    const next = e.data.next_1_hours;
    if (!next || d.air_temperature == null) continue; // nur Stundenwerte
    const temp = d.air_temperature;
    const precip = next.details.precipitation_amount ?? 0;
    const symbol = next.summary.symbol_code;
    const ms = (v: number | undefined) => (v == null ? null : v * 3.6);
    out.push({
      time: Date.parse(e.time),
      temp,
      precip,
      // ca. 1 cm Schnee pro mm Wasser bei Frost (grob)
      snowfall: temp <= 0.5 ? precip : 0,
      code: (d.fog_area_fraction ?? 0) > 50 ? 45 : metSymbolToCode(symbol),
      cloud: d.cloud_area_fraction ?? 0,
      cloudLow: d.cloud_area_fraction_low ?? null,
      visibility: d.fog_area_fraction != null ? (d.fog_area_fraction > 50 ? 500 : null) : null,
      wind: ms(d.wind_speed) ?? 0,
      gust: ms(d.wind_speed_of_gust),
      windAlt: null,
      freezingLevel: null,
      cape: null,
      isDay: /_day$/.test(symbol) ? true : /_night$/.test(symbol) ? false : null,
    });
  }
  if (!out.length) throw new Error('MET Norway: leere Zeitreihe');
  return out;
}

function withTimeout(signal: AbortSignal | undefined, ms: number): AbortSignal {
  const t = AbortSignal.timeout(ms);
  if (!signal) return t;
  return typeof AbortSignal.any === 'function' ? AbortSignal.any([signal, t]) : signal;
}

export function openMeteoUrl(peak: Peak, model: string | null): string {
  const params = new URLSearchParams({
    latitude: peak.lat.toFixed(4),
    longitude: peak.lon.toFixed(4),
    elevation: String(Math.round(peak.elevation)),
    past_days: '3',
    forecast_days: '3',
    hourly: HOURLY.join(','),
    timezone: 'Europe/Zurich',
    timeformat: 'unixtime',
    wind_speed_unit: 'kmh',
  });
  if (model) params.set('models', model);
  return `https://api.open-meteo.com/v1/forecast?${params}`;
}

/** Liegt der Punkt grob in der Schweiz (inkl. Grenzgipfel)? Dann zuerst ICON-CH2. */
function inSwitzerland(p: Peak): boolean {
  return p.lat > 45.8 && p.lat < 47.85 && p.lon > 5.9 && p.lon < 10.55;
}

/** Druckflächenwind (Standardmodell) nach Zeit in vorhandene Stundenwerte einsetzen. */
export function applyAltitudeWind(hourly: MountainHour[], json: unknown, elevation: number): number {
  const h = (json as OmJson)?.hourly;
  if (!h || !Array.isArray(h.time)) return 0;
  const byTime = new Map<number, number>();
  h.time.forEach((t, i) => {
    if (typeof t !== 'number') return;
    const w = windAtAltitude(elevation, {
      850: num(h.wind_speed_850hPa, i),
      700: num(h.wind_speed_700hPa, i),
      600: num(h.wind_speed_600hPa, i),
      500: num(h.wind_speed_500hPa, i),
    });
    if (w != null) byTime.set(t * 1000, w);
  });
  let n = 0;
  for (const x of hourly) {
    const w = byTime.get(x.time);
    if (w != null) {
      x.windAlt = w;
      n++;
    }
  }
  return n;
}

async function mergeAltitudeWind(peak: Peak, hourly: MountainHour[], signal?: AbortSignal): Promise<void> {
  const params = new URLSearchParams({
    latitude: peak.lat.toFixed(4),
    longitude: peak.lon.toFixed(4),
    past_days: '3',
    forecast_days: '3',
    hourly: HOURLY.filter((v) => v.endsWith('hPa')).join(','),
    timezone: 'Europe/Zurich',
    timeformat: 'unixtime',
    wind_speed_unit: 'kmh',
  });
  const res = await fetch(`https://api.open-meteo.com/v1/forecast?${params}`, { signal: withTimeout(signal, 10000) });
  if (res.ok) applyAltitudeWind(hourly, await res.json(), peak.elevation);
}

async function openMeteo(peak: Peak, signal?: AbortSignal): Promise<MountainWeather> {
  const models = inSwitzerland(peak) ? ['meteoswiss_icon_ch2', null] : [null];
  let lastErr: unknown;
  for (const model of models) {
    try {
      const res = await fetch(openMeteoUrl(peak, model), { signal: withTimeout(signal, 15000) });
      if (res.status === 400 && model) continue; // Modell/Variable nicht verfügbar → ohne models
      if (!res.ok) throw new Error(`Open-Meteo HTTP ${res.status}`);
      const json = (await res.json()) as OmJson;
      if (json.error) throw new Error(json.reason ?? 'Open-Meteo Fehler');
      const hourly = parseOpenMeteo(json, peak.elevation);
      // ICON-CH2 ohne brauchbare Werte (z. B. lauter null) → globales Modell
      if (model && hourly.length < 48) continue;
      // ICON-CH2 hat keine Druckflächen: Höhenwind aus dem Standardmodell ergänzen
      if (model && peak.elevation >= 1500 && hourly.every((h) => h.windAlt == null)) {
        await mergeAltitudeWind(peak, hourly, signal).catch(() => undefined);
      }
      return { hourly, pastKnown: true, source: 'open-meteo', model, fetchedAt: Date.now() };
    } catch (err) {
      if (signal?.aborted) throw err;
      lastErr = err;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('Open-Meteo nicht erreichbar');
}

async function metNo(peak: Peak, signal?: AbortSignal): Promise<MountainWeather> {
  const url = `https://api.met.no/weatherapi/locationforecast/2.0/complete?lat=${peak.lat.toFixed(4)}&lon=${peak.lon.toFixed(4)}&altitude=${Math.round(peak.elevation)}`;
  const res = await fetch(url, { signal: withTimeout(signal, 15000) });
  if (!res.ok) throw new Error(`MET Norway HTTP ${res.status}`);
  return { hourly: parseMetNo(await res.json()), pastKnown: false, source: 'met-no', model: null, fetchedAt: Date.now() };
}

/** Gipfelwetter laden: Open-Meteo, sonst MET Norway. */
export async function fetchMountainWeather(peak: Peak, signal?: AbortSignal): Promise<MountainWeather> {
  try {
    return await openMeteo(peak, signal);
  } catch (err) {
    if (signal?.aborted) throw err;
    return metNo(peak, signal);
  }
}
