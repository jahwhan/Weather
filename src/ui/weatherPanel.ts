// Wetter-Panel: Kopf, Lage-Satz, Stundenleiste, 10 Tage, Kacheln, Schweiz-Kacheln,
// Reisezeiten und Quellen. Reines Rendering (HTML-Strings); Ereignisse über data-action.

import type { LngLat } from '../geo';
import { sunPosition, sunTimes } from '../astro/sun';
import { compass, describe } from '../weather/conditions';
import type { WeatherSample } from '../weather/types';
import type { DailyForecast, HourlyPoint, WeatherDetail } from '../weather/detail';
import { applyObservation, type StationObs } from '../swiss/smn';
import type { AvalancheInfo } from '../swiss/slf';
import type { ModeEstimate } from '../route/modes';
import { PROFILE_LABEL, type Profile } from '../route/routing';
import { illustration, sunEventIcon, uiIcon, weatherIcon, windIcon } from './icons';
import { summarize, type SummaryHour } from './summary';
import {
  ago,
  escapeHtml as esc,
  formatDistanceM,
  formatVisibility,
  hhmm,
  hourOf,
  localDate,
  n1s,
  t0,
  tempColor,
  thousands,
  toMs,
  WEEKDAYS,
} from './format';

export type LoadStatus = 'idle' | 'loading' | 'done' | 'error';

export interface RouteInfo {
  profile: Profile;
  modes: ModeEstimate[] | null;
  modesStatus: LoadStatus;
  distance: number;
  duration: number;
  gain: number;
  note?: string;
  places: string[];
}

export interface PanelState {
  place: { name: string; detail?: string; coord: LngLat } | null;
  /** z. B. "Ziel" bei Routen */
  role?: string;
  focus?: { names: string[]; idx: number };
  detail: WeatherDetail | null;
  detailStatus: LoadStatus;
  /** true, solange ein älterer Stand angezeigt und im Hintergrund neu geladen wird */
  refreshing: boolean;
  /** Wetter aus der Reise, falls die Detaildaten (noch) fehlen */
  fallback: { sample: WeatherSample; utcOffsetSec: number; fetchedAt: number } | null;
  obs: StationObs | null;
  obsStatus: LoadStatus;
  useObs: boolean;
  aval: AvalancheInfo | null;
  avalStatus: LoadStatus;
  swiss: boolean;
  route: RouteInfo | null;
  /** Startzeit in der Zukunft gewählt: ehrlich als Prognose kennzeichnen */
  forecastMode: boolean;
  error?: string;
}

export const MODE_ORDER: Profile[] = ['car', 'transit', 'bike', 'foot'];
export const MODE_ICON: Record<Profile, string> = { car: 'car', transit: 'transit', bike: 'bike', foot: 'foot', flight: 'flight' };

// ------------------------------------------------------------ Hilfen

function isNightAt(p: { time: number; isDay?: boolean | null }, lat: number, lon: number): boolean {
  if (p.isDay != null) return !p.isDay;
  return sunPosition(p.time, lat, lon).altitude < -0.8;
}

function icon(code: number, night: boolean, cls?: string): string {
  return weatherIcon(describe(code, night).icon, night, cls);
}

function offsetOf(s: PanelState): number {
  return s.detail?.utcOffsetSec ?? s.fallback?.utcOffsetSec ?? -new Date().getTimezoneOffset() * 60;
}

/** aktueller Zustand: Messwert, falls verwendbar, sonst Modell */
export function nowSample(s: PanelState): { sample: WeatherSample | null; model: WeatherSample | null; measured: boolean } {
  const model = (s.detail?.current as WeatherSample | undefined) ?? s.fallback?.sample ?? null;
  if (model && s.obs && s.useObs) {
    return { sample: applyObservation(model, s.obs), model, measured: s.obs.temp != null };
  }
  return { sample: model, model, measured: false };
}

function todayDaily(s: PanelState): DailyForecast | null {
  return s.detail ? dailyToday(s.detail) : null;
}

function dailyToday(d: WeatherDetail): DailyForecast | null {
  if (!d?.daily?.length) return null;
  const off = d.utcOffsetSec;
  const today = localDate(Date.now(), off).toISOString().slice(0, 10);
  return d.daily.find((x) => dayKey(x, off) === today) ?? d.daily[0];
}

function dayKey(x: DailyForecast, off: number): string {
  if (typeof x.date === 'string' && /^\d{4}-\d{2}-\d{2}/.test(x.date)) return x.date.slice(0, 10);
  const ms = toMs(x.time) ?? toMs(x.date) ?? 0;
  return localDate(ms, off).toISOString().slice(0, 10);
}

/** Stunden ab jetzt (erste = aktuelle Stunde) */
function upcoming(d: WeatherDetail, n: number): HourlyPoint[] {
  const now = Date.now();
  const i0 = d.hourly.findIndex((h) => h.time > now - 3600e3 + 1);
  if (i0 < 0) return [];
  return d.hourly.slice(i0, i0 + n);
}

export function summaryText(s: PanelState): string | null {
  const d = s.detail;
  if (!d) return null;
  const hrs = upcoming(d, 14);
  if (hrs.length < 2) return null;
  const cur = nowSample(s).sample;
  const list: SummaryHour[] = hrs.map((h, i) => ({ ...(i === 0 && cur ? { ...h, ...cur, time: h.time, precipProb: h.precipProb, isDay: h.isDay } : h) }));
  const today = todayDaily(s);
  const tonight = Math.min(...hrs.slice(0, 14).map((h) => h.temp));
  return summarize(list, d.utcOffsetSec, today?.tMax ?? null, Number.isFinite(tonight) ? tonight : null);
}

