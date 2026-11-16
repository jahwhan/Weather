// Bergwetter einschätzen: reine Funktion, aus Stundenwerten am Gipfel,
// Rückblick (Nässe, Neuschnee) und Lawinenbulletin ein Urteil mit Begründung.

import type { Peak } from './peaks.ts';
import type { AvalancheInfo } from '../swiss/slf.ts';

export type Verdict = 'gut' | 'bedingt' | 'abraten';

export interface MountainHour {
  /** UTC ms (Beginn der Stunde) */
  time: number;
  temp: number;
  /** Niederschlag (Wasser) mm/h */
  precip: number;
  /** Schnee cm/h */
  snowfall: number;
  code: number;
  cloud: number;
  cloudLow: number | null;
  /** Sicht in m */
  visibility: number | null;
  /** Wind 10 m in km/h */
  wind: number;
  gust: number | null;
  /** Druckflächenwind in Gipfelhöhe, km/h */
  windAlt: number | null;
  freezingLevel: number | null;
  cape: number | null;
  isDay: boolean | null;
}

export interface MountainInput {
  peak: Peak;
  now: number;
  hourly: MountainHour[];
  avalanche: AvalancheInfo | null;
  pastKnown: boolean;
}

export type ReasonKind = 'ok' | 'warn' | 'bad';

export interface MountainReport {
  peak: Peak;
  verdict: Verdict;
  headline: string;
  summary: string;
  reasons: { kind: ReasonKind; text: string }[];
  bestWindow: { start: number; end: number; label: string } | null;
  facts: { label: string; value: string }[];
  disclaimer: string;
  generatedAt: number;
}

export const DISCLAIMER =
  'Schätzung aus Modelldaten – kein Ersatz für das SLF-Lawinenbulletin, MeteoSchweiz oder eine Bergführerin / einen Bergführer.';

const HOUR = 3600_000;
const TZ = 'Europe/Zurich';

type Topic = 'thunder' | 'wind' | 'avalanche' | 'snow' | 'wet' | 'precip' | 'cold' | 'fog' | 'freeze' | 'past' | 'misc';
interface Reason {
  kind: ReasonKind;
  text: string;
  topic: Topic;
}

const HEADLINE: Partial<Record<Topic, string>> = {
  thunder: 'Gewitter in Sicht – heute lieber nicht.',
  wind: 'Am Gipfel ist es zu stürmisch.',
  avalanche: 'Die Lawinengefahr ist zu hoch.',
  snow: 'Zu viel Neuschnee für eine sichere Tour.',
  wet: 'Leider ist der Fels momentan zu nass.',
  precip: 'Es wird nass und ungemütlich.',
  cold: 'Am Gipfel ist es gefährlich kalt.',
};

// ---------- Zeit in Ortszeit ----------

const fmtParts = new Intl.DateTimeFormat('de-CH', {
  timeZone: TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  hourCycle: 'h23',
});

export function localParts(t: number): { date: string; hour: number; month: number } {
  const p: Record<string, string> = {};
  for (const x of fmtParts.formatToParts(new Date(t))) p[x.type] = x.value;
  return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) % 24, month: Number(p.month) };
}

function dayDiff(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400_000);
}

const WEEKDAY = new Intl.DateTimeFormat('de-CH', { timeZone: TZ, weekday: 'long' });

export function dayWord(t: number, now: number): string {
  const d = dayDiff(localParts(now).date, localParts(t).date);
  if (d === 0) return 'heute';
  if (d === 1) return 'morgen';
  if (d === 2) return 'übermorgen';
  return `am ${WEEKDAY.format(new Date(t))}`;
}

const hh = (h: number) => String(h % 24).padStart(2, '0');

// ---------- Hilfen ----------

function isDaylight(h: MountainHour): boolean {
  if (h.isDay != null) return h.isDay;
  const hr = localParts(h.time).hour;
  return hr >= 7 && hr <= 18;
}

