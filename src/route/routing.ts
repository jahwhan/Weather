// Routen berechnen: OSRM (FOSSGIS-Server für Auto, Velo, Fuss), ÖV über transport.opendata.ch,
// Flug als Grosskreis. Ergebnisse werden pro Modus und Wegpunkten gemerkt, damit ein
// Modusvergleich (modes.ts) und die anschliessende Route nicht doppelt laden.

import { greatCircle, haversine, Polyline, type LngLat } from '../geo.ts';
import type { Place } from './geocode';
import { withTimeout } from '../swiss/http.ts';
import { transitCovers, transitRoute } from '../swiss/transit.ts';

export type Profile = 'car' | 'transit' | 'bike' | 'foot' | 'flight';

export const PROFILE_LABEL: Record<Profile, string> = {
  car: 'Auto',
  transit: 'ÖV',
  bike: 'Velo',
  foot: 'Zu Fuss',
  flight: 'Flug',
};

export const DEFAULT_PROFILE: Profile = 'car';

export interface Route {
  line: Polyline;
  profile: Profile;
  /** geschätzte Reisezeit in Sekunden */
  duration: number;
  waypoints: Place[];
  note?: string;
  /** Distanz laut Routendienst in m (sonst Länge der Linie) */
  distance?: number;
  /** Zusatz wie "IR 70 · direkt" (ÖV) */
  detail?: string;
}

const FLIGHT_KMH = 820;

function flightRoute(waypoints: Place[], note?: string): Route {
  const coords: LngLat[] = [];
  for (let i = 0; i < waypoints.length - 1; i++) {
    const seg = greatCircle(waypoints[i].coord, waypoints[i + 1].coord, 96);
    if (i > 0) seg.shift();
    coords.push(...seg);
  }
  const line = new Polyline(coords);
  // Rollen, Steigen, Sinken: pauschal 30 min pro Etappe
  const duration = (line.length / 1000 / FLIGHT_KMH) * 3600 + 1800 * (waypoints.length - 1);
  return { line, profile: 'flight', duration, waypoints, note, distance: line.length };
}

interface OsrmResponse {
  code: string;
  message?: string;
  routes?: { geometry: { coordinates: LngLat[] }; duration: number; distance: number }[];
}

async function osrm(
  base: string,
  coords: LngLat[],
  signal?: AbortSignal,
): Promise<{ coords: LngLat[]; duration: number; distance: number }> {
  // ";" kodiert: manche Proxys lehnen Pfade mit Matrix-Parameter-Trenner ab, OSRM dekodiert ihn
  const path = coords.map((c) => `${c[0].toFixed(5)},${c[1].toFixed(5)}`).join('%3B');
  const res = await fetch(`${base}/route/v1/driving/${path}?overview=full&geometries=geojson&steps=false`, {
    signal: withTimeout(signal, 20000),
  });
  if (!res.ok) throw new Error(`Routing HTTP ${res.status}`);
  const json = (await res.json()) as OsrmResponse;
  if (json.code !== 'Ok' || !json.routes?.length) throw new Error(json.message ?? json.code);
  const r = json.routes[0];
  return { coords: r.geometry.coordinates, duration: r.duration, distance: r.distance };
}

type RoadProfile = 'car' | 'bike' | 'foot';

const OSRM_BASE: Record<RoadProfile, string[]> = {
  bike: ['https://routing.openstreetmap.de/routed-bike'],
  foot: ['https://routing.openstreetmap.de/routed-foot'],
  car: ['https://routing.openstreetmap.de/routed-car', 'https://router.project-osrm.org'],
};

/** Grenze, ab der ein Modus nicht mehr sinnvoll ist (Luftlinie, km). */
const MAX_DIRECT_KM: Record<RoadProfile | 'transit', number> = { foot: 250, bike: 900, car: 4000, transit: 600 };

/**
 * Plausible Geschwindigkeiten (km/h). Liegt die OSRM-Dauer ausserhalb, wird mit der typischen
 * Geschwindigkeit neu geschätzt (FOSSGIS-Profile: Velo ~15 km/h, Fuss ~4.5 km/h, gemessen 2026-11).
 */
export const SPEED_RANGE: Record<'bike' | 'foot', { min: number; max: number; typical: number }> = {
  bike: { min: 10, max: 25, typical: 16 },
  foot: { min: 3, max: 6, typical: 4.7 },
};

/** Dauer prüfen und wenn nötig aus der Distanz neu schätzen. */
export function plausibleDuration(profile: Profile, duration: number, distance: number): number {
  if (profile !== 'bike' && profile !== 'foot') return duration;
  const r = SPEED_RANGE[profile];
  if (!(duration > 0) || !(distance > 0)) return (distance / 1000 / r.typical) * 3600;
  const kmh = distance / 1000 / (duration / 3600);
  if (kmh < r.min || kmh > r.max) return (distance / 1000 / r.typical) * 3600;
  return duration;
}

