import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRouteText, formatRouteText } from '../src/route/parse.ts';

test('einzelner Ort', () => {
  assert.deepEqual(parseRouteText('Bern'), ['Bern']);
});

test('A bis B in verschiedenen Schreibweisen', () => {
  for (const s of ['Zürich bis Bern', 'von Zürich nach Bern', 'Zürich - Bern', 'Zürich → Bern', 'Zürich -> Bern', 'Zürich to Bern']) {
    assert.deepEqual(parseRouteText(s), ['Zürich', 'Bern'], s);
  }
});

test('Bindestrich im Ortsnamen bleibt erhalten', () => {
  assert.deepEqual(parseRouteText('Rapperswil-Jona bis Bern'), ['Rapperswil-Jona', 'Bern']);
});

test('über-Orte liegen zwischen Start und Ziel', () => {
  assert.deepEqual(parseRouteText('von Basel über Olten nach Luzern'), ['Basel', 'Olten', 'Luzern']);
  assert.deepEqual(parseRouteText('Basel bis Luzern über Olten'), ['Basel', 'Olten', 'Luzern']);
});

test('Koordinaten', () => {
  assert.deepEqual(parseRouteText('47.37, 8.54 bis Bern'), ['47.37, 8.54', 'Bern']);
});

test('Text zurückschreiben', () => {
  assert.equal(formatRouteText(['A', 'B']), 'A bis B');
  assert.equal(formatRouteText(['A', 'B', 'C']), 'A über B bis C');
});
