// Routen berechnen: OSRM (FOSSGIS-Server für Velo, Fuss, Auto), Flug als Grosskreis.

import { greatCircle, haversine, Polyline, type LngLat } from '../geo';
import { withTimeout, type Place } from './geocode';

export type Profile = 'bike' | 'foot' | 'car' | 'flight';

export const PROFILE_LABEL: Record<Profile, string> = {
  bike: 'Velo',
  foot: 'Zu Fuss',
  car: 'Auto',
  flight: 'Flug',
};

export interface Route {
  line: Polyline;
  profile: Profile;
  /** geschätzte Reisezeit in Sekunden */
  duration: number;
  waypoints: Place[];
  note?: string;
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
  return { line, profile: 'flight', duration, waypoints, note };
}

interface OsrmResponse {
  code: string;
  message?: string;
  routes?: { geometry: { coordinates: LngLat[] }; duration: number; distance: number }[];
}

async function osrm(base: string, coords: LngLat[], signal?: AbortSignal): Promise<{ coords: LngLat[]; duration: number }> {
  // ";" kodiert: manche Proxys lehnen Pfade mit Matrix-Parameter-Trenner ab, OSRM dekodiert ihn
  const path = coords.map((c) => `${c[0].toFixed(5)},${c[1].toFixed(5)}`).join('%3B');
  const res = await fetch(`${base}/route/v1/driving/${path}?overview=full&geometries=geojson&steps=false`, {
    signal: withTimeout(signal, 20000),
  });
  if (!res.ok) throw new Error(`Routing HTTP ${res.status}`);
  const json = (await res.json()) as OsrmResponse;
  if (json.code !== 'Ok' || !json.routes?.length) throw new Error(json.message ?? json.code);
  const r = json.routes[0];
  return { coords: r.geometry.coordinates, duration: r.duration };
}

const OSRM_BASE: Record<Exclude<Profile, 'flight'>, string[]> = {
  bike: ['https://routing.openstreetmap.de/routed-bike'],
  foot: ['https://routing.openstreetmap.de/routed-foot'],
  car: ['https://routing.openstreetmap.de/routed-car', 'https://router.project-osrm.org'],
};

/** Grenze, ab der Velo/Fuss nicht mehr sinnvoll sind (Luftlinie). */
const MAX_DIRECT_KM: Record<Exclude<Profile, 'flight'>, number> = { foot: 250, bike: 900, car: 4000 };

export async function computeRoute(waypoints: Place[], profile: Profile, signal?: AbortSignal): Promise<Route> {
  if (waypoints.length < 2) throw new Error('Mindestens zwei Orte nötig');
  if (profile === 'flight') return flightRoute(waypoints);

  let direct = 0;
  for (let i = 0; i < waypoints.length - 1; i++) direct += haversine(waypoints[i].coord, waypoints[i + 1].coord);
  if (direct / 1000 > MAX_DIRECT_KM[profile]) {
    return flightRoute(
      waypoints,
      `${Math.round(direct / 1000).toLocaleString('de-CH')} km Luftlinie sind für „${PROFILE_LABEL[profile]}“ zu weit, gezeigt wird die Fluglinie.`,
    );
  }

  let lastErr: unknown;
  for (const base of OSRM_BASE[profile]) {
    try {
      const r = await osrm(
        base,
        waypoints.map((w) => w.coord),
        signal,
      );
      return { line: new Polyline(r.coords), profile, duration: r.duration, waypoints };
    } catch (err) {
      if (signal?.aborted) throw err;
      lastErr = err;
    }
  }
  console.warn('Routing fehlgeschlagen:', lastErr);
  return flightRoute(waypoints, 'Keine Strassenroute gefunden, gezeigt wird die Luftlinie.');
}