export function directDistance(waypoints: Place[]): number {
  let d = 0;
  for (let i = 0; i < waypoints.length - 1; i++) d += haversine(waypoints[i].coord, waypoints[i + 1].coord);
  return d;
}

export type RouteStatus = 'ok' | 'unavailable' | 'error';
export interface RouteAttempt {
  status: RouteStatus;
  route: Route | null;
  reason?: string;
}

const attempts = new Map<string, Promise<RouteAttempt>>();
const keyOf = (waypoints: Place[], profile: Profile) =>
  `${profile}|${waypoints.map((w) => `${w.coord[0].toFixed(5)},${w.coord[1].toFixed(5)}`).join(';')}`;

/**
 * Route für genau diesen Modus, ohne Ausweichen auf andere Modi. Gemerkt pro Modus und
 * Wegpunkten; Fehler und Abbrüche werden nicht gemerkt.
 */
export function tryRoute(waypoints: Place[], profile: Profile, signal?: AbortSignal): Promise<RouteAttempt> {
  const key = keyOf(waypoints, profile);
  let p = attempts.get(key);
  if (!p) {
    p = tryRouteUncached(waypoints, profile, signal);
    attempts.set(key, p);
    p.then(
      (r) => r.status === 'error' && attempts.delete(key),
      () => attempts.delete(key),
    );
    if (attempts.size > 60) attempts.delete(attempts.keys().next().value!);
  }
  return p;
}

async function tryRouteUncached(waypoints: Place[], profile: Profile, signal?: AbortSignal): Promise<RouteAttempt> {
  if (profile === 'flight') return { status: 'ok', route: flightRoute(waypoints) };
  const direct = directDistance(waypoints) / 1000;
  if (direct > MAX_DIRECT_KM[profile]) {
    return { status: 'unavailable', route: null, reason: `${Math.round(direct).toLocaleString('de-CH')} km Luftlinie` };
  }
  if (profile === 'transit') {
    if (!transitCovers(waypoints)) return { status: 'unavailable', route: null, reason: 'Fahrplan nur für die Schweiz' };
    try {
      const t = await transitRoute(waypoints, signal);
      if (!t) return { status: 'unavailable', route: null, reason: 'Keine Verbindung gefunden' };
      return {
        status: 'ok',
        route: {
          line: new Polyline(t.coords),
          profile,
          duration: t.duration,
          waypoints,
          distance: t.distance,
          detail: t.detail,
        },
      };
    } catch (err) {
      if (signal?.aborted) throw err;
      return { status: 'error', route: null, reason: String(err) };
    }
  }
  let lastErr: unknown;
  for (const base of OSRM_BASE[profile]) {
    try {
      const r = await osrm(
        base,
        waypoints.map((w) => w.coord),
        signal,
      );
      return {
        status: 'ok',
        route: {
          line: new Polyline(r.coords),
          profile,
          duration: plausibleDuration(profile, r.duration, r.distance),
          waypoints,
          distance: r.distance,
        },
      };
    } catch (err) {
      if (signal?.aborted) throw err;
      lastErr = err;
    }
  }
  return { status: 'error', route: null, reason: String(lastErr) };
}

export async function computeRoute(waypoints: Place[], profile: Profile, signal?: AbortSignal): Promise<Route> {
  if (waypoints.length < 2) throw new Error('Mindestens zwei Orte nötig');
  if (profile === 'flight') return flightRoute(waypoints);

  const a = await tryRoute(waypoints, profile, signal);
  if (a.route) return a.route;

  if (profile === 'transit') {
    // ohne Fahrplan wenigstens die Strasse zeigen
    const car = await computeRoute(waypoints, 'car', signal);
    const why = a.status === 'unavailable' && a.reason === 'Fahrplan nur für die Schweiz'
      ? 'ÖV-Fahrplan gibt es nur für die Schweiz und grenznahe Orte'
      : 'Keine ÖV-Verbindung gefunden';
    return { ...car, note: [`${why}, gezeigt wird die Strassenroute.`, car.note].filter(Boolean).join(' ') };
  }
  if (a.status === 'unavailable') {
    return flightRoute(
      waypoints,
      `${a.reason} sind für „${PROFILE_LABEL[profile]}“ zu weit, gezeigt wird die Fluglinie.`,
    );
  }
  console.warn('Routing fehlgeschlagen:', a.reason);
  return flightRoute(waypoints, 'Keine Strassenroute gefunden, gezeigt wird die Luftlinie.');
}
