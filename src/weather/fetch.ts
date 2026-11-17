// Live-Wetter laden: zuerst Open-Meteo (ein Aufruf für alle Punkte), bei Fehler oder Limit
// MET Norway (yr.no) pro Punkt.
//
// In der Schweiz werden die MeteoSchweiz-Modelle ICON-CH1 (1 km, ~33 h) und ICON-CH2 (2 km,
// 5 Tage) angefragt, zusammen mit best_match für Lücken (UV, spätere Tage, Orte ausserhalb).
// Kette: CH-Modelle -> (HTTP 400 oder keine Werte) best_match -> MET Norway.

import { metSymbolToWmo } from './conditions.ts';
import { MODEL_LABEL, type PointWeather, type WeatherSample, type WeatherSource } from './types.ts';
import { angleDiff } from '../geo.ts';
import { HttpError, withTimeout } from '../swiss/http.ts';
import { isInSwitzerland } from '../swiss/region.ts';
import { cachedAt } from '../pwa/stamp.ts';

/** Reihenfolge = Vorrang beim Zusammenführen: feinstes Modell zuerst. */
export const CH_MODELS = ['meteoswiss_icon_ch1', 'meteoswiss_icon_ch2', 'best_match'];

const OM_VARS = [
  'temperature_2m',
  'apparent_temperature',
  'relative_humidity_2m',
  'dew_point_2m',
  'pressure_msl',
  'cloud_cover',
  'cloud_cover_low',
  'cloud_cover_mid',
  'cloud_cover_high',
  'precipitation',
  'snowfall',
  'weather_code',
  'wind_speed_10m',
  'wind_direction_10m',
  'wind_gusts_10m',
  'visibility',
  'shortwave_radiation',
  'direct_radiation',
  'diffuse_radiation',
];

const CACHE_MS = 10 * 60 * 1000;
const cache = new Map<string, PointWeather>();
const keyOf = (lat: number, lon: number) => `${lat.toFixed(3)},${lon.toFixed(3)}`;

export interface WeatherResult {
  points: PointWeather[];
  source: WeatherSource;
  /** Hinweis, falls auf die zweite Quelle ausgewichen wurde */
  note?: string;
}

/** Wetter für mehrere Punkte. Reihenfolge der Antwort = Reihenfolge der Eingabe. */
export async function fetchWeather(points: { lat: number; lon: number }[], signal?: AbortSignal): Promise<WeatherResult> {
  const now = Date.now();
  const cached = points.map((p) => {
    const c = cache.get(keyOf(p.lat, p.lon));
    return c && now - c.fetchedAt < CACHE_MS ? c : null;
  });
  const missingIdx = cached.flatMap((c, i) => (c ? [] : [i]));
  if (missingIdx.length === 0) {
    return { points: cached as PointWeather[], source: cached[0]!.source };
  }
  const missing = missingIdx.map((i) => points[i]);

  let fresh: PointWeather[];
  let note: string | undefined;
  try {
    fresh = await fetchOpenMeteoChain(missing, signal);
  } catch (err) {
    if (signal?.aborted) throw err;
    console.warn('Open-Meteo nicht verfügbar, weiche auf MET Norway aus:', err);
    fresh = await fetchMetNoAll(missing, signal);
    note = 'Open-Meteo nicht erreichbar, Daten von MET Norway (yr.no).';
  }
  missingIdx.forEach((idx, j) => {
    cached[idx] = fresh[j];
    cache.set(keyOf(points[idx].lat, points[idx].lon), fresh[j]);
  });
  return { points: cached as PointWeather[], source: fresh[0].source, note };
}

// ---------------------------------------------------------------- Open-Meteo

export interface OmBlock {
  time: number | number[];
  [k: string]: number | number[] | null | (number | null)[];
}
export interface OmResponse {
  latitude: number;
  longitude: number;
  elevation: number;
  utc_offset_seconds: number;
  timezone: string;
  current?: OmBlock;
  hourly: OmBlock;
  daily?: OmBlock;
}

