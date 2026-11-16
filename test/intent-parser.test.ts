import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseIntent, extractRoute, extractTime } from '../src/chat/intent.ts';
import type { AppContext } from '../src/chat/protocol.ts';

const NOW = Date.parse('2026-11-16T10:00:00+01:00'); // Montag, 10:00 in Zürich
const empty: AppContext = { place: null, route: null, playing: false, timeMode: 'live', offsetHours: 0, weatherSummary: null };
const withRoute: AppContext = { ...empty, place: 'Zürich', route: { from: 'Zürich', to: 'Luzern', mode: 'car' } };
const p = (t: string, ctx: AppContext = empty) => parseIntent(t, ctx, NOW);

test('Orte zeigen und hinfliegen', () => {
  assert.deepEqual(p('Zeig mir Bern').actions, [{ type: 'flyTo', place: 'Bern' }]);
  assert.deepEqual(p('Flieg nach Zermatt').actions, [{ type: 'flyTo', place: 'Zermatt' }]);
  assert.deepEqual(p('flieg mal nach st. moritz!').actions, [{ type: 'flyTo', place: 'St. moritz' }]);
  assert.deepEqual(p('Zeig mer Züri').actions, [{ type: 'flyTo', place: 'Zürich' }]);
  assert.deepEqual(p('Wo liegt Andermatt?').actions, [{ type: 'flyTo', place: 'Andermatt' }]);
  assert.deepEqual(p('zeig 46.5, 8.1').actions, [{ type: 'flyTo', lat: 46.5, lon: 8.1 }]);
  assert.match(p('Flieg nach Zermatt').reply, /Zermatt/);
});

test('Wetter an einem Ort', () => {
  assert.deepEqual(p('Wie ist das Wetter in Luzern?').actions, [{ type: 'showPlace', place: 'Luzern' }]);
  assert.deepEqual(p('Wetter in Zermatt').actions, [{ type: 'showPlace', place: 'Zermatt' }]);
  assert.deepEqual(p('Wie isch s Wetter z Bärn?').actions, [{ type: 'showPlace', place: 'Bern' }]);
  assert.deepEqual(p('Regnet es in Basel?').actions, [{ type: 'showPlace', place: 'Basel' }]);
  assert.deepEqual(p('Wie wird das Wetter?').actions, [{ type: 'openWeather' }]);
  const w = p('Wetter morgen in Chur');
  assert.equal(w.actions[0].type, 'showPlace');
  assert.deepEqual(w.actions[1], { type: 'setTime', mode: 'travel', offsetHours: 22 });
});

test('Routen mit Verkehrsmittel', () => {
  assert.deepEqual(p('Von Zürich nach Luzern mit dem Zug').actions, [{ type: 'setRoute', from: 'Zürich', to: 'Luzern', mode: 'transit' }]);
  assert.deepEqual(p('Zürich nach Luzern mit dem ÖV').actions, [{ type: 'setRoute', from: 'Zürich', to: 'Luzern', mode: 'transit' }]);
  assert.deepEqual(p('von Bern nach Thun mit dem Auto').actions, [{ type: 'setRoute', from: 'Bern', to: 'Thun', mode: 'car' }]);
  assert.deepEqual(p('Von Luzern nach Zug mit dem Velo').actions, [{ type: 'setRoute', from: 'Luzern', to: 'Zug', mode: 'bike' }]);
  assert.deepEqual(p('Von Thun nach Spiez zu Fuss').actions, [{ type: 'setRoute', from: 'Thun', to: 'Spiez', mode: 'foot' }]);
  assert.deepEqual(p('Route Basel – Chur').actions, [{ type: 'setRoute', from: 'Basel', to: 'Chur' }]);
  assert.deepEqual(p('Basel - Chur').actions, [{ type: 'setRoute', from: 'Basel', to: 'Chur' }]);
  assert.deepEqual(p('vo Züri uf Bärn mit em Velo').actions, [{ type: 'setRoute', from: 'Zürich', to: 'Bern', mode: 'bike' }]);
  assert.deepEqual(p('Flug von Zürich nach London').actions, [{ type: 'setRoute', from: 'Zürich', to: 'London', mode: 'flight' }]);
  assert.deepEqual(p('Von Basel über Olten nach Luzern').actions, [{ type: 'setRoute', from: 'Basel', to: 'Luzern', via: ['Olten'] }]);
  assert.match(p('Von Zürich nach Luzern mit dem Zug').reply, /Zürich.*Luzern.*mit dem ÖV/);
});

test('Route mit Zeit', () => {
  const r = p('Von Zürich nach Luzern morgen um 8 mit dem Zug');
  assert.deepEqual(r.actions, [
    { type: 'setRoute', from: 'Zürich', to: 'Luzern', mode: 'transit' },
    { type: 'setTime', mode: 'travel', offsetHours: 22 },
  ]);
  assert.match(r.reply, /morgen um 08:00 Uhr/);
});

