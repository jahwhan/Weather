import 'maplibre-gl/dist/maplibre-gl.css';
import '@fontsource-variable/archivo/wdth.css';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/600.css';
import './styles.css';

import { Map as MlMap, Marker, NavigationControl, setWorkerUrl, type GeoJSONSource } from 'maplibre-gl';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';

import { buildStyle } from './map/style';
import { MapScene } from './map/scene';
import { WeatherFx } from './fx/fx';
import { computeEnv, type Env } from './env';
import { formatDistance, haversine, type LngLat } from './geo';
import { parseRouteText, formatRouteText } from './route/parse';
import { reverseGeocode, searchPlaces, type Place } from './route/geocode';
import { PROFILE_LABEL, type Profile } from './route/routing';
import { buildTrip, lineProgress, weatherAt, type Trip } from './trip';
import { Player, type Frame, type TimeMode } from './player';
import { localTime, renderCard, renderCardEmpty, escapeHtml } from './ui/weatherCard';
import { buildSeries, ProfileChart } from './ui/profile';
import { sunTimes } from './astro/sun';
import { fetchWeather } from './weather/fetch';
import type { WeatherSample } from './weather/types';

setWorkerUrl(workerUrl);

// ------------------------------------------------------------ DOM

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const input = $<HTMLInputElement>('routeInput');
const form = $<HTMLFormElement>('routeForm');
const playBtn = $<HTMLButtonElement>('playBtn');
const playLabel = $<HTMLSpanElement>('playLabel');
const tlPlay = $<HTMLButtonElement>('tlPlay');
const suggestEl = $<HTMLUListElement>('suggest');
const statusEl = $<HTMLParagraphElement>('status');
const wxEl = $<HTMLElement>('wx');
const statsEl = $<HTMLElement>('stats');
const legendEl = $<HTMLElement>('legend');
const liveBadge = $<HTMLSpanElement>('liveBadge');
const profileSeg = $<HTMLDivElement>('profileSeg');
const timeSeg = $<HTMLDivElement>('timeSeg');
const travelBtn = $<HTMLButtonElement>('travelBtn');
const departSel = $<HTMLSelectElement>('departSel');
const durSel = $<HTMLSelectElement>('durSel');
const clearBtn = $<HTMLButtonElement>('clearBtn');

// ------------------------------------------------------------ Zustand

const params = new URLSearchParams(location.search);
let profile: Profile = (['bike', 'foot', 'car', 'flight'] as Profile[]).includes(params.get('p') as Profile)
  ? (params.get('p') as Profile)
  : 'bike';
let timeMode: TimeMode = params.get('t') === 'travel' ? 'travel' : 'live';
let departOffsetH = 0;
let trip: Trip | null = null;
let tripKey = '';
const chosen = new Map<string, Place>();
let buildAbort: AbortController | null = null;
let currentEnv: Env | null = null;
let currentSample: WeatherSample | null = null;
let currentFrame: Frame | null = null;
let lastApply = 0;
let lastCard = 0;

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');

// ------------------------------------------------------------ Karte

const map = new MlMap({
  container: 'map',
  style: buildStyle(),
  center: [8.3, 38],
  zoom: 1.7,
  pitch: 0,
  maxPitch: 85,
  attributionControl: false,
  canvasContextAttributes: { antialias: true },
});
map.addControl(new NavigationControl({ visualizePitch: true }), 'bottom-right');

const scene = new MapScene(map);
const fx = new WeatherFx(map);
const player = new Player(map);
const chart = new ProfileChart($<HTMLCanvasElement>('profile'));

const markers: Marker[] = [];

/** Position der Fahrt als Kreis auf dem Gelände (DOM-Marker sitzen in steilem Gelände ungenau). */
function setHead(pos: LngLat | null): void {
  (map.getSource('head') as GeoJSONSource | undefined)?.setData(
    pos ? { type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: pos } } : { type: 'FeatureCollection', features: [] },
  );
}

map.on('load', () => {
  map.setTerrain({ source: 'dem-terrain', exaggeration: 1.3 });
  scene.updateTerminator(Date.now());
  fx.start();
  const initial = params.get('r') ?? 'Zürich bis Luzern';
  input.value = initial;
  loadFromText(initial, { fly: true, intro: true });
});