/** Werte fehlen (z. B. Modell deckt den Ort nicht ab) */
export class MissingDataError extends Error {}

/**
 * Wert einer Variablen. Bei mehreren Modellen hängt Open-Meteo den Modellnamen an
 * ("temperature_2m_meteoswiss_icon_ch1"); genommen wird der erste vorhandene Wert in der
 * Reihenfolge von `models`, zuletzt der Name ohne Zusatz.
 */
export function omPick(block: OmBlock, name: string, idx: number, models: string[] | null): { v: number | null; model: string | null } {
  const at = (raw: OmBlock[string] | undefined): number | null => {
    const x = idx < 0 ? raw : Array.isArray(raw) ? raw[idx] : null;
    return typeof x === 'number' && Number.isFinite(x) ? x : null;
  };
  for (const m of models ?? []) {
    const v = at(block[`${name}_${m}`]);
    if (v != null) return { v, model: m };
  }
  const v = at(block[name]);
  return { v, model: v != null ? (models?.length === 1 ? models[0] : null) : null };
}

/**
 * Welches Modell liefert den aktuellen Zustand? (Label oder undefined)
 * Zuerst der "current"-Block; trägt der keinen Modellzusatz (bei Mehrmodell-Anfragen nicht
 * sicher dokumentiert), entscheidet die Stunde, in der `now` liegt.
 */
export function omModelLabel(r: OmResponse, models: string[] | null, now = Date.now()): string | undefined {
  if (!models) return MODEL_LABEL.best_match;
  let m = r.current ? omPick(r.current, 'temperature_2m', -1, models).model : null;
  if (!m) {
    const times = r.hourly.time as number[];
    let k = 0;
    for (let i = 0; i < times.length; i++) if (times[i] * 1000 <= now) k = i;
    m = omPick(r.hourly, 'temperature_2m', k, models).model;
  }
  if (!m && models.length === 1) m = models[0];
  return m ? (MODEL_LABEL[m] ?? m) : undefined;
}

async function fetchOpenMeteoChain(points: { lat: number; lon: number }[], signal?: AbortSignal): Promise<PointWeather[]> {
  const swiss = points.some((p) => isInSwitzerland([p.lon, p.lat]));
  if (!swiss) return fetchOpenMeteo(points, signal, null);
  try {
    return await fetchOpenMeteo(points, signal, CH_MODELS);
  } catch (err) {
    if (signal?.aborted) throw err;
    // Tageslimit (429) oder Netzfehler: best_match hilft nicht, gleich MET Norway
    if (!(err instanceof MissingDataError) && !(err instanceof HttpError && err.status === 400)) throw err;
    console.warn('MeteoSchweiz-Modelle nicht verfügbar, nehme best_match:', err);
    return fetchOpenMeteo(points, signal, null);
  }
}

async function fetchOpenMeteo(
  points: { lat: number; lon: number }[],
  signal: AbortSignal | undefined,
  models: string[] | null,
): Promise<PointWeather[]> {
  const params = new URLSearchParams({
    latitude: points.map((p) => p.lat.toFixed(4)).join(','),
    longitude: points.map((p) => p.lon.toFixed(4)).join(','),
    current: OM_VARS.join(','),
    hourly: OM_VARS.join(','),
    past_hours: '3',
    forecast_hours: '60',
    timeformat: 'unixtime',
    timezone: 'auto',
    wind_speed_unit: 'kmh',
  });
  if (models) params.set('models', models.join(','));
  const res = await fetch(`https://api.open-meteo.com/v1/forecast?${params}`, { signal: withTimeout(signal, 15000) });
  if (!res.ok) {
    let reason = '';
    try {
      reason = ((await res.json()) as { reason?: string }).reason ?? '';
    } catch {
      /* keine JSON-Antwort */
    }
    throw new HttpError(res.status, `Open-Meteo HTTP ${res.status}${reason ? `: ${reason}` : ''}`);
  }
  const json = (await res.json()) as OmResponse | OmResponse[] | { error: true; reason: string };
  if (!Array.isArray(json) && 'error' in json) throw new HttpError(400, json.reason);
  const list = Array.isArray(json) ? json : [json as OmResponse];
  if (list.length !== points.length) throw new Error('Open-Meteo: unerwartete Anzahl Orte');
  return parseOpenMeteo(list, points, models, cachedAt(res) ?? undefined);
}

