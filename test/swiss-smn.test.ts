import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  applyObservation,
  parseSmnGeojson,
  parseSmnTime,
  parseStationsCsv,
  parseVqha80,
  pickNearest,
  shouldUseObservation,
  type StationObs,
} from '../src/swiss/smn.ts';
import type { WeatherSample } from '../src/weather/types.ts';

const read = (f: string, enc: BufferEncoding = 'utf8') => readFileSync(new URL(`./fixtures/${f}`, import.meta.url), enc);
const stations = parseStationsCsv(read('smn-stations.csv', 'latin1'));
const obs = parseVqha80(read('smn-VQHA80.csv', 'latin1'), stations);
const T = Date.UTC(2026, 10, 16, 11, 10);

test('Stationsverzeichnis: Name mit Umlaut, Koordinaten, Höhe', () => {
  const sma = stations.get('SMA')!;
  assert.equal(sma.name, 'Zürich / Fluntern');
  assert.ok(Math.abs(sma.lat - 47.378) < 0.01 && Math.abs(sma.lon - 8.566) < 0.01, `${sma.lat},${sma.lon}`);
  assert.equal(sma.elevation, 604);
  assert.equal(stations.size, 7);
});

test('VQHA80: Werte und fehlende Werte', () => {
  assert.equal(parseSmnTime('202611161110'), T);
  const klo = obs.find((o) => o.id === 'KLO')!;
  assert.equal(klo.time, T);
  assert.equal(klo.temp, 11.7);
  assert.equal(klo.humidity, 67.4);
  assert.equal(klo.windSpeed, 25.9);
  assert.equal(klo.windGust, 49.3);
  assert.equal(klo.windDir, 231);
  assert.equal(klo.pressureQff, 1011.5);
  assert.equal(klo.precip10min, 0);
  assert.equal(klo.sunshine10min, 0);
  // Bergstation ohne QFF ("-")
  const pil = obs.find((o) => o.id === 'PIL')!;
  assert.equal(pil.pressureQff, null);
  assert.equal(pil.temp, -1.1);
  // COM ohne Sonnenschein
  assert.equal(obs.find((o) => o.id === 'COM')!.sunshine10min, null);
});

test('GeoJSON-Rückfall: LV95-Koordinaten und Höhe', () => {
  const geo = parseSmnGeojson({ temp: JSON.parse(read('smn-temperature.json')) });
  const luz = geo.find((o) => o.id === 'LUZ')!;
  assert.ok(Math.abs(luz.lat - 47.036) < 0.01 && Math.abs(luz.lon - 8.301) < 0.01, `${luz.lat},${luz.lon}`);
  assert.ok(Math.abs(luz.elevation! - 455) < 3, `${luz.elevation}`);
  assert.equal(typeof luz.temp, 'number');
  assert.equal(luz.humidity, null);
});

test('Nächste Station: Zürich HB -> Fluntern, Luzern Bahnhof -> Luzern', () => {
  const zh = pickNearest(obs, 47.378, 8.54)!;
  assert.equal(zh.id, 'SMA');
  assert.ok(zh.distanceM > 1500 && zh.distanceM < 2500, `${zh.distanceM}`);
  assert.equal(pickNearest(obs, 47.05, 8.31)!.id, 'LUZ');
  // Pilatus Kulm auf 2100 m: Bergstation statt Luzern
  assert.equal(pickNearest(obs, 46.979, 8.254, { targetElevation: 2100 })!.id, 'PIL');
  // Paris: nichts in der Nähe
  assert.equal(pickNearest(obs, 48.85, 2.35), null);
});

test('shouldUseObservation: Distanz, Höhe, Alter', () => {
  const zh = pickNearest(obs, 47.378, 8.54)!;
  assert.equal(shouldUseObservation(zh, 560, T + 15 * 60e3), true);
  // Zürich HB (408 m) liegt 196 m tiefer als Fluntern (604 m): Messung nicht übernehmen
  assert.equal(shouldUseObservation(zh, 408, T + 15 * 60e3), false, 'Höhenunterschied 196 m');
  assert.equal(shouldUseObservation(zh, 900, T + 15 * 60e3), false, 'Höhenunterschied 300 m');
  assert.equal(shouldUseObservation(zh, null, T + 60 * 60e3), false, '50 min alt');
  const far: StationObs = { ...zh, distanceM: 12000 };
  assert.equal(shouldUseObservation(far, 600, T), false, '12 km');
});

test('applyObservation: Messung ersetzt Temperatur, Wind, Druck; Wolken bleiben', () => {
  const sample: WeatherSample = {
    time: T, temp: 9, feelsLike: 7, humidity: 80, dewPoint: 5, pressure: 1013, cloud: 90, cloudLow: 80,
    cloudMid: 50, cloudHigh: 10, precip: 0.2, snowfall: 0, code: 61, windSpeed: 10, windDir: 180, windGust: 20,
    visibility: 20000, shortwave: 100, direct: 10, diffuse: 90, fog: null,
  };
  const zh = obs.find((o) => o.id === 'SMA')!;
  const out = applyObservation(sample, zh);
  assert.equal(out.temp, 10.6);
  assert.ok(Math.abs(out.feelsLike! - 8.6) < 1e-9);
  assert.equal(out.humidity, 64.8);
  assert.ok(Math.abs(out.dewPoint! - 4.3) < 0.3, `Taupunkt ${out.dewPoint}`);
  assert.equal(out.windSpeed, 21.2);
  assert.equal(out.windGust, 48.6);
  assert.equal(out.windDir, 238);
  assert.equal(out.pressure, 1011.2);
  assert.equal(out.cloud, 90);
  assert.equal(out.code, 61);
  assert.equal(out.precip, 0.2);
});
