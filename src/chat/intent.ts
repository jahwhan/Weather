// Lokaler Intent-Parser (Deutsch, etwas Schweizerdeutsch) als Rückfall,
// wenn kein n8n-Endpunkt erreichbar ist.

import { findPeak, peakQuery } from '../mountain/peaks.ts';
import { modePhrase, MODE_LABEL, type AppContext, type ChatAction, type ChatMode, type ChatResponse } from './protocol.ts';

export const EXAMPLES = ['Kann ich aufs Matterhorn?', 'Zürich nach Luzern mit dem Zug', 'Wetter in Zermatt', 'Spiel ab'];

export const HELP_TEXT = [
  'Das kann ich für dich tun:',
  '• Orte zeigen – „Zeig mir Bern“, „Flieg nach Zermatt“',
  '• Wetter – „Wie ist das Wetter in Luzern?“',
  '• Routen – „Von Zürich nach Luzern mit dem Zug“, „Route Basel – Chur mit dem Velo“',
  '• Flug steuern – „Spiel ab“, „Stopp“',
  '• Zeit – „Morgen um 8“, „in 3 Stunden“, „jetzt“',
  '• Bergwetter – „Kann ich aufs Matterhorn?“, „Verhältnisse am Pilatus“',
  '• Vergleich – „Wie lange mit dem Zug?“',
].join('\n');

const TZ = 'Europe/Zurich';

/** Dialekt- und Kurzformen von Ortsnamen. */
const PLACE_ALIASES: Record<string, string> = {
  züri: 'Zürich',
  zueri: 'Zürich',
  zuerich: 'Zürich',
  zurich: 'Zürich',
  bärn: 'Bern',
  baern: 'Bern',
  luzärn: 'Luzern',
  sanggale: 'St. Gallen',
  'st gallen': 'St. Gallen',
  basel: 'Basel',
  winti: 'Winterthur',
  schaffhuuse: 'Schaffhausen',
  genf: 'Genf',
  geneve: 'Genf',
  'genève': 'Genf',
  lausanne: 'Lausanne',
  chur: 'Chur',
};

