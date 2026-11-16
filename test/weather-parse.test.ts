import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  fetchWeather,
  MissingDataError,
  omPick,
  parseOpenMeteo,
  zoneOffsetSec,
  metZone,
  CH_MODELS,
  type OmResponse,
} from '../src/weather/fetch.ts';
import { cloudyUv, parseMetDetail, parseOpenMeteoDetail, localDate, type MetResponse } from '../src/weather/detail.ts';

const met = JSON.parse(readFileSync(new URL('./fixtures/met-zurich-complete.json', import.meta.url), 'utf8')) as MetResponse;

const T0 = Date.UTC(2026, 10, 16, 11, 0) / 1000;
const hours = (n: number) => Array.from({ length: n }, (_, i) => T0 + i * 3600);

/** Antwort im Mehrmodell-Format: Variablen mit Modellzusatz */
function multiModel(): OmResponse {
  const n = 6;
  return {
    latitude: 47.37,
    longitude: 8.54,
    elevation: 409,
    utc_offset_seconds: 3600,
    timezone: 'Europe/Zurich',
    current: {
      time: T0 + 900,
      temperature_2m_meteoswiss_icon_ch1: 10.9,
      temperature_2m_meteoswiss_icon_ch2: 11.6,
      temperature_2m_best_match: 11.0,
      weather_code_meteoswiss_icon_ch1: 3,
      is_day_best_match: 1,
    },
    hourly: {
      time: hours(n),
      temperature_2m_meteoswiss_icon_ch1: [10, 11, null, null, null, null],
      temperature_2m_meteoswiss_icon_ch2: [10.5, 11.5, 12, 12.5, null, null],
      temperature_2m_best_match: [9, 10, 11, 12, 13, 14],
      uv_index_meteoswiss_icon_ch1: [null, null, null, null, null, null],
      uv_index_best_match: [1, 1.5, 2, 1, 0.5, 0],
      freezing_level_height_meteoswiss_icon_ch2: [2160, 1980, 2000, 2100, null, null],
      freezing_level_height_best_match: [2300, 2200, 2100, 2000, 1900, 1800],
      snowfall_height_meteoswiss_icon_ch2: [1910, 1680, 1700, 1800, null, null],
      is_day_best_match: [1, 1, 1, 1, 1, 0],
    },
    daily: {
      time: [Date.UTC(2026, 10, 15, 23, 0) / 1000, Date.UTC(2026, 10, 16, 23, 0) / 1000],
      temperature_2m_max_meteoswiss_icon_ch2: [12.2, null],
      temperature_2m_max_best_match: [12.0, 9.5],
      temperature_2m_min_best_match: [5, 3],
      weather_code_meteoswiss_icon_ch2: [53, null],
      weather_code_best_match: [61, 3],
      uv_index_max_best_match: [1.5, 2],
      sunrise_best_match: [Date.UTC(2026, 10, 16, 6, 31) / 1000, Date.UTC(2026, 10, 17, 6, 33) / 1000],
      precipitation_sum_best_match: [4.2, 0],
      snowfall_sum_best_match: [0, 0],
    },
  };
}

test('omPick: feinstes Modell zuerst, Lücken aus den nächsten', () => {
  const r = multiModel();
  assert.deepEqual(omPick(r.hourly, 'temperature_2m', 0, CH_MODELS), { v: 10, model: 'meteoswiss_icon_ch1' });
  assert.deepEqual(omPick(r.hourly, 'temperature_2m', 2, CH_MODELS), { v: 12, model: 'meteoswiss_icon_ch2' });
  assert.deepEqual(omPick(r.hourly, 'temperature_2m', 5, CH_MODELS), { v: 14, model: 'best_match' });
  assert.equal(omPick(r.hourly, 'uv_index', 1, CH_MODELS).v, 1.5);
  // ohne Modellzusatz (Einzelmodell-Antwort)
  assert.deepEqual(omPick({ time: [0], temperature_2m: [7] }, 'temperature_2m', 0, null), { v: 7, model: null });
});

