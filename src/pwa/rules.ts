// Cache-Regeln des Service Workers als reine Funktionen (ohne DOM/Worker-APIs),
// damit sie mit `node --test` geprüft werden können.

export type Strategy = 'network-first' | 'cache-first' | 'stale-while-revalidate';

export interface Rule {
  /** Name der Regel (für Tests und Fehlersuche) */
  name: 'navigate' | 'shell' | 'tiles' | 'tile-meta' | 'data';
  strategy: Strategy;
  /** Cache, in den Antworten zur Laufzeit geschrieben werden */
  cache: string;
  /** höchstens so viele Einträge (älteste fliegen zuerst raus) */
  maxEntries: number;
  /** älter als das wird nicht mehr (bzw. nur offline als letzter Ausweg) ausgeliefert */
  maxAgeMs: number;
  /** Netz-Wartezeit, bevor auf den Cache ausgewichen wird (nur network-first) */
  timeoutMs: number;
  /** auch opake Antworten (no-cors, Status 0) speichern? */
  allowOpaque: boolean;
}

export const CACHE_PREFIX = 'wf-';
/** Kopfzeile, in der beim Speichern der Zeitpunkt (ms) vermerkt wird */
export const CACHED_AT_HEADER = 'x-wf-cached-at';
/** Abfragen mit diesem Parameter gehen am Service Worker vorbei (Verbindungsprüfung) */
export const PROBE_PARAM = '__wf_probe';

const MIN = 60e3;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** Laufzeit-Caches: Namen bleiben über App-Versionen gleich, nur der Vorab-Cache trägt die Version. */
export const RUNTIME = {
  shell: 'wf-assets-v1',
  tiles: 'wf-tiles-v1',
  tileMeta: 'wf-tilemeta-v1',
  data: 'wf-data-v1',
} as const;

export const precacheName = (version: string) => `${CACHE_PREFIX}shell-${version}`;

export const RULES: Record<Rule['name'], Rule> = {
  navigate: { name: 'navigate', strategy: 'network-first', cache: '', maxEntries: 0, maxAgeMs: Infinity, timeoutMs: 3000, allowOpaque: false },
  shell: { name: 'shell', strategy: 'cache-first', cache: RUNTIME.shell, maxEntries: 80, maxAgeMs: 60 * DAY, timeoutMs: 0, allowOpaque: false },
  tiles: { name: 'tiles', strategy: 'cache-first', cache: RUNTIME.tiles, maxEntries: 800, maxAgeMs: 30 * DAY, timeoutMs: 0, allowOpaque: false },
  'tile-meta': { name: 'tile-meta', strategy: 'stale-while-revalidate', cache: RUNTIME.tileMeta, maxEntries: 30, maxAgeMs: 7 * DAY, timeoutMs: 0, allowOpaque: false },
  data: { name: 'data', strategy: 'network-first', cache: RUNTIME.data, maxEntries: 60, maxAgeMs: 12 * HOUR, timeoutMs: 4000, allowOpaque: false },
};

/** Kartenkacheln, Gelände, Luftbild, Nachtlichter, Schriften der Karte */
export const TILE_HOSTS = [
  'tiles.openfreemap.org',
  'wmts.geo.admin.ch',
  'vectortiles.geo.admin.ch',
  'server.arcgisonline.com',
  'gibs.earthdata.nasa.gov',
  's3.amazonaws.com',
];

/** Wetter-, Mess-, Such- und Routing-Dienste */
export const DATA_HOSTS = [
  'api.open-meteo.com',
  'geocoding-api.open-meteo.com',
  'api.met.no',
  'data.geo.admin.ch',
  'api3.geo.admin.ch',
  'aws.slf.ch',
  'transport.opendata.ch',
  'routing.openstreetmap.de',
  'router.project-osrm.org',
  'photon.komoot.io',
];

/** Niemals über den Service Worker: Chat (n8n) – auch eigene, im Chat eingetragene URLs */
export function isNeverCached(u: URL): boolean {
  return /(^|\.)n8n\.(cloud|io)$/.test(u.hostname) || u.pathname.includes('/webhook/') || u.pathname.includes('/webhook-test/');
}

export interface RequestInfo {
  url: string;
  method: string;
  /** Request.mode: 'navigate' für Seitenaufrufe */
  mode?: string;
  /** Request.destination, z. B. 'document' */
  destination?: string;
  /** Range-Kopfzeile vorhanden (Teil-Abfragen nicht cachen) */
  hasRange?: boolean;
}

/**
 * Welche Regel gilt für eine Abfrage? `null` = Service Worker mischt sich nicht ein
 * (der Browser macht die Abfrage wie ohne SW).
 * @param scope Geltungsbereich des SW, z. B. "https://jahwhan.github.io/Weather/"
 */