/** Antwort(en) von Open-Meteo in PointWeather umwandeln (exportiert für Tests). */
export function parseOpenMeteo(
  list: OmResponse[],
  points: { lat: number; lon: number }[],
  models: string[] | null,
  fetchedAt = Date.now(),
): PointWeather[] {
  const out = list.map((r, i) => {
    const current = r.current ?? r.hourly;
    return {
      lat: points[i].lat,
      lon: points[i].lon,
      elevation: r.elevation ?? null,
      source: 'open-meteo' as const,
      utcOffsetSec: r.utc_offset_seconds ?? 0,
      timezone: r.timezone ?? null,
      current: omSample(current, r.current ? -1 : 0, models),
      hourly: (r.hourly.time as number[]).map((_, k) => omSample(r.hourly, k, models)),
      fetchedAt,
      model: omModelLabel(r, models, fetchedAt),
      // für die Prüfung unten
      _ok: omPick(current, 'temperature_2m', r.current ? -1 : 0, models).v != null,
    };
  });
  if (out.some((p) => !p._ok)) throw new MissingDataError('Open-Meteo: keine aktuellen Werte');
  return out.map(({ _ok, ...p }) => (void _ok, p));
}

export function omSample(block: OmBlock, idx: number, models: string[] | null = null): WeatherSample {
  const v = (name: string): number | null => omPick(block, name, idx, models).v;
  const time = (idx < 0 ? (block.time as number) : (block.time as number[])[idx]) * 1000;
  return {
    time,
    temp: v('temperature_2m') ?? 0,
    feelsLike: v('apparent_temperature'),
    humidity: v('relative_humidity_2m'),
    dewPoint: v('dew_point_2m'),
    pressure: v('pressure_msl'),
    cloud: v('cloud_cover') ?? 0,
    cloudLow: v('cloud_cover_low'),
    cloudMid: v('cloud_cover_mid'),
    cloudHigh: v('cloud_cover_high'),
    precip: v('precipitation') ?? 0,
    snowfall: v('snowfall'),
    code: v('weather_code') ?? 0,
    windSpeed: v('wind_speed_10m') ?? 0,
    windDir: v('wind_direction_10m') ?? 0,
    windGust: v('wind_gusts_10m'),
    visibility: v('visibility'),
    shortwave: v('shortwave_radiation'),
    direct: v('direct_radiation'),
    diffuse: v('diffuse_radiation'),
    fog: null,
  };
}

// ---------------------------------------------------------------- MET Norway

export interface MetEntry {
  time: string;
  data: {
    instant: { details: Record<string, number | undefined> };
    next_1_hours?: { summary: { symbol_code: string }; details: { precipitation_amount?: number } };
    next_6_hours?: { summary: { symbol_code: string }; details: { precipitation_amount?: number } };
  };
}

async function fetchMetNoAll(points: { lat: number; lon: number }[], signal?: AbortSignal): Promise<PointWeather[]> {
  // höchstens vier Anfragen gleichzeitig, um den Dienst zu schonen
  const out: PointWeather[] = new Array(points.length);
  let next = 0;
  const worker = async () => {
    while (next < points.length) {
      const i = next++;
      out[i] = await fetchMetNo(points[i], signal);
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, points.length) }, worker));
  return out;
}

