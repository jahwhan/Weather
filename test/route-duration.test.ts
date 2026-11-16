import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatDuration, compareModes } from '../src/route/modes.ts';
import { plausibleDuration, PROFILE_LABEL, DEFAULT_PROFILE } from '../src/route/routing.ts';

test('formatDuration: Minuten', () => {
  assert.equal(formatDuration(41 * 60), '41 min');
  assert.equal(formatDuration(20), '1 min');
  assert.equal(formatDuration(59 * 60 + 20), '59 min');
});

test('formatDuration: Stunden mit zweistelligen Minuten', () => {
  assert.equal(formatDuration(3900), '1 h 05 min');
  assert.equal(formatDuration(3 * 3600), '3 h');
  assert.equal(formatDuration(3 * 3600 + 23 * 60), '3 h 23 min');
  assert.equal(formatDuration(59 * 60 + 40), '1 h');
});

test('formatDuration: Tage', () => {
  assert.equal(formatDuration(24 * 3600), '1 Tag');
  assert.equal(formatDuration(27 * 3600), '1 Tag 3 h');
  assert.equal(formatDuration(51 * 3600 + 10 * 60), '2 Tage 3 h');
  assert.equal(formatDuration(48 * 3600), '2 Tage');
});

test('formatDuration: ungültige Werte', () => {
  assert.equal(formatDuration(NaN), '–');
  assert.equal(formatDuration(-5), '–');
});

test('Profile: Auto ist Standard, ÖV vorhanden', () => {
  assert.equal(DEFAULT_PROFILE, 'car');
  assert.deepEqual(Object.keys(PROFILE_LABEL), ['car', 'transit', 'bike', 'foot', 'flight']);
  assert.equal(PROFILE_LABEL.transit, 'ÖV');
});

test('plausibleDuration: OSRM-Velo/Fuss nur bei unplausiblem Tempo ersetzen', () => {
  // Zürich -> Luzern, live gemessen: Velo 51.8 km in 203 min (15.3 km/h) bleibt
  assert.equal(plausibleDuration('bike', 203 * 60, 51800), 203 * 60);
  // 50 km in 30 min Velo (100 km/h) ist unsinnig -> 16 km/h
  assert.equal(Math.round(plausibleDuration('bike', 1800, 50000)), Math.round((50 / 16) * 3600));
  // Fuss 48 km in 2 h -> 4.7 km/h
  assert.equal(Math.round(plausibleDuration('foot', 7200, 48000)), Math.round((48 / 4.7) * 3600));
  // Auto bleibt unverändert
  assert.equal(plausibleDuration('car', 100, 50000), 100);
});

test('compareModes: ein Ort -> alles nicht verfügbar, Reihenfolge fix', async () => {
  const r = await compareModes([{ name: 'Zürich', detail: '', coord: [8.54, 47.37], kind: 'x' }]);
  assert.deepEqual(r.map((m) => m.profile), ['car', 'transit', 'bike', 'foot']);
  assert.ok(r.every((m) => m.status === 'unavailable'));
});

test('compareModes: Zürich -> Paris ohne Netz: Fuss/Velo zu weit, ÖV nur Schweiz', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error('offline');
  }) as typeof fetch;
  try {
    const r = await compareModes([
      { name: 'Zürich', detail: '', coord: [8.54, 47.37], kind: 'x' },
      { name: 'Paris', detail: '', coord: [2.35, 48.85], kind: 'x' },
    ]);
    const by = Object.fromEntries(r.map((m) => [m.profile, m]));
    assert.equal(by.foot.status, 'unavailable');
    assert.equal(by.bike.status, 'unavailable');
    assert.equal(by.transit.status, 'unavailable');
    assert.equal(by.car.status, 'error');
  } finally {
    globalThis.fetch = realFetch;
  }
});
