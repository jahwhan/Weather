/// <reference lib="webworker" />
// Service Worker für Wetterflug. Wird mit eigenem Einstieg nach dist/sw.js gebaut
// (scripts/vite-plugin-sw.ts); Version und Vorab-Liste setzt der Build ein.
//
//   Seitenaufruf      network-first (3 s), sonst index.html aus dem Vorab-Cache
//   Build-Dateien     cache-first (gehasht, also unveränderlich)
//   Kartenkacheln     cache-first mit Ablauf und Grössenlimit; TileJSON stale-while-revalidate
//   Wetter/Daten      network-first mit Timeout, Rückfall auf den Cache (max. Alter)
//   POST, Chat (n8n)  nie

import {
  CACHED_AT_HEADER,
  classify,
  entriesToTrim,
  isCacheable,
  isFresh,
  parseCachedAt,
  precacheName,
  staleCaches,
  type Rule,
} from './rules.ts';

declare const self: ServiceWorkerGlobalScope;
declare const __SW_VERSION__: string;
declare const __SW_PRECACHE__: string[];

const VERSION = __SW_VERSION__;
const PRECACHE = precacheName(VERSION);
const scope = () => self.registration.scope;
const indexUrl = () => new URL('index.html', scope()).href;

self.addEventListener('install', (event) => {
  // kein skipWaiting: die neue Version wartet, bis die App „Aktualisieren“ sendet
  event.waitUntil(
    (async () => {
      const cache = await caches.open(PRECACHE);
      const urls = __SW_PRECACHE__.map((p) => new URL(p, scope()).href);
      // am HTTP-Cache vorbei, damit sicher die Dateien dieser Version im Cache landen
      await cache.addAll(urls.map((u) => new Request(u, { cache: 'reload' })));
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const old = staleCaches(await caches.keys(), VERSION);
      await Promise.all(old.map((n) => caches.delete(n)));
      if (self.registration.navigationPreload) await self.registration.navigationPreload.enable().catch(() => {});
      // erste Installation: Seite sofort übernehmen, damit sie offline startet
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') void self.skipWaiting();
  if (event.data?.type === 'VERSION') event.ports[0]?.postMessage(VERSION);
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const rule = classify(
    { url: req.url, method: req.method, mode: req.mode, destination: req.destination, hasRange: req.headers.has('range') },
    scope(),
  );
  if (!rule) return;
  if (rule.name === 'navigate') event.respondWith(navigate(event));
  else if (rule.strategy === 'cache-first') event.respondWith(cacheFirst(req, rule, event));
  else if (rule.strategy === 'stale-while-revalidate') event.respondWith(staleWhileRevalidate(req, rule, event));
  else event.respondWith(networkFirst(req, rule, event));
});

// ------------------------------------------------------------ Strategien

async function navigate(event: FetchEvent): Promise<Response> {
  const net = (async () => {
    const pre = (await event.preloadResponse) as Response | undefined;
    return pre ?? fetch(event.request);
  })();
  try {
    const res = await withTimeout(net, 3000);
    if (res.ok || res.status < 500) return res;
    throw new Error(`HTTP ${res.status}`);
  } catch {
    const shell = (await caches.match(indexUrl(), { cacheName: PRECACHE })) ?? (await caches.match(indexUrl()));
    if (shell) {
      // Netz kam zu spät? Abfrage nicht abbrechen, aber ignorieren
      event.waitUntil(net.then(() => undefined, () => undefined));
      return shell;
    }
    return net; // ohne Cache: auf das Netz warten (Fehlerseite des Browsers)
  }
}

async function cacheFirst(req: Request, rule: Rule, event: FetchEvent): Promise<Response> {
  // Vorab-Cache: gehört zu genau dieser Version, gilt ohne Ablauf
  const pre = await caches.match(req, { cacheName: PRECACHE, ignoreVary: true });
  if (pre) return pre;
  const hit = await caches.match(req, { cacheName: rule.cache });
  if (hit && isFresh(cachedAtOf(hit), rule.maxAgeMs, Date.now())) return hit;
  try {
    const res = await fetch(req);
    if (isCacheable(res, rule)) event.waitUntil(store(rule, req, res.clone()));
    else if (hit && !res.ok) return hit;
    return res;
  } catch (err) {
    // offline: lieber eine abgelaufene Kachel als ein Loch in der Karte
    if (hit) return hit;
    throw err;
  }
}

async function staleWhileRevalidate(req: Request, rule: Rule, event: FetchEvent): Promise<Response> {
  const hit = await caches.match(req, { cacheName: rule.cache });
  const net = fetch(req).then((res) => {
    if (isCacheable(res, rule)) event.waitUntil(store(rule, req, res.clone()));
    return res;
  });
  if (hit) {
    event.waitUntil(net.then(() => undefined, () => undefined));
    if (isFresh(cachedAtOf(hit), rule.maxAgeMs, Date.now())) return hit;
    // zu alt: auf das Netz warten, offline aber trotzdem den alten Stand nehmen
    return net.catch(() => hit);
  }
  return net;
}

async function networkFirst(req: Request, rule: Rule, event: FetchEvent): Promise<Response> {
  const hitP = caches.match(req, { cacheName: rule.cache }).then((h) => (h && isFresh(cachedAtOf(h), rule.maxAgeMs, Date.now()) ? h : undefined));
  const net = fetch(req).then((res) => {
    if (isCacheable(res, rule)) event.waitUntil(store(rule, req, res.clone()));
    return res;
  });
  try {
    // nur mit Rückfall im Cache wird nach dem Timeout aufgegeben
    const hit = await hitP;
    const res = hit ? await withTimeout(net, rule.timeoutMs) : await net;
    if (res.status >= 500 || res.status === 429) {
      if (hit) return hit;
    }
    return res;
  } catch (err) {
    const hit = await hitP;
    if (hit) {
      event.waitUntil(net.then(() => undefined, () => undefined));
      return hit;
    }
    throw err;
  }
}

// ------------------------------------------------------------ Speichern und Trimmen

function cachedAtOf(res: Response): number | null {
  return parseCachedAt(res.headers.get(CACHED_AT_HEADER));
}

async function store(rule: Rule, req: Request, res: Response): Promise<void> {
  try {
    const cache = await caches.open(rule.cache);
    let toStore = res;
    if (res.type !== 'opaque') {
      // Zeitstempel mitspeichern (für Ablauf und damit die App weiss, wie alt der Stand ist)
      const headers = new Headers(res.headers);
      headers.set(CACHED_AT_HEADER, String(Date.now()));
      toStore = new Response(await res.blob(), { status: res.status, statusText: res.statusText, headers });
    }
    await cache.put(req, toStore);
    scheduleTrim(rule);
  } catch {
    /* Speicher voll: dann eben nicht */
  }
}

const trimTimers = new Map<string, ReturnType<typeof setTimeout>>();
function scheduleTrim(rule: Rule): void {
  if (trimTimers.has(rule.cache)) return;
  trimTimers.set(
    rule.cache,
    setTimeout(() => {
      trimTimers.delete(rule.cache);
      void trim(rule);
    }, 2000),
  );
}

async function trim(rule: Rule): Promise<void> {
  const cache = await caches.open(rule.cache);
  const keys = await cache.keys();
  // Zeitstempel lesen ist teuer; nur nötig, wenn das Limit erreicht ist oder ab und zu für den Ablauf
  if (keys.length <= rule.maxEntries && Math.random() > 0.1) return;
  const entries = await Promise.all(
    keys.map(async (k) => {
      const r = await cache.match(k);
      return { key: k.url, req: k, cachedAt: r ? cachedAtOf(r) : null };
    }),
  );
  const drop = new Set(entriesToTrim(entries, rule.maxEntries, rule.maxAgeMs, Date.now()));
  await Promise.all(entries.filter((e) => drop.has(e.key)).map((e) => cache.delete(e.req)));
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  if (!ms) return p;
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}