// ------------------------------------------------------------ Kompakte Zeile

export interface CompactData {
  place: string;
  temp: number | null;
  code: number | null;
  night: boolean;
  line: string;
  badge?: { kind: 'live' | 'measured' | 'forecast' | 'stale'; text: string };
}

export function renderCompact(el: HTMLElement, c: CompactData | null): void {
  if (!c) {
    el.innerHTML = `<div class="compact"><div class="compact-text"><div class="compact-place"><span class="sk" style="width:9em"></span></div><div class="compact-sub"><span class="sk" style="width:12em"></span></div></div><span class="sk" style="width:44px;height:44px;border-radius:50%"></span><span class="sk" style="width:58px;height:40px"></span></div>`;
    return;
  }
  el.innerHTML = `<div class="compact">
    <div class="compact-text">
      <div class="compact-place">${esc(c.place)}</div>
      <div class="compact-sub">${c.badge ? `<span class="badge is-${c.badge.kind}">${esc(c.badge.text)}</span>` : ''}<span>${esc(c.line)}</span></div>
    </div>
    ${c.code != null ? icon(c.code, c.night) : ''}
    <div class="compact-temp">${c.temp != null ? `${t0(c.temp)}°` : '–'}</div>
  </div>`;
}

/** kompakte Zeile für den Ruhezustand aus dem Panel-Zustand */
export function compactFromState(s: PanelState): CompactData | null {
  if (!s.place) return null;
  const { sample, measured } = nowSample(s);
  if (!sample) return null;
  const night = s.place ? sunPosition(Date.now(), s.place.coord[1], s.place.coord[0]).altitude < -0.8 : false;
  const cond = describe(sample.code, night).label;
  const today = todayDaily(s);
  const hl = today ? ` · ↑ ${t0(today.tMax)}° ↓ ${t0(today.tMin)}°` : '';
  return {
    place: s.place.name,
    temp: sample.temp,
    code: sample.code,
    night,
    line: `${cond}${hl}`,
    badge: s.forecastMode ? { kind: 'forecast', text: 'Prognose' } : measured ? { kind: 'measured', text: 'Gemessen' } : undefined,
  };
}

// ------------------------------------------------------------ Panel

export function renderPanel(s: PanelState): string {
  if (!s.place) return renderEmpty();
  const parts: string[] = [];
  parts.push(renderHero(s));
  if (s.focus && s.focus.names.length > 1) parts.push(renderFocus(s.focus));
  if (s.route) parts.push(renderModes(s.route));
  if (!s.detail && s.detailStatus === 'error') {
    parts.push(renderError(s.error));
  } else {
    parts.push(renderHourly(s));
    parts.push(renderDaily(s));
    parts.push(renderTiles(s));
  }
  parts.push(renderSources());
  return parts.join('');
}

function renderEmpty(): string {
  const tries = ['Zürich', 'Zürich nach Luzern', 'Bern nach Interlaken', 'Säntis', 'Lugano'];
  return `<div class="empty">
    ${illustration('empty')}
    <h3>Wohin soll es gehen?</h3>
    <p>Ort oder Route eingeben und abspielen – das Wetter erscheint hier.</p>
    <div class="try-list">${tries.map((t) => `<button type="button" class="chip-link" data-action="try" data-text="${esc(t)}">${esc(t)}</button>`).join('')}</div>
  </div>${renderSources()}`;
}

function renderError(msg?: string): string {
  return `<div class="card empty">
    ${illustration('offline')}
    <h3>Wetterdaten gerade nicht erreichbar</h3>
    <p>${esc(msg ?? 'Der Wetterdienst antwortet im Moment nicht. Meist klappt es beim nächsten Versuch.')}</p>
    <button type="button" class="btn" data-action="retry">${uiIcon('refresh')}Nochmals versuchen</button>
  </div>`;
}

function renderHero(s: PanelState): string {
  const place = s.place!;
  const { sample, model, measured } = nowSample(s);
  const off = offsetOf(s);
  const fetchedAt = s.detail?.fetchedAt ?? s.fallback?.fetchedAt ?? null;
  const stale = s.refreshing || (fetchedAt != null && Date.now() - fetchedAt > 45 * 60e3);
  const badges: string[] = [];
  if (s.forecastMode) badges.push('<span class="badge is-forecast">Prognose</span>');
  else if (measured) badges.push('<span class="badge is-measured">Gemessen</span>');
  else if (sample) badges.push('<span class="badge is-live">Live</span>');
  if (fetchedAt) {
    const localOff = -new Date().getTimezoneOffset() * 60;
    badges.push(`<span>Stand ${hhmm(measured && s.obs ? s.obs.time : fetchedAt, localOff)}${stale ? ' · wird aktualisiert' : ''}</span>`);
  }
  if (!sample) {
    return `<div class="hero">
      <div class="hero-badges"><span class="sk" style="width:120px"></span></div>
      <h2 class="hero-place">${esc(place.name)}</h2>
      ${s.role ? `<div class="hero-sub">${esc(s.role)}</div>` : ''}
      <div class="sk-hero"><span class="sk" style="width:130px;height:84px;border-radius:18px"></span><span class="sk" style="width:110px"></span><span class="sk" style="width:90px"></span></div>
    </div>`;
  }
  const night = sunPosition(Date.now(), place.coord[1], place.coord[0]).altitude < -0.8;
  const cond = describe(sample.code, night).label;
  const today = todayDaily(s);
  void off;
  const detail = place.detail && !place.detail.startsWith(place.name) ? place.detail.replace(/, CH$/, '') : '';
  const sub = s.role ? `${s.role}${detail ? ` · ${detail}` : ''}` : detail;
  return `<div class="hero">
    <div class="hero-badges">${badges.join('')}</div>
    <h2 class="hero-place">${esc(place.name)}</h2>
    ${sub ? `<div class="hero-sub">${esc(sub)}</div>` : ''}
    <div class="hero-temp">${t0(sample.temp)}°</div>
    <div class="hero-cond">${esc(cond)}</div>
    ${
      today
        ? `<div class="hero-hl"><span>${uiIcon('arrowUp')}${t0(today.tMax)}°</span><span>${uiIcon('arrowDown')}${t0(today.tMin)}°</span></div>`
        : s.detailStatus === 'error'
          ? ''
          : `<div class="hero-hl"><span class="sk" style="width:110px"></span></div>`
    }
    ${measured && model ? `<div class="hero-model">Modell ${t0(model.temp)}° · gemessen in ${esc(s.obs!.name)}</div>` : ''}
  </div>`;
}