/** Regenanteil: Open-Meteo-Schnee in cm, 7 cm ≈ 10 mm Wasser. */
const rainOf = (h: MountainHour) => Math.max(0, h.precip - (h.snowfall * 10) / 7);
const effWind = (h: MountainHour) => Math.max(h.wind, h.windAlt ?? 0);
const isThunderCode = (c: number) => c >= 95 && c <= 99;
const isConvectiveCode = (c: number) => (c >= 80 && c <= 86) || isThunderCode(c);
const isFog = (h: MountainHour) => h.code === 45 || h.code === 48 || (h.visibility != null && h.visibility < 1000);

/** Windchill (Environment Canada), T in °C, v in km/h. */
export function windChill(t: number, v: number): number {
  if (t > 10 || v < 5) return t;
  const p = Math.pow(v, 0.16);
  return 13.12 + 0.6215 * t - 11.37 * p + 0.3965 * t * p;
}

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const max = (xs: number[], d = 0) => (xs.length ? Math.max(...xs) : d);
const min = (xs: number[], d = 0) => (xs.length ? Math.min(...xs) : d);

function mm(v: number): string {
  return v >= 10 ? String(Math.round(v)) : (Math.round(v * 10) / 10).toString();
}
const round50 = (v: number) => Math.round(v / 50) * 50;
/** Ganzzahl mit typografischem Minus */
const int = (v: number) => String(Math.round(v)).replace('-', '−');
const shortName = (p: Peak) => p.name.replace(/\s*\(.*\)\s*/, '').trim();

// ---------- Bestes Zeitfenster ----------

function hourScore(h: MountainHour, prev24: MountainHour[]): number {
  let s = 100;
  s -= Math.min(50, h.precip * 25);
  if (isThunderCode(h.code)) s -= 70;
  if ((h.cape ?? 0) > 800) s -= 15;
  if ((h.cape ?? 0) > 1500) s -= 15;
  const w = effWind(h);
  if (w > 30) s -= (w - 30) * 1.2;
  if (h.gust != null && h.gust > 60) s -= (h.gust - 60) * 0.8;
  if (isFog(h)) s -= 25;
  s -= h.cloud * 0.1;
  // Nässe/Neuschnee der 24 h davor (inkl. Prognose)
  s -= Math.min(40, sum(prev24.map((x) => x.precip)) * 2.5);
  s -= Math.min(30, sum(prev24.map((x) => x.snowfall)) * 1.5);
  const wc = windChill(h.temp, w);
  if (wc < -20) s -= (-20 - wc) * 1.5;
  return s;
}

export function findBestWindow(hourly: MountainHour[], now: number): MountainReport['bestWindow'] {
  const sorted = [...hourly].sort((a, b) => a.time - b.time);
  const cand = sorted
    .map((h, i) => ({ h, i }))
    .filter(({ h }) => h.time > now - HOUR && h.time <= now + 48 * HOUR && isDaylight(h));
  if (!cand.length) return null;
  const scores = cand.map(({ h }) => hourScore(h, sorted.filter((x) => x.time < h.time && x.time >= h.time - 24 * HOUR)));

  let best: { a: number; len: number; value: number } | null = null;
  for (let a = 0; a < cand.length; a++) {
    for (let len = 3; len <= 8 && a + len <= cand.length; len++) {
      const last = cand[a + len - 1].h.time;
      if (last - cand[a].h.time !== (len - 1) * HOUR) break; // Lücke (Nacht)
      const sc = scores.slice(a, a + len);
      const avg = sum(sc) / len;
      if (avg < 55 || min(sc) < 35) continue;
      const value = avg + len * 0.8;
      if (!best || value > best.value + 1e-9) best = { a, len, value };
    }
  }
  if (!best) return null;
  const start = cand[best.a].h.time;
  const end = start + best.len * HOUR;
  const label = `${dayWord(start, now)} ${hh(localParts(start).hour)}–${hh(localParts(end).hour)} Uhr`;
  return { start, end, label };
}