async function fetchMetNo(p: { lat: number; lon: number }, signal?: AbortSignal): Promise<PointWeather> {
  // MET verlangt höchstens vier Nachkommastellen
  const url = `https://api.met.no/weatherapi/locationforecast/2.0/complete?lat=${p.lat.toFixed(4)}&lon=${p.lon.toFixed(4)}`;
  const res = await fetch(url, { signal: withTimeout(signal, 15000) });
  if (!res.ok) throw new Error(`MET Norway HTTP ${res.status}`);
  const json = (await res.json()) as {
    geometry: { coordinates: [number, number, number?] };
    properties: { timeseries: MetEntry[] };
  };
  const series = json.properties.timeseries;
  const hourly: WeatherSample[] = [];
  for (let i = 0; i < series.length; i++) {
    const e = series[i];
    const t = Date.parse(e.time);
    const nextT = i + 1 < series.length ? Date.parse(series[i + 1].time) : t + 3600e3;
    // nur stündliche Einträge, die 6-Stunden-Einträge am Ende reichen für 60 h nicht
    if (nextT - t > 3600e3 && hourly.length > 48) break;
    hourly.push(metSample(e));
  }
  const now = Date.now();
  let currentIdx = 0;
  for (let i = 0; i < hourly.length; i++) if (hourly[i].time <= now) currentIdx = i;
  const a = hourly[currentIdx];
  const b = hourly[Math.min(currentIdx + 1, hourly.length - 1)];
  const t = b.time > a.time ? Math.min(1, Math.max(0, (now - a.time) / (b.time - a.time))) : 0;
  const current = { ...lerpSample(a, b, t), time: now };
  return {
    lat: p.lat,
    lon: p.lon,
    elevation: json.geometry.coordinates[2] ?? null,
    source: 'met-no',
    ...metZone(p.lat, p.lon, now),
    current,
    hourly,
    fetchedAt: cachedAt(res) ?? now,
    model: MODEL_LABEL['met-no'],
  };
}

/** Abstand einer IANA-Zeitzone zu UTC in Sekunden (über Intl, inkl. Sommerzeit), null bei Fehler. */
export function zoneOffsetSec(timeZone: string, at = Date.now()): number | null {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).formatToParts(new Date(at));
    const get = (t: string) => Number(parts.find((x) => x.type === t)?.value);
    const local = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second'));
    const off = Math.round((local - Math.floor(at / 1000) * 1000) / 1000);
    return Number.isFinite(off) ? off : null;
  } catch {
    return null;
  }
}

/**
 * Zeitzone für MET-Daten (MET liefert keine): in der Schweiz Europe/Zurich über Intl,
 * sonst Sonnenzeit als Näherung (Länge / 15°).
 */
export function metZone(lat: number, lon: number, at = Date.now()): { utcOffsetSec: number; timezone: string | null } {
  if (isInSwitzerland([lon, lat])) {
    const off = zoneOffsetSec('Europe/Zurich', at);
    if (off != null) return { utcOffsetSec: off, timezone: 'Europe/Zurich' };
  }
  return { utcOffsetSec: Math.round(lon / 15) * 3600, timezone: null };
}

export function metSample(e: MetEntry): WeatherSample {
  const d = e.data.instant.details;
  const n = (k: string) => (typeof d[k] === 'number' ? (d[k] as number) : null);
  const next = e.data.next_1_hours ?? e.data.next_6_hours;
  const precip1 = e.data.next_1_hours?.details.precipitation_amount;
  const precip6 = e.data.next_6_hours?.details.precipitation_amount;
  const precip = precip1 ?? (precip6 != null ? precip6 / 6 : 0);
  const code = metSymbolToWmo(next?.summary.symbol_code);
  const temp = n('air_temperature') ?? 0;
  const fog = n('fog_area_fraction');
  return {
    time: Date.parse(e.time),
    temp,
    feelsLike: n('apparent_air_temperature'),
    humidity: n('relative_humidity'),
    dewPoint: n('dew_point_temperature'),
    pressure: n('air_pressure_at_sea_level'),
    cloud: n('cloud_area_fraction') ?? 0,
    cloudLow: n('cloud_area_fraction_low'),
    cloudMid: n('cloud_area_fraction_medium'),
    cloudHigh: n('cloud_area_fraction_high'),
    precip,
    snowfall: null,
    code: fog != null && fog > 40 && code < 45 ? 45 : code,
    windSpeed: (n('wind_speed') ?? 0) * 3.6,
    windDir: n('wind_from_direction') ?? 0,
    windGust: n('wind_speed_of_gust') != null ? n('wind_speed_of_gust')! * 3.6 : null,
    visibility: null,
    shortwave: null,
    direct: null,
    diffuse: null,
    fog,
  };
}

