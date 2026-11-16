import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PEAKS, findPeak, normalize, peakQuery, wgs84ToLv95 } from '../src/mountain/peaks.ts';

test('Liste: 4000er und beliebte Gipfel, plausible Koordinaten', () => {
  const big = PEAKS.filter((p) => p.is4000);
  assert.ok(big.length >= 45, `nur ${big.length} 4000er`);
  for (const p of big) assert.ok(p.elevation >= 4000, p.name);
  const ids = new Set<string>();
  for (const p of PEAKS) {
    assert.ok(!ids.has(p.id), `doppelte id ${p.id}`);
    ids.add(p.id);
    assert.ok(p.lat > 45.8 && p.lat < 47.9 && p.lon > 5.9 && p.lon < 10.6, `${p.name} ausserhalb CH`);
  }
});

test('Aliase und Umschreibungen', () => {
  const cases: [string, string][] = [
    ['Matterhorn', 'matterhorn'],
    ['Kann ich aufs Matterhorn?', 'matterhorn'],
    ['Cervin', 'matterhorn'],
    ['monte cervino', 'matterhorn'],
    ['Monte Rosa', 'dufourspitze'],
    ['Wie sind die Verhältnisse am Pilatus?', 'pilatus'],
    ['Bergwetter Eiger', 'eiger'],
    ['Moench', 'moench'],
    ['MÖNCH', 'moench'],
    ['auf den Säntis', 'saentis'],
    ['Saentis', 'saentis'],
    ['Piz Palü', 'piz-palue'],
    ['Piz Palue', 'piz-palue'],
    ['aufs Klein Matterhorn', 'klein-matterhorn'],
    ['Grand Combin', 'grand-combin'],
    ['Tödi', 'toedi'],
    ['Rigi', 'rigi'],
    ['Uetliberg', 'uetliberg'],
    ['Dent d’Hérens', 'dent-d-herens'],
    ['des Matterhorns', 'matterhorn'],
    ['Moléson', 'moleson'],
  ];
  for (const [q, id] of cases) assert.equal(findPeak(q)?.id, id, q);
});

test('nichts gefunden', () => {
  assert.equal(findPeak('Zürich nach Bern'), null);
  assert.equal(findPeak(''), null);
  assert.equal(findPeak('Hallo'), null);
});

test('Normalisierung und Suchtext', () => {
  assert.equal(normalize('Grüezi  Mönch!'), 'gruzi monch');
  assert.equal(peakQuery('Kann ich aufs Schwarzhorn?'), 'Schwarzhorn');
  assert.equal(peakQuery('Bergwetter am Hohgant'), 'Hohgant');
});

test('WGS84 → LV95 (Bern, Zimmerwald)', () => {
  const [e, n] = wgs84ToLv95(46.9511, 7.4386);
  assert.ok(Math.abs(e - 2600000) < 100 && Math.abs(n - 1200000) < 100, `${e} ${n}`);
});
