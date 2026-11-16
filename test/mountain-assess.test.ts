import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseOpenMeteo, parseMetNo, windAtAltitude, metSymbolToCode, openMeteoUrl, applyAltitudeWind } from '../src/mountain/fetch.ts';
import { assessMountain, findBestWindow, windChill, DISCLAIMER, type MountainHour } from '../src/mountain/assess.ts';
import { findPeak } from '../src/mountain/peaks.ts';
import { parseBulletin } from '../src/swiss/slf.ts';

const fx = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));
const matterhorn = findPeak('Matterhorn')!;
const titlis = findPeak('Titlis')!;

function report(file: string, peak = matterhorn, now: number, avalanche = null as ReturnType<typeof parseBulletin>, pastKnown = true) {
  const hourly = parseOpenMeteo(fx(file), peak.elevation);
  return assessMountain({ peak, now, hourly, avalanche, pastKnown });
}

const DRY_NOW = Date.parse('2026-08-11T06:00:00+02:00');
const WET_NOW = Date.parse('2026-08-11T17:00:00+02:00');
const FOEHN_NOW = Date.parse('2026-11-16T10:00:00+01:00');

test('Open-Meteo parsen: 144 Stunden, Druckflächenwind in Gipfelhöhe', () => {
  const h = parseOpenMeteo(fx('mountain-om-dry-matterhorn.json'), 4478);
  assert.equal(h.length, 144);
  assert.equal(h[0].time, Date.parse('2026-08-09T00:00:00+02:00'));
  assert.ok(h.every((x) => x.windAlt != null && x.isDay != null));
  // ISO-Zeiten (ohne Zone) mit utc_offset_seconds
  const iso = parseOpenMeteo({ utc_offset_seconds: 3600, hourly: { time: ['2026-11-16T10:00'], temperature_2m: [1] } }, 500);
  assert.equal(iso[0].time, Date.parse('2026-11-16T10:00:00+01:00'));
  assert.throws(() => parseOpenMeteo({}, 100));
});

test('Wind in Gipfelhöhe interpolieren', () => {
  const lv = { 850: 20, 700: 40, 600: 60, 500: 80 };
  assert.equal(windAtAltitude(1000, lv), null);
  assert.equal(windAtAltitude(3000, lv), 40);
  assert.equal(windAtAltitude(3600, lv), 50);
  assert.equal(windAtAltitude(4200, lv), 60);
  assert.equal(windAtAltitude(6000, lv), 80);
  assert.equal(windAtAltitude(3600, { 850: null, 700: 40, 600: null, 500: null }), 40);
});

test('URL: Gipfelhöhe, Rückblick, Druckflächen, ICON-CH2', () => {
  const u = new URL(openMeteoUrl(matterhorn, 'meteoswiss_icon_ch2'));
  assert.equal(u.searchParams.get('elevation'), '4478');
  assert.equal(u.searchParams.get('past_days'), '3');
  assert.equal(u.searchParams.get('models'), 'meteoswiss_icon_ch2');
  assert.match(u.searchParams.get('hourly')!, /wind_speed_600hPa/);
  assert.equal(new URL(openMeteoUrl(matterhorn, null)).searchParams.get('models'), null);
});

test('trocken & stabil → gut, bestes Fenster heute früh', () => {
  const r = report('mountain-om-dry-matterhorn.json', matterhorn, DRY_NOW);
  assert.equal(r.verdict, 'gut');
  assert.equal(r.headline, 'Gute Verhältnisse am Matterhorn.');
  assert.ok(r.reasons.every((x) => x.kind === 'ok'));
  assert.ok(r.bestWindow);
  assert.match(r.bestWindow.label, /^heute 06–\d\d Uhr$/);
  assert.equal(r.disclaimer, DISCLAIMER);
  const facts = Object.fromEntries(r.facts.map((f) => [f.label, f.value]));
  assert.equal(facts['Neuschnee 72 h'], '0 cm');
  assert.equal(facts['Gewitterrisiko'], 'gering');
  assert.equal(facts['Lawinengefahr'], 'Kein Lawinenbulletin (Sommer)');
  assert.match(facts['Temperatur am Gipfel'], /^−\d+ °C/);
});

test('nass nach Regen → abraten, Fels nass, morgen früh besser', () => {
  const r = report('mountain-om-wet-matterhorn.json', matterhorn, WET_NOW);
  assert.equal(r.verdict, 'abraten');
  assert.equal(r.headline, 'Leider ist der Fels momentan zu nass.');
  assert.match(r.summary, /In den letzten 48 Stunden fielen \d+ mm/);
  assert.match(r.summary, /Nullgradgrenze liegt bei 3200 m – am Gipfel ist mit Eis zu rechnen/);
  assert.match(r.summary, /Am besten wird es morgen früh zwischen 06 und 1\d Uhr\.$/);
  assert.equal(r.reasons[0].kind, 'bad');
  assert.ok(r.bestWindow);
  assert.match(r.bestWindow.label, /^morgen 06–1\d Uhr$/);
  // Fenster endet vor den Nachmittagsschauern (ab 12 Uhr CAPE)
  assert.ok(r.bestWindow.end <= Date.parse('2026-08-12T12:00:00+02:00'));
});

