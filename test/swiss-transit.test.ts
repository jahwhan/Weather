import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  bestConnection,
  connectionLine,
  parseTransportDuration,
  transitCovers,
  type TConnectionsResponse,
} from '../src/swiss/transit.ts';

const fx = JSON.parse(readFileSync(new URL('./fixtures/transport-connections.json', import.meta.url), 'utf8')) as Record<
  string,
  TConnectionsResponse
>;

test('Dauer "00d00:41:00" parsen', () => {
  assert.equal(parseTransportDuration('00d00:41:00'), 41 * 60);
  assert.equal(parseTransportDuration('01d02:03:04'), 86400 + 7384);
  assert.equal(parseTransportDuration(null), null);
  assert.equal(parseTransportDuration('kaputt'), null);
});

test('Zürich HB -> Luzern: schnellste Verbindung IR 70 direkt, 41 min', () => {
  const best = bestConnection(fx['zh-lu'])!;
  assert.equal(best.duration, 41 * 60);
  assert.equal(best.detail, 'IR 70 · direkt');
  assert.equal(best.transfers, 0);
  // Linie: Zürich HB ... Luzern, Länge Luftlinie zwischen den Halten ~ 40–60 km
  const [lng0, lat0] = best.coords[0];
  const [lng1, lat1] = best.coords[best.coords.length - 1];
  assert.ok(Math.abs(lng0 - 8.540212) < 1e-4 && Math.abs(lat0 - 47.378176) < 1e-4, 'Start = Zürich HB (x/y vertauscht)');
  assert.ok(Math.abs(lng1 - 8.31018) < 1e-4 && Math.abs(lat1 - 47.050176) < 1e-4, 'Ziel = Luzern');
  assert.ok(best.distance > 40000 && best.distance < 60000, `Distanz ${best.distance}`);
});

test('Bern -> Zermatt: Umstieg im Detailtext', () => {
  const best = bestConnection(fx['bern-zermatt'])!;
  assert.equal(best.duration, 130 * 60);
  assert.equal(best.detail, 'IC 8 · R · 1 Umstieg');
});

test('Koordinaten als Start/Ziel: Fusswege werden gerade verbunden', () => {
  const c = fx.coords.connections![1];
  const line = connectionLine(c);
  // erster Punkt ist die Startkoordinate (Fussweg zum HB)
  assert.ok(Math.abs(line[0][0] - 8.5417) < 1e-4 && Math.abs(line[0][1] - 47.3769) < 1e-4);
  const last = line[line.length - 1];
  assert.ok(Math.abs(last[0] - 8.3093) < 1e-3 && Math.abs(last[1] - 47.0502) < 1e-3);
  assert.equal(bestConnection(fx.coords)!.duration, 53 * 60);
});

test('Leere/fehlerhafte Antworten', () => {
  assert.equal(bestConnection({ connections: [] }), null);
  assert.equal(bestConnection({}), null);
  assert.equal(bestConnection({ connections: [{ duration: null, sections: [] }] }), null);
});

test('transitCovers: Schweiz und grenznah ja, Paris nein', () => {
  const p = (lng: number, lat: number) => ({ name: '', detail: '', coord: [lng, lat] as [number, number], kind: '' });
  assert.equal(transitCovers([p(8.54, 47.37), p(8.31, 47.05)]), true);
  assert.equal(transitCovers([p(8.54, 47.37), p(9.18, 47.66)]), true, 'Konstanz grenznah');
  assert.equal(transitCovers([p(8.54, 47.37), p(2.35, 48.85)]), false);
  assert.equal(transitCovers([p(9.18, 47.66), p(9.75, 47.5)]), false, 'beide ausserhalb');
});
