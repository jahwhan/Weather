import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CACHED_AT_HEADER,
  classify,
  entriesToTrim,
  isCacheable,
  isFresh,
  isTileMeta,
  parseCachedAt,
  precacheList,
  precacheName,
  RULES,
  RUNTIME,
  staleCaches,
} from '../src/pwa/rules.ts';
import { cachedAt, stampCached } from '../src/pwa/stamp.ts';

const SCOPE = 'https://jahwhan.github.io/Weather/';
const get = (url: string, extra: Partial<{ mode: string; destination: string; method: string; hasRange: boolean }> = {}) =>
  classify({ url, method: 'GET', mode: 'cors', ...extra }, SCOPE)?.name ?? null;

test('Seitenaufrufe im Geltungsbereich: network-first mit 3 s', () => {
  assert.equal(get('https://jahwhan.github.io/Weather/', { mode: 'navigate', destination: 'document' }), 'navigate');
  assert.equal(get('https://jahwhan.github.io/Weather/?r=Bern&p=car', { mode: 'navigate' }), 'navigate');
  assert.equal(get('https://jahwhan.github.io/Weather/?source=pwa', { mode: 'navigate' }), 'navigate');
  assert.equal(RULES.navigate.strategy, 'network-first');
  assert.equal(RULES.navigate.timeoutMs, 3000);
  // andere Seiten auf derselben Domain gehören nicht zur App
  assert.equal(get('https://jahwhan.github.io/andere-app/', { mode: 'navigate' }), null);
});

test('gehashte Build-Dateien und Icons: cache-first', () => {
  assert.equal(get('https://jahwhan.github.io/Weather/assets/index-7fJgCrQm.js'), 'shell');
  assert.equal(get('https://jahwhan.github.io/Weather/assets/maplibre-gl-worker-CMkqA50c.mjs'), 'shell');
  assert.equal(get('https://jahwhan.github.io/Weather/icons/icon-192.png'), 'shell');
  assert.equal(get('https://jahwhan.github.io/Weather/manifest.webmanifest'), 'shell');
  assert.equal(RULES.shell.strategy, 'cache-first');
  // der Service Worker selbst nie
  assert.equal(get('https://jahwhan.github.io/Weather/sw.js'), null);
});

test('Kartenkacheln: cache-first mit Limit und Ablauf', () => {
  for (const u of [
    'https://tiles.openfreemap.org/planet/20251112_001001_pt/9/267/179.pbf',
    'https://tiles.openfreemap.org/fonts/Noto%20Sans%20Regular/0-255.pbf',
    'https://wmts.geo.admin.ch/1.0.0/ch.swisstopo.swissimage/default/current/3857/12/2138/1438.jpeg',
    'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/9/179/267',
    'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/10/534/358.png',
    'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/VIIRS_Black_Marble/default/2016-01-01/GoogleMapsCompatible_Level8/5/11/16.png',
    'https://vectortiles.geo.admin.ch/tiles/ch.swisstopo.base.vt/v1.0.0/10/534/358.pbf',
  ]) {
    assert.equal(get(u), 'tiles', u);
  }
  assert.equal(RULES.tiles.strategy, 'cache-first');
  assert.ok(RULES.tiles.maxEntries > 100 && RULES.tiles.maxEntries <= 2000);
  assert.ok(Number.isFinite(RULES.tiles.maxAgeMs));
  // andere Buckets auf S3 nicht
  assert.equal(get('https://s3.amazonaws.com/irgendwas/datei.png'), null);
});

test('TileJSON und Stil-JSON: stale-while-revalidate', () => {
  assert.equal(get('https://tiles.openfreemap.org/planet'), 'tile-meta');
  assert.equal(get('https://vectortiles.geo.admin.ch/styles/ch.swisstopo.basemap.vt/style.json'), 'tile-meta');
  assert.equal(isTileMeta(new URL('https://tiles.openfreemap.org/planet/20251112_001001_pt/9/267/179.pbf')), false);
  assert.equal(RULES['tile-meta'].strategy, 'stale-while-revalidate');
});

test('Wetter- und Daten-Dienste: network-first mit Timeout, kleines Limit, max. Alter', () => {
  for (const u of [
    'https://api.open-meteo.com/v1/forecast?latitude=47.37&longitude=8.54&current=temperature_2m',
    'https://api.met.no/weatherapi/locationforecast/2.0/complete?lat=47.37&lon=8.54',
    'https://data.geo.admin.ch/ch.meteoschweiz.messwerte-aktuell/VQHA80.csv',
    'https://api3.geo.admin.ch/rest/services/SearchServer?searchText=Bern',
    'https://aws.slf.ch/api/bulletin/caaml/de/geojson',
    'https://transport.opendata.ch/v1/connections?from=Z%C3%BCrich&to=Luzern',
    'https://routing.openstreetmap.de/routed-car/route/v1/driving/8.5,47.3;8.3,47.0',
    'https://router.project-osrm.org/route/v1/driving/8.5,47.3;8.3,47.0',
  ]) {
    assert.equal(get(u), 'data', u);
  }
  const r = RULES.data;
  assert.equal(r.strategy, 'network-first');
  assert.ok(r.timeoutMs > 0 && r.timeoutMs <= 6000);
  assert.ok(r.maxEntries <= 100);
  assert.ok(r.maxAgeMs <= 24 * 3600e3);
});

