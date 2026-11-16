// Eine "Reise": ein Ort (Orbit) oder eine Route (Flyover) samt Wetter und Höhenprofil.

import { haversine, Polyline, type LngLat } from './geo';
import type { Place } from './route/geocode';
import { computeRoute, type Profile, type Route } from './route/routing';
import { climbStats, routeElevations, type ElevationSource } from './route/elevation';
import { fetchWeather, lerpSample, sampleAt } from './weather/fetch';
import type { PointWeather, WeatherSample, WeatherSource } from './weather/types';

export interface WeatherStop {
  dist: number;
  point: LngLat;
  weather: PointWeather;
}

export interface Trip {
  kind: 'point' | 'route';
  places: Place[];
  route: Route | null;
  line: Polyline | null;
  /** Wetter-Stützpunkte entlang der Strecke (bei einem Ort genau einer) */
  stops: WeatherStop[];
  source: WeatherSource;
  note?: string;
  /** Höhenprofil, Distanz in m */
  profile: { dist: number; ele: number }[];
  gain: number;
  loss: number;
  /** Herkunft des Höhenprofils: swisstopo (Strecke ganz in der Schweiz) oder Terrarium-Kacheln */
  elevationSource?: ElevationSource;
  /** kumulierte Mercator-Längen, für "line-progress" */
  mercCum: Float64Array | null;
}

function mercatorCum(line: Polyline): Float64Array {
  const toM = ([lng, lat]: LngLat): [number, number] => {
    const x = (lng + 180) / 360;
    const s = Math.sin((Math.max(-85, Math.min(85, lat)) * Math.PI) / 180);
    const y = 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
    return [x, y];
  };
  const out = new Float64Array(line.coords.length);
  let prev = toM(line.coords[0]);
  for (let i = 1; i < line.coords.length; i++) {
    const cur = toM(line.coords[i]);
    out[i] = out[i - 1] + Math.hypot(cur[0] - prev[0], cur[1] - prev[1]);
    prev = cur;
  }
  return out;
}

/** Distanz (m) in den "line-progress"-Wert der Linie umrechnen. */
export function lineProgress(trip: Trip, dist: number): number {
  const line = trip.line;
  const mc = trip.mercCum;
  if (!line || !mc) return 1;
  const cum = line.cum;
  const d = Math.max(0, Math.min(line.length, dist));
  let lo = 0;
  let hi = cum.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] <= d) lo = mid;
    else hi = mid;
  }
  const seg = cum[hi] - cum[lo] || 1;
  const t = (d - cum[lo]) / seg;
  const total = mc[mc.length - 1] || 1;
  return (mc[lo] + (mc[hi] - mc[lo]) * t) / total;
}

export async function buildTrip(
  places: Place[],
  profile: Profile,
  signal?: AbortSignal,
  onStage?: (stage: string) => void,
): Promise<Trip> {
  if (places.length === 1) {
    onStage?.('Live-Wetter laden …');
    const p = places[0];
    const w = await fetchWeather([{ lat: p.coord[1], lon: p.coord[0] }], signal);
    return {
      kind: 'point',
      places,
      route: null,
      line: null,
      stops: [{ dist: 0, point: p.coord, weather: w.points[0] }],
      source: w.source,
      note: w.note,
      profile: [],
      gain: 0,
      loss: 0,
      mercCum: null,
    };
  }

  onStage?.('Route berechnen …');
  const route = await computeRoute(places, profile, signal);
  const line = route.line;
  const km = line.length / 1000;

  // Wetter-Stützpunkte: etwa alle 8–40 km, mindestens 3, höchstens 24
  const nStops = Math.max(3, Math.min(24, Math.round(km / Math.max(8, km / 24)) + 1));
  const stopsRaw = line.sample(nStops);
  onStage?.(`Live-Wetter an ${nStops} Punkten laden …`);
  const weatherP = fetchWeather(
    stopsRaw.map((s) => ({ lat: s.point[1], lon: s.point[0] })),
    signal,
  );

  // Höhenprofil parallel
  const nProfile = Math.max(40, Math.min(240, Math.round(km * 4)));
  const profPts = line.sample(nProfile);
  const elevP: Promise<{ ele: number[]; source: ElevationSource | undefined }> = routeElevations(
    profPts.map((p) => p.point),
    signal,
  ).catch((err) => {
    if (signal?.aborted) throw err;
    return { ele: profPts.map(() => 0), source: undefined };
  });

  const [w, { ele, source: elevationSource }] = await Promise.all([weatherP, elevP]);
  // für die Anzeige leicht glätten (Kachelrauschen, Brücken)
  const smooth = ele.map((_, i) => {
    let s = 0;
    let n = 0;
    for (let j = Math.max(0, i - 1); j <= Math.min(ele.length - 1, i + 1); j++) {
      s += ele[j];
      n++;
    }
    return s / n;
  });
  // Anstieg mit Hysterese (7 m) statt jede Differenz aufzusummieren. swisstopo-Höhen
  // (swissALTI3D) sind kaum verrauscht und werden ungeglättet ausgewertet, Terrarium geglättet.
  const { gain, loss } = climbStats(elevationSource === 'swisstopo' ? ele : smooth);
  return {
    kind: 'route',
    places,
    route,
    line,
    stops: stopsRaw.map((s, i) => ({ dist: s.dist, point: s.point, weather: w.points[i] })),
    source: w.source,
    note: [route.note, w.note].filter(Boolean).join(' ') || undefined,
    profile: profPts.map((p, i) => ({ dist: p.dist, ele: smooth[i] })),
    gain: route.profile === 'flight' ? 0 : gain,
    loss: route.profile === 'flight' ? 0 : loss,
    elevationSource,
    mercCum: mercatorCum(line),
  };
}

export interface WeatherHere {
  sample: WeatherSample;
  lat: number;
  lon: number;
  stop: WeatherStop;
}

/** Wetter an einer Stelle der Route zu einer Zeit (räumlich und zeitlich interpoliert). */
export function weatherAt(trip: Trip, dist: number, time: number, live: boolean): WeatherHere {
  const stops = trip.stops;
  if (stops.length === 1 || !trip.line) {
    const s = stops[0];
    return { sample: sampleAt(s.weather, time, live), lat: s.point[1], lon: s.point[0], stop: s };
  }
  let i = 0;
  while (i < stops.length - 2 && stops[i + 1].dist < dist) i++;
  const a = stops[i];
  const b = stops[i + 1];
  const t = Math.max(0, Math.min(1, (dist - a.dist) / (b.dist - a.dist || 1)));
  const sa = sampleAt(a.weather, time, live);
  const sb = sampleAt(b.weather, time, live);
  const p = trip.line.pointAt(dist);
  return { sample: lerpSample(sa, sb, t), lat: p[1], lon: p[0], stop: t < 0.5 ? a : b };
}

export function tripLength(trip: Trip): number {
  return trip.line?.length ?? 0;
}

export function nearestStop(trip: Trip, coord: LngLat): WeatherStop {
  let best = trip.stops[0];
  let bd = Infinity;
  for (const s of trip.stops) {
    const d = haversine(s.point, coord);
    if (d < bd) {
      bd = d;
      best = s;
    }
  }
  return best;
}
