// Höhenprofil aus dem swisstopo-Profildienst (api3.geo.admin.ch/rest/services/profile.json).
// Höhen aus swissALTI3D (2 m, "DTM2") bzw. DHM25, kombiniert als "COMB". Genauer als die
// Terrarium-Kacheln (in der Schweiz ~30 m Raster aus SRTM/EU-DEM), aber nur für die Schweiz
// und knapp darüber hinaus.

import type { LngLat } from '../geo';
import { fetchJson } from './http.ts';
import { wgs84ToLv95 } from './lv95.ts';

const URL_PROFILE = 'https://api3.geo.admin.ch/rest/services/profile.json';
/** Der Dienst nimmt höchstens 5000 Stützpunkte an (HTTP 413), wir bleiben deutlich darunter. */
export const MAX_PROFILE_POINTS = 3000;

export interface ProfilePoint {
  dist: number;
  alts?: { COMB?: number | null; DTM2?: number | null; DTM25?: number | null } | null;
  easting?: number;
  northing?: number;
}

/**
 * Höhen der Antwort auf die eigenen Punkte (kumulierte LV95-Distanz `cum`) übertragen.
 * Die Antwort enthält alle Eingabepunkte (distinct_points) plus evtl. Zwischenpunkte;
 * dazwischen wird linear interpoliert. Fehlende Höhen -> NaN.
 */
export function mapProfile(resp: ProfilePoint[], cum: number[]): number[] {
  const pts = resp
    .map((p) => ({ d: p.dist, h: p.alts?.COMB ?? p.alts?.DTM2 ?? p.alts?.DTM25 ?? null }))
    .filter((p): p is { d: number; h: number } => Number.isFinite(p.d) && p.h != null && Number.isFinite(p.h));
  if (pts.length === 0) return cum.map(() => NaN);
  // der Dienst misst die Länge wie wir in LV95; kleine Abweichungen auf die Gesamtlänge skalieren
  const total = cum[cum.length - 1] || 1;
  const respTotal = pts[pts.length - 1].d || total;
  const k = respTotal / total;
  let j = 0;
  return cum.map((c) => {
    const d = c * k;
    while (j < pts.length - 2 && pts[j + 1].d < d) j++;
    const a = pts[j];
    const b = pts[Math.min(j + 1, pts.length - 1)];
    if (d <= a.d) return a.h;
    if (d >= b.d) return b.h;
    return a.h + ((b.h - a.h) * (d - a.d)) / (b.d - a.d || 1);
  });
}

/** Höhen (m ü. M.) für die Punkte; wirft bei Fehlern oder wenn zu viele Höhen fehlen. */
export async function swissProfile(points: LngLat[], signal?: AbortSignal): Promise<number[]> {
  if (points.length < 2) throw new Error('Profil braucht mindestens zwei Punkte');
  // sehr lange Linien ausdünnen (gleichmässig), die Rückabbildung interpoliert
  const step = Math.ceil(points.length / MAX_PROFILE_POINTS);
  const idx: number[] = [];
  for (let i = 0; i < points.length; i += step) idx.push(i);
  if (idx[idx.length - 1] !== points.length - 1) idx.push(points.length - 1);
  const lv = idx.map((i) => wgs84ToLv95(points[i]));
  const coords = lv.map(([e, n]) => [Math.round(e * 10) / 10, Math.round(n * 10) / 10]);
  // kumulierte Distanzen aller Originalpunkte in LV95
  const all = points.map((p) => wgs84ToLv95(p));
  const cum = [0];
  for (let i = 1; i < all.length; i++) {
    cum.push(cum[i - 1] + Math.hypot(all[i][0] - all[i - 1][0], all[i][1] - all[i - 1][1]));
  }
  const params = new URLSearchParams({ sr: '2056', nb_points: String(coords.length), distinct_points: 'true' });
  const resp = await fetchJson<ProfilePoint[]>(`${URL_PROFILE}?${params}`, signal, 12000, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'LineString', coordinates: coords }),
  });
  if (!Array.isArray(resp) || resp.length < 2) throw new Error('swisstopo-Profil: leere Antwort');
  const ele = mapProfile(resp, cum);
  const missing = ele.filter((v) => !Number.isFinite(v)).length;
  if (missing > ele.length * 0.2) throw new Error('swisstopo-Profil: zu viele Lücken');
  return ele;
}