map.on('error', (e) => {
  // einzelne fehlende Kacheln sind normal, nur loggen
  console.debug('Kartenfehler', e.error?.message ?? e);
});

// Bewegung durch den Nutzer pausiert die Animation
for (const ev of ['mousedown', 'touchstart', 'wheel'] as const) {
  map.on(ev, () => {
    if (player.state === 'playing') player.pause();
  });
}

// Zoom ändert die Gewichtung Globus/Boden: Szene nachführen
map.on('move', () => {
  if (player.state === 'playing') return;
  if (currentEnv) applyEnv(currentEnv, false);
  else scene.updateTerminator(Date.now());
});

map.on('click', (e) => {
  if (player.state === 'playing') return;
  handleMapClick([e.lngLat.lng, e.lngLat.lat]);
});

// ------------------------------------------------------------ Status

function setStatus(html: string, kind: 'info' | 'busy' | 'error' = 'info'): void {
  statusEl.classList.toggle('is-error', kind === 'error');
  statusEl.innerHTML = kind === 'busy' ? `<span class="spin" aria-hidden="true"></span>${html}` : html;
  playBtn.setAttribute('aria-busy', String(kind === 'busy'));
}

function durationText(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.round((sec % 3600) / 60);
  if (h === 0) return `${m} min`;
  return `${h} h ${String(m).padStart(2, '0')} min`;
}

function tripSummary(t: Trip): string {
  if (t.kind === 'point') {
    return `<b>${escapeHtml(t.places[0].name)}</b>${t.places[0].detail ? ` · ${escapeHtml(t.places[0].detail)}` : ''}. Abspielen zeigt einen Rundflug. Ein zweiter Klick auf die Karte setzt ein Ziel.`;
  }
  const r = t.route!;
  const parts = [
    `<b>${formatDistance(r.line.length)}</b> ${PROFILE_LABEL[r.profile]}`,
    r.profile === 'flight' ? null : `↑ ${Math.round(t.gain)} m`,
    `ca. ${durationText(r.duration)}`,
    `Wetter an ${t.stops.length} Punkten`,
  ].filter(Boolean);
  return parts.join(' · ') + (t.note ? `<br>${escapeHtml(t.note)}` : '');
}

// ------------------------------------------------------------ Reise laden

class UserError extends Error {}

async function resolvePlaces(text: string, signal: AbortSignal): Promise<Place[]> {
  const segs = parseRouteText(text);
  if (segs.length === 0) throw new UserError('Bitte einen Ort oder eine Route eingeben, z. B. „Bern“ oder „Basel bis Luzern“.');
  if (segs.length > 6) throw new UserError('Höchstens sechs Orte pro Route.');
  const c = map.getCenter();
  const bias: LngLat = [c.lng, c.lat];
  return Promise.all(
    segs.map(async (seg) => {
      const known = chosen.get(norm(seg));
      if (known) return known;
      const found = await searchPlaces(seg, bias, signal, 1);
      if (!found.length) throw new UserError(`„${seg}“ wurde nicht gefunden. Schreibweise prüfen oder einen grösseren Ort wählen.`);
      return found[0];
    }),
  );
}

interface LoadOpts {
  autoplay?: boolean;
  fly?: boolean;
  intro?: boolean;
}

async function loadFromText(text: string, opts: LoadOpts = {}): Promise<void> {
  buildAbort?.abort();
  const ac = new AbortController();
  buildAbort = ac;
  setStatus('Orte suchen …', 'busy');
  try {
    const places = await resolvePlaces(text, ac.signal);
    if (ac.signal.aborted) return;
    await loadPlaces(places, opts, ac);
  } catch (err) {
    if (ac.signal.aborted) return;
    setStatus(err instanceof UserError ? escapeHtml(err.message) : failText(err), 'error');
  }
}

function failText(err: unknown): string {
  const e = err as Error;
  if (e?.name === 'TimeoutError' || e?.name === 'AbortError') return 'Ein Dienst antwortet gerade nicht (Zeitüberschreitung). Bitte nochmals auf Abspielen drücken.';
  return `Laden fehlgeschlagen: ${escapeHtml(String(e?.message ?? err))}. Internetverbindung prüfen und erneut versuchen.`;
}