function cleanPlace(raw: string): string {
  let s = raw
    .replace(/[?!.;:]+$/g, '')
    .replace(/^(?:z'|z’)/i, '')
    .replace(/^\s*(?:nach|zu|zum|zur|in|im|uf|auf|bis|über|ueber|nach dem|von|vo)\s+/i, '')
    .replace(/\s+(?:bitte|mal|grad|gerade|jetzt|schnell|an|aa)$/i, '')
    .trim();
  s = s.replace(/^["„“'«»]+|["„“'«»]+$/g, '').trim();
  const alias = PLACE_ALIASES[s.toLowerCase()];
  if (alias) return alias;
  if (s && s[0] === s[0].toLowerCase()) s = s[0].toUpperCase() + s.slice(1);
  return s;
}

// ---------- Verkehrsmittel ----------

const MODE_PATTERNS: [RegExp, ChatMode][] = [
  [/(?<!\p{L})(?:zu\s+fu(?:ss|ß)|z['’]?\s?fuess|zfuess|zu\s+fuess|laufen|wandernd|spazieren|per\s+pedes|fussweg|fu(?:ss|ß)g(?:ä|ae)nger)(?!\p{L})/iu, 'foot'],
  [/(?<!\p{L})(?:velo|fahrrad|rad|bike|e-?bike|mountainbike|radeln|velofahren)(?!\p{L})/iu, 'bike'],
  [/(?<!\p{L})(?:zug|bahn|(?:ö|oe)v|oev|öffentlich(?:en)?|oeffentlich(?:en)?|tram|bus|postauto|sbb|s-bahn|schiff)(?!\p{L})/iu, 'transit'],
  [/(?<!\p{L})(?:auto|wagen|pw|töff|toeff|motorrad|car)(?!\p{L})/iu, 'car'],
  [/(?<!\p{L})(?:flugzeug|flieger|per\s+flug|als\s+flug|flugroute|im\s+flug|mit\s+(?:dem|em)\s+flug|flug(?=\s+(?:von|vo|ab|nach)\b))(?!\p{L})/iu, 'flight'],
];

/** Verkehrsmittel und Füllphrase dazu entfernen ("mit dem Zug", "per Velo", "zu Fuss"). */
function extractMode(text: string): { mode: ChatMode | null; rest: string } {
  for (const [re, mode] of MODE_PATTERNS) {
    const m = re.exec(text);
    if (!m) continue;
    // "mit dem/em/de/der" bzw. "per/im" davor mit entfernen
    const before = text.slice(0, m.index).replace(/\s*\b(?:mit\s+(?:dem|em|de|der|den|einem|em)?|per|im|mitm|mim|mit'm)\s*$/i, ' ');
    const rest = `${before} ${text.slice(m.index + m[0].length)}`.replace(/\s+/g, ' ').trim();
    return { mode, rest };
  }
  return { mode: null, rest: text };
}

// ---------- Zeit ----------

function zurichNow(now: number): { hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat('de-CH', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(now));
  const g = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  return { hour: g('hour') % 24, minute: g('minute') };
}

interface TimeHit {
  action: Extract<ChatAction, { type: 'setTime' }>;
  label: string;
  rest: string;
}

const NUM_WORDS: Record<string, number> = {
  ein: 1, eine: 1, einer: 1, einem: 1, eins: 1, zwei: 2, zwo: 2, drei: 3, vier: 4, fünf: 5, fuenf: 5, sechs: 6,
  sieben: 7, acht: 8, neun: 9, zehn: 10, elf: 11, zwölf: 12, zwoelf: 12, halbe: 0.5,
};

function toNum(s: string): number | null {
  const n = Number(s.replace(',', '.'));
  if (Number.isFinite(n)) return n;
  return NUM_WORDS[s.toLowerCase()] ?? null;
}

/** "morgen um 8", "heute 14:30", "in 3 Stunden", "jetzt" → setTime. */
export function extractTime(text: string, now: number): TimeHit | null {
  const t = text;
  if (/\b(?:jetzt|live|aktuell|sofort|gegenwart)\b/i.test(t) && !/\bin\s+\d/.test(t)) {
    const m = /\b(?:jetzt|live|aktuell|sofort|gegenwart)\b/i.exec(t)!;
    // nur wenn es um die Zeit geht (z. B. "Wetter jetzt", "zurück auf live")
    if (/^(?:jetzt|live|zurück|zurueck|wieder|zeit|aktuell)/i.test(t.trim()) || /\b(?:live|zeit)\b/i.test(t)) {
      return { action: { type: 'setTime', mode: 'live', offsetHours: 0 }, label: 'jetzt', rest: (t.slice(0, m.index) + t.slice(m.index + m[0].length)).trim() };
    }
  }

  const rel = /\bin\s+(\d+(?:[.,]\d+)?|ein(?:er)?|eine|zwei|drei|vier|fünf|fuenf|sechs|sieben|acht|neun|zehn|elf|zwölf|zwoelf|einer\s+halben|halbe)\s*(stunden?|std\.?|h|minuten|min|tagen?)\b/i.exec(t);
  if (rel) {
    let n = /halb/i.test(rel[1]) ? 0.5 : (toNum(rel[1]) ?? 1);
    const unit = rel[2].toLowerCase();
    if (unit.startsWith('min')) n = n / 60;
    else if (unit.startsWith('tag')) n = n * 24;
    const off = Math.round(n * 4) / 4;
    const label = unit.startsWith('tag') ? `in ${Math.round(n / 24)} Tag${Math.round(n / 24) === 1 ? '' : 'en'}` : unit.startsWith('min') ? `in ${Math.round(n * 60)} Minuten` : `in ${off} Stunde${off === 1 ? '' : 'n'}`;
    return { action: { type: 'setTime', mode: 'travel', offsetHours: off }, label, rest: (t.slice(0, rel.index) + t.slice(rel.index + rel[0].length)).trim() };
  }

  const dayM = /(?<!\p{L})(heute|morgen|übermorgen|uebermorgen|moorn|morn)(?!\p{L})/iu.exec(t);
  const clock = /\b(?:um|ab|gegen|so um)?\s*(\d{1,2})(?:[:.h](\d{2}))?\s*(?:uhr|h\b)?/i;
  const partM = /\b(früh|frueh|morgens|vormittag|mittag|nachmittag|abend|abends|nacht)\b/i.exec(t);
  // Uhrzeit nur mit "um"/"Uhr" oder zusammen mit einem Tag erkennen (nicht jede Zahl)
  const clockStrict = /\b(?:um|ab|gegen)\s+(\d{1,2})(?:[:.](\d{2}))?\s*(?:uhr)?\b|\b(\d{1,2})(?:[:.](\d{2}))?\s*uhr\b|\b(\d{1,2})[:.](\d{2})\b/i.exec(t);
  let hour: number | null = null;
  let minute = 0;
  let clockMatch: RegExpExecArray | null = clockStrict;
  if (clockStrict) {
    hour = Number(clockStrict[1] ?? clockStrict[3] ?? clockStrict[5]);
    minute = Number(clockStrict[2] ?? clockStrict[4] ?? clockStrict[6] ?? 0);
  } else if (dayM) {
    const after = t.slice(dayM.index + dayM[0].length);
    const m2 = clock.exec(after);
    if (m2 && /^\s*(?:um|ab|gegen|so um)?\s*\d/.test(after)) {
      hour = Number(m2[1]);
      minute = Number(m2[2] ?? 0);
      clockMatch = m2;
    }
  }
  if (hour != null && (hour > 23 || minute > 59)) hour = null;
  if (hour == null && partM) {
    const p = partM[1].toLowerCase();
    hour = /fr(ü|ue)h|morgens/.test(p) ? 7 : p === 'vormittag' ? 10 : p === 'mittag' ? 12 : p === 'nachmittag' ? 15 : p === 'nacht' ? 22 : 19;
  }
  if (!dayM && hour == null) return null;

  let dayOffset = 0;
  if (dayM) {
    const d = dayM[1].toLowerCase();
    dayOffset = d === 'heute' ? 0 : /^(ü|ue)bermorgen$/.test(d) ? 2 : 1;
  }
  // "heute Abend um 8" → 20 Uhr
  if (hour != null && hour < 12 && partM && /abend|nachmittag|nacht/i.test(partM[1])) hour += 12;
  const cur = zurichNow(now);
  if (hour == null) hour = dayOffset === 0 ? cur.hour : 8;
  let off = dayOffset * 24 + (hour - cur.hour) + (minute - cur.minute) / 60;
  // "um 8" ohne Tag, schon vorbei → morgen
  if (!dayM && off < -0.5) off += 24;
  off = Math.round(off * 4) / 4;

  const dayLabel = dayOffset === 0 ? 'heute' : dayOffset === 1 ? 'morgen' : 'übermorgen';
  const label = `${dayLabel} um ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')} Uhr`;
  let rest = t;
  for (const m of [clockMatch, dayM, partM]) if (m) rest = rest.replace(m[0], ' ');
  rest = rest.replace(/\s+/g, ' ').trim();
  return { action: { type: 'setTime', mode: 'travel', offsetHours: off }, label, rest };
}

// ---------- Route ----------

const COORD = /^\s*(-?\d{1,2}(?:\.\d+)?)\s*[,;\s]\s*(-?\d{1,3}(?:\.\d+)?)\s*$/;

/** "von A nach B", "A nach B", "A bis B", "Route A – B", "A → B", "vo A uf B", optional "über C". */
export function extractRoute(text: string): { from: string; to: string; via: string[] } | null {
  let t = text
    .replace(/^\s*(?:bitte\s+)?(?:zeig(?:e)?\s+(?:mir\s+)?(?:die\s+)?|berechne\s+(?:die\s+)?|plane?\s+(?:die\s+|eine\s+)?|mach\s+(?:mir\s+)?(?:eine\s+)?)?(?:route|weg|strecke|reise|fahrt|verbindung)\s*(?::|von|vo)?\s*/i, '')
    .replace(/^\s*(?:ich\s+will|ich\s+möchte|ich\s+moechte|i\s+wott|ich\s+muss)\s+/i, '')
    .replace(/[?!.]+\s*$/, '')
    .trim();
  t = t.replace(/\s+(?:fahren|reisen|gehen|kommen|fliegen|go|gah|cho)\s*$/i, '').trim();
  t = t.replace(/^(?:flieg\w*|flüg|fahr\w*|geh\w*|reis\w*|bring\s+mich|navigier\w*)\s+(?=(?:von|vo|ab)\s)/i, '');

  let via: string[] = [];
  const viaRe = /\s+(?:über|ueber|via|übers)\s+(.+?)(?=\s+(?:nach|bis|uf)\s+|$)/i;
  const vm = viaRe.exec(t);
  if (vm) {
    via = vm[1].split(/\s*(?:,|\bund\b)\s*/).map(cleanPlace).filter(Boolean);
    t = (t.slice(0, vm.index) + ' ' + t.slice(vm.index + vm[0].length)).replace(/\s+/g, ' ').trim();
  }

  let m = /^(?:von|vo|ab)\s+(.+?)\s+(?:nach|bis|zu|zum|zur|uf|in|ins)\s+(.+)$/i.exec(t);
  if (!m) m = /^(.+?)\s+(?:nach|bis|uf)\s+(.+)$/i.exec(t);
  if (!m) m = /^(.+?)\s*(?:→|->|–|—|\s-\s|=>)\s*(.+)$/.exec(t);
  if (!m) return null;
  if (/^(?:flieg\w*|flüg|flueg|fahr\w*|geh\w*|gang|zeig\w*|bring\w*|reis\w*|navigier\w*|zoom\w*|spring\w*|ich|wir|wie|was|wann|wo|mit|zu)\b/i.test(m[1].trim())) return null;
  const from = cleanPlace(m[1]);
  const to = cleanPlace(m[2]);
  if (!from || !to || from.split(' ').length > 5 || to.split(' ').length > 5) return null;
  if (/^(?:hause|haus)$/i.test(to)) return null;
  return { from, to, via };
}

// ---------- Hauptfunktion ----------

const reply = (text: string, actions: ChatAction[] = []): ChatResponse => ({ reply: text, actions });

function unknown(): ChatResponse {
  return reply(
    `Das habe ich leider nicht verstanden. Versuch es zum Beispiel mit „${EXAMPLES[1]}“, „${EXAMPLES[2]}“ oder „${EXAMPLES[0]}“.`,
  );
}

const MOUNTAIN_HINT =
  /\b(?:kann\s+ich|chan\s+i|darf\s+ich|bergwetter|verh(?:ä|ae)ltnisse|gipfel|besteig\w*|hochtour|bergtour|klettern|aufs|aufstieg|uf\s+de|uf\s+d|go\s+wandere)\b/i;

/** Lokaler Parser; now nur für Tests überschreibbar. */
export function parseIntent(text: string, ctx: AppContext, now: number = Date.now()): ChatResponse {
  const raw = text.trim().replace(/\s+/g, ' ');
  if (!raw) return reply(`Wie kann ich helfen? Zum Beispiel: „${EXAMPLES[0]}“ oder „${EXAMPLES[1]}“.`);
  const low = raw.toLowerCase();

  if (/^(?:hilfe|help|\?+|was\s+kannst\s+du|was\s+chasch\s+du|wie\s+funktioniert|befehle|optionen|was\s+geht)/i.test(low)) {
    return reply(HELP_TEXT);
  }
  if (/^(?:danke|merci|vielen\s+dank|dankeschön|danke\s+vielmal|merci\s+vilmal|top|super|perfekt)\b/i.test(low)) {
    return reply('Gern geschehen! Sag Bescheid, wenn ich noch etwas zeigen soll.');
  }
  if (/^(?:hallo|hoi|hoii|grüezi|gruezi|grüessech|salü|sali|hey|hi|guten\s+(?:morgen|tag|abend)|servus|ciao|moin)\b[\s!.,]*$/i.test(low)) {
    return reply(`Hoi! Ich bin dein Wetterflug-Assistent. Frag mich zum Beispiel „${EXAMPLES[0]}“ oder „${EXAMPLES[1]}“.`);
  }

  // Abspielen / Pause
  if (/^(?:stopp?|pause|pausier\w*|anhalten|halt|warte|stop\s+mal|hör\s+auf|hoer\s+auf|aufhören)\b/i.test(low)) {
    return reply(ctx.playing ? 'Angehalten.' : 'Der Flug ist bereits angehalten.', [{ type: 'pause' }]);
  }
  if (/^(?:spiel(?:e)?\s+ab|abspielen|start(?:en)?|los(?:\s+geht['’]?s)?|play|go|flug\s+starten|starte\s+den\s+flug|abflug|weiter|fortsetzen|spiel\s+los|leg\s+los|abfahrt)\b[\s!.]*$/i.test(low)) {
    if (!ctx.route) return reply(`Es gibt noch keine Route. Sag zum Beispiel: „${EXAMPLES[1]}“.`);
    return reply('Los geht’s – der Flug startet.', [{ type: 'play' }]);
  }

  // Bergwetter
  const peak = findPeak(raw);
  if (peak && (MOUNTAIN_HINT.test(raw) || /\b(?:wetter|wind|schnee|nass|sicher|gut)\b/i.test(raw) || raw.split(' ').length <= 3)) {
    const name = peak.name.replace(/\s*\(.*\)\s*/, '');
    return reply(`Ich schaue mir die Verhältnisse am ${name} an …`, [{ type: 'showMountain', peak: peak.name }]);
  }
  if (!peak && /\b(?:kann\s+ich\s+(?:aufs|auf\s+den|auf\s+die)|bergwetter|verh(?:ä|ae)ltnisse\s+(?:am|auf)|besteigen)\b/i.test(raw)) {
    const q = peakQuery(raw);
    if (q) return reply(`Ich suche „${cleanPlace(q)}“ und schaue mir die Verhältnisse an …`, [{ type: 'showMountain', peak: cleanPlace(q) }]);
  }

  // Vergleich
  if (/\b(?:vergleich\w*|wie\s+lange?|wie\s+lang|dauer|schneller|am\s+schnellsten|reisezeit\w*|wie\s+viel\s+zeit)\b/i.test(raw)) {
    const { mode } = extractMode(raw);
    const r = extractRoute(extractMode(raw).rest.replace(/\b(?:wie\s+lange?|dauert(?:\s+es)?|vergleich\w*)\b/gi, ' ').trim());
    const actions: ChatAction[] = [];
    if (r) actions.push({ type: 'setRoute', from: r.from, to: r.to, ...(r.via.length ? { via: r.via } : {}), ...(mode ? { mode } : {}) });
    actions.push({ type: 'compareModes' });
    if (!r && !ctx.route) return reply(`Dafür brauche ich eine Route. Sag zum Beispiel: „${EXAMPLES[1]}“.`);
    const what = mode ? `Reisezeit ${modePhrase(mode)} – im Vergleich` : 'Ich vergleiche die Reisezeiten';
    return reply(`${what} mit Auto, ÖV, Velo und zu Fuss.`, actions);
  }

  // Zeit und Verkehrsmittel herauslösen, Rest auf Route prüfen
  const timeHit = extractTime(raw, now);
  const afterTime = timeHit ? timeHit.rest : raw;
  const { mode, rest } = extractMode(afterTime);
  const route = extractRoute(rest);
  const isWeatherQ = /\bwetter\b|\bregnet\b|\bschneit\b|\btemperatur\b|\bwie\s+warm\b|\bwie\s+kalt\b/i.test(rest);

  if (route && !isWeatherQ) {
    const actions: ChatAction[] = [
      { type: 'setRoute', from: route.from, to: route.to, ...(route.via.length ? { via: route.via } : {}), ...(mode ? { mode } : {}) },
    ];
    if (timeHit) actions.push(timeHit.action);
    const viaTxt = route.via.length ? ` über ${route.via.join(', ')}` : '';
    const how = mode ? ` ${modePhrase(mode)}` : ctx.route ? ` ${modePhrase(ctx.route.mode)}` : '';
    const when = timeHit ? `, ${timeHit.label}` : '';
    return reply(`Route von ${route.from}${viaTxt} nach ${route.to}${how}${when} – ich berechne sie.`, actions);
  }

  // nur Ziel ("mit dem Auto nach Bern"): Start = aktueller Ort
  const toOnly = /^(?:nach|zu|zum|zur|uf|bis|in)\s+(.+)$/i.exec(rest);
  if (toOnly && (mode || timeHit)) {
    const to = cleanPlace(toOnly[1]);
    if (ctx.place) {
      const actions: ChatAction[] = [{ type: 'setRoute', from: ctx.place, to, ...(mode ? { mode } : {}) }];
      if (timeHit) actions.push(timeHit.action);
      return reply(`Route von ${ctx.place} nach ${to}${mode ? ` ${modePhrase(mode)}` : ''} – ich berechne sie.`, actions);
    }
    return reply(`Von wo aus soll es nach ${to} gehen? Zum Beispiel: „Von Bern nach ${to}${mode ? ` ${modePhrase(mode)}` : ''}“.`);
  }

  // Wetter an einem Ort
  const wm =
    /\bwetter\s+(?:in|im|für|fuer|z['’]?|bei|am|an|auf|um)\s+(.+)$/i.exec(rest) ??
    /\b(?:regnet|schneit)\s+(?:es\s+)?(?:in|im|z['’]?)\s+(.+)$/i.exec(rest) ??
    /\b(?:wie\s+(?:warm|kalt)\s+(?:ist\s+es|isch\s+es|wird\s+es)?)\s*(?:in|im|z['’]?)\s+(.+)$/i.exec(rest) ??
    /\b(?:wetter)\s+([A-ZÄÖÜ][\w.\- ]+)$/.exec(rest);
  if (wm) {
    const place = cleanPlace(wm[1].replace(/\b(?:heute|morgen|jetzt|aus|so|aktuell)\b/gi, ' ').replace(/\s+/g, ' ').trim());
    if (place) {
      const actions: ChatAction[] = [{ type: 'showPlace', place }];
      if (timeHit) actions.push(timeHit.action);
      const when = timeHit ? ` (${timeHit.label})` : '';
      return reply(`Hier ist das Wetter in ${place}${when}.`, actions);
    }
  }

  // Ort zeigen / hinfliegen
  const fm =
    /^(?:zeig(?:e)?|zeig\s+mal|zeigt)\s+(?:mir|mer|üs|uns)?\s*(?:mal|bitte)?\s*(.+)$/i.exec(rest) ??
    /^(?:flieg(?:e)?|flüg|flueg|fliege|fly|geh|gang|fahr|navigier\w*|zoom\w*|spring|bring\s+mich)\s+(?:mal\s+|bitte\s+)?(?:nach|zu|zum|zur|über|ueber|uf|auf|in|ins|an)?\s*(.+)$/i.exec(rest) ??
    /^(?:wo\s+(?:ist|liegt|isch))\s+(.+)$/i.exec(rest);
  if (fm) {
    const target = fm[1].replace(/^(?:die\s+karte\s+(?:von|vo)\s+|karte\s+(?:von|vo)\s+)/i, '');
    const c = COORD.exec(target.replace(/[?!.]+$/, ''));
    if (c) {
      const lat = Number(c[1]);
      const lon = Number(c[2]);
      return reply(`Ich fliege zu ${lat.toFixed(3)}, ${lon.toFixed(3)}.`, [{ type: 'flyTo', lat, lon }]);
    }
    if (/^(?:das\s+)?wetter\b/i.test(target)) return reply('Hier sind die Wetterdetails.', [{ type: 'openWeather' }]);
    const place = cleanPlace(target);
    if (place) {
      const actions: ChatAction[] = [{ type: 'flyTo', place }];
      if (timeHit) actions.push(timeHit.action);
      return reply(`Ich fliege nach ${place}.`, actions);
    }
  }

  // Nur Verkehrsmittel
  if (mode && rest.replace(/\b(?:und|bitte|lieber|doch|stattdessen|dann|jetzt|umstellen|wechseln|auf)\b/gi, '').trim().length <= 3) {
    const actions: ChatAction[] = [{ type: 'setMode', mode }];
    if (timeHit) actions.push(timeHit.action);
    if (ctx.route) return reply(`Umgestellt: ${ctx.route.from} – ${ctx.route.to} ${modePhrase(mode)}.`, actions);
    return reply(`${MODE_LABEL[mode]} ist eingestellt. Wohin soll es gehen?`, actions);
  }

  // Nur Zeit
  if (timeHit && rest.replace(/\b(?:und|bitte|zeig|mir|das|wetter|für|fuer|stell|auf|die|zeit|wie|ist|es|dann|um|zurück|zurueck|wieder|geh|gehe|mach|wechsel|wechseln)\b/gi, '').trim().length <= 2) {
    if (timeHit.action.mode === 'live') return reply('Zurück auf live – du siehst das aktuelle Wetter.', [timeHit.action]);
    return reply(`Ich zeige das Wetter für ${timeHit.label}.`, [timeHit.action]);
  }

  // allgemeine Wetterfrage ohne Ort
  if (/\b(?:wetter|wie\s+wird\s+es|regnet\s+es|wie\s+warm|wie\s+kalt|wetterbericht|prognose)\b/i.test(raw)) {
    if (ctx.weatherSummary) return reply(`${ctx.weatherSummary} Die Details öffne ich dir.`, [{ type: 'openWeather' }]);
    return reply('Hier sind die Wetterdetails.', [{ type: 'openWeather' }]);
  }

  // Koordinate allein
  const c = COORD.exec(raw);
  if (c) {
    const lat = Number(c[1]);
    const lon = Number(c[2]);
    if (Math.abs(lat) <= 90 && Math.abs(lon) <= 180) return reply(`Ich fliege zu ${lat.toFixed(3)}, ${lon.toFixed(3)}.`, [{ type: 'flyTo', lat, lon }]);
  }

  // kurzer Ortsname allein ("Luzern")
  if (raw.split(' ').length <= 3 && /^[A-ZÄÖÜ]/.test(raw) && !/[?]/.test(raw)) {
    const place = cleanPlace(raw);
    return reply(`Hier ist das Wetter in ${place}.`, [{ type: 'showPlace', place }]);
  }

  return unknown();
}
