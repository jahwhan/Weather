// Lawinengefahr aus dem SLF-Bulletin (CAAML als GeoJSON).
// Jedes Feature ist eine Warnregion (WGS84, [lon, lat]); Regionen ohne
// Bulletin (Mittelland, Sommer) haben keine dangerRatings.

export interface AvalancheInfo {
  level: 1 | 2 | 3 | 4 | 5 | null;
  /** z. B. "3 – erheblich" */
  levelLabel: string;
  regionName: string | null;
  regionId: string | null;
  /** Ende der Gültigkeit, UTC ms */
  validUntil: number | null;
  /** z. B. "oberhalb 2200 m" */
  elevationNote: string | null;
  /** Expositionen, deutsch abgekürzt (N, NO, O, SO, S, SW, W, NW) */
  aspects: string[] | null;
  /** Lawinenprobleme, deutsch */
  problems: string[];
  url: 'https://www.slf.ch/de/lawinenbulletin-und-schneesituation/';
}

export const SLF_URL = 'https://www.slf.ch/de/lawinenbulletin-und-schneesituation/' as const;
export const SLF_GEOJSON = 'https://aws.slf.ch/api/bulletin/caaml/de/geojson';
export const NO_BULLETIN_TEXT = 'Kein Lawinenbulletin (Sommer)';

type Ring = number[][];
type PolygonGeom = { type: 'Polygon'; coordinates: number[][][] };
type MultiPolygonGeom = { type: 'MultiPolygon'; coordinates: number[][][][] };

/** Gerade-Ungerade-Regel für einen Ring. pt = [lon, lat]. */
function inRing(pt: [number, number], ring: Ring): boolean {
  const [x, y] = pt;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0];
    const yi = ring[i][1];
    const xj = ring[j][0];
    const yj = ring[j][1];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Punkt in GeoJSON-Polygon (erster Ring aussen, weitere Ringe sind Löcher). */
export function pointInPolygon(pt: [number, number], polygon: number[][][]): boolean {
  if (!polygon.length || !inRing(pt, polygon[0])) return false;
  for (let k = 1; k < polygon.length; k++) if (inRing(pt, polygon[k])) return false;
  return true;
}

export function pointInGeometry(pt: [number, number], geom: PolygonGeom | MultiPolygonGeom): boolean {
  if (!geom) return false;
  if (geom.type === 'Polygon') return pointInPolygon(pt, geom.coordinates);
  if (geom.type === 'MultiPolygon') return geom.coordinates.some((poly) => pointInPolygon(pt, poly));
  return false;
}

const LEVEL: Record<string, 1 | 2 | 3 | 4 | 5> = {
  low: 1,
  moderate: 2,
  considerable: 3,
  high: 4,
  very_high: 5,
};
const LEVEL_NAME = ['', 'gering', 'mässig', 'erheblich', 'gross', 'sehr gross'];
const SUB: Record<string, string> = { plus: '+', minus: '−', neutral: '=' };

const PROBLEM: Record<string, string> = {
  new_snow: 'Neuschnee',
  wind_slab: 'Triebschnee',
  persistent_weak_layers: 'Altschnee',
  wet_snow: 'Nassschnee',
  gliding_snow: 'Gleitschnee',
  cornices: 'Wechten',
  favourable_situation: 'Günstige Situation',
  no_distinct_avalanche_problem: 'Kein ausgeprägtes Lawinenproblem',
};

const ASPECT_ORDER = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
const ASPECT_DE: Record<string, string> = { N: 'N', NE: 'NO', E: 'O', SE: 'SO', S: 'S', SW: 'SW', W: 'W', NW: 'NW' };

export function levelLabel(level: number | null, subdivision?: string | null): string {
  if (!level) return 'Keine Gefahrenstufe';
  const sub = subdivision && level <= 4 ? (SUB[subdivision] ?? '') : '';
  return `${level}${sub === '=' ? '' : sub} – ${LEVEL_NAME[level]}`;
}

interface Elevation {
  lowerBound?: string;
  upperBound?: string;
}
interface DangerRating {
  mainValue?: string;
  validTimePeriod?: string;
  elevation?: Elevation;
  customData?: { CH?: { subdivision?: string } };
}
interface Problem {
  problemType?: string;
  elevation?: Elevation;
  aspects?: string[];
}
interface Props {
  regions?: { regionID?: string; name?: string }[];
  validTime?: { startTime?: string; endTime?: string };
  dangerRatings?: DangerRating[];
  avalancheProblems?: Problem[];
}

function boundValue(b: string | undefined): number | null {
  if (b == null) return null;
  const n = parseFloat(b);
  return Number.isFinite(n) ? n : null;
}

function boundText(b: string): string {
  const n = boundValue(b);
  if (n != null) return `${n} m`;
  return b === 'treeline' ? 'der Waldgrenze' : b;
}

function elevationText(e: Elevation | undefined): string | null {
  if (!e) return null;
  if (e.lowerBound && e.upperBound) return `zwischen ${boundText(e.lowerBound)} und ${boundText(e.upperBound)}`;
  if (e.lowerBound) return `oberhalb ${boundText(e.lowerBound)}`;
  if (e.upperBound) return `unterhalb ${boundText(e.upperBound)}`;
  return null;
}