async function loadPlaces(places: Place[], opts: LoadOpts = {}, ac?: AbortController): Promise<void> {
  if (!ac) {
    buildAbort?.abort();
    ac = new AbortController();
    buildAbort = ac;
  }
  const signal = ac.signal;
  player.stop();
  try {
    const t = await buildTrip(places, profile, signal, (stage) => setStatus(escapeHtml(stage), 'busy'));
    if (signal.aborted) return;
    trip = t;
    tripKey = keyFor(places.map((p) => p.name), profile);
    for (const p of places) chosen.set(norm(p.name), p);
    showTrip(t);
    player.setTrip(t);
    setStatus(tripSummary(t));
    updateTimeControls();
    refreshSeries();
    setIdleFocus();
    history.replaceState(null, '', `?r=${encodeURIComponent(formatRouteText(places.map((p) => p.name)))}&p=${profile}${timeMode === 'travel' ? '&t=travel' : ''}`);
    if (opts.fly) flyToOverview(t, opts.intro ? 4200 : 1800);
    if (opts.autoplay) setTimeout(() => startPlayback(), opts.fly ? 1900 : 0);
  } catch (err) {
    if (signal.aborted) return;
    setStatus(failText(err), 'error');
  }
}

const keyFor = (names: string[], p: Profile) => `${names.map(norm).join('|')}#${p}`;

function showTrip(t: Trip): void {
  const src = map.getSource('route') as GeoJSONSource | undefined;
  src?.setData(
    t.line
      ? { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: t.line.coords } }
      : { type: 'FeatureCollection', features: [] },
  );
  scene.setRouteProgress(null);
  scene.setGhostVisible(false);
  markers.forEach((m) => m.remove());
  markers.length = 0;
  t.places.forEach((p, i) => {
    // MapLibre setzt transform auf das Marker-Element, darum die Drehung innen
    const el = document.createElement('div');
    const last = i === t.places.length - 1 && t.places.length > 1;
    el.innerHTML = `<div class="pin${last ? ' is-end' : ''}"><span>${String.fromCharCode(65 + i)}</span></div>`;
    el.title = p.name;
    markers.push(new Marker({ element: el, anchor: 'bottom', offset: [0, -6] }).setLngLat(p.coord).addTo(map));
  });
  setHead(null);
}

function uiPadding() {
  const el = map.getContainer();
  const wide = el.clientWidth > 860;
  const cmd = $('cmd').getBoundingClientRect();
  const tl = $('timeline').getBoundingClientRect();
  const wx = wxEl.getBoundingClientRect();
  return wide
    ? { top: 60, bottom: el.clientHeight - tl.top + 30, left: cmd.right + 40, right: el.clientWidth - wx.left + 40 }
    : { top: wx.bottom + 30, bottom: el.clientHeight - tl.top + 30, left: 30, right: 30 };
}

function flyToOverview(t: Trip, duration: number): void {
  if (t.kind === 'point') {
    map.flyTo({ center: t.places[0].coord, zoom: 12.6, pitch: 62, bearing: -20, duration, padding: uiPadding(), essential: true });
    return;
  }
  const [sw, ne] = t.line!.bounds();
  const cam = map.cameraForBounds([sw, ne], { padding: uiPadding(), pitch: 50, bearing: -15, absolutePadding: true });
  if (!cam) return;
  map.flyTo({ ...cam, pitch: 50, bearing: -15, zoom: Math.min(cam.zoom ?? 10, 14.5), duration, essential: true });
}

// ------------------------------------------------------------ Klick auf die Karte

let clickSeq = 0;
async function handleMapClick(coord: LngLat): Promise<void> {
  const seq = ++clickSeq;
  const prev = trip?.places ?? [];
  const keepStart = prev.length === 1 && haversine(prev[0].coord, coord) > 200;
  setStatus(keepStart ? 'Ziel gesetzt, Route wird berechnet …' : 'Ort gesetzt, Wetter wird geladen …', 'busy');
  const place = await reverseGeocode(coord);
  if (seq !== clickSeq) return;
  const next = keepStart ? [prev[0], place] : [place];
  chosen.set(norm(place.name), place);
  input.value = formatRouteText(next.map((p) => p.name));
  await loadPlaces(next, { fly: !keepStart });
  if (keepStart && trip) flyToOverview(trip, 1600);
}

