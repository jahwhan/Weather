// Orte suchen und Koordinaten benennen.
// Zuerst die Bundes-Geodienste (geo.admin.ch, © swisstopo) für die Schweiz, für das Ausland
// Photon (komoot) mit Rückfall auf das Open-Meteo-Geocoding.

import type { LngLat } from '../geo';
import { withTimeout } from '../swiss/http.ts';
import { isInSwitzerland } from '../swiss/region.ts';
import { reverseGeoAdmin, searchGeoAdmin, type RankedPlace } from '../swiss/search.ts';

export { withTimeout };

export interface Place {
  name: string;
  /** Zusatz wie "Zürich, CH" */
  detail: string;
  coord: LngLat;
  kind: string;
}

interface PhotonFeature {
  geometry: { coordinates: [number, number] };
  properties: {
    name?: string;
    street?: string;
    housenumber?: string;
    city?: string;
    district?: string;
    locality?: string;
    county?: string;
    state?: string;
    country?: string;
    countrycode?: string;
    osm_key?: string;
    osm_value?: string;
    type?: string;
  };
}

const COORD_RE = /^\s*(-?\d{1,2}(?:[.,]\d+)?)\s*[,;\s]\s*(-?\d{1,3}(?:[.,]\d+)?)\s*$/;

/** "47.37, 8.54" als Koordinate erkennen (Breite, Länge). */
export function parseCoordinate(text: string): LngLat | null {
  const m = COORD_RE.exec(text);
  if (!m) return null;
  const lat = parseFloat(m[1].replace(',', '.'));
  const lng = parseFloat(m[2].replace(',', '.'));
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return [lng, lat];
}

function photonPlace(f: PhotonFeature): Place {
  const p = f.properties;
  let name = p.name ?? '';
  if (!name && p.street) name = `${p.street}${p.housenumber ? ' ' + p.housenumber : ''}`;
  const area = [p.city ?? p.locality ?? p.district, p.state !== p.city ? p.state : undefined, p.countrycode]
    .filter((x, i, arr) => x && arr.indexOf(x) === i && x !== name)
    .join(', ');
  return {
    name: name || p.city || p.state || 'Unbenannter Ort',
    detail: area,
    coord: f.geometry.coordinates,
    kind: p.osm_value ?? p.type ?? '',
  };
}

// Suchergebnisse im Browser merken: schnellere Neuladen, weniger Last für die Dienste.
// v2: Schweizer Treffer kommen von geo.admin.ch, alte Photon-Ergebnisse (v1) werden ignoriert.
// Der Speicher lässt sich vorbelegen: localStorage[CACHE_KEY] = {"zürich|6": [Place, …]}
export const CACHE_KEY = 'wetterflug.geocode.v2';
let memo: Record<string, Place[]> | null = null;
function cache(): Record<string, Place[]> {
  if (memo) return memo;
  try {
    memo = JSON.parse(localStorage.getItem(CACHE_KEY) ?? '{}') as Record<string, Place[]>;
    localStorage.removeItem('wetterflug.geocode.v1');
  } catch {
    memo = {};
  }
  return memo!;
}
function remember(key: string, places: Place[]): void {
  const c = cache();
  c[key] = places;
  const keys = Object.keys(c);
  if (keys.length > 150) delete c[keys[0]];
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(c));
  } catch {
    /* Speicher voll oder gesperrt */
  }
}

export async function searchPlaces(query: string, bias?: LngLat, signal?: AbortSignal, limit = 6): Promise<Place[]> {
  const q = query.trim();
  if (!q) return [];
  const coord = parseCoordinate(q);
  if (coord) {
    return [{ name: `${coord[1].toFixed(4)}, ${coord[0].toFixed(4)}`, detail: 'Koordinate', coord, kind: 'coordinate' }];
  }
  const key = `${q.toLowerCase()}|${limit}`;
  const hit = cache()[key];
  if (hit?.length) return hit;
  const found = await searchUncached(q, bias, signal, limit);
  if (found.length) remember(key, found);
  return found;
}

const samePlace = (a: Place, b: Place) =>
  a.name.toLowerCase() === b.name.toLowerCase() &&
  Math.abs(a.coord[0] - b.coord[0]) < 0.05 &&
  Math.abs(a.coord[1] - b.coord[1]) < 0.03;

const stripRank = ({ name, detail, coord, kind }: RankedPlace): Place => ({ name, detail, coord, kind });

/**
 * Schweizer Treffer (geo.admin) und ausländische (Photon/Open-Meteo) zusammenführen.
 * Passt geo.admin eindeutig (Gemeinde, Ort, Gipfel, Adresse …), gewinnt die Schweiz; sonst
 * (z. B. "Paris" -> nur Flurnamen "Les Paris") kommen die ausländischen Treffer zuerst.
 */
export function mergeResults(ch: RankedPlace[], foreign: Place[], limit: number): Place[] {
  const strong = ch.filter((p) => p.strong).map(stripRank);
  const weak = ch.filter((p) => !p.strong).map(stripRank);
  const ordered = strong.length ? [...strong, ...foreign, ...weak] : [...foreign, ...weak];
  const out: Place[] = [];
  for (const p of ordered) {
    if (!out.some((q) => samePlace(p, q))) out.push(p);
    if (out.length >= limit) break;
  }
  return out;
}

