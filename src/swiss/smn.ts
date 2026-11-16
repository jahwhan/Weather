// Aktuelle Messwerte des SwissMetNet (MeteoSchweiz, Open Government Data über data.geo.admin.ch).
//
// Hauptquelle ist die Sammeldatei VQHA80.csv (~16 KB, alle Stationen und Grössen, alle 10 min),
// dazu das Stationsverzeichnis (CSV, Latin-1) mit Koordinaten und Höhe. Fällt VQHA80 aus,
// werden die GeoJSON-Datensätze je Messgrösse geladen (je ~150 KB; Temperatur ist Pflicht,
// die anderen werden parallel und fehlertolerant geholt).

import { haversine, type LngLat } from '../geo.ts';
import type { WeatherSample } from '../weather/types';
import { fetchJson, withTimeout } from './http.ts';
import { lv95ToWgs84 } from './lv95.ts';

const BASE = 'https://data.geo.admin.ch';
export const VQHA80_URL = `${BASE}/ch.meteoschweiz.messwerte-aktuell/VQHA80.csv`;
export const STATIONS_URL = `${BASE}/ch.meteoschweiz.messnetz-automatisch/ch.meteoschweiz.messnetz-automatisch_de.csv`;
const geojsonUrl = (id: string) => `${BASE}/ch.meteoschweiz.messwerte-${id}/ch.meteoschweiz.messwerte-${id}_de.json`;

export interface StationObs {
  id: string;
  name: string;
  lat: number;
  lon: number;
  elevation: number | null;
  /** Messzeit, ms UTC */
  time: number;
  /** Abstand zum gefragten Ort in m (bei parseObservations 0) */
  distanceM: number;
  /** °C */
  temp: number | null;
  /** % */
  humidity: number | null;
  /** mm in 10 min */
  precip10min: number | null;
  /** km/h, 10-min-Mittel */
  windSpeed: number | null;
  /** km/h, Böenspitze */
  windGust: number | null;
  /** Grad, aus der der Wind kommt */
  windDir: number | null;
  /** hPa, auf Meereshöhe reduziert (QFF) */
  pressureQff: number | null;
  /** min Sonnenschein in 10 min */
  sunshine10min: number | null;
}

export interface StationMeta {
  id: string;
  name: string;
  lat: number;
  lon: number;
  elevation: number | null;
}

const num = (s: string | undefined | null): number | null => {
  if (s == null) return null;
  const t = String(s).trim().replace(/^"|"$/g, '');
  if (t === '' || t === '-') return null;
  const v = Number(t);
  // MeteoSchweiz kennzeichnet fehlende Werte teils mit 99999
  return Number.isFinite(v) && Math.abs(v) < 9999 ? v : null;
};