// ------------------------------------------------------------ Umgebung anwenden

function frameLive(): boolean {
  return departOffsetH === 0;
}

function departure(): number {
  return Date.now() + departOffsetH * 3600e3;
}

function applyEnv(env: Env, force: boolean): void {
  fx.setEnv(env);
  const now = performance.now();
  if (force || now - lastApply > 70) {
    lastApply = now;
    scene.apply(env);
  }
}

function updateCard(force = false): void {
  const now = performance.now();
  if (!force && now - lastCard < 110) return;
  lastCard = now;
  if (!trip || !currentEnv || !currentSample) return;
  const playing = player.state !== 'idle' && currentFrame;
  let place = trip.places[0].name;
  if (trip.kind === 'route') {
    const names = trip.places.map((p) => p.name);
    place = playing
      ? `km ${(currentFrame!.dist / 1000).toFixed(1).replace('.', ',')} → ${names[names.length - 1]}`
      : `${names[0]} · Start`;
  }
  const stop = currentFrame && trip.kind === 'route' ? weatherAt(trip, currentFrame.dist, currentFrame.time, frameLive()).stop : trip.stops[0];
  const live = frameLive() && Math.abs(currentEnv.time - Date.now()) < 30 * 60e3;
  renderCard(wxEl, currentEnv, currentSample, {
    place,
    utcOffsetSec: stop.weather.utcOffsetSec,
    source: stop.weather.source,
    fetchedAt: stop.weather.fetchedAt,
    live,
    cameraBearing: map.getBearing(),
  });
  liveBadge.textContent = live ? 'Live' : 'Prognose';
  liveBadge.classList.toggle('is-forecast', !live);
  updateStats();
}

/** Ruhezustand: Wetter am Start bzw. am Ort, zur gewählten Startzeit. */
function setIdleFocus(): void {
  if (!trip) return;
  currentFrame = null;
  setHead(null);
  const time = departure();
  const w = weatherAt(trip, 0, time, frameLive());
  currentSample = w.sample;
  currentEnv = computeEnv(w.sample, w.lat, w.lon, time);
  applyEnv(currentEnv, true);
  updateCard(true);
  chart.setCursor(0);
}

function onFrame(f: Frame): void {
  if (!trip) return;
  currentFrame = f;
  const w = weatherAt(trip, f.dist, f.time, frameLive());
  currentSample = w.sample;
  currentEnv = computeEnv(w.sample, w.lat, w.lon, f.time);
  fx.setMotion(f.motion);
  applyEnv(currentEnv, false);
  if (trip.kind === 'route') {
    setHead(trip.line!.pointAt(f.dist));
    scene.setRouteProgress(f.phase === 'outro' ? null : lineProgress(trip, f.dist));
    scene.setGhostVisible(f.phase !== 'outro');
  }
  chart.setCursor(f.routeFrac);
  updateCard();
}

player.onFrame = onFrame;
player.onState = (s) => {
  const playing = s === 'playing';
  document.body.classList.toggle('is-playing', playing);
  form.classList.toggle('is-playing', playing);
  tlPlay.classList.toggle('is-playing', playing);
  tlPlay.setAttribute('aria-label', playing ? 'Pause' : 'Abspielen');
  playLabel.textContent = playing ? 'Pause' : s === 'paused' ? 'Weiter' : 'Abspielen';
  fx.setCinematic(playing);
  if (!playing) fx.setMotion(0);
  if (s === 'idle') {
    scene.setGhostVisible(false);
    scene.setRouteProgress(null);
  }
};

function startPlayback(): void {
  if (!trip) return;
  if (player.state === 'paused') {
    player.play();
    return;
  }
  const dur = durSel.value === 'auto' ? Player.autoDuration(trip) : Number(durSel.value) * 1000;
  player.durationMs = dur;
  player.mode = timeMode;
  player.departure = departure();
  if (trip.kind === 'point' && currentEnv) {
    // zuerst Richtung Sonne (oder Mond) blicken
    player.orbitStartBearing =
      currentEnv.sunAlt > -3 ? currentEnv.sunAz : currentEnv.moon.altitude > 0 ? currentEnv.moon.azimuth : map.getBearing();
  }
  scene.setGhostVisible(true);
  scene.setRouteProgress(0);
  player.play();
}

