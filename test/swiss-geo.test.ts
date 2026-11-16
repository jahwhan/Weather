import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lv95ToWgs84, wgs84ToLv95 } from '../src/swiss/lv95.ts';
import { isInSwitzerland, isSwissRoute } from '../src/swiss/region.ts';

const dms = (d: number, m: number, s: number) => d + m / 60 + s / 3600;

test('LV95 -> WGS84: Projektionszentrum alte Sternwarte Bern', () => {
  const [lng, lat] = lv95ToWgs84([2600000, 1200000]);
  assert.ok(Math.abs(lng - 7.43863) < 2e-5, `lng ${lng}`);
  assert.ok(Math.abs(lat - 46.95108) < 2e-5, `lat ${lat}`);
});

test('WGS84 -> LV95: Beispiel aus der swisstopo-Dokumentation (±1 m)', () => {
  // 46° 02' 38.87" N, 8° 43' 49.79" E -> E 2 699 999.76, N 1 099 999.97
  const [E, N] = wgs84ToLv95([dms(8, 43, 49.79), dms(46, 2, 38.87)]);
  assert.ok(Math.abs(E - 2699999.76) < 1, `E ${E}`);
  assert.ok(Math.abs(N - 1099999.97) < 1, `N ${N}`);
});

test('LV95 hin und zurück bleibt unter 3 m (je Richtung ~1 m)', () => {
  for (const p of [
    [8.5417, 47.3769],
    [6.1432, 46.2044],
    [9.8306, 46.8007],
    [7.6586, 45.9764],
  ] as [number, number][]) {
    const back = lv95ToWgs84(wgs84ToLv95(p));
    const dx = (back[0] - p[0]) * 111320 * Math.cos((p[1] * Math.PI) / 180);
    const dy = (back[1] - p[1]) * 110570;
    assert.ok(Math.hypot(dx, dy) < 3, `Abweichung ${Math.hypot(dx, dy)} m bei ${p}`);
  }
});

test('isInSwitzerland: Schweizer Städte drin', () => {
  assert.equal(isInSwitzerland([8.5417, 47.3769]), true, 'Zürich');
  assert.equal(isInSwitzerland([6.1432, 46.2044]), true, 'Genf');
  assert.equal(isInSwitzerland([8.9511, 46.0037]), true, 'Lugano');
  assert.equal(isInSwitzerland([7.4474, 46.948]), true, 'Bern');
  assert.equal(isInSwitzerland([7.5886, 47.5596]), true, 'Basel');
  assert.equal(isInSwitzerland([7.7491, 46.0207]), true, 'Zermatt');
  assert.equal(isInSwitzerland([9.5209, 47.141]), true, 'Vaduz (FL)');
  assert.equal(isInSwitzerland([9.1753, 47.6475]), true, 'Kreuzlingen');
});

test('isInSwitzerland: Nachbarorte draussen', () => {
  assert.equal(isInSwitzerland([9.1757, 47.6633]), false, 'Konstanz');
  assert.equal(isInSwitzerland([9.19, 45.4642]), false, 'Mailand');
  assert.equal(isInSwitzerland([7.6616, 47.6145]), false, 'Lörrach');
  assert.equal(isInSwitzerland([6.2366, 46.1953]), false, 'Annemasse');
  assert.equal(isInSwitzerland([9.7471, 47.5031]), false, 'Bregenz');
  assert.equal(isInSwitzerland([9.0852, 45.8081]), false, 'Como');
  assert.equal(isInSwitzerland([2.35, 48.85]), false, 'Paris');
});

test('isSwissRoute', () => {
  const zhLu: [number, number][] = [
    [8.54, 47.378],
    [8.5, 47.25],
    [8.42, 47.15],
    [8.31, 47.05],
  ];
  assert.equal(isSwissRoute(zhLu), true);
  assert.equal(isSwissRoute(zhLu, 'all'), true);
  const zhMilano: [number, number][] = [...zhLu, [8.9, 46.0], [9.0, 45.8], [9.1, 45.6], [9.19, 45.46], [9.2, 45.4]];
  assert.equal(isSwissRoute(zhMilano, 'all'), false);
  assert.equal(isSwissRoute([]), false);
});
