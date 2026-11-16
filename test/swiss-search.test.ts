import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { cleanLabel, normalize, parseGeoAdminResults, type GeoAdminResponse } from '../src/swiss/search.ts';
import { mergeResults, searchPlaces, CACHE_KEY, type Place } from '../src/route/geocode.ts';

const fx = JSON.parse(readFileSync(new URL('./fixtures/geoadmin-search.json', import.meta.url), 'utf8')) as Record<
  string,
  GeoAdminResponse
>;

test('Label-Bereinigung', () => {
  assert.equal(cleanLabel('<b>Zürich (ZH)</b>'), 'Zürich (ZH)');
  assert.equal(cleanLabel('<i>Alpiner Gipfel</i> <b>Matterhorn</b> ()'), 'Alpiner Gipfel Matterhorn ()');
  assert.equal(cleanLabel('<b>Zürich\n</b> (ZH)'), 'Zürich (ZH)');
  assert.equal(normalize('  Zürich  HB '), 'zurich hb');
});

test('Luzern: Gemeinde zuerst, mit Kanton im Detail', () => {
  const r = parseGeoAdminResults(fx.Luzern, 'Luzern');
  assert.equal(r[0].name, 'Luzern');
  assert.equal(r[0].detail, 'Gemeinde, LU');
  assert.equal(r[0].kind, 'municipality');
  assert.ok(r[0].strong);
  assert.ok(Math.abs(r[0].coord[0] - 8.30) < 0.02 && Math.abs(r[0].coord[1] - 47.05) < 0.02);
  // doppelte Siedlung "Luzern" (Gazetteer) neben der Gemeinde entfernt
  assert.equal(r.filter((p) => p.name === 'Luzern' && p.kind !== 'canton').length, 1);
});

test('Matterhorn: Gipfel vor Gondelbahnen, Name ohne Fremdsprachen-Varianten', () => {
  const r = parseGeoAdminResults(fx.Matterhorn, 'Matterhorn');
  assert.equal(r[0].name, 'Matterhorn');
  assert.equal(r[0].kind, 'peak');
  assert.match(r[0].detail, /Gipfel/);
  const gondel = r.findIndex((p) => /Express/.test(p.name));
  assert.ok(gondel > 0);
});

test('Paris: nur schwache Schweizer Treffer (Flurnamen) -> Ausland gewinnt', () => {
  const r = parseGeoAdminResults(fx.Paris, 'Paris');
  assert.ok(r.length > 0);
  assert.ok(r.every((p) => !p.strong), r.filter((p) => p.strong).map((p) => p.name).join());
  const paris: Place = { name: 'Paris', detail: 'Île-de-France, FR', coord: [2.35, 48.85], kind: 'city' };
  const merged = mergeResults(r, [paris], 6);
  assert.equal(merged[0].name, 'Paris');
  assert.equal(merged.length, 6);
});

test('Rigi: Siedlungen per Wortanfang eindeutig, "Rigiblick" nicht', () => {
  const r = parseGeoAdminResults(fx.Rigi, 'Rigi');
  assert.ok(r[0].strong);
  assert.match(r[0].name, /^Rigi /);
});

test('Adresse mit Hausnummer: Adressen vorne, Detail = PLZ Ort', () => {
  const r = parseGeoAdminResults(fx['Bahnhofstrasse 1 Zürich'], 'Bahnhofstrasse 1 Zürich');
  assert.equal(r[0].name, 'Bahnhofstrasse 1');
  assert.equal(r[0].detail, '8001 Zürich');
  assert.ok(r[0].strong);
});

test('Zürich: Gemeinde vor Kanton vor Ausfahrten; Schweiz eindeutig -> keine Auslandstreffer vorne', () => {
  const r = parseGeoAdminResults(fx['Zürich'], 'Zürich');
  assert.deepEqual(
    r.slice(0, 2).map((p) => [p.name, p.kind]),
    [
      ['Zürich', 'municipality'],
      ['Zürich', 'canton'],
    ],
  );
  const merged = mergeResults(r, [{ name: 'Zürich', detail: 'ZH, CH', coord: [8.54, 47.37], kind: 'city' }], 4);
  assert.equal(merged[0].detail, 'Gemeinde, ZH');
  assert.equal(merged.length, 4);
});

test('searchPlaces: Vorbelegung über localStorage (Cache-Version v2) ohne Netz', async () => {
  const store = new Map<string, string>();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  };
  assert.equal(CACHE_KEY, 'wetterflug.geocode.v2');
  const place: Place = { name: 'Testort', detail: 'Gemeinde, ZH', coord: [8.5, 47.4], kind: 'municipality' };
  store.set(CACHE_KEY, JSON.stringify({ 'testort|6': [place] }));
  store.set('wetterflug.geocode.v1', '{}');
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error('kein Netz im Test');
  }) as typeof fetch;
  try {
    assert.deepEqual(await searchPlaces('Testort'), [place]);
    assert.equal(store.has('wetterflug.geocode.v1'), false, 'alter Cache entfernt');
    // Koordinaten werden direkt erkannt
    const c = await searchPlaces('47.37, 8.54');
    assert.equal(c[0].kind, 'coordinate');
  } finally {
    globalThis.fetch = realFetch;
  }
});