// ------------------------------------------------------------ Kennzahlen unter dem Profil

function eleAt(dist: number): number | null {
  const p = trip?.profile;
  if (!p || !p.length) return null;
  let j = 0;
  while (j < p.length - 2 && p[j + 1].dist < dist) j++;
  const a = p[j];
  const b = p[Math.min(j + 1, p.length - 1)];
  const u = Math.max(0, Math.min(1, (dist - a.dist) / (b.dist - a.dist || 1)));
  return a.ele + (b.ele - a.ele) * u;
}

function updateStats(): void {
  if (!trip || !currentEnv) {
    statsEl.innerHTML = '';
    return;
  }
  const off = trip.stops[0].weather.utcOffsetSec;
  const items: [string, string][] = [];
  if (trip.kind === 'route') {
    const L = trip.line!.length;
    const d = currentFrame?.dist ?? 0;
    items.push(['Distanz', `${formatDistance(d)} / ${formatDistance(L)}`]);
    const e = eleAt(d);
    if (e != null && trip.route?.profile !== 'flight') items.push(['Höhe', `${Math.round(e)} m ü. M.`]);
    if (trip.route?.profile !== 'flight') items.push(['Anstieg', `↑ ${Math.round(trip.gain)} m`]);
    items.push(['Ortszeit', localTime(currentEnv.time, off, departOffsetH > 12)]);
    if (timeMode === 'travel') items.push(['Ankunft', localTime(departure() + (trip.route?.duration ?? 0) * 1000, trip.stops[trip.stops.length - 1].weather.utcOffsetSec, true)]);
    else items.push(['Reisezeit', durationText(trip.route?.duration ?? 0)]);
  } else {
    const p = trip.stops[0].point;
    const st = sunTimes(currentEnv.time, p[1], p[0]);
    items.push(['Ortszeit', localTime(currentEnv.time, off, timeMode === 'travel' || departOffsetH > 12)]);
    items.push(['Aufgang', st.sunrise ? localTime(st.sunrise, off) : '–']);
    items.push(['Untergang', st.sunset ? localTime(st.sunset, off) : '–']);
    if (st.sunrise && st.sunset) items.push(['Tageslänge', durationText((st.sunset - st.sunrise) / 1000)]);
    items.push(['Höhe', trip.stops[0].weather.elevation != null ? `${Math.round(trip.stops[0].weather.elevation)} m ü. M.` : '–']);
  }
  statsEl.innerHTML = items.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('');
}

function refreshSeries(): void {
  if (!trip) {
    chart.setSeries(null);
    return;
  }
  const travel = timeMode === 'travel';
  chart.setSeries(buildSeries(trip, departure(), travel || trip.kind === 'point', frameLive()));
  const isPoint = trip.kind === 'point';
  legendEl.innerHTML = [
    isPoint ? '' : '<span><i style="background:rgba(238,242,248,.7)"></i>Höhe</span>',
    '<span><i style="background:linear-gradient(90deg,#7cc4ff,#dcecf5,#ffc46e)"></i>Temperatur</span>',
    '<span><i style="background:#5fb0ff"></i>Niederschlag</span>',
    '<span><i style="background:#d6deea"></i>Bewölkung</span>',
    '<span><i style="background:linear-gradient(90deg,#141c3c,#ffb347,#dce4f0)"></i>Tag/Nacht</span>',
    isPoint ? '<span>x-Achse: nächste 24 h</span>' : travel ? '<span>x-Achse: Strecke, Wetter zur Ankunftszeit</span>' : '<span>x-Achse: Strecke, Wetter jetzt</span>',
  ].join('');
}

