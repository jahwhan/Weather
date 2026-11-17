// Wetter-App-Daten für EINEN Ort: aktueller Zustand, Stundenwerte ab jetzt, 10-Tage-Vorhersage,
// Nullgradgrenze und Schneefallgrenze.
//
// Quelle: Open-Meteo (in der Schweiz MeteoSchweiz ICON-CH1/CH2, ergänzt um best_match für UV und
// die Tage 6–10), Rückfall MET Norway (Tage aus 1-h- und 6-h-Blöcken zusammengesetzt).
// Zwischenspeicher: 10 min im Speicher und im localStorage; `cachedDetail` liefert auch ältere
// Daten für die sofortige Anzeige beim nächsten Start ("Stand HH:MM").

import { sunPosition, sunTimes } from '../astro/sun.ts';
import { isInSwitzerland } from '../swiss/region.ts';
import { HttpError, withTimeout } from '../swiss/http.ts';
import {
  CH_MODELS,
  MissingDataError,
  metSample,
  metZone,
  omModelLabel,
  omPick,
  omSample,
  type MetEntry,
  type OmBlock,
  type OmResponse,
} from './fetch.ts';
import { MODEL_LABEL, type WeatherSample, type WeatherSource } from './types.ts';
import { stampCached } from '../pwa/stamp.ts';

export interface DailyForecast {
  /** YYYY-MM-DD Ortszeit */
  date: string;
  /** ms UTC des Tagesbeginns (Ortszeit) */
  time: number;
  code: number;
  tMax: number;
  tMin: number;
  /** mm */
  precipSum: number | null;
  /** % */
  precipProbMax: number | null;
  /** cm */
  snowfallSum: number | null;
  uvMax: number | null;
  /** ms UTC */
  sunrise: number | null;
  sunset: number | null;
  /** km/h */
  windMax: number | null;
  gustMax: number | null;
  /** Grad */
  windDirDominant: number | null;
}

export interface HourlyPoint extends WeatherSample {
  /** % */
  precipProb: number | null;
  uv: number | null;
  isDay: boolean | null;
  /** Nullgradgrenze, m ü. M. */
  freezingLevel: number | null;
}

export interface WeatherDetail {
  lat: number;
  lon: number;
  elevation: number | null;
  timezone: string | null;
  utcOffsetSec: number;
  source: WeatherSource;
  model: string | null;
  fetchedAt: number;
  current: HourlyPoint;
  /** ab aktueller Stunde, mind. 25 h */
  hourly: HourlyPoint[];
  /** 10 Tage (MET Norway: so viele, wie geliefert werden, meist 9–10) */
  daily: DailyForecast[];
  /** m, jetzt */
  freezingLevel: number | null;
  /** m, Schneefallgrenze (Modellwert oder Schätzung, siehe snowLineEstimated) */
  snowLine: number | null;
  /** true: Schneefallgrenze geschätzt als Nullgradgrenze − 300 m */
  snowLineEstimated?: boolean;
  /** true: Nullgradgrenze aus der Temperatur geschätzt (MET Norway, Standardatmosphäre) */
  freezingLevelEstimated?: boolean;
}

/** Faustregel: Schneefallgrenze liegt im Mittel ~300 m unter der Nullgradgrenze. */
export const SNOWLINE_OFFSET_M = 300;

const HOURLY_EXTRA = ['precipitation_probability', 'uv_index', 'is_day', 'freezing_level_height', 'snowfall_height'];
const OM_DAILY = [
  'weather_code',
  'temperature_2m_max',
  'temperature_2m_min',
  'precipitation_sum',
  'precipitation_probability_max',
  'snowfall_sum',
  'uv_index_max',
  'sunrise',
  'sunset',
  'wind_speed_10m_max',
  'wind_gusts_10m_max',
  'wind_direction_10m_dominant',
];
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

// ---------------------------------------------------------------- Cache

const CACHE_MS = 10 * 60 * 1000;
const STORE_KEY = 'wetterflug.detail.v1';
const STORE_MAX = 6;
const mem = new Map<string, WeatherDetail>();
const keyOf = (lat: number, lon: number) => `${lat.toFixed(2)},${lon.toFixed(2)}`;

function readStore(): Record<string, WeatherDetail> {
  try {
    return JSON.parse(localStorage.getItem(STORE_KEY) ?? '{}') as Record<string, WeatherDetail>;
  } catch {
    return {};
  }
}

