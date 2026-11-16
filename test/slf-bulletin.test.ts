import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pointInPolygon, pointInGeometry, parseBulletin, levelLabel, NO_BULLETIN_TEXT } from '../src/swiss/slf.ts';

const bulletin = JSON.parse(readFileSync(new URL('./fixtures/slf-bulletin-2026-11-16.geojson', import.meta.url), 'utf8'));

const square = (x0: number, y0: number, x1: number, y1: number) => [
  [x0, y0],
  [x1, y0],
  [x1, y1],
  [x0, y1],
  [x0, y0],
];

test('Punkt in einfachem Polygon', () => {
  const poly = [square(0, 0, 10, 10)];
  assert.equal(pointInPolygon([5, 5], poly), true);
  assert.equal(pointInPolygon([11, 5], poly), false);
  assert.equal(pointInPolygon([5, -1], poly), false);
});

test('Loch wird ausgespart', () => {
  const poly = [square(0, 0, 10, 10), square(4, 4, 6, 6)];
  assert.equal(pointInPolygon([5, 5], poly), false);
  assert.equal(pointInPolygon([2, 2], poly), true);
  assert.equal(pointInPolygon([7, 5], poly), true);
});

test('MultiPolygon', () => {
  const geom = { type: 'MultiPolygon' as const, coordinates: [[square(0, 0, 1, 1)], [square(5, 5, 6, 6)]] };
  assert.equal(pointInGeometry([0.5, 0.5], geom), true);
  assert.equal(pointInGeometry([5.5, 5.5], geom), true);
  assert.equal(pointInGeometry([3, 3], geom), false);
  assert.equal(pointInGeometry([0.5, 0.5], { type: 'Polygon', coordinates: [square(0, 0, 1, 1)] }), true);
});

test('Davos: Stufe 1, Altschnee oberhalb 2400 m', () => {
  const info = parseBulletin(bulletin, [9.836, 46.802], 1560);
  assert.ok(info);
  assert.equal(info.regionName, 'Davos');
  assert.equal(info.regionId, 'CH-5123');
  assert.equal(info.level, 1);
  assert.equal(info.levelLabel, '1 – gering');
  assert.deepEqual(info.problems, ['Altschnee']);
  assert.equal(info.elevationNote, 'oberhalb 2400 m');
  assert.deepEqual(info.aspects, ['N', 'NO', 'O', 'W', 'NW']);
  assert.equal(info.validUntil, Date.parse('2026-11-16T16:00:00Z'));
  assert.equal(info.url, 'https://www.slf.ch/de/lawinenbulletin-und-schneesituation/');
});

test('Zermatt / Matterhorn: Stufe 2, Triebschnee und Altschnee', () => {
  for (const pt of [[7.749, 46.02], [7.6586, 45.9764]] as [number, number][]) {
    const info = parseBulletin(bulletin, pt, 4478);
    assert.ok(info);
    assert.equal(info.regionName, 'Zermatt');
    assert.equal(info.level, 2);
    assert.equal(info.levelLabel, '2 – mässig');
    assert.deepEqual(info.problems, ['Triebschnee', 'Altschnee']);
    assert.equal(info.elevationNote, 'oberhalb 2400 m');
  }
});

test('Mittelland: Region ohne Gefahrenstufe', () => {
  const info = parseBulletin(bulletin, [7.44, 46.95]);
  assert.ok(info);
  assert.equal(info.level, null);
  assert.equal(info.regionName, 'Zentrales Mittelland');
});

test('ausserhalb, leer oder Unsinn → null', () => {
  assert.equal(parseBulletin(bulletin, [2.35, 48.85]), null); // Paris
  assert.equal(parseBulletin({ type: 'FeatureCollection', features: [] }, [9.8, 46.8]), null);
  assert.equal(parseBulletin(null, [9.8, 46.8]), null);
  assert.equal(parseBulletin('kaputt', [9.8, 46.8]), null);
  assert.equal(NO_BULLETIN_TEXT, 'Kein Lawinenbulletin (Sommer)');
});

test('höhenabhängige Stufen', () => {
  const poly = { type: 'Polygon', coordinates: [square(0, 0, 1, 1)] };
  const json = {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        geometry: poly,
        properties: {
          regions: [{ regionID: 'X', name: 'Test' }],
          dangerRatings: [
            { mainValue: 'considerable', elevation: { lowerBound: '2200' }, customData: { CH: { subdivision: 'plus' } } },
            { mainValue: 'moderate', elevation: { upperBound: '2200' } },
          ],
          avalancheProblems: [{ problemType: 'new_snow', elevation: { lowerBound: '2200' }, aspects: ['S', 'N'] }],
        },
      },
    ],
  };
  const high = parseBulletin(json, [0.5, 0.5], 3000)!;
  assert.equal(high.level, 3);
  assert.equal(high.levelLabel, '3+ – erheblich');
  assert.equal(high.elevationNote, 'oberhalb 2200 m');
  assert.deepEqual(high.aspects, ['N', 'S']);
  const low = parseBulletin(json, [0.5, 0.5], 1500)!;
  assert.equal(low.level, 2);
  assert.equal(low.elevationNote, 'unterhalb 2200 m');
  assert.equal(parseBulletin(json, [0.5, 0.5])!.level, 3); // ohne Höhe: die höhere Stufe
  assert.equal(levelLabel(5), '5 – sehr gross');
});
