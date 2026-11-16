// Ortssuche und Rückwärtssuche über die Bundes-Geodienste (api3.geo.admin.ch, © swisstopo).
// SearchServer liefert Gemeinden, Orte, Gipfel, Postleitzahlen, Adressen und Parzellen;
// identify benennt einen angeklickten Punkt (Gemeinde, Ortschaft, nahe Gipfel).

import type { LngLat } from '../geo';
import type { Place } from '../route/geocode';
import { fetchJson } from './http.ts';
import { lv95ToWgs84, wgs84ToLv95 } from './lv95.ts';

const API = 'https://api3.geo.admin.ch/rest/services';

export interface GeoAdminAttrs {
  label: string;
  detail?: string;
  lat: number;
  lon: number;
  origin: string;
  objectclass?: string;
  rank?: number;
}

export interface GeoAdminResponse {
  results?: { attrs: GeoAdminAttrs; id?: number; weight?: number }[];
}

export interface RankedPlace extends Place {
  /** kleiner = besser */
  score: number;
  /** passt eindeutig zur Eingabe (sonst nur "irgendwas Ähnliches in der Schweiz") */
  strong: boolean;
}

/** HTML-Auszeichnung entfernen, Leerraum zusammenfassen. */
export function cleanLabel(html: string): string {
  return html
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Kleinbuchstaben ohne Akzente, Umlaute als Grundbuchstabe (ü -> u). */
export function normalize(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/** `name` beginnt mit `query` an einer Wortgrenze ("Rigi" passt zu "Rigi Kulm", nicht zu "Rigiblick"). */
function startsAtWord(name: string, query: string): boolean {
  const n = normalize(name);
  const q = normalize(query);
  if (!n.startsWith(q)) return false;
  const next = n.charAt(q.length);
  return next === '' || /[\s\-,/(.']/.test(next);
}

/** Jedes Wort der Eingabe ist Anfang eines Wortes im Text. */
function allTokensMatch(text: string, query: string): boolean {
  const words = normalize(text).split(/[\s,()\-/]+/).filter(Boolean);
  return normalize(query)
    .split(/[\s,]+/)
    .filter(Boolean)
    .every((t) => words.some((w) => w.startsWith(t)));
}

// Grundrang nach Art des Treffers (gazetteer-Objektklassen aus swissNAMES3D/TLM)
const GAZ_RANK: Record<string, number> = {
  TLM_SIEDLUNGSNAME: 12,
  TLM_NAME_PKT: 14,
  TLM_STEHENDES_GEWAESSER: 22,
  TLM_GELAENDENAME: 25,
  TLM_HALTESTELLE: 28,
  TLM_STRASSENNAME: 50,
  TLM_FLURNAME: 60,
};
const GAZ_SETTLEMENT = new Set(['TLM_SIEDLUNGSNAME']);
const GAZ_KIND: Record<string, string> = {
  TLM_SIEDLUNGSNAME: 'locality',
  TLM_NAME_PKT: 'peak',
  TLM_STEHENDES_GEWAESSER: 'lake',
  TLM_GELAENDENAME: 'terrain',
  TLM_HALTESTELLE: 'station',
  TLM_FLURNAME: 'name',
};

interface Parsed {
  name: string;
  detail: string;
  kind: string;
  base: number;
  /** Klasse, bei der schon ein Wortanfang reicht (Gemeinde, Ort, PLZ …) */
  loose: boolean;
  /** Klasse, die nie eindeutig ist (Flurname, Parzelle …) */
  weakClass: boolean;
}

function parseOne(a: GeoAdminAttrs, query: string): Parsed | null {
  const label = a.label ?? '';
  const plain = cleanLabel(label);
  const hasDigit = /\d/.test(query);
  switch (a.origin) {
    case 'gg25': {
      // "<b>Zürich (ZH)</b>"
      const m = /^(.*?)\s*\(([A-Z]{2})\)$/.exec(plain);
      return {
        name: m ? m[1] : plain,
        detail: m ? `Gemeinde, ${m[2]}` : 'Gemeinde',
        kind: 'municipality',
        base: 10,
        loose: true,
        weakClass: false,
      };
    }
    case 'kantone':
      return { name: plain, detail: 'Kanton', kind: 'canton', base: 30, loose: true, weakClass: false };
    case 'district':
      return { name: plain, detail: 'Bezirk', kind: 'district', base: 35, loose: true, weakClass: false };
    case 'zipcode': {
      // "<b>6003 - Luzern</b>"
      const m = /^(\d{4})\s*-\s*(.*)$/.exec(plain);
      return {
        name: m ? `${m[1]} ${m[2]}` : plain,
        detail: 'Postleitzahl',
        kind: 'postcode',
        base: hasDigit ? 5 : 15,
        loose: true,
        weakClass: false,
      };
    }
    case 'address': {
      // "Bahnhofstrasse 1 <b>8001 Zürich</b>"
      const m = /^(.*?)\s*<b>(.*?)<\/b>/.exec(label.replace(/\s+/g, ' '));
      return {
        name: m ? cleanLabel(m[1]) || cleanLabel(m[2]) : plain,
        detail: m ? cleanLabel(m[2]) : '',
        kind: 'address',
        base: hasDigit ? 8 : 40,
        loose: false,
        weakClass: !hasDigit,
      };
    }
    case 'parcel': {
      // "<b>Locarno</b> 6003 (CH 7697 0207 2486)"
      const m = /^<b>(.*?)<\/b>\s*([^\s(]+)/.exec(label);
      return {
        name: m ? `Parzelle ${m[2]}` : plain,
        detail: m ? cleanLabel(m[1]) : 'Parzelle',
        kind: 'parcel',
        base: 90,
        loose: false,
        weakClass: true,
      };
    }
    case 'gazetteer': {
      // "<i>Alpiner Gipfel</i> <b>Matterhorn Mont Cervin|Monte Cervino</b> () - "
      // "<b>Rigi Kulm</b> (SZ) - Arth"
      const type = /<i>(.*?)<\/i>/.exec(label)?.[1];
      const bold = /<b>([\s\S]*?)<\/b>/.exec(label)?.[1];
      const rest = label.replace(/^[\s\S]*<\/b>/, '');
      const kt = /\(([A-Z,]*)\)/.exec(rest)?.[1] ?? '';
      const comm = (/\)\s*-\s*(.*)$/.exec(cleanLabel(rest))?.[1] ?? '').split(',').filter(Boolean);
      const rawName = cleanLabel(bold ?? plain);
      // Mehrsprachige Namen: "Matterhorn Mont Cervin|Monte Cervino". Passt die Eingabe auf den
      // Anfang, nur diesen Teil zeigen, sonst den ersten Abschnitt.
      let name = rawName.split('|')[0].trim();
      if (rawName.includes('|') && startsAtWord(name, query) && normalize(name) !== normalize(query)) {
        name = name.slice(0, query.trim().length);
      }
      const cls = a.objectclass ?? '';
      const typeLabel = cleanLabel(type ?? (GAZ_SETTLEMENT.has(cls) ? 'Ort' : 'Name'))
        .replace(/\s+swisstopo$/, '')
        .replace(/ae/g, 'ä')
        .replace(/oe/g, 'ö')
        .replace(/ue(?![lr])/g, 'ü')
        .replace(/\bAe/g, 'Ä')
        .replace(/\bOe/g, 'Ö')
        .replace(/\bUe/g, 'Ü');
      const where =
        comm.length === 1 && normalize(comm[0]) !== normalize(name)
          ? `${comm[0]}${kt && !comm[0].includes('(') ? ` (${kt})` : ''}`
          : kt;
      return {
        name,
        detail: [typeLabel, where].filter(Boolean).join(', '),
        kind: GAZ_KIND[cls] ?? 'name',
        base: GAZ_RANK[cls] ?? 45,
        loose: GAZ_SETTLEMENT.has(cls),
        weakClass: cls === 'TLM_FLURNAME' || cls === 'TLM_STRASSENNAME' || cls === 'TLM_FLIESSGEWAESSER',
      };
    }
    default:
      return { name: plain, detail: a.origin, kind: a.origin, base: 70, loose: false, weakClass: true };
  }
}

/**
 * Antwort des SearchServers in Orte umwandeln, sortiert nach Relevanz:
 * Gemeinden/Orte/Gipfel vor Adressen, Flurnamen und Parzellen; doppelte Treffer entfernt.
 */
export function parseGeoAdminResults(json: GeoAdminResponse, query: string): RankedPlace[] {
  const out: RankedPlace[] = [];
  const results = json.results ?? [];
  results.forEach((r, order) => {
    const a = r.attrs;
    if (!a || !Number.isFinite(a.lat) || !Number.isFinite(a.lon)) return;
    const p = parseOne(a, query);
    if (!p || !p.name) return;
    const exact = normalize(p.name) === normalize(query);
    const word = startsAtWord(p.name, query);
    const tokens = allTokensMatch(`${p.name} ${p.detail}`, query);
    let score = p.base + order * 0.01;
    if (exact) score -= 8;
    else if (word) score -= 3;
    else if (!tokens) score += 20;
    const strong =
      !p.weakClass &&
      (exact || (p.loose && word) || (p.kind === 'peak' && word) || (p.kind === 'address' && tokens));
    out.push({ name: p.name, detail: p.detail, coord: [a.lon, a.lat], kind: p.kind, score, strong });
  });
  out.sort((x, y) => Number(y.strong) - Number(x.strong) || x.score - y.score);
  // gleicher Name nahe beieinander (Gemeinde und Siedlung, doppelte Einträge) nur einmal
  const kept: RankedPlace[] = [];
  for (const p of out) {
    const dup = kept.some(
      (k) =>
        normalize(k.name) === normalize(p.name) &&
        Math.abs(k.coord[0] - p.coord[0]) < 0.03 &&
        Math.abs(k.coord[1] - p.coord[1]) < 0.02,
    );
    if (!dup) kept.push(p);
  }
  return kept;
}

/** Terrainhöhe (swissALTI3D/DHM25) an einem Punkt in m ü. M., null ausserhalb/bei Fehler. */
export async function swissHeight(coord: LngLat, signal?: AbortSignal): Promise<number | null> {
  try {
    const [E, N] = wgs84ToLv95(coord);
    const j = await fetchJson<{ height?: string | number }>(
      `${API}/height?easting=${E.toFixed(1)}&northing=${N.toFixed(1)}&sr=2056`,
      signal,
      2500,
    );
    const h = Number(j.height);
    return Number.isFinite(h) ? h : null;
  } catch {
    return null;
  }
}

/** Orte über den geo.admin-SearchServer suchen. */
export async function searchGeoAdmin(query: string, signal?: AbortSignal, limit = 6): Promise<RankedPlace[]> {
  const params = new URLSearchParams({
    searchText: query,
    type: 'locations',
    sr: '4326',
    limit: String(Math.min(30, Math.max(limit * 2, 10))),
    lang: 'de',
  });
  const json = await fetchJson<GeoAdminResponse>(`${API}/api/SearchServer?${params}`, signal, 3500);
  const places = parseGeoAdminResults(json, query).slice(0, limit);
  // Gipfelhöhe ergänzen ("Alpiner Gipfel, 4477 m"), höchstens drei Abfragen
  const peaks = places.filter((p) => p.kind === 'peak').slice(0, 3);
  await Promise.all(
    peaks.map(async (p) => {
      const h = await swissHeight(p.coord, signal);
      if (h != null && h > 300) {
        const [type, ...rest] = p.detail.split(', ');
        p.detail = [`${type}, ${Math.round(h)} m`, ...rest].join(', ');
      }
    }),
  );
  return places;
}

// ---------------------------------------------------------------- Rückwärtssuche

interface IdentifyResult {
  layerBodId: string;
  featureId?: number | string;
  attributes: Record<string, unknown>;
}

const PEAK_TYPES = /gipfel|pass|hügel|huegel|aussichtspunkt/i;

/** Name eines Punktes in der Schweiz (Gipfel in der Nähe, sonst Ortschaft/Gemeinde). */
export async function reverseGeoAdmin(coord: LngLat, signal?: AbortSignal): Promise<Place | null> {
  const [E, N] = wgs84ToLv95(coord);
  const pt = `${E.toFixed(1)},${N.toFixed(1)}`;
  const year = new Date().getFullYear() - 1;
  const admin = fetchJson<{ results?: IdentifyResult[] }>(
    `${API}/api/MapServer/identify?geometryType=esriGeometryPoint&geometry=${pt}&sr=2056` +
      '&layers=all:ch.swisstopo-vd.ortschaftenverzeichnis_plz,ch.swisstopo.swissboundaries3d-gemeinde-flaeche.fill' +
      `&tolerance=0&returnGeometry=false&lang=de&timeInstant=${year}`,
    signal,
    3500,
  );
  // Namen im Umkreis von ~200 m (10 km Ausschnitt auf 1000 px, Toleranz 20 px)
  const ext = `${(E - 5000).toFixed(0)},${(N - 5000).toFixed(0)},${(E + 5000).toFixed(0)},${(N + 5000).toFixed(0)}`;
  const names = fetchJson<{ results?: IdentifyResult[] }>(
    `${API}/api/MapServer/identify?geometryType=esriGeometryPoint&geometry=${pt}&sr=2056` +
      `&layers=all:ch.swisstopo.swissnames3d&tolerance=20&mapExtent=${ext}&imageDisplay=1000,1000,96&returnGeometry=false&lang=de`,
    signal,
    3500,
  ).catch(() => ({ results: [] as IdentifyResult[] }));

  const [a, n] = await Promise.all([admin, names]);
  const res = a.results ?? [];
  const gem = res.find((r) => r.layerBodId.includes('gemeinde'))?.attributes;
  const plz = res.find((r) => r.layerBodId.includes('ortschaftenverzeichnis'))?.attributes;
  const gemName = typeof gem?.gemname === 'string' ? gem.gemname : null;
  const kanton = typeof gem?.kanton === 'string' ? gem.kanton : null;
  const ort = typeof plz?.langtext === 'string' ? plz.langtext : null;

  const peaks = (n.results ?? []).filter(
    (r) => r.attributes.objektklasse === 'TLM_NAME_PKT' && PEAK_TYPES.test(String(r.attributes.objektart ?? '')),
  );
  peaks.sort((x, y) => Number(y.attributes.status === 'offiziell') - Number(x.attributes.status === 'offiziell'));
  const peak = peaks[0];
  if (peak) {
    const type = String(peak.attributes.objektart);
    let at: LngLat = coord;
    try {
      const f = await fetchJson<{ feature?: { geometry?: { coordinates?: number[][] | number[] } } }>(
        `${API}/api/MapServer/ch.swisstopo.swissnames3d/${peak.featureId}?geometryFormat=geojson&sr=2056`,
        signal,
        2500,
      );
      const c = f.feature?.geometry?.coordinates;
      const first = Array.isArray(c?.[0]) ? (c![0] as number[]) : (c as number[] | undefined);
      if (first && first.length >= 2) at = lv95ToWgs84([first[0], first[1]]);
    } catch {
      /* dann eben die Klickposition */
    }
    const h = await swissHeight(at, signal);
    return {
      name: String(peak.attributes.name),
      detail: [h != null ? `${type}, ${Math.round(h)} m` : type, gemName && kanton ? `${gemName} (${kanton})` : gemName]
        .filter(Boolean)
        .join(', '),
      coord: at,
      kind: 'peak',
    };
  }
  if (!gemName && !ort) return null;
  const name = ort ?? gemName!;
  const detail = [gemName && ort && normalize(gemName) !== normalize(ort) ? `Gemeinde ${gemName}` : null, kanton, 'CH']
    .filter(Boolean)
    .join(', ');
  return { name, detail, coord, kind: 'locality' };
}