test('parseOpenMeteo: Mehrmodell-Antwort, Modell-Label aus dem aktuellen Wert', () => {
  const [p] = parseOpenMeteo([multiModel()], [{ lat: 47.37, lon: 8.54 }], CH_MODELS, 0);
  assert.equal(p.model, 'MeteoSchweiz ICON-CH1');
  assert.equal(p.current.temp, 10.9);
  assert.deepEqual(p.hourly.map((h) => h.temp), [10, 11, 12, 12.5, 13, 14]);
  assert.equal(p.utcOffsetSec, 3600);
  assert.equal(p.timezone, 'Europe/Zurich');
});

test('Modell-Label: "current" ohne Zusatz -> Stunde von jetzt entscheidet', () => {
  const r = multiModel();
  r.current = { time: T0 + 900, temperature_2m: 10.9 };
  const [p] = parseOpenMeteo([r], [{ lat: 47.37, lon: 8.54 }], CH_MODELS, (T0 + 900) * 1000);
  assert.equal(p.current.temp, 10.9);
  assert.equal(p.model, 'MeteoSchweiz ICON-CH1');
  const [q] = parseOpenMeteo([r], [{ lat: 47.37, lon: 8.54 }], CH_MODELS, (T0 + 3 * 3600) * 1000);
  assert.equal(q.model, 'MeteoSchweiz ICON-CH2');
});

test('parseOpenMeteo: ohne Werte -> MissingDataError (Auslöser für best_match)', () => {
  const r = multiModel();
  r.current = { time: T0 };
  assert.throws(() => parseOpenMeteo([r], [{ lat: 47.37, lon: 8.54 }], CH_MODELS), MissingDataError);
});

test('parseOpenMeteoDetail: Stunden ab jetzt, Tage zusammengeführt, Schneefallgrenze vom Modell', () => {
  const d = parseOpenMeteoDetail(multiModel(), 47.37, 8.54, CH_MODELS, (T0 + 1200) * 1000);
  assert.equal(d.hourly[0].time, T0 * 1000);
  assert.equal(d.hourly[0].uv, 1);
  assert.equal(d.current.temp, 10.9);
  assert.equal(d.current.isDay, true);
  assert.equal(d.freezingLevel, 2160);
  assert.equal(d.snowLine, 1910);
  assert.equal(d.snowLineEstimated, false);
  assert.equal(d.daily.length, 2);
  assert.equal(d.daily[0].date, '2026-11-16');
  assert.equal(d.daily[0].tMax, 12.2, 'Tag 1 von ICON-CH2');
  assert.equal(d.daily[1].tMax, 9.5, 'Tag 2 von best_match');
  assert.equal(d.daily[0].code, 53);
  assert.equal(d.daily[0].sunrise, Date.UTC(2026, 10, 16, 6, 31));
  assert.equal(d.model, 'MeteoSchweiz ICON-CH1');
});

test('parseOpenMeteoDetail: ohne snowfall_height -> Schätzung Nullgradgrenze − 300 m', () => {
  const r = multiModel();
  delete r.hourly.snowfall_height_meteoswiss_icon_ch2;
  const d = parseOpenMeteoDetail(r, 47.37, 8.54, CH_MODELS, (T0 + 60) * 1000);
  assert.equal(d.snowLine, 2160 - 300);
  assert.equal(d.snowLineEstimated, true);
});