export function classify(req: RequestInfo, scope: string): Rule | null {
  if (req.method !== 'GET' || req.hasRange) return null;
  let u: URL;
  try {
    u = new URL(req.url);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  if (u.searchParams.has(PROBE_PARAM) || isNeverCached(u)) return null;

  const s = new URL(scope);
  if (u.origin === s.origin) {
    if (!u.pathname.startsWith(s.pathname)) return null;
    if (req.mode === 'navigate' || req.destination === 'document') return RULES.navigate;
    const rel = u.pathname.slice(s.pathname.length);
    if (rel === 'sw.js') return null;
    // gehashte Build-Dateien und statische Dateien aus public/ (Manifest, Icons)
    if (rel.startsWith('assets/') || rel.startsWith('icons/') || rel === 'manifest.webmanifest') return RULES.shell;
    return null;
  }

  if (TILE_HOSTS.includes(u.hostname)) {
    if (u.hostname === 's3.amazonaws.com' && !u.pathname.startsWith('/elevation-tiles-prod/')) return null;
    return isTileMeta(u) ? RULES['tile-meta'] : RULES.tiles;
  }
  if (DATA_HOSTS.includes(u.hostname)) return RULES.data;
  return null;
}

/** TileJSON, Stil-JSON und ähnliches ändern sich: nicht ewig, sondern stale-while-revalidate. */
export function isTileMeta(u: URL): boolean {
  if (/\.json$/i.test(u.pathname)) return true;
  // OpenFreeMap: https://tiles.openfreemap.org/planet (TileJSON mit versionierten Kachel-URLs)
  if (u.hostname === 'tiles.openfreemap.org' && /^\/[a-z0-9_-]+\/?$/i.test(u.pathname)) return true;
  // WMTS-Capabilities
  if (/GetCapabilities|WMTSCapabilities/i.test(u.pathname + u.search)) return true;
  return false;
}

export interface ResponseInfo {
  status: number;
  type: string;
}

/** Nur vollständige, erfolgreiche Antworten speichern; opake nur, wenn die Regel es erlaubt. */
export function isCacheable(res: ResponseInfo, rule: Rule): boolean {
  if (res.type === 'opaque') return rule.allowOpaque;
  return res.status === 200;
}

/** Ist ein gespeicherter Eintrag noch frisch? Ohne Zeitstempel: als alt behandeln. */
export function isFresh(cachedAt: number | null, maxAgeMs: number, now: number): boolean {
  if (maxAgeMs === Infinity) return true;
  if (cachedAt == null || !Number.isFinite(cachedAt)) return false;
  return now - cachedAt <= maxAgeMs;
}

export function parseCachedAt(v: string | null | undefined): number | null {
  if (!v) return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export interface Entry {
  key: string;
  cachedAt: number | null;
}

/**
 * Welche Einträge löschen? Abgelaufene immer, danach die ältesten (FIFO in
 * Einfüge-Reihenfolge, wie die Cache API sie liefert), bis das Limit passt.
 * `entries` in Einfüge-Reihenfolge (ältester zuerst).
 */
export function entriesToTrim(entries: Entry[], maxEntries: number, maxAgeMs: number, now: number): string[] {
  const out: string[] = [];
  const keep: Entry[] = [];
  for (const e of entries) {
    if (maxAgeMs !== Infinity && e.cachedAt != null && now - e.cachedAt > maxAgeMs) out.push(e.key);
    else keep.push(e);
  }
  const over = keep.length - maxEntries;
  if (over > 0) {
    // ohne Zeitstempel zählen sie als älteste; sonst Einfüge-Reihenfolge
    const order = keep
      .map((e, i) => ({ e, i }))
      .sort((a, b) => (a.e.cachedAt ?? -1) - (b.e.cachedAt ?? -1) || a.i - b.i);
    for (let k = 0; k < over; k++) out.push(order[k].e.key);
  }
  return out;
}

/** Caches früherer Versionen (eigenes Präfix, aber weder aktueller Vorab- noch Laufzeit-Cache). */
export function staleCaches(existing: string[], version: string): string[] {
  const keep = new Set<string>([precacheName(version), ...Object.values(RUNTIME)]);
  return existing.filter((n) => n.startsWith(CACHE_PREFIX) && !keep.has(n));
}

/** Liste der Vorab-Dateien aus den Build-Dateien: ohne Sourcemaps, ohne den SW selbst, sortiert. */
export function precacheList(files: string[]): string[] {
  const set = new Set<string>();
  for (const f of files) {
    const p = f.replace(/^\.?\//, '');
    if (!p || p.endsWith('.map') || p === 'sw.js' || p.endsWith('.DS_Store') || p.startsWith('.')) continue;
    set.add(p);
  }
  return [...set].sort();
}