/** CSV-Zeile mit ";" und optionalen Anführungszeichen zerlegen. */
function splitCsv(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (q && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else q = !q;
    } else if (ch === ';' && !q) {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

/** "202611161110" (UTC) -> ms */
export function parseSmnTime(s: string): number {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(s.trim());
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) : NaN;
}

/** Stationsverzeichnis (CSV) lesen. */
export function parseStationsCsv(text: string): Map<string, StationMeta> {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  const out = new Map<string, StationMeta>();
  if (!lines.length) return out;
  const head = splitCsv(lines[0]).map((h) => h.trim());
  const col = (re: RegExp) => head.findIndex((h) => re.test(h));
  const iName = col(/^Station$/);
  const iId = col(/^Abk/);
  const iAlt = col(/^Stationsh/);
  const iLat = col(/^Breitengrad/);
  const iLon = col(/^L.ngengrad/);
  const iE = col(/^KoordinatenE/);
  const iN = col(/^KoordinatenN/);
  for (const line of lines.slice(1)) {
    const c = splitCsv(line);
    const id = c[iId]?.trim();
    if (!id || c.length < head.length - 2) continue;
    let lat = num(c[iLat]);
    let lon = num(c[iLon]);
    if ((lat == null || lon == null) && iE >= 0 && iN >= 0) {
      const E = Number(c[iE]);
      const N = Number(c[iN]);
      if (Number.isFinite(E) && Number.isFinite(N)) [lon, lat] = lv95ToWgs84([E, N]);
    }
    if (lat == null || lon == null) continue;
    out.set(id, { id, name: c[iName]?.trim() || id, lat, lon, elevation: num(c[iAlt]) });
  }
  return out;
}

/** VQHA80.csv mit dem Stationsverzeichnis zu Messungen verbinden. */
export function parseVqha80(text: string, stations: Map<string, StationMeta>): StationObs[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return [];
  const head = lines[0].split(';').map((h) => h.trim());
  const at = (k: string) => head.indexOf(k);
  const idx = {
    id: 0,
    time: at('Date') >= 0 ? at('Date') : 1,
    temp: at('tre200s0'),
    precip: at('rre150z0'),
    sun: at('sre000z0'),
    hum: at('ure200s0'),
    dir: at('dkl010z0'),
    wind: at('fu3010z0'),
    gust: at('fu3010z1'),
    qff: at('pp0qffs0'),
  };
  const out: StationObs[] = [];
  for (const line of lines.slice(1)) {
    const c = line.split(';');
    const meta = stations.get(c[idx.id]?.trim());
    if (!meta) continue;
    const time = parseSmnTime(c[idx.time] ?? '');
    if (!Number.isFinite(time)) continue;
    const v = (i: number) => (i >= 0 ? num(c[i]) : null);
    out.push({
      ...meta,
      time,
      distanceM: 0,
      temp: v(idx.temp),
      humidity: v(idx.hum),
      precip10min: v(idx.precip),
      windSpeed: v(idx.wind),
      windGust: v(idx.gust),
      windDir: v(idx.dir),
      pressureQff: v(idx.qff),
      sunshine10min: v(idx.sun),
    });
  }
  return out;
}

// ---------------------------------------------------------------- GeoJSON-Rückfall

interface SmnFeature {
  id: string;
  geometry: { coordinates: [number, number] };
  properties: {
    station_name?: string;
    value?: number | string | null;
    wind_direction?: number | null;
    reference_ts?: string;
    altitude?: string | number;
  };
}
export interface SmnCollection {
  features?: SmnFeature[];
}

type ObsField = 'temp' | 'humidity' | 'precip10min' | 'windSpeed' | 'windGust' | 'pressureQff' | 'sunshine10min';

/** Datensatz-IDs der Einzel-GeoJSONs (live geprüft 2026-11). */
export const SMN_DATASETS: Record<ObsField, string> = {
  temp: 'lufttemperatur-10min',
  humidity: 'luftfeuchtigkeit-10min',
  precip10min: 'niederschlag-10min',
  windSpeed: 'windgeschwindigkeit-kmh-10min',
  windGust: 'wind-boeenspitze-kmh-10min',
  pressureQff: 'luftdruck-qff-10min',
  sunshine10min: 'sonnenscheindauer-10min',
};

/** Mehrere GeoJSON-Datensätze zu Messungen zusammenführen (Temperatur bestimmt die Stationsliste). */
export function parseSmnGeojson(sets: Partial<Record<ObsField, SmnCollection>>): StationObs[] {
  const base = sets.temp?.features ?? [];
  const lookup = (f: ObsField) => {
    const m = new Map<string, SmnFeature>();
    for (const x of sets[f]?.features ?? []) m.set(x.id, x);
    return m;
  };
  const maps = Object.fromEntries((Object.keys(SMN_DATASETS) as ObsField[]).map((f) => [f, lookup(f)])) as Record<
    ObsField,
    Map<string, SmnFeature>
  >;
  const out: StationObs[] = [];
  for (const f of base) {
    const [lon, lat] = lv95ToWgs84(f.geometry.coordinates);
    const time = Date.parse(f.properties.reference_ts ?? '');
    if (!Number.isFinite(time)) continue;
    const val = (field: ObsField) => num(maps[field].get(f.id)?.properties.value as string | undefined);
    const wind = maps.windSpeed.get(f.id) ?? maps.windGust.get(f.id);
    out.push({
      id: f.id,
      name: f.properties.station_name ?? f.id,
      lat,
      lon,
      elevation: num(String(f.properties.altitude ?? '').replace(/\s*m$/, '')),
      time,
      distanceM: 0,
      temp: val('temp'),
      humidity: val('humidity'),
      precip10min: val('precip10min'),
      windSpeed: val('windSpeed'),
      windGust: val('windGust'),
      windDir: num(wind?.properties.wind_direction as unknown as string),
      pressureQff: val('pressureQff'),
      sunshine10min: val('sunshine10min'),
    });
  }
  return out;
}

// ---------------------------------------------------------------- Laden und Auswahl

const CACHE_MS = 10 * 60 * 1000;
const META_KEY = 'wetterflug.smn-stations.v1';
const META_MAX_AGE = 7 * 24 * 3600 * 1000;
let obsCache: { at: number; data: Promise<StationObs[]> } | null = null;
let metaCache: Promise<Map<string, StationMeta>> | null = null;

async function fetchText(url: string, signal: AbortSignal | undefined, ms: number, encoding = 'utf-8'): Promise<string> {
  const res = await fetch(url, { signal: withTimeout(signal, ms) });
  if (!res.ok) throw new Error(`HTTP ${res.status} für ${url}`);
  return new TextDecoder(encoding).decode(await res.arrayBuffer());
}

function loadStations(signal?: AbortSignal): Promise<Map<string, StationMeta>> {
  if (metaCache) return metaCache;
  metaCache = (async () => {
    try {
      const raw = JSON.parse(localStorage.getItem(META_KEY) ?? 'null') as { at: number; list: StationMeta[] } | null;
      if (raw && Date.now() - raw.at < META_MAX_AGE && raw.list.length > 50) {
        return new Map(raw.list.map((s) => [s.id, s]));
      }
    } catch {
      /* kein localStorage */
    }
    // Stationsverzeichnis ist Latin-1 kodiert
    const map = parseStationsCsv(await fetchText(STATIONS_URL, signal, 8000, 'iso-8859-1'));
    if (map.size < 50) throw new Error('SMN-Stationsverzeichnis unvollständig');
    try {
      localStorage.setItem(META_KEY, JSON.stringify({ at: Date.now(), list: [...map.values()] }));
    } catch {
      /* Speicher voll oder gesperrt */
    }
    return map;
  })();
  metaCache.catch(() => (metaCache = null));
  return metaCache;
}

async function loadFromCsv(signal?: AbortSignal): Promise<StationObs[]> {
  const [stations, text] = await Promise.all([loadStations(signal), fetchText(VQHA80_URL, signal, 6000, 'iso-8859-1')]);
  const obs = parseVqha80(text, stations);
  if (obs.length < 50) throw new Error('VQHA80 unvollständig');
  return obs;
}

async function loadFromGeojson(signal?: AbortSignal): Promise<StationObs[]> {
  const fields = Object.keys(SMN_DATASETS) as ObsField[];
  const results = await Promise.allSettled(
    fields.map((f) => fetchJson<SmnCollection>(geojsonUrl(SMN_DATASETS[f]), signal, f === 'temp' ? 10000 : 8000)),
  );
  const sets: Partial<Record<ObsField, SmnCollection>> = {};
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') sets[fields[i]] = r.value;
  });
  if (!sets.temp) throw new Error('SMN-Temperaturdatensatz nicht verfügbar');
  return parseSmnGeojson(sets);
}