// ---------------------------------------------------------------- Interpolation

const lerpN = (a: number | null, b: number | null, t: number): number | null =>
  a == null ? b : b == null ? a : a + (b - a) * t;

export function lerpSample(a: WeatherSample, b: WeatherSample, t: number): WeatherSample {
  return {
    time: a.time + (b.time - a.time) * t,
    temp: a.temp + (b.temp - a.temp) * t,
    feelsLike: lerpN(a.feelsLike, b.feelsLike, t),
    humidity: lerpN(a.humidity, b.humidity, t),
    dewPoint: lerpN(a.dewPoint, b.dewPoint, t),
    pressure: lerpN(a.pressure, b.pressure, t),
    cloud: a.cloud + (b.cloud - a.cloud) * t,
    cloudLow: lerpN(a.cloudLow, b.cloudLow, t),
    cloudMid: lerpN(a.cloudMid, b.cloudMid, t),
    cloudHigh: lerpN(a.cloudHigh, b.cloudHigh, t),
    precip: a.precip + (b.precip - a.precip) * t,
    snowfall: lerpN(a.snowfall, b.snowfall, t),
    code: t < 0.5 ? a.code : b.code,
    windSpeed: a.windSpeed + (b.windSpeed - a.windSpeed) * t,
    windDir: (a.windDir + angleDiff(a.windDir, b.windDir) * t + 360) % 360,
    windGust: lerpN(a.windGust, b.windGust, t),
    visibility: lerpN(a.visibility, b.visibility, t),
    shortwave: lerpN(a.shortwave, b.shortwave, t),
    direct: lerpN(a.direct, b.direct, t),
    diffuse: lerpN(a.diffuse, b.diffuse, t),
    fog: lerpN(a.fog, b.fog, t),
  };
}

/**
 * Wetter eines Ortes zu einem Zeitpunkt.
 * `live`: nahe an jetzt wird die aktuelle Messung/Analyse verwendet.
 */
export function sampleAt(pw: PointWeather, ms: number, live: boolean): WeatherSample {
  const now = Date.now();
  if (live && Math.abs(ms - now) < 30 * 60e3) return { ...pw.current, time: ms };
  const h = pw.hourly;
  if (h.length === 0) return { ...pw.current, time: ms };
  if (ms <= h[0].time) return { ...h[0], time: ms };
  if (ms >= h[h.length - 1].time) return { ...h[h.length - 1], time: ms };
  let lo = 0;
  let hi = h.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (h[mid].time <= ms) lo = mid;
    else hi = mid;
  }
  const t = (ms - h[lo].time) / (h[hi].time - h[lo].time);
  const s = lerpSample(h[lo], h[hi], t);
  // nahe an jetzt weich in die aktuelle Analyse überblenden
  const dt = Math.abs(ms - now);
  if (dt < 90 * 60e3) {
    return { ...lerpSample(pw.current, s, Math.min(1, dt / (90 * 60e3))), time: ms };
  }
  return s;
}

/** Letzte Zeit, für die stündliche Vorhersagen vorliegen. */
export function forecastHorizon(points: PointWeather[]): number {
  return Math.min(...points.map((p) => (p.hourly.length ? p.hourly[p.hourly.length - 1].time : Date.now())));
}