function renderFocus(f: { names: string[]; idx: number }): string {
  const last = f.names.length - 1;
  return `<div class="focus-switch" role="group" aria-label="Wetter anzeigen für">${f.names
    .map((n, i) => {
      const role = i === 0 ? 'Start' : i === last ? 'Ziel' : 'Via';
      return `<button type="button" class="chip-link" data-action="focus" data-idx="${i}" aria-pressed="${i === f.idx}">${role}: ${esc(n)}</button>`;
    })
    .join('')}</div>`;
}

function durationLabel(sec: number): string {
  const totalMin = Math.round(sec / 60);
  if (totalMin < 60) return `${Math.max(1, totalMin)} min`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h >= 24) return `${Math.round(sec / 3600)} h`;
  return m ? `${h} h ${String(m).padStart(2, '0')}` : `${h} h`;
}

function renderModes(r: RouteInfo): string {
  const byProfile = new Map<Profile, ModeEstimate>();
  for (const m of r.modes ?? []) byProfile.set(m.profile, m);
  const chips = MODE_ORDER.map((p) => {
    const est = byProfile.get(p);
    let time: string;
    if (p === r.profile && r.duration > 0 && (!est || est.status !== 'ok')) time = `<span class="mc-time">${durationLabel(r.duration)}</span>`;
    else if (est?.status === 'ok' && est.duration != null) time = `<span class="mc-time">${durationLabel(est.duration)}</span>`;
    else if (est) time = `<span class="mc-time is-na" title="${esc(est.detail ?? '')}">–</span>`;
    else if (r.modesStatus === 'loading') time = `<span class="mc-time"><span class="sk" style="width:3.2em"></span></span>`;
    else time = `<span class="mc-time is-na">–</span>`;
    const label = PROFILE_LABEL[p] ?? p;
    return `<button type="button" class="mode-chip" data-action="mode" data-profile="${p}" aria-pressed="${p === r.profile}" aria-label="${esc(label)}">${uiIcon(MODE_ICON[p])}<span class="mc-label">${esc(label)}</span>${time}</button>`;
  }).join('');
  const facts = [formatDistanceM(r.distance), r.profile !== 'flight' && r.gain > 20 ? `↑ ${thousands(r.gain)} m` : null].filter(Boolean).join(' · ');
  return `<section class="card" aria-label="Reisezeiten">
    <h3 class="card-h">${uiIcon('route')}Reisezeiten<span class="card-h-extra">${esc(r.places[0])} → ${esc(r.places[r.places.length - 1])}</span></h3>
    <div class="modes">${chips}</div>
    <div class="modes-foot"><span>${esc(facts)}</span><button type="button" class="chip-link" data-action="mode" data-profile="flight" aria-pressed="${r.profile === 'flight'}">${uiIcon('flight')}Als Flug</button></div>
    ${r.note ? `<p class="route-note">${esc(r.note)}</p>` : ''}
  </section>`;
}

// ------------------------------------------------------------ Stunden

function renderHourly(s: PanelState): string {
  const d = s.detail;
  const head = `<h3 class="card-h">${uiIcon('clock')}Stündlich</h3>`;
  if (!d) {
    const cells = Array.from({ length: 8 }, () => `<div class="hour"><span class="sk" style="width:26px"></span><div class="h-ic"><span class="sk" style="width:30px;height:30px;border-radius:50%"></span></div><span class="sk" style="width:24px"></span></div>`).join('');
    return `<section class="card" aria-busy="true"><p class="summary"><span class="sk" style="width:92%"></span><br><span class="sk" style="width:60%"></span></p><div class="card-sep"></div><div class="hours">${cells}</div></section>`;
  }
  const off = d.utcOffsetSec;
  const lat = d.lat;
  const lon = d.lon;
  const hrs = upcoming(d, 25);
  const { sample: cur } = nowSample(s);
  // Sonnenereignisse im Fenster
  const t0w = hrs[0]?.time ?? Date.now();
  const t1w = t0w + 24 * 3600e3;
  const events: { time: number; rise: boolean }[] = [];
  for (const day of d.daily.slice(0, 3)) {
    const sr = toMs(day.sunrise);
    const ss = toMs(day.sunset);
    if (sr && sr > Date.now() && sr < t1w) events.push({ time: sr, rise: true });
    if (ss && ss > Date.now() && ss < t1w) events.push({ time: ss, rise: false });
  }
  if (!events.length && !d.daily.length) {
    const st = sunTimes(Date.now(), lat, lon);
    if (st.sunrise && st.sunrise > Date.now()) events.push({ time: st.sunrise, rise: true });
    if (st.sunset && st.sunset > Date.now()) events.push({ time: st.sunset, rise: false });
  }
  events.sort((a, b) => a.time - b.time);

  const cells: string[] = [];
  hrs.slice(0, 24).forEach((h, i) => {
    const p = i === 0 && cur ? { ...h, temp: cur.temp, code: cur.code } : h;
    const night = isNightAt(h, lat, lon);
    const prob = h.precipProb != null && h.precipProb >= 10 ? `${Math.round(h.precipProb / 10) * 10} %` : '';
    const gusty = (h.windGust ?? 0) >= 55 && !describe(p.code).precip;
    cells.push(`<div class="hour${i === 0 ? ' is-now' : ''}">
      <span class="h-t">${i === 0 ? 'Jetzt' : `${hourOf(h.time, off)} Uhr`}</span>
      <div class="h-ic">${gusty ? windIcon() : icon(p.code, night)}<span class="h-p">${prob}</span></div>
      <span class="h-temp">${t0(p.temp)}°</span>
    </div>`);
    const nextT = hrs[i + 1]?.time ?? h.time + 3600e3;
    for (const ev of events) {
      if (ev.time >= Math.max(h.time, i === 0 ? Date.now() : h.time) && ev.time < nextT) {
        cells.push(`<div class="hour is-sun">
          <span class="h-t">${hhmm(ev.time, off)}</span>
          <div class="h-ic">${sunEventIcon(ev.rise)}<span class="h-p"></span></div>
          <span class="h-temp">${ev.rise ? 'Aufgang' : 'Untergang'}</span>
        </div>`);
      }
    }
  });
  const text = summaryText(s);
  return `<section class="card" aria-label="Stündliche Vorhersage">
    ${text ? `<p class="summary">${esc(text)}</p><div class="card-sep"></div>` : head}
    <div class="hours" role="list">${cells.join('')}</div>
  </section>`;
}