function windowSentence(w: MountainReport['bestWindow'], now: number, verdict: Verdict): string {
  if (!w) return 'In den nächsten 48 Stunden ist leider kein gutes Zeitfenster in Sicht.';
  const day = dayWord(w.start, now);
  const from = hh(localParts(w.start).hour);
  const to = hh(localParts(w.end).hour);
  const startH = localParts(w.start).hour;
  const early = startH <= 8 && day !== 'heute' ? ' früh' : '';
  if (verdict === 'gut') return `Am schönsten ist es ${day}${early} zwischen ${from} und ${to} Uhr.`;
  return `Am besten wird es ${day}${early} zwischen ${from} und ${to} Uhr.`;
}

// ---------- Hauptfunktion ----------

export function assessMountain(input: MountainInput): MountainReport {
  const { peak, now, avalanche, pastKnown } = input;
  const hourly = [...input.hourly].sort((a, b) => a.time - b.time);
  const elev = peak.elevation;

  const past = (h: number) => hourly.filter((x) => x.time <= now && x.time > now - h * HOUR);
  const p24 = past(24);
  const p48 = past(48);
  const p72 = past(72);
  const precip24 = sum(p24.map((x) => x.precip));
  const precip48 = sum(p48.map((x) => x.precip));
  const precip72 = sum(p72.map((x) => x.precip));
  const rain72 = sum(p72.map(rainOf));
  const snow72 = sum(p72.map((x) => x.snowfall));
  const snowWater72 = (snow72 * 10) / 7;

  // aktuelle Stunde
  let cur = hourly[0];
  for (const h of hourly) if (h.time <= now) cur = h;

  // Tourenstunden: Tageslicht der nächsten 18 h, sonst die nächsten 12 h
  const ahead = hourly.filter((x) => x.time > now - HOUR && x.time <= now + 18 * HOUR);
  let tour = ahead.filter(isDaylight);
  if (!tour.length) tour = hourly.filter((x) => x.time > now - HOUR && x.time <= now + 12 * HOUR);
  if (!tour.length) tour = [cur];

  const reasons: Reason[] = [];
  const add = (kind: ReasonKind, topic: Topic, text: string) => reasons.push({ kind, topic, text });

  // Gewitter
  const thunderHour = tour.find((h) => isThunderCode(h.code));
  const capeMax = max(tour.map((h) => h.cape ?? 0));
  const convHour = tour.find(
    (h) => ((h.cape ?? 0) > 800 && (isConvectiveCode(h.code) || h.precip > 0.3)) || (h.cape ?? 0) > 1500,
  );
  let thunderRisk: 'gering' | 'mässig' | 'hoch' = 'gering';
  if (thunderHour) {
    thunderRisk = 'hoch';
    add('bad', 'thunder', `Gewitter sind angesagt (ab etwa ${hh(localParts(thunderHour.time).hour)} Uhr) – am Grat lebensgefährlich.`);
  } else if (convHour) {
    thunderRisk = 'mässig';
    add(
      'warn',
      'thunder',
      `Gewitterrisiko ab etwa ${hh(localParts(convHour.time).hour)} Uhr (CAPE ${Math.round(capeMax)} J/kg) – früh starten und bis Mittag zurück sein.`,
    );
  } else {
    add('ok', 'thunder', 'Kein Gewittersignal.');
  }

  // Wind
  const wMax = max(tour.map(effWind));
  const gMax = max(tour.map((h) => h.gust ?? 0));
  const gustText = gMax > 0 ? `, Böen ${Math.round(gMax)} km/h` : '';
  if (wMax > 70 || gMax > 90) add('bad', 'wind', `Am Gipfel stürmt es mit bis zu ${Math.round(wMax)} km/h${gustText}.`);
  else if (wMax > 50 || gMax > 70) add('warn', 'wind', `Starker Wind am Gipfel: bis ${Math.round(wMax)} km/h${gustText}.`);
  else add('ok', 'wind', `Wenig bis mässig Wind (bis ${Math.round(wMax)} km/h).`);

  // Lawinen
  if (avalanche?.level && elev >= 1500) {
    const m = /oberhalb (\d+) m/.exec(avalanche.elevationNote ?? '');
    const below = m ? elev < Number(m[1]) : false;
    const lvl = below ? Math.max(1, avalanche.level - 1) : avalanche.level;
    const where = avalanche.regionName ? ` (${avalanche.regionName})` : '';
    const note = avalanche.elevationNote ? `, ${avalanche.elevationNote}` : '';
    if (lvl >= 3) add('bad', 'avalanche', `Lawinengefahr ${avalanche.levelLabel}${where} – für Touren im Schnee ist abzuraten.`);
    else if (lvl === 2) add('warn', 'avalanche', `Lawinengefahr ${avalanche.levelLabel}${note} – Hänge sorgfältig beurteilen.`);
    else add('ok', 'avalanche', `Lawinengefahr ${avalanche.levelLabel}${below && avalanche.level > 1 ? ' (Gipfel unter der Gefahrenzone)' : ''}.`);
  }

  // Rückblick: Neuschnee und Nässe
  if (pastKnown) {
    const snowFirst = snowWater72 >= rain72;
    const snowReason = (): void => {
      if (snow72 >= 30)
        add('bad', 'snow', `In den letzten 72 Stunden fielen rund ${Math.round(snow72)} cm Neuschnee – Spuren fehlen und die Lawinengefahr steigt.`);
      else if (snow72 >= 10) add('warn', 'snow', `${Math.round(snow72)} cm Neuschnee in 72 Stunden – Wege und Fels können verschneit sein.`);
      else if (snow72 >= 2) add('warn', 'snow', `Etwas Neuschnee (${Math.round(snow72)} cm in 72 Stunden) – rutschige Stellen möglich.`);
    };
    const wetReason = (): void => {
      if (precip48 >= 10 || precip24 >= 5) add('bad', 'wet', `In den letzten 48 Stunden fielen ${mm(precip48)} mm Niederschlag.`);
      else if (rain72 >= 3) add('warn', 'wet', `Vor kurzem hat es geregnet (${mm(rain72)} mm in 72 Stunden) – im Schatten kann der Fels noch feucht sein.`);
    };
    if (snowFirst) {
      snowReason();
      if (snow72 < 30) wetReason();
    } else {
      wetReason();
      snowReason();
    }
    if (precip72 < 1 && snow72 < 1) add('ok', 'wet', 'Die letzten 72 Stunden waren trocken.');
  } else {
    add('warn', 'past', 'Für die letzten Tage fehlen Daten – Nässe und Neuschnee bitte vor Ort prüfen.');
  }

  // Nullgradgrenze / Eis
  const fl = cur.freezingLevel;
  const minTemp = min(tour.map((h) => h.temp), cur.temp);
  if (fl != null) {
    const flTxt = `${round50(fl)} m`;
    if (fl < elev && (precip72 >= 2 || elev < 3500)) {
      const wetBad = reasons.find((r) => r.topic === 'wet' && r.kind === 'bad');
      if (wetBad) wetBad.text += ` Die Nullgradgrenze liegt bei ${flTxt} – am Gipfel ist mit Eis zu rechnen.`;
      else add('warn', 'freeze', `Die Nullgradgrenze liegt bei ${flTxt}, unter dem Gipfel – mit Eis und Schnee ist zu rechnen.`);
    } else if (fl < elev) {
      add('ok', 'freeze', `Nullgradgrenze bei ${flTxt} – oben gefroren, Steigeisen und Pickel gehören dazu.`);
    } else {
      add('ok', 'freeze', `Nullgradgrenze bei ${flTxt}, über dem Gipfel.`);
    }
  } else if (minTemp < 0 && precip72 >= 2) {
    add('warn', 'freeze', 'Am Gipfel herrscht Frost – frischer Niederschlag kann vereist sein.');
  }

  // Niederschlag in den kommenden Stunden
  const precipNext = sum(tour.map((h) => h.precip));
  if (precipNext >= 5) add('bad', 'precip', `Es wird nass: in den kommenden Stunden ${mm(precipNext)} mm Niederschlag.`);
  else if (precipNext >= 1) add('warn', 'precip', `Zeitweise Niederschlag (${mm(precipNext)} mm).`);

  // Sicht
  const fogShare = tour.filter(isFog).length / tour.length;
  const visVals = tour.map((h) => h.visibility).filter((v): v is number => v != null);
  if (fogShare >= 0.25) add('warn', 'fog', `Der Gipfel steckt ${fogShare >= 0.6 ? 'meist' : 'zeitweise'} im Nebel (Sicht unter 1 km).`);
  else if (visVals.length && min(visVals) >= 10000 && max(tour.map((h) => h.cloudLow ?? 0)) < 60) add('ok', 'fog', 'Gute Sicht.');

  // Kälte / Windchill
  const wcMin = min(tour.map((h) => windChill(h.temp, effWind(h))), windChill(cur.temp, effWind(cur)));
  if (wcMin < -30) add('bad', 'cold', `Extrem kalt: gefühlt bis ${int(wcMin)} °C – Erfrierungsgefahr.`);
  else if (wcMin < -20) add('warn', 'cold', `Sehr kalt am Gipfel: gefühlt bis ${int(wcMin)} °C.`);

  // Urteil
  const verdict: Verdict = reasons.some((r) => r.kind === 'bad') ? 'abraten' : reasons.some((r) => r.kind === 'warn') ? 'bedingt' : 'gut';
  const order: Topic[] = ['thunder', 'wind', 'avalanche', 'snow', 'wet', 'precip', 'cold', 'freeze', 'fog', 'past', 'misc'];
  // Nass/Schnee nach Dominanz
  if (rain72 > snowWater72) {
    order.splice(order.indexOf('wet'), 1);
    order.splice(order.indexOf('snow'), 0, 'wet');
  }
  const rank = (r: Reason) => (r.kind === 'bad' ? 0 : r.kind === 'warn' ? 100 : 200) + order.indexOf(r.topic);
  const sortedReasons = [...reasons].sort((a, b) => rank(a) - rank(b));

  const bestWindow = findBestWindow(hourly, now);
  let headline: string;
  if (verdict === 'abraten') headline = HEADLINE[sortedReasons[0].topic] ?? 'Heute besser nicht.';
  else if (verdict === 'bedingt') headline = 'Machbar – aber mit Vorsicht.';
  else headline = `Gute Verhältnisse am ${shortName(peak)}.`;

  const problems = sortedReasons.filter((r) => r.kind !== 'ok');
  const first = problems.length ? problems[0].text : `Trocken, ruhiger Wind und kein Gewittersignal am ${shortName(peak)}.`;
  const summary = `${first} ${windowSentence(bestWindow, now, verdict)}`;

  // Fakten
  const wc = windChill(cur.temp, effWind(cur));
  const visibility = cur.visibility;
  const summerMonth = [6, 7, 8, 9, 10].includes(localParts(now).month);
  const facts: MountainReport['facts'] = [
    { label: 'Temperatur am Gipfel', value: `${int(cur.temp)} °C${wc < cur.temp - 3 ? ` (gefühlt ${int(wc)} °C)` : ''}` },
    { label: 'Wind / Böen', value: `${Math.round(effWind(cur))} km/h${cur.gust != null ? ` · Böen ${Math.round(cur.gust)} km/h` : ''}` },
    { label: 'Nullgradgrenze', value: fl != null ? `${round50(fl)} m` : '–' },
    { label: 'Neuschnee 72 h', value: pastKnown ? `${Math.round(snow72)} cm` : 'unbekannt' },
    { label: 'Regen 72 h', value: pastKnown ? `${mm(rain72)} mm` : 'unbekannt' },
    { label: 'Gewitterrisiko', value: thunderRisk },
    {
      label: 'Sicht',
      value: visibility == null ? '–' : visibility >= 10000 ? 'über 10 km' : visibility >= 1000 ? `${Math.round(visibility / 1000)} km` : `${Math.round(visibility / 50) * 50} m`,
    },
    {
      label: 'Lawinengefahr',
      value: avalanche ? avalanche.levelLabel : summerMonth ? 'Kein Lawinenbulletin (Sommer)' : 'kein Bulletin verfügbar',
    },
  ];

  return {
    peak,
    verdict,
    headline,
    summary,
    reasons: sortedReasons.map(({ kind, text }) => ({ kind, text })),
    bestWindow,
    facts,
    disclaimer: DISCLAIMER,
    generatedAt: now,
  };
}