/** Gilt die Höhenangabe für die gegebene Höhe? (unbekannte Grenze wie "treeline" → ja) */
function elevationApplies(e: Elevation | undefined, elevation: number | null | undefined): boolean {
  if (!e || elevation == null) return true;
  const lo = boundValue(e.lowerBound);
  const hi = boundValue(e.upperBound);
  if (lo != null && elevation < lo) return false;
  if (hi != null && elevation > hi) return false;
  return true;
}

function isFeatureCollection(json: unknown): json is { features: { properties?: Props; geometry?: PolygonGeom | MultiPolygonGeom }[] } {
  return !!json && typeof json === 'object' && Array.isArray((json as { features?: unknown }).features);
}

/**
 * Bulletin für einen Punkt auswerten. pt = [lon, lat] (GeoJSON-Reihenfolge).
 * null: kein Bulletin (leer, Sommer) oder Punkt ausserhalb aller Warnregionen.
 */
export function parseBulletin(json: unknown, pt: [number, number], elevation?: number | null): AvalancheInfo | null {
  if (!isFeatureCollection(json) || json.features.length === 0) return null;
  const hits = json.features.filter((f) => f.geometry && pointInGeometry(pt, f.geometry));
  if (!hits.length) return null;
  // Falls Polygone überlappen: das Feature mit Bulletin bevorzugen
  const f = hits.find((h) => h.properties?.dangerRatings?.length) ?? hits[0];
  const p = f.properties ?? {};
  const region = p.regions?.[0];
  const ratings = (p.dangerRatings ?? []).filter((r) => r.mainValue && LEVEL[r.mainValue]);

  const base = {
    regionName: region?.name ?? null,
    regionId: region?.regionID ?? null,
    validUntil: p.validTime?.endTime ? Date.parse(p.validTime.endTime) || null : null,
    url: SLF_URL,
  };

  if (!ratings.length) {
    return { ...base, level: null, levelLabel: 'Keine Gefahrenstufe für diese Region', elevationNote: null, aspects: null, problems: [] };
  }

  // höhenabhängige Stufen: passende nehmen, sonst die höchste
  let applicable = ratings.filter((r) => elevationApplies(r.elevation, elevation));
  if (!applicable.length) applicable = ratings;
  let best = applicable[0];
  for (const r of applicable) if (LEVEL[r.mainValue!] > LEVEL[best.mainValue!]) best = r;
  const level = LEVEL[best.mainValue!];

  const problems = p.avalancheProblems ?? [];
  const names: string[] = [];
  for (const pr of problems) {
    const n = pr.problemType ? (PROBLEM[pr.problemType] ?? pr.problemType) : null;
    if (n && !names.includes(n)) names.push(n);
  }
  const aspSet = new Set<string>();
  for (const pr of problems) for (const a of pr.aspects ?? []) aspSet.add(a);
  const aspects = aspSet.size ? ASPECT_ORDER.filter((a) => aspSet.has(a)).map((a) => ASPECT_DE[a]) : null;

  let elevationNote = elevationText(best.elevation);
  if (!elevationNote) {
    const notes = [...new Set(problems.map((pr) => elevationText(pr.elevation)).filter((x): x is string => !!x))];
    elevationNote = notes.length ? notes.join(', ') : null;
  }

  return {
    ...base,
    level,
    levelLabel: levelLabel(level, best.customData?.CH?.subdivision),
    elevationNote,
    aspects,
    problems: names,
  };
}

let cache: { at: number; json: unknown } | null = null;
const CACHE_MS = 30 * 60 * 1000;

/** Nur für Tests: Cache leeren. */
export function clearAvalancheCache(): void {
  cache = null;
}

async function loadBulletin(signal?: AbortSignal): Promise<unknown | null> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.json;
  const t = AbortSignal.timeout(15000);
  const sig = signal && typeof AbortSignal.any === 'function' ? AbortSignal.any([signal, t]) : (signal ?? t);
  const res = await fetch(SLF_GEOJSON, { signal: sig });
  if (res.status === 404 || res.status === 204) {
    cache = { at: Date.now(), json: null };
    return null;
  }
  if (!res.ok) throw new Error(`SLF HTTP ${res.status}`);
  const json: unknown = await res.json();
  cache = { at: Date.now(), json };
  return json;
}

/** Lawinengefahr an einem Ort; null ausserhalb der Saison oder ausserhalb der Warnregionen. */
export async function avalancheDanger(
  lat: number,
  lon: number,
  opts: { elevation?: number | null; signal?: AbortSignal } = {},
): Promise<AvalancheInfo | null> {
  try {
    const json = await loadBulletin(opts.signal);
    if (!json) return null;
    return parseBulletin(json, [lon, lat], opts.elevation);
  } catch (err) {
    if ((err as Error)?.name === 'AbortError' && opts.signal?.aborted) throw err;
    return null;
  }
}
