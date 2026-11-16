// Öffentlicher Verkehr über transport.opendata.ch (Fahrplandaten der SBB/opentransportdata.swiss).
// Liefert Reisezeit, Produkte/Umstiege und eine Linie für den Flyover aus den Haltestellen
// der Verbindung (passList). Die Linie verbindet die Halte gerade, folgt also nicht jedem
// Gleisbogen – für die Kamerafahrt reicht das.

import { haversine, type LngLat } from '../geo.ts';
import type { Place } from '../route/geocode';
import { CH_BBOX, isInSwitzerland } from './region.ts';
import { fetchJson } from './http.ts';

const API = 'https://transport.opendata.ch/v1';

interface TCoord {
  type?: string;
  /** Achtung: bei transport.opendata.ch ist x die Breite und y die Länge */
  x: number | null;
  y: number | null;
}
interface TStation {
  id: string | null;
  name: string | null;
  coordinate?: TCoord | null;
  icon?: string | null;
  distance?: number | null;
}
interface TCheckpoint {
  station?: TStation | null;
  location?: { coordinate?: TCoord | null } | null;
}
interface TSection {
  walk?: { duration?: number | null } | null;
  journey?: {
    category?: string | null;
    number?: string | null;
    passList?: TCheckpoint[];
  } | null;
  departure?: TCheckpoint | null;
  arrival?: TCheckpoint | null;
}
export interface TConnection {
  duration: string | null;
  transfers?: number | null;
  products?: string[] | null;
  from?: TCheckpoint | null;
  to?: TCheckpoint | null;
  sections?: TSection[] | null;
}
export interface TConnectionsResponse {
  connections?: TConnection[];
}

export interface TransitLeg {
  /** Reisezeit in Sekunden */
  duration: number;
  transfers: number;
  products: string[];
  /** z. B. "IR 70 · direkt" oder "IC 8 · R · 1 Umstieg" */
  detail: string;
  coords: LngLat[];
  /** Länge der Linie in m (Luftlinie zwischen den Halten, daher etwas kürzer als die Gleise) */
  distance: number;
}

/** "00d00:41:00" -> 2460 s */
export function parseTransportDuration(s: string | null | undefined): number | null {
  if (!s) return null;
  const m = /^(\d+)d(\d{1,2}):(\d{2}):(\d{2})$/.exec(s.trim());
  if (!m) return null;
  return +m[1] * 86400 + +m[2] * 3600 + +m[3] * 60 + +m[4];
}

function toLngLat(c: TCoord | null | undefined): LngLat | null {
  if (!c || c.x == null || c.y == null || !Number.isFinite(c.x) || !Number.isFinite(c.y)) return null;
  return [c.y, c.x];
}

const cpCoord = (cp: TCheckpoint | null | undefined): LngLat | null =>
  toLngLat(cp?.location?.coordinate) ?? toLngLat(cp?.station?.coordinate);

/** Linie einer Verbindung: Halte der Fahrten, Fusswege als gerade Stücke. */
export function connectionLine(c: TConnection): LngLat[] {
  const out: LngLat[] = [];
  const push = (p: LngLat | null) => {
    if (!p) return;
    const last = out[out.length - 1];
    if (!last || last[0] !== p[0] || last[1] !== p[1]) out.push(p);
  };
  for (const s of c.sections ?? []) {
    const pass = s.journey?.passList;
    if (pass?.length) {
      for (const cp of pass) push(toLngLat(cp.station?.coordinate) ?? toLngLat(cp.location?.coordinate));
    } else {
      push(cpCoord(s.departure));
      push(cpCoord(s.arrival));
    }
  }
  if (out.length < 2) {
    push(cpCoord(c.from));
    push(cpCoord(c.to));
  }
  return out;
}

export function connectionDetail(products: string[], transfers: number): string {
  const p = products.filter(Boolean).join(' · ') || 'ÖV';
  const t = transfers === 0 ? 'direkt' : transfers === 1 ? '1 Umstieg' : `${transfers} Umstiege`;
  return `${p} · ${t}`;
}

/** Verbindungen auswerten, die schnellste zurückgeben (null, wenn keine brauchbare dabei ist). */
export function bestConnection(json: TConnectionsResponse): TransitLeg | null {
  let best: TransitLeg | null = null;
  for (const c of json.connections ?? []) {
    const duration = parseTransportDuration(c.duration);
    if (duration == null || duration <= 0) continue;
    const coords = connectionLine(c);
    if (coords.length < 2) continue;
    // bei gleicher Dauer die mit weniger Umstiegen
    const transfers = c.transfers ?? 0;
    if (best && (duration > best.duration || (duration === best.duration && transfers >= best.transfers))) continue;
    let distance = 0;
    for (let i = 1; i < coords.length; i++) distance += haversine(coords[i - 1], coords[i]);
    const products = c.products ?? [];
    best = { duration, transfers, products, detail: connectionDetail(products, transfers), coords, distance };
  }
  return best;
}