// ------------------------------------------------------------ 10 Tage

function renderDaily(s: PanelState): string {
  const d = s.detail;
  const head = `<h3 class="card-h">${uiIcon('calendar')}10-Tage-Vorhersage</h3>`;
  if (!d) {
    const rows = Array.from({ length: 5 }, () => `<div class="day"><span class="sk" style="width:40px"></span><span class="sk" style="width:28px;height:28px;border-radius:50%"></span><span class="sk" style="width:26px"></span><span class="sk" style="height:5px"></span><span class="sk" style="width:26px"></span></div>`).join('');
    return `<section class="card" aria-busy="true">${head}<div class="days">${rows}</div></section>`;
  }
  const off = d.utcOffsetSec;
  const todayKey = localDate(Date.now(), off).toISOString().slice(0, 10);
  const days = d.daily.filter((x) => dayKey(x, off) >= todayKey).slice(0, 10);
  if (!days.length) return '';
  const lo = Math.min(...days.map((x) => x.tMin));
  const hi = Math.max(...days.map((x) => x.tMax));
  const span = Math.max(1, hi - lo);
  const cur = nowSample(s).sample;
  const rows = days
    .map((x) => {
      const key = dayKey(x, off);
      const isToday = key === todayKey;
      const wd = new Date(`${key}T12:00:00Z`).getUTCDay();
      const name = isToday ? 'Heute' : WEEKDAYS[wd];
      const prob = x.precipProbMax != null && x.precipProbMax >= 20 ? `<small>${Math.round(x.precipProbMax / 10) * 10} %</small>` : '';
      const left = ((x.tMin - lo) / span) * 100;
      const width = Math.max(4, ((x.tMax - x.tMin) / span) * 100);
      const dot = isToday && cur ? `<b style="left:${Math.max(0, Math.min(100, ((cur.temp - lo) / span) * 100)).toFixed(1)}%"></b>` : '';
      return `<div class="day" role="listitem" aria-label="${name}: ${describe(x.code).label}, ${t0(x.tMin)} bis ${t0(x.tMax)} Grad">
        <span class="d-name">${name}</span>
        <span class="d-ic">${icon(x.code, false)}${prob}</span>
        <span class="d-lo">${t0(x.tMin)}°</span>
        <span class="trk"><i style="left:${left.toFixed(1)}%;width:${width.toFixed(1)}%;background:linear-gradient(90deg,${tempColor(x.tMin)},${tempColor(x.tMax)})"></i>${dot}</span>
        <span class="d-hi">${t0(x.tMax)}°</span>
      </div>`;
    })
    .join('');
  return `<section class="card" aria-label="10-Tage-Vorhersage">${head.replace('10-Tage', `${days.length}-Tage`)}<div class="days" role="list">${rows}</div></section>`;
}

// ------------------------------------------------------------ Kacheln

function tile(title: string, ic: string, body: string, extra = '', cls = ''): string {
  return `<section class="card tile ${cls}"><h3 class="card-h">${uiIcon(ic)}${title}${extra}</h3>${body}</section>`;
}

function skTile(title: string, ic: string, cls = ''): string {
  return tile(title, ic, `<span class="sk" style="width:60%;height:28px"></span><div class="tile-foot"><span class="sk" style="width:90%"></span></div>`, '', cls);
}

function uvLabel(v: number): string {
  if (v < 3) return 'Niedrig';
  if (v < 6) return 'Mässig';
  if (v < 8) return 'Hoch';
  if (v < 11) return 'Sehr hoch';
  return 'Extrem';
}