/** Alle aktuellen Messungen (10 min im Speicher gehalten). */
export function loadObservations(signal?: AbortSignal): Promise<StationObs[]> {
  if (obsCache && Date.now() - obsCache.at < CACHE_MS) return obsCache.data;
  const data = loadFromCsv(signal).catch((err) => {
    if (signal?.aborted) throw err;
    console.warn('VQHA80 nicht verfügbar, lade GeoJSON-Datensätze:', err);
    return loadFromGeojson(signal);
  });
  obsCache = { at: Date.now(), data };
  data.catch(() => (obsCache = null));
  return data;
}

/**
 * Nächste Station mit Temperaturmessung. Mit `targetElevation` zählt ein Höhenunterschied
 * wie zusätzliche Distanz (100 m Höhe ~ 2 km), damit im Gebirge nicht die Talstation gewinnt.
 */
export function pickNearest(
  obs: StationObs[],
  lat: number,
  lon: number,
  opts: { maxKm?: number; targetElevation?: number | null } = {},
): StationObs | null {
  const maxM = (opts.maxKm ?? 25) * 1000;
  const here: LngLat = [lon, lat];
  let best: StationObs | null = null;
  let bestScore = Infinity;
  for (const o of obs) {
    if (o.temp == null) continue;
    const d = haversine(here, [o.lon, o.lat]);
    if (d > maxM) continue;
    const dz = opts.targetElevation != null && o.elevation != null ? Math.abs(opts.targetElevation - o.elevation) : 0;
    const score = d + dz * 20;
    if (score < bestScore) {
      bestScore = score;
      best = { ...o, distanceM: d };
    }
  }
  return best;
}