/** Fahrplan gibt es für die Schweiz und grenznahe Orte (bis ~25 km über die Grenze). */
export function transitCovers(places: Place[]): boolean {
  if (places.length < 2) return false;
  const pad = 0.3;
  const near = (c: LngLat) =>
    c[0] > CH_BBOX[0] - pad && c[0] < CH_BBOX[2] + pad && c[1] > CH_BBOX[1] - pad * 0.7 && c[1] < CH_BBOX[3] + pad * 0.7;
  return places.every((p) => near(p.coord)) && places.some((p) => isInSwitzerland(p.coord));
}

const stationCache = new Map<string, Promise<string>>();

/**
 * Bezeichnung für from/to: eine nahe Bahnstation (per Namenssuche, z. B. "Luzern" -> Luzern),
 * sonst die nächste Haltestelle, sonst die Koordinate ("lat,lon", der Dienst ergänzt Fusswege).
 */
export function resolveStop(place: Place, signal?: AbortSignal): Promise<string> {
  const key = `${place.name}|${place.coord[0].toFixed(4)}|${place.coord[1].toFixed(4)}`;
  let p = stationCache.get(key);
  if (!p) {
    p = resolveStopUncached(place, signal);
    stationCache.set(key, p);
    p.catch(() => stationCache.delete(key));
  }
  return p;
}

async function resolveStopUncached(place: Place, signal?: AbortSignal): Promise<string> {
  const [lng, lat] = place.coord;
  const fallback = `${lat.toFixed(5)},${lng.toFixed(5)}`;
  if (place.kind === 'coordinate' || place.kind === 'address') return fallback;
  const byName = fetchJson<{ stations?: TStation[] }>(
    `${API}/locations?${new URLSearchParams({ query: place.name, type: 'station' })}`,
    signal,
    6000,
  ).catch(() => ({ stations: [] as TStation[] }));
  const nearby = fetchJson<{ stations?: TStation[] }>(
    `${API}/locations?x=${lat.toFixed(5)}&y=${lng.toFixed(5)}&type=station`,
    signal,
    6000,
  ).catch(() => ({ stations: [] as TStation[] }));
  const [a, b] = await Promise.all([byName, nearby]);
  const dist = (s: TStation) => {
    const c = toLngLat(s.coordinate);
    return c ? haversine(c, place.coord) : Infinity;
  };
  // 1. Bahnhof mit passendem Namen in der Nähe (Gemeinden/Orte: Mittelpunkt bis 5 km vom Bahnhof)
  const trains = (a.stations ?? []).filter((s) => s.id && s.icon === 'train' && dist(s) < 5000);
  trains.sort((x, y) => dist(x) - dist(y));
  if (trains[0]?.id) return trains[0].id;
  // 2. nächste Haltestelle (Bahn bevorzugt bis 1.5 km, sonst jede bis 1 km)
  const near = (b.stations ?? []).filter((s) => s.id);
  const train = near.find((s) => s.icon === 'train' && dist(s) < 1500);
  if (train?.id) return train.id;
  const any = near.find((s) => dist(s) < 1000);
  if (any?.id) return any.id;
  return fallback;
}

/** Eine Etappe von a nach b. */
export async function transitLeg(a: Place, b: Place, signal?: AbortSignal): Promise<TransitLeg | null> {
  const [from, to] = await Promise.all([resolveStop(a, signal), resolveStop(b, signal)]);
  const params = new URLSearchParams({ from, to, limit: '4' });
  const json = await fetchJson<TConnectionsResponse>(`${API}/connections?${params}`, signal, 12000);
  return bestConnection(json);
}

/** Ganze Route über mehrere Orte: Etappen aneinandergehängt (Wartezeiten zwischen den Etappen nicht mitgezählt). */
export async function transitRoute(places: Place[], signal?: AbortSignal): Promise<TransitLeg | null> {
  const legs = await Promise.all(places.slice(0, -1).map((p, i) => transitLeg(p, places[i + 1], signal)));
  if (legs.some((l) => !l)) return null;
  const ok = legs as TransitLeg[];
  const coords: LngLat[] = [];
  for (const leg of ok) {
    for (const c of leg.coords) {
      const last = coords[coords.length - 1];
      if (!last || last[0] !== c[0] || last[1] !== c[1]) coords.push(c);
    }
  }
  return {
    duration: ok.reduce((s, l) => s + l.duration, 0),
    transfers: ok.reduce((s, l) => s + l.transfers, 0) + ok.length - 1,
    products: ok.flatMap((l) => l.products),
    detail: ok.map((l) => l.detail).join(' | '),
    coords,
    distance: ok.reduce((s, l) => s + l.distance, 0),
  };
}