function uvTile(d: WeatherDetail, off: number): string {
  const today = dailyToday(d);
  const hrs = upcoming(d, 24);
  const curUv = d.current.uv ?? hrs[0]?.uv ?? 0;
  let foot = '';
  const rest = hrs.filter((h) => hourOf(h.time, off) >= hourOf(Date.now(), off) && localDate(h.time, off).getUTCDate() === localDate(Date.now(), off).getUTCDate());
  const peak = rest.reduce<HourlyPoint | null>((a, h) => ((h.uv ?? -1) > (a?.uv ?? -1) ? h : a), null);
  if (peak && (peak.uv ?? 0) >= 3 && peak.time > Date.now()) foot = `Höchstwert ${Math.round(peak.uv!)} um ${hourOf(peak.time, off)} Uhr.`;
  else if ((today?.uvMax ?? curUv) < 3) foot = 'Für den Rest des Tages niedrig.';
  else foot = `Heute bis ${Math.round(today?.uvMax ?? curUv)}.`;
  const pos = Math.min(100, (curUv / 11) * 100);
  return tile(
    'UV-Index',
    'uv',
    `<div class="tile-val">${Math.round(curUv)}</div><div class="tile-label">${uvLabel(curUv)}</div><div class="uv-bar"><b style="left:${pos.toFixed(1)}%"></b></div><div class="tile-foot">${foot}</div>`,
  );
}

function sunTile(d: WeatherDetail, lat: number, lon: number, off: number): string {
  const now = Date.now();
  let sr: number | null = null;
  let ss: number | null = null;
  let srNext: number | null = null;
  for (const day of d.daily.slice(0, 2)) {
    const a = toMs(day.sunrise);
    const b = toMs(day.sunset);
    if (sr == null && a && b && b > now - 18 * 3600e3) {
      sr = a;
      ss = b;
    } else if (a && srNext == null && a > now) srNext = a;
  }
  if (sr == null || ss == null) {
    const st = sunTimes(now, lat, lon);
    sr = st.sunrise;
    ss = st.sunset;
  }
  if (!sr || !ss) return tile('Sonne', 'sunrise', `<div class="tile-val">–</div><div class="tile-foot">Polartag oder Polarnacht.</div>`);
  const day = now >= sr && now < ss;
  const title = day ? 'Untergang' : 'Aufgang';
  const main = day ? ss : now < sr ? sr : (srNext ?? sr + 24 * 3600e3);
  const foot = day ? `Aufgang: ${hhmm(sr, off)}` : `Untergang: ${hhmm(ss, off)}`;
  // Sonnenbahn über den lokalen Tag (Kosinuskurve), Horizont auf Höhe Auf-/Untergang
  const W = 150;
  const H = 62;
  const dayStart = Math.floor((now + off * 1000) / 86400e3) * 86400e3 - off * 1000;
  const fx = (t: number) => (t - dayStart) / 86400e3;
  const noon = (fx(sr) + fx(ss)) / 2;
  const mid = 34;
  const amp = 24;
  const yAt = (x: number) => mid - amp * Math.cos(2 * Math.PI * (x - noon));
  const hz = yAt(fx(sr));
  const pts = (a: number, b: number) => {
    const out: string[] = [];
    for (let i = 0; i <= 40; i++) {
      const x = a + ((b - a) * i) / 40;
      out.push(`${(x * W).toFixed(1)},${yAt(x).toFixed(1)}`);
    }
    return out.join(' ');
  };
  const xn = Math.max(0, Math.min(1, fx(now)));
  const sunY = yAt(xn);
  const up = sunY < hz;
  return tile(
    title,
    'sunrise',
    `<div class="tile-val">${hhmm(main, off)}</div>
    <svg class="viz" viewBox="-4 0 ${W + 8} ${H}" aria-hidden="true">
      <polyline class="v-track-d" points="${pts(0, 1)}"/>
      <polyline class="v-day" points="${pts(fx(sr), fx(ss))}"/>
      <line class="v-horizon" x1="-4" x2="${W + 4}" y1="${hz.toFixed(1)}" y2="${hz.toFixed(1)}"/>
      ${up ? `<circle class="v-sun-glow" cx="${(xn * W).toFixed(1)}" cy="${sunY.toFixed(1)}" r="9"/>` : ''}
      <circle class="v-sun" cx="${(xn * W).toFixed(1)}" cy="${sunY.toFixed(1)}" r="4.5" ${up ? '' : 'style="opacity:.55"'}/>
    </svg>
    <div class="tile-foot">${foot}</div>`,
  );
}