export async function nearestStation(
  lat: number,
  lon: number,
  opts: { maxKm?: number; signal?: AbortSignal; targetElevation?: number | null } = {},
): Promise<StationObs | null> {
  const obs = await loadObservations(opts.signal);
  return pickNearest(obs, lat, lon, opts);
}

/** Schwellen für die Übernahme einer Messung in den "jetzt"-Zustand. */
export const OBS_MAX_DISTANCE_M = 8000;
export const OBS_MAX_ELEVATION_DIFF_M = 150;
export const OBS_MAX_AGE_MS = 40 * 60 * 1000;

/** Messung ist nah (< 8 km), auf ähnlicher Höhe (< 150 m) und jünger als 40 min. */
export function shouldUseObservation(obs: StationObs, targetElevation: number | null, now = Date.now()): boolean {
  if (obs.temp == null) return false;
  if (!(obs.distanceM < OBS_MAX_DISTANCE_M)) return false;
  if (now - obs.time > OBS_MAX_AGE_MS || obs.time - now > 15 * 60 * 1000) return false;
  if (targetElevation != null && obs.elevation != null && Math.abs(targetElevation - obs.elevation) >= OBS_MAX_ELEVATION_DIFF_M) {
    return false;
  }
  return true;
}

/** Magnus-Formel: Taupunkt aus Temperatur und Feuchte. */
function dewPoint(t: number, rh: number): number {
  const a = 17.62;
  const b = 243.12;
  const g = Math.log(Math.max(1, rh) / 100) + (a * t) / (b + t);
  return (b * g) / (a - g);
}

/**
 * Messwerte in den "jetzt"-Zustand übernehmen (Temperatur, Feuchte, Taupunkt, Wind, Druck);
 * Bewölkung, Wettercode, Strahlung usw. bleiben vom Modell. Die gefühlte Temperatur wird um
 * die Temperaturdifferenz verschoben.
 */
export function applyObservation(sample: WeatherSample, obs: StationObs): WeatherSample {
  const out: WeatherSample = { ...sample };
  if (obs.temp != null) {
    const dt = obs.temp - sample.temp;
    out.temp = obs.temp;
    if (sample.feelsLike != null) out.feelsLike = sample.feelsLike + dt;
  }
  if (obs.humidity != null) out.humidity = obs.humidity;
  if (obs.temp != null && obs.humidity != null) out.dewPoint = dewPoint(obs.temp, obs.humidity);
  if (obs.windSpeed != null) out.windSpeed = obs.windSpeed;
  if (obs.windDir != null) out.windDir = obs.windDir;
  if (obs.windGust != null) out.windGust = obs.windGust;
  if (obs.pressureQff != null) out.pressure = obs.pressureQff;
  // 10-min-Summe -> mm/h, nur wenn es tatsächlich regnet (sonst Modellwert behalten)
  if (obs.precip10min != null && obs.precip10min > 0) out.precip = obs.precip10min * 6;
  return out;
}