test('Föhnsturm → abraten wegen Wind, Lawinenstufe 2 als Warnung', () => {
  const av = parseBulletin(fx('slf-bulletin-2026-11-16.geojson'), [titlis.lon, titlis.lat], titlis.elevation);
  const r = report('mountain-om-foehn-titlis.json', titlis, FOEHN_NOW, av);
  assert.equal(r.verdict, 'abraten');
  assert.equal(r.headline, 'Am Gipfel ist es zu stürmisch.');
  assert.match(r.reasons[0].text, /stürmt es mit bis zu \d+ km\/h, Böen \d+ km\/h/);
  assert.ok(r.reasons.some((x) => x.kind === 'warn' && /Lawinengefahr 2 – mässig/.test(x.text)));
  const facts = Object.fromEntries(r.facts.map((f) => [f.label, f.value]));
  assert.equal(facts['Lawinengefahr'], '2 – mässig');
});

test('Gewitter am Nachmittag → abraten', () => {
  const hourly = parseOpenMeteo(fx('mountain-om-dry-matterhorn.json'), 4478).map((h) => {
    const hour = new Date(h.time).getUTCHours() + 2;
    return hour >= 14 && hour <= 17 ? { ...h, code: 95, cape: 1400, precip: 2 } : h;
  });
  const r = assessMountain({ peak: matterhorn, now: DRY_NOW, hourly, avalanche: null, pastKnown: true });
  assert.equal(r.verdict, 'abraten');
  assert.equal(r.headline, 'Gewitter in Sicht – heute lieber nicht.');
  assert.match(r.reasons[0].text, /ab etwa 14 Uhr/);
  assert.equal(r.facts.find((f) => f.label === 'Gewitterrisiko')!.value, 'hoch');
  // Fenster am Morgen, vor dem Gewitter
  assert.ok(r.bestWindow && r.bestWindow.end <= Date.parse('2026-08-11T14:00:00+02:00'));
});

test('Lawinenstufe 3 → abraten; ohne Rückblick mindestens bedingt', () => {
  const av = { level: 3 as const, levelLabel: '3 – erheblich', regionName: 'Zermatt', regionId: 'CH-4222', validUntil: null, elevationNote: null, aspects: null, problems: ['Neuschnee'], url: 'https://www.slf.ch/de/lawinenbulletin-und-schneesituation/' as const };
  const r = report('mountain-om-dry-matterhorn.json', matterhorn, DRY_NOW, av);
  assert.equal(r.verdict, 'abraten');
  assert.equal(r.headline, 'Die Lawinengefahr ist zu hoch.');
  const r2 = report('mountain-om-dry-matterhorn.json', matterhorn, DRY_NOW, null, false);
  assert.equal(r2.verdict, 'bedingt');
  assert.equal(r2.facts.find((f) => f.label === 'Regen 72 h')!.value, 'unbekannt');
});

test('kein Fenster bei Dauerregen', () => {
  const base = Date.parse('2026-08-11T00:00:00+02:00');
  const hourly: MountainHour[] = Array.from({ length: 96 }, (_, i) => ({
    time: base + i * 3600_000, temp: 2, precip: 3, snowfall: 0, code: 63, cloud: 100, cloudLow: 100, visibility: 500,
    wind: 40, gust: 70, windAlt: null, freezingLevel: 3000, cape: 0, isDay: (i % 24) >= 6 && (i % 24) <= 20,
  }));
  assert.equal(findBestWindow(hourly, base + 6 * 3600_000), null);
  const r = assessMountain({ peak: findPeak('Pilatus')!, now: base + 8 * 3600_000, hourly, avalanche: null, pastKnown: true });
  assert.equal(r.verdict, 'abraten');
  assert.match(r.summary, /kein gutes Zeitfenster/);
});

test('Windchill', () => {
  assert.equal(windChill(15, 30), 15);
  assert.ok(Math.abs(windChill(-10, 30) - -19.5) < 0.5);
});

test('MET Norway parsen (ohne Vergangenheit)', () => {
  const json = {
    properties: {
      timeseries: [
        { time: '2026-11-16T10:00:00Z', data: { instant: { details: { air_temperature: -8, wind_speed: 15, wind_speed_of_gust: 22, cloud_area_fraction: 20 } }, next_1_hours: { summary: { symbol_code: 'fair_day' }, details: { precipitation_amount: 0 } } } },
        { time: '2026-11-16T11:00:00Z', data: { instant: { details: { air_temperature: -1, wind_speed: 5, cloud_area_fraction: 100 } }, next_1_hours: { summary: { symbol_code: 'heavysnowandthunder' }, details: { precipitation_amount: 2 } } } },
        { time: '2026-11-16T18:00:00Z', data: { instant: { details: { air_temperature: -3 } }, next_6_hours: { summary: { symbol_code: 'cloudy' }, details: {} } } },
      ],
    },
  };
  const h = parseMetNo(json);
  assert.equal(h.length, 2);
  assert.equal(h[0].wind, 54);
  assert.ok(Math.abs(h[0].gust! - 79.2) < 1e-9);
  assert.equal(h[0].isDay, true);
  assert.equal(h[1].code, 99);
  assert.equal(h[1].snowfall, 2);
  assert.equal(metSymbolToCode('lightrainshowers_night'), 80);
  assert.equal(metSymbolToCode('fog'), 45);
});

test('Höhenwind aus Standardmodell ergänzen (ICON-CH2 ohne Druckflächen)', () => {
  const hourly = parseOpenMeteo(fx('mountain-om-dry-matterhorn.json'), 4478).map((h) => ({ ...h, windAlt: null }));
  const t0 = hourly[0].time / 1000;
  const n = applyAltitudeWind(hourly, { hourly: { time: [t0, t0 + 3600], wind_speed_700hPa: [30, 40], wind_speed_600hPa: [50, 60], wind_speed_500hPa: [70, 80] } }, 4200);
  assert.equal(n, 2);
  assert.equal(hourly[0].windAlt, 50);
  assert.equal(hourly[1].windAlt, 60);
  assert.equal(hourly[2].windAlt, null);
});