function windTile(cur: WeatherSample): string {
  const R = 46;
  const c = 54;
  const ticks: string[] = [];
  for (let a = 0; a < 360; a += 10) {
    const major = a % 90 === 0;
    if (major) continue;
    const r0 = R - (a % 30 === 0 ? 7 : 4);
    const rad = (a * Math.PI) / 180;
    ticks.push(`<line class="${a % 30 === 0 ? 'v-tick-major' : 'v-tick'}" x1="${(c + Math.sin(rad) * r0).toFixed(1)}" y1="${(c - Math.cos(rad) * r0).toFixed(1)}" x2="${(c + Math.sin(rad) * R).toFixed(1)}" y2="${(c - Math.cos(rad) * R).toFixed(1)}"/>`);
  }
  const letters = [
    ['N', 0],
    ['O', 90],
    ['S', 180],
    ['W', 270],
  ] as const;
  const lt = letters
    .map(([l, a]) => {
      const rad = (a * Math.PI) / 180;
      return `<text class="v-letter${l === 'N' ? ' n' : ''}" x="${(c + Math.sin(rad) * (R - 1)).toFixed(1)}" y="${(c - Math.cos(rad) * (R - 1) + 3.5).toFixed(1)}" text-anchor="middle">${l}</text>`;
    })
    .join('');
  // Pfeil zeigt, wohin der Wind weht (aus windDir kommend)
  const to = (cur.windDir + 180) % 360;
  const arrow = `<g transform="rotate(${to.toFixed(0)} ${c} ${c})">
    <line class="v-arrow-tail" x1="${c}" y1="${c + R - 9}" x2="${c}" y2="${c + 17}"/>
    <line class="v-arrow-tail" x1="${c}" y1="${c - 17}" x2="${c}" y2="${c - R + 16}"/>
    <path class="v-arrow" d="M${c} ${c - R + 6} l-5.5 10 h11 z"/>
    <circle cx="${c}" cy="${c + R - 9}" r="3" class="v-arrow"/>
  </g>`;
  const gust = cur.windGust != null ? Math.round(cur.windGust) : null;
  const rows = [
    ['Wind', `${Math.round(cur.windSpeed)} km/h`],
    ['Böen', gust != null ? `${gust} km/h` : '–'],
    ['Richtung', `${Math.round(cur.windDir)}° ${compass(cur.windDir)}`],
  ];
  return tile(
    'Wind',
    'wind',
    `<div style="display:grid;grid-template-columns:1fr auto;gap:12px;align-items:center">
      <dl class="route-facts" style="grid-template-columns:1fr;gap:6px;margin:0">${rows.map(([k, v]) => `<div style="flex-direction:row;justify-content:space-between;border-bottom:.5px solid var(--separator);padding-bottom:6px"><dt style="font-size:15px;color:var(--text-2)">${k}</dt><dd style="font-size:15px">${v}</dd></div>`).join('')}</dl>
      <svg class="viz" viewBox="0 0 108 108" style="width:118px;margin:0" aria-label="Wind aus ${compass(cur.windDir)}">
        <circle class="v-track" cx="${c}" cy="${c}" r="${R}" style="stroke-width:1"/>
        ${ticks.join('')}${lt}${arrow}
        <circle cx="${c}" cy="${c}" r="16" style="fill:var(--glass-bg-strong)"/>
        <text class="v-center-val" x="${c}" y="${c + 3}" text-anchor="middle">${Math.round(cur.windSpeed)}</text>
        <text class="v-center-unit" x="${c}" y="${c + 12}" text-anchor="middle">km/h</text>
      </svg>
    </div>`,
    '',
    'wide',
  );
}

function precipTile(d: WeatherDetail): string {
  const now = Date.now();
  const past = d.hourly.filter((h) => h.time <= now && h.time > now - 24 * 3600e3);
  const next = d.hourly.filter((h) => h.time > now && h.time <= now + 24 * 3600e3);
  const sum = (a: HourlyPoint[]) => a.reduce((s, h) => s + (h.precip || 0), 0);
  const nextSum = sum(next);
  let val: string;
  let label: string;
  if (past.length >= 12) {
    val = `${n1s(sum(past))}`;
    label = 'in den letzten 24 h';
  } else {
    const today = dailyToday(d);
    val = `${n1s(today?.precipSum ?? 0)}`;
    label = 'heute';
  }
  const snowNext = next.reduce((s, h) => s + (h.snowfall ?? 0), 0);
  const foot =
    nextSum < 0.1
      ? 'In den nächsten 24 h kein Niederschlag erwartet.'
      : snowNext >= 1
        ? `Nächste 24 h: ${n1s(nextSum)} mm, davon etwa ${Math.round(snowNext)} cm Schnee.`
        : `Nächste 24 h: ${n1s(nextSum)} mm erwartet.`;
  return tile('Niederschlag', 'drop', `<div class="tile-val">${val}<small>mm</small></div><div class="tile-label" style="font-weight:500;color:var(--text-2);font-size:14px">${label}</div><div class="tile-foot">${foot}</div>`);
}

function feelsTile(cur: WeatherSample): string {
  const f = cur.feelsLike;
  if (f == null) return '';
  const diff = f - cur.temp;
  const foot = diff < -1.5 ? 'Der Wind lässt es kälter wirken.' : diff > 1.5 ? 'Die Feuchtigkeit lässt es wärmer wirken.' : 'Ähnlich wie die tatsächliche Temperatur.';
  return tile('Gefühlt', 'thermo', `<div class="tile-val">${t0(f)}°</div><div class="tile-foot">${foot}</div>`);
}

function humidityTile(cur: WeatherSample): string {
  if (cur.humidity == null) return '';
  const dp = cur.dewPoint;
  return tile(
    'Luftfeuchte',
    'humidity',
    `<div class="tile-val">${Math.round(cur.humidity)}<small>%</small></div><div class="tile-foot">${dp != null ? `Taupunkt aktuell ${t0(dp)}°.` : ''}</div>`,
  );
}

function visibilityTile(cur: WeatherSample): string {
  const v = cur.visibility;
  if (v == null) return '';
  const foot = v >= 30000 ? 'Ausgezeichnete Fernsicht.' : v >= 10000 ? 'Gute Sicht.' : v >= 4000 ? 'Leichter Dunst.' : v >= 1000 ? 'Dunstig, eingeschränkte Sicht.' : 'Nebel.';
  return tile('Sicht', 'eye', `<div class="tile-val">${formatVisibility(v)}</div><div class="tile-foot">${foot}</div>`);
}