function writeStore(key: string, d: WeatherDetail): void {
  try {
    const all = readStore();
    delete all[key];
    all[key] = d;
    const keys = Object.keys(all);
    for (const k of keys.slice(0, Math.max(0, keys.length - STORE_MAX))) delete all[k];
    localStorage.setItem(STORE_KEY, JSON.stringify(all));
  } catch {
    /* Speicher voll oder gesperrt */
  }
}

/** Letzte bekannte Daten für den Ort (auch veraltet; `fetchedAt` sagt, wie alt). */
export function cachedDetail(lat: number, lon: number): WeatherDetail | null {
  const key = keyOf(lat, lon);
  const m = mem.get(key);
  if (m) return m;
  const s = readStore()[key];
  if (s && Array.isArray(s.hourly) && Array.isArray(s.daily) && s.current) {
    mem.set(key, s);
    return s;
  }
  return null;
}

// laufende Abfragen teilen: der Start lädt das Wetter schon vor der Karte, das Panel hängt sich an
const inflight = new Map<string, Promise<WeatherDetail>>();

export async function fetchDetail(lat: number, lon: number, signal?: AbortSignal): Promise<WeatherDetail> {
  const key = keyOf(lat, lon);
  const c = cachedDetail(lat, lon);
  if (c && Date.now() - c.fetchedAt < CACHE_MS) return c;
  let p = inflight.get(key);
  if (!p) {
    p = (async () => {
      let d: WeatherDetail;
      try {
        d = await fetchDetailOpenMeteo(lat, lon);
      } catch (err) {
        console.warn('Open-Meteo (Detail) nicht verfügbar, weiche auf MET Norway aus:', err);
        d = await fetchDetailMetNo(lat, lon);
      }
      mem.set(key, d);
      writeStore(key, d);
      return d;
    })();
    inflight.set(key, p);
    p.then(
      () => inflight.delete(key),
      () => inflight.delete(key),
    );
  }
  if (!signal) return p;
  if (signal.aborted) throw signal.reason ?? new DOMException('Abgebrochen', 'AbortError');
  // Abbruch beendet nur das Warten dieses Aufrufers, nicht die geteilte Abfrage
  return new Promise<WeatherDetail>((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new DOMException('Abgebrochen', 'AbortError'));
    signal.addEventListener('abort', onAbort, { once: true });
    p!.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

// ---------------------------------------------------------------- Open-Meteo

async function fetchDetailOpenMeteo(lat: number, lon: number, signal?: AbortSignal): Promise<WeatherDetail> {
  const swiss = isInSwitzerland([lon, lat]);
  if (!swiss) return omRequest(lat, lon, signal, null);
  try {
    return await omRequest(lat, lon, signal, CH_MODELS);
  } catch (err) {
    if (signal?.aborted) throw err;
    if (!(err instanceof MissingDataError) && !(err instanceof HttpError && err.status === 400)) throw err;
    return omRequest(lat, lon, signal, null);
  }
}

async function omRequest(lat: number, lon: number, signal: AbortSignal | undefined, models: string[] | null): Promise<WeatherDetail> {
  const params = new URLSearchParams({
    latitude: lat.toFixed(4),
    longitude: lon.toFixed(4),
    current: [...OM_VARS, 'is_day'].join(','),
    hourly: [...OM_VARS, ...HOURLY_EXTRA].join(','),
    daily: OM_DAILY.join(','),
    forecast_days: '10',
    timeformat: 'unixtime',
    timezone: 'auto',
    wind_speed_unit: 'kmh',
  });
  if (models) params.set('models', models.join(','));
  const res = await fetch(`https://api.open-meteo.com/v1/forecast?${params}`, { signal: withTimeout(signal, 15000) });
  if (!res.ok) throw new HttpError(res.status, `Open-Meteo HTTP ${res.status}`);
  const json = (await res.json()) as OmResponse | { error: true; reason: string };
  if ('error' in json) throw new HttpError(400, json.reason);
  return stampCached(parseOpenMeteoDetail(json, lat, lon, models), res);
}

const omNum = (b: OmBlock | undefined, name: string, i: number, models: string[] | null) =>
  b ? omPick(b, name, i, models).v : null;

function omHourly(r: OmResponse, k: number, models: string[] | null): HourlyPoint {
  const isDay = omNum(r.hourly, 'is_day', k, models);
  return {
    ...omSample(r.hourly, k, models),
    precipProb: omNum(r.hourly, 'precipitation_probability', k, models),
    uv: omNum(r.hourly, 'uv_index', k, models),
    isDay: isDay == null ? null : isDay > 0,
    freezingLevel: omNum(r.hourly, 'freezing_level_height', k, models),
  };
}

/** YYYY-MM-DD für einen Zeitpunkt in Ortszeit */
export function localDate(ms: number, utcOffsetSec: number): string {
  return new Date(ms + utcOffsetSec * 1000).toISOString().slice(0, 10);
}

/** Open-Meteo-Antwort (Einzelort) in WeatherDetail umwandeln (exportiert für Tests). */
export function parseOpenMeteoDetail(
  r: OmResponse,
  lat: number,
  lon: number,
  models: string[] | null,
  now = Date.now(),
): WeatherDetail {
  const times = (r.hourly.time as number[]).map((t) => t * 1000);
  const hourStart = Math.floor(now / 3600e3) * 3600e3;
  let first = times.findIndex((t) => t >= hourStart);
  if (first < 0) first = Math.max(0, times.length - 1);
  const hourly: HourlyPoint[] = [];
  for (let k = first; k < times.length && hourly.length < 48; k++) hourly.push(omHourly(r, k, models));
  if (!hourly.length || hourly[0].temp == null || omPick(r.hourly, 'temperature_2m', first, models).v == null) {
    throw new MissingDataError('Open-Meteo: keine Stundenwerte');
  }
  const h0 = hourly[0];
  const cur = r.current ? omSample(r.current, -1, models) : h0;
  if (r.current && omPick(r.current, 'temperature_2m', -1, models).v == null) {
    throw new MissingDataError('Open-Meteo: keine aktuellen Werte');
  }
  const isDayNow = r.current ? omNum(r.current, 'is_day', -1, models) : null;
  const current: HourlyPoint = {
    ...cur,
    precipProb: h0.precipProb,
    uv: h0.uv,
    isDay: isDayNow == null ? h0.isDay : isDayNow > 0,
    freezingLevel: h0.freezingLevel,
  };
  const off = r.utc_offset_seconds ?? 0;
  const daily: DailyForecast[] = [];
  const d = r.daily;
  if (d) {
    (d.time as number[]).forEach((t, i) => {
      const tMax = omNum(d, 'temperature_2m_max', i, models);
      const tMin = omNum(d, 'temperature_2m_min', i, models);
      if (tMax == null || tMin == null) return;
      const ms = (x: number | null) => (x == null ? null : x * 1000);
      daily.push({
        date: localDate(t * 1000, off),
        time: t * 1000,
        code: omNum(d, 'weather_code', i, models) ?? 3,
        tMax,
        tMin,
        precipSum: omNum(d, 'precipitation_sum', i, models),
        precipProbMax: omNum(d, 'precipitation_probability_max', i, models),
        snowfallSum: omNum(d, 'snowfall_sum', i, models),
        uvMax: omNum(d, 'uv_index_max', i, models),
        sunrise: ms(omNum(d, 'sunrise', i, models)),
        sunset: ms(omNum(d, 'sunset', i, models)),
        windMax: omNum(d, 'wind_speed_10m_max', i, models),
        gustMax: omNum(d, 'wind_gusts_10m_max', i, models),
        windDirDominant: omNum(d, 'wind_direction_10m_dominant', i, models),
      });
    });
  }
  const snowModel = omNum(r.hourly, 'snowfall_height', first, models);
  const freezing = h0.freezingLevel;
  return {
    lat,
    lon,
    elevation: r.elevation ?? null,
    timezone: r.timezone ?? null,
    utcOffsetSec: off,
    source: 'open-meteo',
    model: omModelLabel(r, models, now) ?? null,
    fetchedAt: now,
    current,
    hourly,
    daily,
    freezingLevel: freezing,
    snowLine: snowModel ?? (freezing != null ? Math.max(0, freezing - SNOWLINE_OFFSET_M) : null),
    snowLineEstimated: snowModel == null,
  };
}

// ---------------------------------------------------------------- MET Norway

interface MetDetailsExt {
  precipitation_amount?: number;
  probability_of_precipitation?: number;
  air_temperature_max?: number;
  air_temperature_min?: number;
}

async function fetchDetailMetNo(lat: number, lon: number, signal?: AbortSignal): Promise<WeatherDetail> {
  const url = `https://api.met.no/weatherapi/locationforecast/2.0/complete?lat=${lat.toFixed(4)}&lon=${lon.toFixed(4)}`;
  const res = await fetch(url, { signal: withTimeout(signal, 15000) });
  if (!res.ok) throw new HttpError(res.status, `MET Norway HTTP ${res.status}`);
  const json = (await res.json()) as MetResponse;
  return stampCached(parseMetDetail(json, lat, lon), res);
}

export interface MetResponse {
  geometry: { coordinates: [number, number, number?] };
  properties: { timeseries: MetEntry[] };
}

/** Temperaturgradient der Standardatmosphäre, K/m */
const LAPSE = 0.0065;

/** UV bei Bewölkung: MET liefert nur den Wert für wolkenlosen Himmel (Faktor nach Kasten/Czeplak). */
export function cloudyUv(uvClear: number | null, cloudPct: number | null): number | null {
  if (uvClear == null) return null;
  const n = Math.max(0, Math.min(1, (cloudPct ?? 0) / 100));
  return uvClear * (1 - 0.75 * Math.pow(n, 3.4));
}

const PRECIP_CODES = new Set([51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 68, 69, 71, 73, 75, 77, 80, 81, 82, 83, 84, 85, 86, 95, 96, 99]);

/** MET-Norway-Antwort in WeatherDetail umwandeln (exportiert für Tests). */
export function parseMetDetail(json: MetResponse, lat: number, lon: number, now = Date.now()): WeatherDetail {
  const series = json.properties.timeseries;
  const elevation = json.geometry.coordinates[2] ?? null;
  const zone = metZone(lat, lon, now);
  const off = zone.utcOffsetSec;
  const hourStart = Math.floor(now / 3600e3) * 3600e3;

  const freezingFrom = (t: number) => (elevation != null ? Math.max(0, elevation + t / LAPSE) : null);
  const toHourly = (e: MetEntry): HourlyPoint => {
    const s = metSample(e);
    const d = e.data.instant.details;
    const n1 = e.data.next_1_hours?.details as MetDetailsExt | undefined;
    const alt = sunPosition(s.time, lat, lon).altitude;
    return {
      ...s,
      precipProb: n1?.probability_of_precipitation ?? null,
      uv: cloudyUv(typeof d.ultraviolet_index_clear_sky === 'number' ? d.ultraviolet_index_clear_sky : null, s.cloud),
      isDay: alt > -0.833,
      freezingLevel: freezingFrom(s.temp),
    };
  };

  // Stundenwerte: nur die stündlichen Einträge ab der aktuellen Stunde
  const hourly: HourlyPoint[] = [];
  for (let i = 0; i < series.length && hourly.length < 48; i++) {
    const t = Date.parse(series[i].time);
    const nextT = i + 1 < series.length ? Date.parse(series[i + 1].time) : t + 3600e3;
    if (nextT - t > 3600e3) break;
    if (t >= hourStart) hourly.push(toHourly(series[i]));
  }
  if (!hourly.length) throw new Error('MET Norway: keine Stundenwerte');

  // Tage: jeder Eintrag deckt bis zum nächsten Eintrag ab (1 h oder 6 h)
  interface Acc {
    time: number;
    temps: number[];
    tMax: number;
    tMin: number;
    precip: number;
    precipKnown: boolean;
    prob: number | null;
    uv: number | null;
    wind: number | null;
    gust: number | null;
    u: number;
    v: number;
    codes: { code: number; weight: number; day: boolean }[];
  }
  const days = new Map<string, Acc>();
  for (let i = 0; i < series.length; i++) {
    const e = series[i];
    const t = Date.parse(e.time);
    const nextT = i + 1 < series.length ? Date.parse(series[i + 1].time) : t + 6 * 3600e3;
    const span = Math.round((nextT - t) / 3600e3);
    const date = localDate(t, off);
    let a = days.get(date);
    if (!a) {
      const [y, m, dd] = date.split('-').map(Number);
      a = {
        time: Date.UTC(y, m - 1, dd) - off * 1000,
        temps: [],
        tMax: -Infinity,
        tMin: Infinity,
        precip: 0,
        precipKnown: false,
        prob: null,
        uv: null,
        wind: null,
        gust: null,
        u: 0,
        v: 0,
        codes: [],
      };
      days.set(date, a);
    }
    const s = metSample(e);
    const det = e.data.instant.details;
    a.temps.push(s.temp);
    a.tMax = Math.max(a.tMax, s.temp);
    a.tMin = Math.min(a.tMin, s.temp);
    const block = (span > 1 ? e.data.next_6_hours : e.data.next_1_hours) ?? e.data.next_6_hours;
    const bd = block?.details as MetDetailsExt | undefined;
    if (bd?.air_temperature_max != null) a.tMax = Math.max(a.tMax, bd.air_temperature_max);
    if (bd?.air_temperature_min != null) a.tMin = Math.min(a.tMin, bd.air_temperature_min);
    // Niederschlag: 1-h-Werte bei stündlichen Einträgen, sonst 6-h-Block (ohne Doppelzählung)
    if (bd?.precipitation_amount != null && (span <= 1 || span >= 6)) {
      a.precip += bd.precipitation_amount;
      a.precipKnown = true;
    }
    if (bd?.probability_of_precipitation != null) a.prob = Math.max(a.prob ?? 0, bd.probability_of_precipitation);
    const uvc = typeof det.ultraviolet_index_clear_sky === 'number' ? det.ultraviolet_index_clear_sky : null;
    const uv = cloudyUv(uvc, s.cloud);
    if (uv != null) a.uv = Math.max(a.uv ?? 0, uv);
    a.wind = Math.max(a.wind ?? 0, s.windSpeed);
    if (s.windGust != null) a.gust = Math.max(a.gust ?? 0, s.windGust);
    // vorherrschende Richtung: Vektormittel, gewichtet mit Tempo und Dauer
    const rad = (s.windDir * Math.PI) / 180;
    a.u += Math.sin(rad) * s.windSpeed * span;
    a.v += Math.cos(rad) * s.windSpeed * span;
    if (block) {
      const localHour = new Date(t + off * 1000).getUTCHours();
      a.codes.push({ code: s.code, weight: span, day: localHour >= 6 && localHour < 18 });
    }
  }

  const daily: DailyForecast[] = [];
  for (const [date, a] of days) {
    if (daily.length >= 10) break;
    // erster Tag nur, wenn noch etwas davon übrig ist; Tage mit sehr wenig Daten (Ende der Reihe) weglassen
    if (a.time + 86400e3 <= now || a.temps.length < 2) continue;
    const st = sunTimes(a.time + 12 * 3600e3, lat, lon);
    const dayCodes = a.codes.filter((c) => c.day);
    const pool = dayCodes.length ? dayCodes : a.codes;
    const wet = pool.filter((c) => PRECIP_CODES.has(c.code));
    const pick = (list: typeof pool) => {
      const w = new Map<number, number>();
      for (const c of list) w.set(c.code, (w.get(c.code) ?? 0) + c.weight);
      return [...w].sort((x, y) => y[1] - x[1] || y[0] - x[0])[0]?.[0] ?? 3;
    };
    // Niederschlag gewinnt, wenn er mindestens ein Viertel des Tages betrifft
    const wetW = wet.reduce((s, c) => s + c.weight, 0);
    const allW = pool.reduce((s, c) => s + c.weight, 0) || 1;
    const code = wet.length && wetW / allW >= 0.25 ? pick(wet) : pick(pool);
    const dir = a.u === 0 && a.v === 0 ? null : ((Math.atan2(a.u, a.v) * 180) / Math.PI + 360) % 360;
    daily.push({
      date,
      time: a.time,
      code,
      tMax: a.tMax,
      tMin: a.tMin,
      precipSum: a.precipKnown ? Math.round(a.precip * 10) / 10 : null,
      precipProbMax: a.prob,
      snowfallSum: null,
      uvMax: a.uv != null ? Math.round(a.uv * 10) / 10 : null,
      sunrise: st.sunrise,
      sunset: st.sunset,
      windMax: a.wind,
      gustMax: a.gust,
      windDirDominant: dir,
    });
  }

  // aktueller Zustand: zwischen den beiden umgebenden Stunden interpoliert
  const h0 = hourly[0];
  const h1 = hourly[1] ?? h0;
  const t = h1.time > h0.time ? Math.max(0, Math.min(1, (now - h0.time) / (h1.time - h0.time))) : 0;
  const mix = (x: number | null, y: number | null) => (x == null ? y : y == null ? x : x + (y - x) * t);
  const current: HourlyPoint = {
    ...h0,
    time: now,
    temp: h0.temp + (h1.temp - h0.temp) * t,
    feelsLike: mix(h0.feelsLike, h1.feelsLike),
    humidity: mix(h0.humidity, h1.humidity),
    dewPoint: mix(h0.dewPoint, h1.dewPoint),
    pressure: mix(h0.pressure, h1.pressure),
    windSpeed: h0.windSpeed + (h1.windSpeed - h0.windSpeed) * t,
    isDay: sunPosition(now, lat, lon).altitude > -0.833,
    freezingLevel: freezingFrom(h0.temp + (h1.temp - h0.temp) * t),
  };
  const freezing = current.freezingLevel;
  return {
    lat,
    lon,
    elevation,
    timezone: zone.timezone,
    utcOffsetSec: off,
    source: 'met-no',
    model: MODEL_LABEL['met-no'],
    fetchedAt: now,
    current,
    hourly,
    daily,
    freezingLevel: freezing,
    snowLine: freezing != null ? Math.max(0, freezing - SNOWLINE_OFFSET_M) : null,
    snowLineEstimated: true,
    freezingLevelEstimated: true,
  };
}