chart.onSeek = (frac) => {
  if (!trip) return;
  // Profil-Anteil in Zeitachse der Animation umrechnen
  let lo = 0.1;
  let hi = 0.88;
  for (let i = 0; i < 30; i++) {
    const mid = (lo + hi) / 2;
    const f = player.frameAt(mid);
    if (!f) return;
    if (f.routeFrac < frac) lo = mid;
    else hi = mid;
  }
  if (player.state === 'idle') {
    player.durationMs = durSel.value === 'auto' ? Player.autoDuration(trip) : Number(durSel.value) * 1000;
    player.mode = timeMode;
    player.departure = departure();
    scene.setGhostVisible(true);
  }
  if (player.state === 'playing') player.pause();
  player.seek((lo + hi) / 2);
};

// ------------------------------------------------------------ Bedienelemente

function setSeg(seg: HTMLElement, value: string): void {
  seg.querySelectorAll<HTMLButtonElement>('button').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.v === value)));
}

setSeg(profileSeg, profile);
setSeg(timeSeg, timeMode);

profileSeg.addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest('button');
  if (!b?.dataset.v || b.dataset.v === profile) return;
  profile = b.dataset.v as Profile;
  setSeg(profileSeg, profile);
  if (trip && trip.places.length > 1) loadPlaces(trip.places, { fly: true });
});

timeSeg.addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest('button');
  if (!b?.dataset.v || b.disabled) return;
  timeMode = b.dataset.v as TimeMode;
  setSeg(timeSeg, timeMode);
  player.stop();
  refreshSeries();
  setIdleFocus();
});

function fillDepart(): void {
  const prev = departSel.value || '0';
  const now = Date.now();
  const opts = [0, 1, 2, 3, 6, 9, 12, 18, 24, 36, 48];
  departSel.innerHTML = opts
    .map((h) => {
      const label = h === 0 ? 'jetzt' : `+${h} h · ${localTime(now + h * 3600e3, -new Date().getTimezoneOffset() * 60, h >= 12)}`;
      return `<option value="${h}">${label}</option>`;
    })
    .join('');
  departSel.value = prev;
}
fillDepart();
departSel.addEventListener('focus', fillDepart);
departSel.addEventListener('change', () => {
  departOffsetH = Number(departSel.value);
  player.stop();
  refreshSeries();
  setIdleFocus();
});

function updateTimeControls(): void {
  const isPoint = trip?.kind === 'point';
  travelBtn.textContent = isPoint ? '24 h' : 'Unterwegs';
  travelBtn.title = isPoint ? 'Zeitraffer über die nächsten 24 Stunden' : 'Wetter zur Zeit, zu der man dort ankommt';
}

durSel.addEventListener('change', () => {
  if (player.state !== 'idle' && trip) player.durationMs = durSel.value === 'auto' ? Player.autoDuration(trip) : Number(durSel.value) * 1000;
});

form.addEventListener('submit', (e) => {
  e.preventDefault();
  closeSuggest();
  const text = input.value.trim();
  if (!text) {
    setStatus('Ort oder Route eingeben, z. B. „Bern“ oder „Basel bis Luzern“, oder auf die Karte klicken.', 'error');
    input.focus();
    return;
  }
  if (player.state === 'playing') {
    player.pause();
    return;
  }
  const segs = parseRouteText(text);
  if (trip && keyFor(segs, profile) === tripKey) startPlayback();
  else loadFromText(text, { autoplay: true, fly: false });
});

tlPlay.addEventListener('click', () => {
  if (player.state === 'playing') player.pause();
  else if (trip) startPlayback();
});

clearBtn.addEventListener('click', () => {
  input.value = '';
  input.focus();
  closeSuggest();
});

document.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
  if (e.code === 'Space' && trip) {
    e.preventDefault();
    if (player.state === 'playing') player.pause();
    else startPlayback();
  }
});

wxEl.addEventListener('click', () => wxEl.classList.toggle('is-open'));

const optsBtn = $<HTMLButtonElement>('optsBtn');
optsBtn.addEventListener('click', () => {
  const open = !$('cmd').classList.contains('is-open');
  $('cmd').classList.toggle('is-open', open);
  optsBtn.setAttribute('aria-expanded', String(open));
});

// ------------------------------------------------------------ Vorschläge

let suggestAbort: AbortController | null = null;
let suggestTimer = 0;
let suggestItems: Place[] = [];
let activeIdx = -1;