function pressureTile(d: WeatherDetail, cur: WeatherSample): string {
  const p = cur.pressure;
  if (p == null) return '';
  const hrs = upcoming(d, 4);
  const later = hrs[3]?.pressure;
  const trend = later == null ? '' : later - p > 1 ? 'steigend' : later - p < -1 ? 'fallend' : 'gleichbleibend';
  const lo = 960;
  const hi = 1050;
  const u = Math.max(0, Math.min(1, (p - lo) / (hi - lo)));
  const a0 = Math.PI * 0.85;
  const a1 = Math.PI * 2.15;
  const R = 40;
  const c = 50;
  const arc = (from: number, to: number) => {
    const x0 = c + Math.cos(from) * R;
    const y0 = c + Math.sin(from) * R;
    const x1 = c + Math.cos(to) * R;
    const y1 = c + Math.sin(to) * R;
    return `M${x0.toFixed(1)} ${y0.toFixed(1)}A${R} ${R} 0 ${to - from > Math.PI ? 1 : 0} 1 ${x1.toFixed(1)} ${y1.toFixed(1)}`;
  };
  const ticks: string[] = [];
  for (let i = 0; i <= 30; i++) {
    const a = a0 + ((a1 - a0) * i) / 30;
    const r0 = R - (i % 5 === 0 ? 7 : 4);
    ticks.push(`<line class="${i % 5 === 0 ? 'v-tick-major' : 'v-tick'}" x1="${(c + Math.cos(a) * r0).toFixed(1)}" y1="${(c + Math.sin(a) * r0).toFixed(1)}" x2="${(c + Math.cos(a) * R).toFixed(1)}" y2="${(c + Math.sin(a) * R).toFixed(1)}"/>`);
  }
  const an = a0 + (a1 - a0) * u;
  return tile(
    'Luftdruck',
    'gauge',
    `<svg class="viz" viewBox="0 0 100 82" style="max-width:150px;margin:0 auto" aria-hidden="true">
      ${ticks.join('')}
      <path d="${arc(a0, an)}" fill="none" stroke="var(--accent)" stroke-width="3" stroke-linecap="round" opacity=".85"/>
      <line class="v-needle" x1="${(c + Math.cos(an) * (R - 13)).toFixed(1)}" y1="${(c + Math.sin(an) * (R - 13)).toFixed(1)}" x2="${(c + Math.cos(an) * (R + 2)).toFixed(1)}" y2="${(c + Math.sin(an) * (R + 2)).toFixed(1)}"/>
      <text class="v-center-val" x="${c}" y="${c + 2}" text-anchor="middle">${thousands(p)}</text>
      <text class="v-center-unit" x="${c}" y="${c + 12}" text-anchor="middle">hPa</text>
      ${trend ? `<text class="v-label" x="${c}" y="${c + 30}" text-anchor="middle">${trend}</text>` : ''}
    </svg>`,
  );
}

function levelTile(title: string, ic: string, level: number, siteEle: number | null, estimated: boolean, snow: boolean): string {
  // Bergsilhouette 0…4500 m, gestrichelte Linie auf der Grenze
  const W = 150;
  const H = 66;
  const maxE = 4600;
  const y = (e: number) => H - 4 - (Math.max(0, Math.min(maxE, e)) / maxE) * (H - 10);
  const ridge = `M0 ${H} L18 ${y(1400)} L34 ${y(2300)} L48 ${y(1900)} L70 ${y(3900)} L88 ${y(2900)} L104 ${y(3400)} L124 ${y(2000)} L${W} ${y(1200)} L${W} ${H} Z`;
  const ly = y(level);
  return tile(
    title,
    ic,
    `<div class="tile-val">${thousands(level)}<small>m</small></div>
    <svg class="viz" viewBox="0 0 ${W} ${H}" aria-hidden="true">
      <defs><clipPath id="clip-${ic}-${Math.round(level)}"><rect x="0" y="0" width="${W}" height="${ly.toFixed(1)}"/></clipPath></defs>
      <path class="v-mountain" d="${ridge}"/>
      ${snow ? `<path class="v-mountain-snow" d="${ridge}" clip-path="url(#clip-${ic}-${Math.round(level)})"/>` : ''}
      <line class="v-level" x1="0" x2="${W}" y1="${ly.toFixed(1)}" y2="${ly.toFixed(1)}"/>
      ${siteEle != null ? `<circle cx="10" cy="${y(siteEle).toFixed(1)}" r="3" fill="var(--accent)"/>` : ''}
    </svg>
    <div class="tile-foot">${siteEle != null ? `${level > siteEle ? `${thousands(level - siteEle)} m über` : `${thousands(siteEle - level)} m unter`} dem Ort (${thousands(siteEle)} m).` : 'Meter über Meer.'}</div>`,
    estimated ? '<span class="tile-tag">Schätzung</span>' : '',
  );
}

const AVAL_COLORS = ['#ccff66', '#ffff00', '#ff9900', '#ff0000', '#a60000'];

function avalancheTile(s: PanelState): string {
  if (!s.swiss) return '';
  const ele = s.detail?.elevation ?? null;
  if (s.avalStatus === 'loading') {
    if (ele != null && ele < 800) return '';
    return skTile('Lawinengefahr', 'warn', 'wide');
  }
  const a = s.aval;
  if (!a || a.level == null) {
    // ausserhalb der Saison: freundlicher Hinweis, aber nur im Gebirge
    if (a == null && ele != null && ele >= 900) {
      return tile(
        'Lawinengefahr',
        'warn',
        `<div class="aval"><div class="aval-level l0">–</div><div><div class="aval-title">Zurzeit kein Lawinenbulletin</div><div class="aval-meta">Das SLF veröffentlicht das Bulletin im Winterhalbjahr. <a class="aval-link" href="https://www.slf.ch/de/lawinenbulletin-und-schneesituation/" target="_blank" rel="noopener">SLF ${uiIcon('external')}</a></div></div></div>`,
        '',
        'wide',
      );
    }
    return '';
  }
  const lvl = a.level;
  const meta = [a.regionName, a.elevationNote, a.aspects?.length ? `Exposition ${a.aspects.join(', ')}` : null].filter(Boolean).join(' · ');
  const scale = AVAL_COLORS.map((c, i) => `<i class="${i < lvl ? 'on' : ''}" style="background:${c}"></i>`).join('');
  return tile(
    'Lawinengefahr',
    'warn',
    `<div class="aval">
      <div class="aval-level l${lvl}" aria-label="Gefahrenstufe ${lvl}">${lvl}</div>
      <div>
        <div class="aval-title">${esc(a.levelLabel)}</div>
        <div class="aval-meta">${esc(meta)}</div>
        <div class="aval-scale" aria-hidden="true">${scale}</div>
      </div>
    </div>
    <div class="tile-foot">${a.problems.length ? `${esc(a.problems.join(', '))}. ` : ''}${a.validUntil ? `Gültig bis ${hhmm(a.validUntil, -new Date().getTimezoneOffset() * 60)} Uhr. ` : ''}<a class="aval-link" href="${esc(a.url)}" target="_blank" rel="noopener">Bulletin beim SLF ${uiIcon('external')}</a></div>`,
    '',
    'wide',
  );
}