test('nur Ziel mit Verkehrsmittel nutzt den aktuellen Ort', () => {
  assert.deepEqual(p('Mit dem Auto nach Bern', withRoute).actions, [{ type: 'setRoute', from: 'Zürich', to: 'Bern', mode: 'car' }]);
  const q = p('Mit dem Auto nach Bern');
  assert.deepEqual(q.actions, []);
  assert.match(q.reply, /Von wo aus/);
});

test('Abspielen und Pause', () => {
  for (const t of ['Spiel ab', 'Start', 'Los', 'los!', 'Play']) assert.deepEqual(p(t, withRoute).actions, [{ type: 'play' }], t);
  for (const t of ['Stopp', 'Stop', 'Pause', 'anhalten']) assert.deepEqual(p(t, { ...withRoute, playing: true }).actions, [{ type: 'pause' }], t);
  const noRoute = p('Spiel ab');
  assert.deepEqual(noRoute.actions, []);
  assert.match(noRoute.reply, /keine Route/);
});

test('Verkehrsmittel allein', () => {
  assert.deepEqual(p('Mit dem Velo', withRoute).actions, [{ type: 'setMode', mode: 'bike' }]);
  assert.deepEqual(p('lieber mit dem Zug', withRoute).actions, [{ type: 'setMode', mode: 'transit' }]);
  assert.deepEqual(p('zu Fuss', withRoute).actions, [{ type: 'setMode', mode: 'foot' }]);
  assert.match(p('Mit dem Velo').reply, /Wohin/);
});

test('Zeit', () => {
  assert.deepEqual(p('Morgen um 8').actions, [{ type: 'setTime', mode: 'travel', offsetHours: 22 }]);
  assert.deepEqual(p('in 3 Stunden').actions, [{ type: 'setTime', mode: 'travel', offsetHours: 3 }]);
  assert.deepEqual(p('in drei Stunden').actions, [{ type: 'setTime', mode: 'travel', offsetHours: 3 }]);
  assert.deepEqual(p('heute Abend').actions, [{ type: 'setTime', mode: 'travel', offsetHours: 9 }]);
  assert.deepEqual(p('übermorgen um 14:30').actions, [{ type: 'setTime', mode: 'travel', offsetHours: 52.5 }]);
  assert.deepEqual(p('um 9 Uhr').actions, [{ type: 'setTime', mode: 'travel', offsetHours: 23 }]); // schon vorbei → morgen
  assert.deepEqual(p('zurück auf live').actions, [{ type: 'setTime', mode: 'live', offsetHours: 0 }]);
  assert.equal(extractTime('Zeig mir Bern', NOW), null);
});

test('Bergwetter', () => {
  assert.deepEqual(p('Kann ich aufs Matterhorn?').actions, [{ type: 'showMountain', peak: 'Matterhorn' }]);
  assert.deepEqual(p('Bergwetter Eiger').actions, [{ type: 'showMountain', peak: 'Eiger' }]);
  assert.deepEqual(p('Wie sind die Verhältnisse am Pilatus?').actions, [{ type: 'showMountain', peak: 'Pilatus (Tomlishorn)' }]);
  assert.deepEqual(p('Chan i morn uf de Säntis?').actions, [{ type: 'showMountain', peak: 'Säntis' }]);
  assert.deepEqual(p('Kann ich aufs Schwarzhorn?').actions, [{ type: 'showMountain', peak: 'Schwarzhorn' }]);
  assert.match(p('Kann ich aufs Matterhorn?').reply, /Verhältnisse am Matterhorn/);
});

test('Vergleich', () => {
  assert.deepEqual(p('Wie lange mit dem Zug?', withRoute).actions, [{ type: 'compareModes' }]);
  assert.deepEqual(p('Vergleich', withRoute).actions, [{ type: 'compareModes' }]);
  assert.deepEqual(p('Wie lange von Bern nach Thun?').actions, [{ type: 'setRoute', from: 'Bern', to: 'Thun' }, { type: 'compareModes' }]);
  assert.deepEqual(p('Vergleich').actions, []);
});

test('Hilfe, Gruss, Dank, Unbekanntes', () => {
  assert.match(p('Hilfe').reply, /Bergwetter/);
  assert.match(p('Was kannst du?').reply, /Routen/);
  assert.match(p('Hoi').reply, /Matterhorn/);
  assert.match(p('Danke!').reply, /Gern/);
  const u = p('Erzähl mir einen Witz über Kühe und Käse');
  assert.deepEqual(u.actions, []);
  assert.match(u.reply, /nicht verstanden.*„/);
  assert.deepEqual(p('').actions, []);
});

test('kurzer Ortsname allein', () => {
  assert.deepEqual(p('Luzern').actions, [{ type: 'showPlace', place: 'Luzern' }]);
});

test('Route-Extraktion', () => {
  assert.deepEqual(extractRoute('Zürich bis Bern'), { from: 'Zürich', to: 'Bern', via: [] });
  assert.equal(extractRoute('Flieg nach Zermatt'), null);
  assert.equal(extractRoute('Zeig mir Bern'), null);
});
