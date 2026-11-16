import { test } from 'node:test';
import assert from 'node:assert/strict';
import { climbStats, rawClimb, fillGaps } from '../src/route/elevation.ts';
import { mapProfile } from '../src/swiss/profile.ts';

test('Hysterese: Rauschen unter der Schwelle zählt nicht', () => {
  // flach mit ±3 m Rauschen über 100 Punkte
  const noisy = Array.from({ length: 100 }, (_, i) => 500 + (i % 2 ? 3 : -3));
  assert.deepEqual(climbStats(noisy, 7), { gain: 0, loss: 0 });
  // rohes Aufsummieren macht daraus ~600 m
  assert.ok(rawClimb(noisy).gain > 290);
});

test('Hysterese: echter Anstieg bleibt erhalten', () => {
  // 400 -> 800 m in 2-m-Schritten, mit ±2 m Rauschen, dann zurück auf 450
  const up = Array.from({ length: 201 }, (_, i) => 400 + 2 * i + (i % 2 ? 2 : -2));
  const down = Array.from({ length: 36 }, (_, i) => 800 - 10 * i);
  const { gain, loss } = climbStats([...up, ...down], 7);
  assert.ok(Math.abs(gain - 400) <= 10, `gain ${gain}`);
  assert.ok(Math.abs(loss - 350) <= 10, `loss ${loss}`);
});

test('Hysterese: Lücken (NaN) werden übersprungen', () => {
  assert.deepEqual(climbStats([400, NaN, 420, NaN, 400], 7), { gain: 20, loss: 20 });
  assert.deepEqual(fillGaps([NaN, 5, NaN, 7]), [5, 5, 5, 7]);
});

test('swisstopo-Profil auf eigene Punkte abbilden (inkl. Zwischenpunkte und Lücken)', () => {
  // Antwort mit eingefügtem Zwischenpunkt bei 150 m und fehlender Höhe bei 250 m
  const resp = [
    { dist: 0, alts: { COMB: 400 } },
    { dist: 100, alts: { COMB: 410 } },
    { dist: 150, alts: { COMB: 430 } },
    { dist: 200, alts: { COMB: 420 } },
    { dist: 250, alts: { COMB: null, DTM25: null } },
    { dist: 300, alts: { COMB: 440 } },
  ];
  const ele = mapProfile(resp, [0, 100, 200, 300]);
  assert.deepEqual(ele, [400, 410, 420, 440]);
  // leicht abweichende Gesamtlänge wird skaliert
  const scaled = mapProfile(resp, [0, 101, 202, 303]);
  assert.deepEqual(scaled.map((v) => Math.round(v)), [400, 410, 420, 440]);
  assert.ok(mapProfile([], [0, 1]).every((v) => Number.isNaN(v)));
});