const SEP_RE = /\s+(?:bis|nach|to|über|ueber|via)\s+|\s*(?:→|->|–|—)\s*|\s+-\s+/gi;

function lastSegment(text: string): { seg: string; start: number } {
  let start = 0;
  for (const m of text.matchAll(SEP_RE)) start = (m.index ?? 0) + m[0].length;
  return { seg: text.slice(start).replace(/^von\s+/i, ''), start };
}

function closeSuggest(): void {
  suggestEl.hidden = true;
  suggestItems = [];
  activeIdx = -1;
  input.setAttribute('aria-expanded', 'false');
}

function renderSuggest(): void {
  if (!suggestItems.length) return closeSuggest();
  suggestEl.innerHTML = suggestItems
    .map(
      (p, i) =>
        `<li role="option" id="sg-${i}" aria-selected="${i === activeIdx}" data-i="${i}"><span class="s-name">${escapeHtml(p.name)}</span>${p.detail ? `<span class="s-detail">${escapeHtml(p.detail)}</span>` : ''}</li>`,
    )
    .join('');
  suggestEl.hidden = false;
  input.setAttribute('aria-expanded', 'true');
}

function pickSuggestion(i: number): void {
  const p = suggestItems[i];
  if (!p) return;
  const { start } = lastSegment(input.value);
  input.value = input.value.slice(0, start) + p.name;
  chosen.set(norm(p.name), p);
  closeSuggest();
  input.focus();
  // gleich laden, damit Karte und Wetter reagieren
  loadFromText(input.value, { fly: true });
}

input.addEventListener('input', () => {
  clearTimeout(suggestTimer);
  const { seg } = lastSegment(input.value);
  if (seg.trim().length < 2) return closeSuggest();
  suggestTimer = window.setTimeout(async () => {
    suggestAbort?.abort();
    const ac = new AbortController();
    suggestAbort = ac;
    try {
      const c = map.getCenter();
      const res = await searchPlaces(seg, [c.lng, c.lat], ac.signal, 6);
      if (ac.signal.aborted) return;
      suggestItems = res;
      activeIdx = -1;
      renderSuggest();
    } catch {
      /* Suche abgebrochen oder offline */
    }
  }, 220);
});

input.addEventListener('keydown', (e) => {
  if (suggestEl.hidden) return;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    const n = suggestItems.length;
    activeIdx = (activeIdx + (e.key === 'ArrowDown' ? 1 : -1) + n) % n;
    renderSuggest();
    input.setAttribute('aria-activedescendant', `sg-${activeIdx}`);
  } else if (e.key === 'Enter' && activeIdx >= 0) {
    e.preventDefault();
    pickSuggestion(activeIdx);
  } else if (e.key === 'Escape') {
    closeSuggest();
  }
});

suggestEl.addEventListener('mousedown', (e) => {
  const li = (e.target as HTMLElement).closest('li');
  if (!li) return;
  e.preventDefault();
  pickSuggestion(Number(li.dataset.i));
});

input.addEventListener('blur', () => setTimeout(closeSuggest, 150));

// ------------------------------------------------------------ Live halten

// Uhrzeit läuft weiter: Sonnenstand im Ruhezustand jede Minute nachführen
setInterval(() => {
  if (player.state === 'idle' && trip && !currentFrame) setIdleFocus();
}, 60e3);

// Wetter alle 10 Minuten neu laden
setInterval(async () => {
  if (!trip || player.state === 'playing') return;
  try {
    const t = trip;
    const res = await fetchWeather(t.stops.map((s) => ({ lat: s.point[1], lon: s.point[0] })));
    if (t !== trip) return;
    t.stops.forEach((s, i) => (s.weather = res.points[i]));
    refreshSeries();
    if (player.state === 'idle' && !currentFrame) setIdleFocus();
  } catch {
    /* beim nächsten Mal wieder */
  }
}, 10 * 60e3);

renderCardEmpty(wxEl, 'Live-Wetter wird geladen …');

// für Tests und zum Ausprobieren in der Konsole
Object.assign(window, { wetterflug: { map, player, scene, fx, get trip() { return trip; }, get env() { return currentEnv; } } });