async function searchUncached(q: string, bias: LngLat | undefined, signal: AbortSignal | undefined, limit: number): Promise<Place[]> {
  // beide Quellen parallel; ist die Schweiz eindeutig, wird nicht auf das Ausland gewartet
  const foreignCtl = new AbortController();
  const onAbort = () => foreignCtl.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  const foreignP = searchForeign(q, bias, foreignCtl.signal, limit).catch(() => [] as Place[]);
  let ch: RankedPlace[] = [];
  try {
    ch = await searchGeoAdmin(q, signal, limit);
  } catch (err) {
    if (signal?.aborted) throw err;
    console.warn('geo.admin-Suche nicht verfügbar:', err);
  }
  try {
    if (ch.some((p) => p.strong)) {
      foreignCtl.abort();
      return mergeResults(ch, [], limit);
    }
    const foreign = await foreignP;
    if (signal?.aborted) throw signal.reason ?? new DOMException('Abgebrochen', 'AbortError');
    return mergeResults(ch, foreign, limit);
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
}

async function searchForeign(q: string, bias: LngLat | undefined, signal: AbortSignal | undefined, limit: number): Promise<Place[]> {
  try {
    const params = new URLSearchParams({ q, limit: String(limit), lang: 'de' });
    if (bias) {
      params.set('lat', bias[1].toFixed(3));
      params.set('lon', bias[0].toFixed(3));
      params.set('location_bias_scale', '0.3');
    }
    const res = await fetch(`https://photon.komoot.io/api/?${params}`, { signal: withTimeout(signal, 4500) });
    if (!res.ok) throw new Error(`Photon HTTP ${res.status}`);
    const json = (await res.json()) as { features: PhotonFeature[] };
    const places = json.features.map(photonPlace);
    // gleiche Namen am gleichen Ort nur einmal zeigen
    const seen = new Set<string>();
    const unique = places.filter((p) => {
      const k = `${p.name}|${p.coord[0].toFixed(2)}|${p.coord[1].toFixed(2)}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    if (unique.length) return unique;
  } catch (err) {
    if (signal?.aborted) throw err;
    console.warn('Photon nicht verfügbar:', err);
  }
  return searchOpenMeteo(q, signal, limit);
}

async function searchOpenMeteo(q: string, signal?: AbortSignal, limit = 6): Promise<Place[]> {
  const params = new URLSearchParams({ name: q, count: String(limit), language: 'de', format: 'json' });
  const url = `https://geocoding-api.open-meteo.com/v1/search?${params}`;
  let res: Response;
  try {
    res = await fetch(url, { signal: withTimeout(signal, 6000) });
  } catch (err) {
    if (signal?.aborted) throw err;
    // einmal wiederholen, der Dienst hängt gelegentlich
    res = await fetch(url, { signal: withTimeout(signal, 10000) });
  }
  if (!res.ok) return [];
  const json = (await res.json()) as {
    results?: { name: string; latitude: number; longitude: number; admin1?: string; country_code?: string; feature_code?: string }[];
  };
  return (json.results ?? []).map((r) => ({
    name: r.name,
    detail: [r.admin1, r.country_code].filter(Boolean).join(', '),
    coord: [r.longitude, r.latitude] as LngLat,
    kind: r.feature_code ?? 'place',
  }));
}

/** Name für eine angeklickte Stelle. Fällt auf die Koordinate zurück. */
export async function reverseGeocode(coord: LngLat, signal?: AbortSignal): Promise<Place> {
  const fallback: Place = {
    name: `${coord[1].toFixed(4)}, ${coord[0].toFixed(4)}`,
    detail: 'Koordinate',
    coord,
    kind: 'coordinate',
  };
  if (isInSwitzerland(coord)) {
    try {
      const ch = await reverseGeoAdmin(coord, signal);
      if (ch) return ch;
    } catch (err) {
      if (signal?.aborted) return fallback;
      console.warn('geo.admin-Rückwärtssuche nicht verfügbar:', err);
    }
  }
  try {
    const params = new URLSearchParams({ lat: coord[1].toFixed(5), lon: coord[0].toFixed(5), lang: 'de', limit: '1' });
    const res = await fetch(`https://photon.komoot.io/reverse?${params}`, { signal: withTimeout(signal, 4000) });
    if (!res.ok) return fallback;
    const json = (await res.json()) as { features: PhotonFeature[] };
    const f = json.features[0];
    if (!f) return fallback;
    const p = f.properties;
    // für Klicks lieber den Ort als die Strasse anzeigen
    const town = p.city ?? p.locality ?? p.district ?? p.county;
    const label =
      p.osm_key === 'place' || !town
        ? photonPlace(f).name
        : p.name && p.osm_key !== 'highway'
          ? `${p.name}, ${town}`
          : town;
    return { name: label, detail: [p.state, p.countrycode].filter(Boolean).join(', '), coord, kind: p.osm_value ?? '' };
  } catch {
    return fallback;
  }
}