function stationTile(s: PanelState): string {
  if (!s.swiss) return '';
  if (s.obsStatus === 'loading') return skTile('Messstation', 'station', 'wide');
  const o = s.obs;
  if (!o) return '';
  const vals: string[] = [];
  if (o.temp != null) vals.push(`<span><strong>${n1s(o.temp)} °C</strong></span>`);
  if (o.windSpeed != null) vals.push(`<span>Wind <strong>${Math.round(o.windSpeed)} km/h</strong>${o.windGust != null ? `, Böen ${Math.round(o.windGust)}` : ''}</span>`);
  if (o.humidity != null) vals.push(`<span>Feuchte <strong>${Math.round(o.humidity)} %</strong></span>`);
  if (o.precip10min != null && o.precip10min > 0) vals.push(`<span>Regen <strong>${n1s(o.precip10min)} mm</strong>/10 min</span>`);
  if (o.pressureQff != null) vals.push(`<span><strong>${thousands(o.pressureQff)} hPa</strong></span>`);
  const where = [formatDistanceM(o.distanceM), o.elevation != null ? `${thousands(o.elevation)} m ü. M.` : null, ago(o.time)].filter(Boolean).join(', ');
  return tile(
    'Messstation',
    'station',
    `<div class="station">
      <div class="station-ic">${uiIcon('station')}</div>
      <div class="station-main">Gemessen in <b>${esc(o.name)}</b><br><span style="color:var(--text-2);font-size:13.5px">${esc(where)}</span>
        <div class="station-vals">${vals.join('')}</div>
      </div>
    </div>
    ${!s.useObs && o.temp != null ? `<div class="tile-foot">Für diesen Ort zeigt der Kopf den Modellwert (Station zu weit entfernt oder auf anderer Höhe).</div>` : ''}`,
    '<span class="tile-tag">SwissMetNet</span>',
    'wide',
  );
}

function renderTiles(s: PanelState): string {
  const d = s.detail;
  const cur = nowSample(s).sample;
  if (!d || !cur) {
    return `<div class="tiles">${skTile('UV-Index', 'uv')}${skTile('Sonne', 'sunrise')}${skTile('Wind', 'wind', 'wide')}${skTile('Niederschlag', 'drop')}${skTile('Gefühlt', 'thermo')}</div>`;
  }
  const off = d.utcOffsetSec;
  const lat = d.lat;
  const lon = d.lon;
  const base = [uvTile(d, off), sunTile(d, lat, lon, off), windTile(cur), precipTile(d), feelsTile(cur), humidityTile(cur), visibilityTile(cur), pressureTile(d, cur)];
  const swiss: string[] = [];
  if (s.swiss) {
    const fl = d.freezingLevel ?? d.current.freezingLevel ?? null;
    if (fl != null) swiss.push(levelTile('Nullgradgrenze', 'freezing', fl, d.elevation, false, false));
    const sl = d.snowLine;
    if (sl != null) swiss.push(levelTile('Schneefallgrenze', 'snowflake', sl, d.elevation, (d as { snowLineEstimated?: boolean }).snowLineEstimated ?? true, true));
  }
  const wide = [avalancheTile(s), stationTile(s)];
  return `<div class="tiles">${[...base, ...swiss, ...wide].filter(Boolean).join('')}</div>`;
}

// ------------------------------------------------------------ Quellen

export function renderSources(): string {
  const a = (href: string, t: string) => `<a href="${href}" target="_blank" rel="noopener">${t}</a>`;
  return `<footer class="sources">
    <h4>Quellen</h4>
    <p>Wetter: MeteoSchweiz-Modelle via ${a('https://open-meteo.com/', 'Open-Meteo')} / ${a('https://api.met.no/', 'MET Norway')} · Messwerte: ${a('https://www.meteoschweiz.admin.ch/', 'MeteoSchweiz')} (SwissMetNet) · Lawinen: ${a('https://www.slf.ch/', 'SLF')} · Karte: © ${a('https://www.swisstopo.admin.ch/', 'swisstopo')}, © ${a('https://www.openstreetmap.org/copyright', 'OpenStreetMap')}, ${a('https://openfreemap.org', 'OpenFreeMap')}, ${a('https://openmaptiles.org/', 'OpenMapTiles')} · Satellit: Esri, Maxar, Earthstar Geographics · ÖV: ${a('https://transport.opendata.ch/', 'transport.opendata.ch')} · Höhen: swisstopo / Mapzen · Routing: ${a('https://routing.openstreetmap.de/', 'FOSSGIS OSRM')} · Suche: ${a('https://api3.geo.admin.ch/', 'geo.admin.ch')} / ${a('https://photon.komoot.io/', 'Photon')}</p>
  </footer>`;
}
