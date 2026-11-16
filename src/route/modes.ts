// Reisemodi vergleichen: Auto, ÖV, Velo, zu Fuss – Dauer und Distanz für dieselben Orte.
// Die Routen landen im Zwischenspeicher von routing.ts, ein anschliessendes computeRoute
// für den gewählten Modus lädt nichts nach.

import type { Place } from './geocode';
import { directDistance, tryRoute, type Profile } from './routing.ts';
import { withTimeout } from '../swiss/http.ts';
import { transitCovers } from '../swiss/transit.ts';

export interface ModeEstimate {
  profile: Profile;
  /** Sekunden */
  duration: number | null;
  /** Meter */
  distance: number | null;
  status: 'ok' | 'unavailable' | 'error';
  detail?: string;
}

export const COMPARE_ORDER: Profile[] = ['car', 'transit', 'bike', 'foot'];

/** Ab dieser Luftlinie (km) wird der Modus im Vergleich nicht mehr angeboten. */
export const COMPARE_MAX_KM: Partial<Record<Profile, number>> = { foot: 80, bike: 300, car: 4000, transit: 600 };

const TIMEOUT_MS: Partial<Record<Profile, number>> = { car: 15000, transit: 20000, bike: 15000, foot: 15000 };

/** "41 min", "1 h 05 min", "3 h", "1 Tag 2 h", "2 Tage 3 h" */
export function formatDuration(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return '–';
  const totalMin = Math.max(1, Math.round(sec / 60));
  if (totalMin < 60) return `${totalMin} min`;
  if (totalMin < 24 * 60) {
    const h = Math.floor(totalMin / 60);
    const m = totalMin % 60;
    return m === 0 ? `${h} h` : `${h} h ${String(m).padStart(2, '0')} min`;
  }
  const totalH = Math.round(totalMin / 60);
  const d = Math.floor(totalH / 24);
  const h = totalH % 24;
  const days = d === 1 ? '1 Tag' : `${d} Tage`;
  return h === 0 ? days : `${days} ${h} h`;
}

async function estimate(places: Place[], profile: Profile, direct: number, signal?: AbortSignal): Promise<ModeEstimate> {
  const max = COMPARE_MAX_KM[profile];
  if (max != null && direct / 1000 > max) {
    return { profile, duration: null, distance: null, status: 'unavailable', detail: 'zu weit' };
  }
  if (profile === 'transit' && !transitCovers(places)) {
    return { profile, duration: null, distance: null, status: 'unavailable', detail: 'nur Schweiz' };
  }
  try {
    const a = await tryRoute(places, profile, withTimeout(signal, TIMEOUT_MS[profile] ?? 15000));
    if (a.status !== 'ok' || !a.route) {
      return { profile, duration: null, distance: null, status: a.status === 'ok' ? 'error' : a.status, detail: a.reason };
    }
    const r = a.route;
    const distance = r.distance ?? r.line.length;
    let detail = r.detail;
    if (!detail && (profile === 'bike' || profile === 'foot') && r.duration > 0) {
      detail = `Ø ${(distance / 1000 / (r.duration / 3600)).toFixed(1).replace('.', ',')} km/h`;
    }
    if (!detail && profile === 'car') detail = 'ohne Verkehr';
    return { profile, duration: r.duration, distance, status: 'ok', detail };
  } catch (err) {
    if (signal?.aborted) throw err;
    return { profile, duration: null, distance: null, status: 'error', detail: 'nicht erreichbar' };
  }
}

/** Dauer und Distanz für Auto, ÖV, Velo und zu Fuss, parallel geladen (je mit Zeitlimit). */
export async function compareModes(places: Place[], signal?: AbortSignal): Promise<ModeEstimate[]> {
  if (places.length < 2) {
    return COMPARE_ORDER.map((profile) => ({ profile, duration: null, distance: null, status: 'unavailable' as const }));
  }
  const direct = directDistance(places);
  return Promise.all(COMPARE_ORDER.map((p) => estimate(places, p, direct, signal)));
}