test('POST, Teil-Abfragen, Chat (n8n) und fremde Hosts: nie über den Cache', () => {
  assert.equal(get('https://api.open-meteo.com/v1/forecast?x=1', { method: 'POST' }), null);
  assert.equal(get('https://bomboclatt.app.n8n.cloud/webhook/wetterflug-chat'), null);
  assert.equal(get('https://bomboclatt.app.n8n.cloud/webhook/wetterflug-chat', { method: 'POST' }), null);
  assert.equal(get('https://mein-server.example/webhook/abc'), null);
  assert.equal(get('https://example.com/irgendwas.json'), null);
  assert.equal(get('https://tiles.openfreemap.org/planet/1/0/0.pbf', { hasRange: true }), null);
  // Verbindungsprüfung geht am SW vorbei
  assert.equal(get('https://jahwhan.github.io/Weather/manifest.webmanifest?__wf_probe=1'), null);
  assert.equal(get('chrome-extension://abc/x.js'), null);
});

test('Geltungsbereich im Unterordner und an der Wurzel', () => {
  assert.equal(classify({ url: 'http://localhost:4173/assets/a.js', method: 'GET' }, 'http://localhost:4173/')?.name, 'shell');
  assert.equal(classify({ url: 'http://localhost:4173/Weather/assets/a.js', method: 'GET' }, 'http://localhost:4173/Weather/')?.name, 'shell');
  assert.equal(classify({ url: 'http://localhost:4173/assets/a.js', method: 'GET' }, 'http://localhost:4173/Weather/'), null);
});

test('nur vollständige Antworten speichern, opake nur auf Wunsch', () => {
  assert.equal(isCacheable({ status: 200, type: 'cors' }, RULES.tiles), true);
  assert.equal(isCacheable({ status: 206, type: 'cors' }, RULES.tiles), false);
  assert.equal(isCacheable({ status: 404, type: 'cors' }, RULES.tiles), false);
  assert.equal(isCacheable({ status: 429, type: 'cors' }, RULES.data), false);
  assert.equal(isCacheable({ status: 0, type: 'opaque' }, RULES.tiles), false);
  assert.equal(isCacheable({ status: 0, type: 'opaque' }, { ...RULES.tiles, allowOpaque: true }), true);
});

test('Frische und Zeitstempel', () => {
  const now = 1_700_000_000_000;
  assert.equal(isFresh(now - 1000, 60e3, now), true);
  assert.equal(isFresh(now - 61e3, 60e3, now), false);
  assert.equal(isFresh(null, 60e3, now), false);
  assert.equal(isFresh(null, Infinity, now), true);
  assert.equal(parseCachedAt(String(now)), now);
  assert.equal(parseCachedAt('abc'), null);
  assert.equal(parseCachedAt(null), null);
});

test('Trimmen: Abgelaufene raus, dann die ältesten bis zum Limit', () => {
  const now = 10_000;
  const e = (key: string, cachedAt: number | null) => ({ key, cachedAt });
  // abgelaufen: a; Limit 2 → von b,c,d die älteste (b) zusätzlich
  assert.deepEqual(entriesToTrim([e('a', 0), e('b', 9000), e('c', 9500), e('d', 9800)], 2, 5000, now), ['a', 'b']);
  // ohne Zeitstempel gilt als ältester
  assert.deepEqual(entriesToTrim([e('a', 9000), e('b', null), e('c', 9500)], 2, Infinity, now), ['b']);
  // gleiche Zeit: Einfüge-Reihenfolge
  assert.deepEqual(entriesToTrim([e('a', 5), e('b', 5), e('c', 5)], 1, Infinity, now), ['a', 'b']);
  // unter dem Limit, nichts abgelaufen
  assert.deepEqual(entriesToTrim([e('a', 9000)], 5, 5000, now), []);
});

test('alte Caches beim Aktivieren löschen, Laufzeit-Caches behalten', () => {
  const v = 'abc123';
  const existing = [precacheName('alt999'), precacheName(v), RUNTIME.tiles, RUNTIME.data, RUNTIME.shell, RUNTIME.tileMeta, 'wf-tiles-v0', 'fremder-cache'];
  assert.deepEqual(staleCaches(existing, v), [precacheName('alt999'), 'wf-tiles-v0']);
});

test('Vorab-Liste aus dem Build', () => {
  assert.deepEqual(precacheList(['index.html', 'assets/a.js', 'assets/a.js.map', 'sw.js', './icons/i.png', 'assets/a.js', '.DS_Store']), [
    'assets/a.js',
    'icons/i.png',
    'index.html',
  ]);
});

test('Antwort aus dem SW-Cache: fetchedAt = Speicherzeitpunkt', () => {
  const old = Date.now() - 2 * 3600e3;
  const cached = new Response('{}', { headers: { [CACHED_AT_HEADER]: String(old) } });
  assert.equal(cachedAt(cached), old);
  assert.equal(stampCached({ fetchedAt: Date.now() }, cached).fetchedAt, old);
  const fresh = new Response('{}');
  const now = Date.now();
  assert.equal(cachedAt(fresh), null);
  assert.equal(stampCached({ fetchedAt: now }, fresh).fetchedAt, now);
});
