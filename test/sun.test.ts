import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sunPosition, sunTimes, moonState, illuminanceLux, clearSkyGhi } from '../src/astro/sun.ts';

const ZH = { lat: 47.3769, lon: 8.5417 };

test('Sonnenhöchststand Zürich zur Sommersonnenwende', () => {
  const p = sunPosition(Date.UTC(2026, 5, 21, 11, 27), ZH.lat, ZH.lon);
  assert.ok(Math.abs(p.altitude - 66.0) < 0.6, `Höhe ${p.altitude}`);
  assert.ok(Math.abs(p.azimuth - 180) < 3, `Azimut ${p.azimuth}`);
});

test('Sonne am Morgen im Osten, am Abend im Westen', () => {
  const am = sunPosition(Date.UTC(2026, 2, 20, 7, 0), ZH.lat, ZH.lon);
  const pm = sunPosition(Date.UTC(2026, 2, 20, 16, 0), ZH.lat, ZH.lon);
  assert.ok(am.azimuth > 90 && am.azimuth < 140, `morgens ${am.azimuth}`);
  assert.ok(pm.azimuth > 220 && pm.azimuth < 270, `abends ${pm.azimuth}`);
});

test('Auf- und Untergang Zürich am 21. Juni', () => {
  const t = sunTimes(Date.UTC(2026, 5, 21, 12), ZH.lat, ZH.lon);
  const rise = new Date(t.sunrise!);
  const set = new Date(t.sunset!);
  // 05:29 und 21:26 Sommerzeit = 03:29 und 19:26 UTC
  assert.ok(Math.abs(rise.getUTCHours() * 60 + rise.getUTCMinutes() - (3 * 60 + 29)) <= 4, rise.toISOString());
  assert.ok(Math.abs(set.getUTCHours() * 60 + set.getUTCMinutes() - (19 * 60 + 26)) <= 4, set.toISOString());
});

test('Polarnacht liefert keinen Sonnenaufgang', () => {
  const t = sunTimes(Date.UTC(2026, 11, 21, 12), 78.2, 15.6);
  assert.equal(t.sunrise, null);
});

test('Vollmond am 24. November 2026 ist fast voll beleuchtet', () => {
  const m = moonState(Date.UTC(2026, 10, 24, 15), ZH.lat, ZH.lon);
  assert.ok(m.fraction > 0.97, `Anteil ${m.fraction}`);
});

test('Helligkeit: Mittagssonne hell, Dämmerung dunkel', () => {
  assert.ok(illuminanceLux(60, clearSkyGhi(60)) > 80000);
  assert.ok(illuminanceLux(-6, 0) < 5);
  assert.ok(illuminanceLux(-20, 0) < 0.01);
});