test('MET-Norway-Rückfall: 10-Tage-Aggregation aus 1-h- und 6-h-Blöcken', () => {
  const now = Date.parse('2026-11-16T10:20:00Z');
  const d = parseMetDetail(met, 47.3769, 8.5417, now);
  assert.equal(d.source, 'met-no');
  assert.equal(d.timezone, 'Europe/Zurich');
  assert.equal(d.utcOffsetSec, 3600);
  assert.ok(d.hourly.length >= 25, `${d.hourly.length} Stunden`);
  assert.equal(d.hourly[0].time, Date.parse('2026-11-16T10:00:00Z'));
  assert.ok(d.daily.length >= 9 && d.daily.length <= 10, `${d.daily.length} Tage`);
  for (let i = 1; i < d.daily.length; i++) {
    assert.equal(d.daily[i].time - d.daily[i - 1].time, 86400e3, 'aufeinanderfolgende Tage');
  }
  for (const day of d.daily) {
    assert.ok(day.tMax >= day.tMin);
    assert.ok(day.sunrise! < day.sunset!);
    assert.equal(localDate(day.time, 3600), day.date);
    assert.ok(day.windDirDominant == null || (day.windDirDominant >= 0 && day.windDirDominant < 360));
    assert.equal(day.snowfallSum, null);
  }
  // Sonnenaufgang Zürich Mitte November ~07:30 MEZ = 06:30 UTC
  const sr = new Date(d.daily[0].sunrise!);
  assert.ok(Math.abs(sr.getUTCHours() * 60 + sr.getUTCMinutes() - 390) < 15, sr.toISOString());
  assert.equal(d.snowLineEstimated, true);
  assert.ok(d.freezingLevel != null && d.snowLine === Math.max(0, d.freezingLevel - 300));
  // Niederschlagssumme nicht negativ, UV mit Bewölkung höchstens der Wert bei klarem Himmel
  assert.ok(d.daily.every((x) => x.precipSum == null || x.precipSum >= 0));
});

test('UV bei Bewölkung', () => {
  assert.equal(cloudyUv(4, 0), 4);
  assert.ok(Math.abs(cloudyUv(4, 100)! - 1) < 1e-9);
  assert.ok(cloudyUv(4, 50)! > 3.5);
  assert.equal(cloudyUv(null, 50), null);
});

test('Zeitzone über Intl: Europe/Zurich Winter/Sommer, MET-Rückfall', () => {
  assert.equal(zoneOffsetSec('Europe/Zurich', Date.UTC(2026, 0, 15, 12)), 3600);
  assert.equal(zoneOffsetSec('Europe/Zurich', Date.UTC(2026, 6, 15, 12)), 7200);
  assert.equal(zoneOffsetSec('Kein/Ort'), null);
  assert.deepEqual(metZone(47.37, 8.54, Date.UTC(2026, 6, 15, 12)), { utcOffsetSec: 7200, timezone: 'Europe/Zurich' });
  assert.deepEqual(metZone(40.7, -74.0), { utcOffsetSec: -5 * 3600, timezone: null });
});

test('fetchWeather-Kette: CH-Modelle -> HTTP 400 -> best_match', async () => {
  const urls: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL) => {
    const url = String(input);
    urls.push(url);
    if (url.includes('models=')) {
      return new Response(JSON.stringify({ error: true, reason: 'Invalid model' }), { status: 400 });
    }
    const r = multiModel();
    // Einzelmodell-Antwort: ohne Zusatz
    r.current = { time: T0, temperature_2m: 8 };
    r.hourly = { time: hours(3), temperature_2m: [8, 9, 10] };
    return new Response(JSON.stringify(r), { status: 200 });
  }) as typeof fetch;
  try {
    const w = await fetchWeather([{ lat: 47.3001, lon: 8.5001 }]);
    assert.equal(urls.length, 2);
    assert.match(urls[0], /models=meteoswiss_icon_ch1%2Cmeteoswiss_icon_ch2%2Cbest_match/);
    assert.doesNotMatch(urls[1], /models=/);
    assert.equal(w.source, 'open-meteo');
    assert.equal(w.points[0].current.temp, 8);
    assert.equal(w.points[0].model, 'Open-Meteo Best Match');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('fetchWeather-Kette: Tageslimit (429) -> direkt MET Norway, Zeitzone Europe/Zurich', async () => {
  const urls: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL) => {
    const url = String(input);
    urls.push(url);
    if (url.includes('open-meteo')) return new Response('{"error":true,"reason":"limit"}', { status: 429 });
    return new Response(JSON.stringify(met), { status: 200 });
  }) as typeof fetch;
  try {
    const w = await fetchWeather([{ lat: 46.9001, lon: 7.4001 }]);
    assert.equal(urls.filter((u) => u.includes('open-meteo')).length, 1);
    assert.equal(w.source, 'met-no');
    assert.equal(w.points[0].timezone, 'Europe/Zurich');
    assert.ok(w.points[0].utcOffsetSec === 3600 || w.points[0].utcOffsetSec === 7200);
    assert.ok(w.note);
  } finally {
    globalThis.fetch = realFetch;
  }
});
