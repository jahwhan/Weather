import 'maplibre-gl/dist/maplibre-gl.css';
import './ui/tokens.css';
import './ui/hud.css';
import './ui/sheet.css';

import { Map as MlMap, Marker, NavigationControl, setWorkerUrl, type GeoJSONSource } from 'maplibre-gl';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';

import { buildStyle } from './map/style';
import { MapScene } from './map/scene';
import { WeatherFx } from './fx/fx';
import { computeEnv, type Env } from './env';
import { formatDistance, haversine, type LngLat } from './geo';
import { parseRouteText, formatRouteText } from './route/parse';
import { reverseGeocode, searchPlaces, type Place } from './route/geocode';
import { DEFAULT_PROFILE, PROFILE_LABEL, type Profile } from './route/routing';
import { compareModes as compareModesApi, type ModeEstimate } from './route/modes';
import { buildTrip, lineProgress, weatherAt, type Trip } from './trip';
import { Player, type Frame, type TimeMode } from './player';
import { localTime, liveCompact } from './ui/weatherCard';
import { buildSeries, ProfileChart } from './ui/profile';
import { BottomSheet, type Snap } from './ui/sheet';
import { uiIcon } from './ui/icons';
import { escapeHtml } from './ui/format';
import {
  compactFromState,
  MODE_ICON,
  MODE_ORDER,
  nowSample,
  renderCompact,
  renderPanel,
  summaryText,
  type PanelState,
} from './ui/weatherPanel';
import { sunTimes } from './astro/sun';
import { fetchWeather, sampleAt } from './weather/fetch';
import { cachedDetail, fetchDetail, type WeatherDetail } from './weather/detail';
import { nearestStation, shouldUseObservation } from './swiss/smn';
import { avalancheDanger } from './swiss/slf';
import { isInSwitzerland } from './swiss/region';
import type { WeatherSample } from './weather/types';
import { describe } from './weather/conditions';

setWorkerUrl(workerUrl);

// ------------------------------------------------------------ DOM

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const input = $<HTMLInputElement>('routeInput');
const form = $<HTMLFormElement>('routeForm');
const playBtn = $<HTMLButtonElement>('playBtn');
const suggestEl = $<HTMLUListElement>('suggest');
const statusEl = $<HTMLDivElement>('status');
const hintEl = $<HTMLDivElement>('hint');
const statsEl = $<HTMLElement>('stats');
const legendEl = $<HTMLElement>('legend');
const timelineEl = $<HTMLElement>('timeline');
const timeSeg = $<HTMLDivElement>('timeSeg');
const travelBtn = $<HTMLButtonElement>('travelBtn');
const timeNote = $<HTMLParagraphElement>('timeNote');
const departSel = $<HTMLSelectElement>('departSel');
const durSel = $<HTMLSelectElement>('durSel');
const clearBtn = $<HTMLButtonElement>('clearBtn');
const modeBtn = $<HTMLButtonElement>('modeBtn');
const timeBtn = $<HTMLButtonElement>('timeBtn');
const chatBtn = $<HTMLButtonElement>('chatBtn');
const settingsBtn = $<HTMLButtonElement>('settingsBtn');
const modeList = $<HTMLDivElement>('modeList');
const wxBody = $<HTMLDivElement>('wxBody');
const wxCompact = $<HTMLDivElement>('wxCompact');

// ------------------------------------------------------------ Gespeicherter Zustand

const STATE_KEY = 'wetterflug.state.v2';
const SNAP_KEY = 'wetterflug.snapshot.v1';
const HINT_KEY = 'wetterflug.hint.v1';
const RECENT_KEY = 'wetterflug.recent.v1';

interface SavedState {
  text?: string;
  profile?: Profile;
  timeMode?: TimeMode;
  cam?: { center: LngLat; zoom: number; pitch: number; bearing: number };
  dur?: string;
}

interface Snapshot {
  name: string;
  coord: LngLat;
  detail: WeatherDetail;
}

function readJson<T>(key: string): T | null {
  try {
    const v = localStorage.getItem(key);
    return v ? (JSON.parse(v) as T) : null;
  } catch {
    return null;
  }
}
function writeJson(key: string, v: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch {
    /* Speicher voll oder gesperrt */
  }
}

const saved: SavedState = readJson<SavedState>(STATE_KEY) ?? {};
function persist(patch: Partial<SavedState>): void {
  Object.assign(saved, patch);
  writeJson(STATE_KEY, saved);
}

// ------------------------------------------------------------ Zustand

const ALL_PROFILES: Profile[] = ['car', 'transit', 'bike', 'foot', 'flight'];
const params = new URLSearchParams(location.search);
const urlProfile = params.get('p') as Profile | null;
let profile: Profile = urlProfile && ALL_PROFILES.includes(urlProfile) ? urlProfile : saved.profile && ALL_PROFILES.includes(saved.profile) ? saved.profile : DEFAULT_PROFILE;
let timeMode: TimeMode = params.get('t') === 'travel' ? 'travel' : (saved.timeMode ?? 'live');
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
let focusIdx = 0;
let modesCache: { key: string; list: ModeEstimate[] } | null = null;
if (saved.dur) durSel.value = saved.dur;

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');

// bekannte Orte: kein Geocoding nötig für den ersten Eindruck
const KNOWN: Place[] = [
  { name: 'Zürich', detail: 'Zürich, CH', coord: [8.5417, 47.3769], kind: 'city' },
  { name: 'Luzern', detail: 'Luzern, CH', coord: [8.3093, 47.0502], kind: 'city' },
  { name: 'Bern', detail: 'Bern, CH', coord: [7.4474, 46.948], kind: 'city' },
  { name: 'Basel', detail: 'Basel-Stadt, CH', coord: [7.5886, 47.5596], kind: 'city' },
  { name: 'Genf', detail: 'Genf, CH', coord: [6.1432, 46.2044], kind: 'city' },
  { name: 'Lausanne', detail: 'Waadt, CH', coord: [6.6323, 46.5197], kind: 'city' },
  { name: 'Lugano', detail: 'Tessin, CH', coord: [8.9511, 46.0037], kind: 'city' },
  { name: 'St. Gallen', detail: 'St. Gallen, CH', coord: [9.3767, 47.4245], kind: 'city' },
  { name: 'Interlaken', detail: 'Bern, CH', coord: [7.8632, 46.6863], kind: 'town' },
  { name: 'Chur', detail: 'Graubünden, CH', coord: [9.532, 46.8499], kind: 'city' },
  { name: 'Zermatt', detail: 'Wallis, CH', coord: [7.7491, 46.0207], kind: 'village' },
  { name: 'Säntis', detail: 'Appenzell, CH', coord: [9.3434, 47.2493], kind: 'peak' },
];
for (const p of KNOWN) chosen.set(norm(p.name), p);

// ------------------------------------------------------------ Karte: direkt über der Schweiz in 3D

const DEFAULT_CAM = { center: [8.23, 46.8] as LngLat, zoom: 7.3, pitch: 45, bearing: -10 };
const startCam = saved.cam && Number.isFinite(saved.cam.zoom) ? saved.cam : DEFAULT_CAM;

const map = new MlMap({
  container: 'map',
  style: buildStyle(),
  center: startCam.center,
  zoom: startCam.zoom,
  pitch: startCam.pitch,
  bearing: startCam.bearing,
  maxPitch: 85,
  attributionControl: false,
  canvasContextAttributes: { antialias: true },
});
map.addControl(new NavigationControl({ visualizePitch: true }), 'top-right');

const scene = new MapScene(map);
const fx = new WeatherFx(map);
const player = new Player(map);
const chart = new ProfileChart($<HTMLCanvasElement>('profile'));
const sheet = new BottomSheet($('sheet'));

const markers: Marker[] = [];

function setHead(pos: LngLat | null): void {
  (map.getSource('head') as GeoJSONSource | undefined)?.setData(
    pos ? { type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: pos } } : { type: 'FeatureCollection', features: [] },
  );
}

const initialText = params.get('r') ?? saved.text ?? 'Zürich';
input.value = initialText;
syncSearchState();

// Wetter für einen bekannten Startort sofort laden und zeigen, nicht erst nach der Karte
{
  const segs = parseRouteText(initialText);
  const first = segs.length === 1 ? chosen.get(norm(segs[0])) : undefined;
  // erst nach dem Modul-Durchlauf, weil das Panel weiter unten definiert wird
  if (first) queueMicrotask(() => startPanel([first], first));
}

map.on('load', () => {
  map.setTerrain({ source: 'dem-terrain', exaggeration: 1.3 });
  scene.updateTerminator(Date.now());
  fx.start();
  loadFromText(initialText, { fly: !saved.cam, gentle: true });
});

map.on('error', (e) => {
  console.debug('Kartenfehler', e.error?.message ?? e);
});

for (const ev of ['mousedown', 'touchstart', 'wheel'] as const) {
  map.on(ev, () => {
    if (player.state === 'playing') player.pause();
  });
}

map.on('move', () => {
  if (player.state === 'playing') return;
  if (currentEnv) applyEnv(currentEnv, false);
  else scene.updateTerminator(Date.now());
});

let camTimer = 0;
map.on('moveend', () => {
  if (player.state !== 'idle') return;
  clearTimeout(camTimer);
  camTimer = window.setTimeout(() => {
    const c = map.getCenter();
    persist({ cam: { center: [+c.lng.toFixed(5), +c.lat.toFixed(5)], zoom: +map.getZoom().toFixed(2), pitch: Math.round(map.getPitch()), bearing: Math.round(map.getBearing()) } });
  }, 600);
});

map.on('click', (e) => {
  if (player.state === 'playing') return;
  closePopovers();
  handleMapClick([e.lngLat.lng, e.lngLat.lat]);
});

// ------------------------------------------------------------ Status (Toast)

let statusTimer = 0;
let retryAction: (() => void) | null = null;

function setStatus(text: string, kind: 'info' | 'busy' | 'error' | 'clear' = 'info', retry?: () => void): void {
  clearTimeout(statusTimer);
  const busy = kind === 'busy';
  form.setAttribute('aria-busy', String(busy));
  playBtn.setAttribute('aria-busy', String(busy));
  if (kind === 'clear' || !text) {
    statusEl.hidden = true;
    return;
  }
  statusEl.hidden = false;
  statusEl.classList.toggle('is-error', kind === 'error');
  retryAction = retry ?? null;
  if (kind === 'error') {
    statusEl.innerHTML = `<span class="t-icon">${uiIcon('warn')}</span><div class="t-body"><span>${escapeHtml(text)}</span><div class="t-actions">${retry ? `<button type="button" class="btn" data-action="retry">${uiIcon('refresh')}Nochmals versuchen</button>` : ''}<button type="button" class="btn secondary" data-action="dismiss">Schliessen</button></div></div>`;
  } else {
    statusEl.innerHTML = `${busy ? '<span class="spinner" aria-hidden="true"></span>' : ''}<span>${escapeHtml(text)}</span>`;
    if (!busy) statusTimer = window.setTimeout(() => (statusEl.hidden = true), 3800);
  }
}

statusEl.addEventListener('click', (e) => {
  const a = (e.target as HTMLElement).closest<HTMLElement>('[data-action]')?.dataset.action;
  if (a === 'retry') {
    statusEl.hidden = true;
    retryAction?.();
  } else if (a === 'dismiss') statusEl.hidden = true;
});

function durationText(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.round((sec % 3600) / 60);
  if (h === 0) return `${m} min`;
  return `${h} h ${String(m).padStart(2, '0')} min`;
}

// ------------------------------------------------------------ Reise laden

class UserError extends Error {}

async function resolvePlaces(text: string, signal: AbortSignal): Promise<Place[]> {
  const segs = parseRouteText(text);
  if (segs.length === 0) throw new UserError('Bitte einen Ort oder eine Route eingeben, z. B. „Bern“ oder „Zürich nach Luzern“.');
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
  /** erster Start: kurze, sanfte Kamerafahrt */
  gentle?: boolean;
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
    setStatus(err instanceof UserError ? err.message : failText(err), 'error', err instanceof UserError ? undefined : () => loadFromText(text, opts));
    if (!trip) renderAll();
  }
}

function failText(err: unknown): string {
  const e = err as Error;
  if (e?.name === 'TimeoutError' || e?.name === 'AbortError') return 'Ein Dienst antwortet gerade nicht. Bitte gleich nochmals versuchen.';
  return 'Laden hat nicht geklappt. Internetverbindung prüfen und nochmals versuchen.';
}

async function loadPlaces(places: Place[], opts: LoadOpts = {}, ac?: AbortController): Promise<void> {
  if (!ac) {
    buildAbort?.abort();
    ac = new AbortController();
    buildAbort = ac;
  }
  const signal = ac.signal;
  player.stop();
  const prevKey = trip ? trip.places.map((p) => norm(p.name)).join('|') : '';
  // Panel sofort auf den neuen Ort stellen (zeigt Gespeichertes oder Skeleton)
  const nextKey = places.map((p) => norm(p.name)).join('|');
  if (nextKey !== prevKey) {
    focusIdx = places.length > 1 ? places.length - 1 : 0;
    startPanel(places, places[focusIdx]);
  }
  try {
    const t = await buildTrip(places, profile, signal, (stage) => setStatus(stage, 'busy'));
    if (signal.aborted) return;
    trip = t;
    tripKey = keyFor(places.map((p) => p.name), profile);
    for (const p of places) chosen.set(norm(p.name), p);
    showTrip(t);
    player.setTrip(t);
    setStatus('', 'clear');
    if (t.note) setStatus(t.note, 'info');
    updateTimeControls();
    refreshSeries();
    setIdleFocus();
    timelineEl.hidden = false;
    const text = formatRouteText(places.map((p) => p.name));
    persist({ text, profile, timeMode });
    pushRecent(text);
    history.replaceState(null, '', `?r=${encodeURIComponent(text)}&p=${profile}${timeMode === 'travel' ? '&t=travel' : ''}`);
    // Panel: Reiseinfo und Ersatzwetter aus der Reise
    panel.route = routeInfo(t);
    setFallbackFromTrip();
    if (t.kind === 'route') loadModes(places);
    renderAll();
    if (opts.fly) {
      if (opts.gentle) gentleIntro(t);
      else flyToOverview(t, 1500);
    }
    if (opts.autoplay) setTimeout(() => startPlayback(), opts.fly ? 1600 : 0);
  } catch (err) {
    if (signal.aborted) return;
    setStatus(failText(err), 'error', () => loadPlaces(places, opts));
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
    const el = document.createElement('div');
    const last = i === t.places.length - 1 && t.places.length > 1;
    el.innerHTML = `<div class="pin${last ? ' is-end' : ''}"><span>${String.fromCharCode(65 + i)}</span></div>`;
    el.title = p.name;
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      setFocus(i);
    });
    markers.push(new Marker({ element: el, anchor: 'bottom', offset: [0, -6] }).setLngLat(p.coord).addTo(map));
  });
  setHead(null);
}

function uiPadding() {
  const el = map.getContainer();
  const W = el.clientWidth;
  const H = el.clientHeight;
  if (!sheet.isDesktop()) {
    const visible = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--sheet-visible')) || 140;
    return { top: 90, bottom: Math.min(H * 0.55, visible + 30), left: 30, right: 70 };
  }
  const panelR = $('sheet').getBoundingClientRect().right;
  const tl = timelineEl.hidden ? H : timelineEl.getBoundingClientRect().top;
  return { top: 90, bottom: Math.max(40, H - tl + 30), left: Math.min(W * 0.5, panelR + 40), right: 80 };
}

function flyToOverview(t: Trip, duration: number): void {
  if (reducedMotion()) duration = 0;
  if (t.kind === 'point') {
    map.flyTo({ center: t.places[0].coord, zoom: 11.6, pitch: 60, bearing: -15, duration, padding: uiPadding(), essential: true });
    return;
  }
  const [sw, ne] = t.line!.bounds();
  const cam = map.cameraForBounds([sw, ne], { padding: uiPadding(), pitch: 50, bearing: -15, absolutePadding: true } as never);
  if (!cam) return;
  map.flyTo({ ...cam, pitch: 50, bearing: -15, zoom: Math.min(cam.zoom ?? 10, 14.5), duration, essential: true });
}

/** erster Start ohne gespeicherte Kamera: kurz und sanft vom Schweiz-Überblick zum Ort */
function gentleIntro(t: Trip): void {
  const duration = reducedMotion() ? 0 : 1600;
  if (t.kind === 'point') {
    map.easeTo({ center: t.places[0].coord, zoom: 9.8, pitch: 55, bearing: -12, duration, padding: uiPadding(), essential: true, easing: springEase });
  } else {
    const [sw, ne] = t.line!.bounds();
    const cam = map.cameraForBounds([sw, ne], { padding: uiPadding(), pitch: 50, bearing: -12 } as never);
    if (cam) map.easeTo({ ...cam, pitch: 50, bearing: -12, zoom: Math.min(cam.zoom ?? 10, 13), duration, essential: true, easing: springEase });
  }
}

const springEase = (t: number) => 1 - Math.pow(1 - t, 3.2);
const reducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

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
  syncSearchState();
  await loadPlaces(next, { fly: !keepStart });
  if (keepStart && trip) flyToOverview(trip, 1400);
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

/** kompakte Wetterzeile: beim Abspielen live an der Position, sonst Ort aus dem Panel */
function updateCard(force = false): void {
  const now = performance.now();
  if (!force && now - lastCard < 110) return;
  lastCard = now;
  if (!trip || !currentEnv || !currentSample) return;
  const active = player.state !== 'idle' && currentFrame;
  if (active) {
    let place = trip.places[0].name;
    if (trip.kind === 'route') {
      const names = trip.places.map((p) => p.name);
      place = `km ${(currentFrame!.dist / 1000).toFixed(1).replace('.', ',')} → ${names[names.length - 1]}`;
    }
    const stop = trip.kind === 'route' ? weatherAt(trip, currentFrame!.dist, currentFrame!.time, frameLive()).stop : trip.stops[0];
    const live = frameLive() && Math.abs(currentEnv.time - Date.now()) < 30 * 60e3;
    renderCompact(wxCompact, liveCompact(currentEnv, currentSample, { place, utcOffsetSec: stop.weather.utcOffsetSec, live }));
  } else {
    renderCompact(wxCompact, compactFromState(panel));
  }
  updateStats();
}

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
  playBtn.style.setProperty('--progress', f.t.toFixed(4));
  updateCard();
}

let snapBeforePlay: Snap | null = null;

player.onFrame = onFrame;
player.onState = (s) => {
  const playing = s === 'playing';
  document.body.classList.toggle('is-playing', playing);
  document.body.classList.toggle('is-active', s !== 'idle');
  playBtn.classList.toggle('is-playing', playing);
  playBtn.classList.toggle('has-progress', s !== 'idle');
  playBtn.setAttribute('aria-label', playing ? 'Pause' : s === 'paused' ? 'Weiter abspielen' : 'Abspielen');
  fx.setCinematic(playing);
  if (!playing) fx.setMotion(0);
  if (playing && sheet.snap !== 'collapsed') {
    // Karte ist die Bühne: Panel auf die kompakte Zeile reduzieren
    snapBeforePlay = sheet.snap;
    sheet.setSnap('collapsed');
  }
  if (s === 'idle') {
    scene.setGhostVisible(false);
    scene.setRouteProgress(null);
    playBtn.style.setProperty('--progress', '0');
    if (snapBeforePlay) {
      sheet.setSnap(snapBeforePlay);
      snapBeforePlay = null;
    }
    updateCard(true);
  }
};

function startPlayback(): void {
  if (!trip) return;
  closePopovers();
  if (!hintEl.hidden) dismissHint();
  if (player.state === 'paused') {
    player.play();
    return;
  }
  const dur = durSel.value === 'auto' ? Player.autoDuration(trip) : Number(durSel.value) * 1000;
  player.durationMs = dur;
  player.mode = timeMode;
  player.departure = departure();
  if (trip.kind === 'point' && currentEnv) {
    player.orbitStartBearing =
      currentEnv.sunAlt > -3 ? currentEnv.sunAz : currentEnv.moon.altitude > 0 ? currentEnv.moon.azimuth : map.getBearing();
  }
  scene.setGhostVisible(true);
  scene.setRouteProgress(0);
  player.play();
}

// ------------------------------------------------------------ Kennzahlen über dem Profil

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
    else items.push([PROFILE_LABEL[trip.route?.profile ?? profile] ?? 'Reisezeit', durationText(trip.route?.duration ?? 0)]);
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
    isPoint ? '<span>nächste 24 h</span>' : travel ? '<span>Strecke, Wetter zur Ankunftszeit</span>' : '<span>Strecke, Wetter jetzt</span>',
  ].join('');
}

chart.onSeek = (frac) => {
  if (!trip) return;
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

// ------------------------------------------------------------ Wetter-Panel

const panel: PanelState = {
  place: null,
  detail: null,
  detailStatus: 'idle',
  refreshing: false,
  fallback: null,
  obs: null,
  obsStatus: 'idle',
  useObs: false,
  aval: null,
  avalStatus: 'idle',
  swiss: false,
  route: null,
  forecastMode: false,
};

let panelSeq = 0;
let panelAbort: AbortController | null = null;

function snapshotFor(coord: LngLat): WeatherDetail | null {
  const s = readJson<Snapshot>(SNAP_KEY);
  if (!s || haversine(s.coord, coord) > 1500) return null;
  return s.detail;
}

function startPanel(places: Place[], focus: Place): void {
  panel.focus = places.length > 1 ? { names: places.map((p) => p.name), idx: focusIdx } : undefined;
  panel.role = places.length > 1 ? (focusIdx === 0 ? 'Start' : focusIdx === places.length - 1 ? 'Ziel' : 'Via') : undefined;
  if (places.length < 2) panel.route = null;
  else if (panel.route && panel.route.places.join('|') !== places.map((p) => p.name).join('|')) panel.route = null;
  loadPanel(focus);
}

function loadPanel(place: Place): void {
  const seq = ++panelSeq;
  panelAbort?.abort();
  const ac = new AbortController();
  panelAbort = ac;
  const [lon, lat] = place.coord;
  panel.place = { name: place.name, detail: place.detail, coord: place.coord };
  panel.swiss = isInSwitzerland(place.coord);
  const stale = safe(() => cachedDetail(lat, lon)) ?? snapshotFor(place.coord);
  panel.detail = stale;
  panel.refreshing = !!stale;
  panel.detailStatus = 'loading';
  panel.error = undefined;
  panel.obs = null;
  panel.obsStatus = panel.swiss ? 'loading' : 'idle';
  panel.useObs = false;
  panel.aval = null;
  panel.avalStatus = panel.swiss ? 'loading' : 'idle';
  setFallbackFromTrip();
  renderAll();

  const ok = () => seq === panelSeq && !ac.signal.aborted;

  // alle Abfragen parallel, jede füllt ihren Teil, Fehler bleiben lokal
  fetchDetail(lat, lon, ac.signal)
    .then((d) => {
      if (!ok()) return;
      panel.detail = d;
      panel.detailStatus = 'done';
      panel.refreshing = false;
      if (panel.obs) panel.useObs = shouldUseObservation(panel.obs, d.elevation ?? null);
      writeJson(SNAP_KEY, { name: place.name, coord: place.coord, detail: d } satisfies Snapshot);
      renderAll();
    })
    .catch((err) => {
      if (!ok()) return;
      console.warn('Wetterdetails nicht verfügbar:', err);
      panel.detailStatus = 'error';
      panel.refreshing = false;
      panel.error = (err as Error)?.name === 'TimeoutError' ? 'Der Wetterdienst hat zu lange gebraucht.' : undefined;
      renderAll();
    });

  if (panel.swiss) {
    const ele = stale?.elevation ?? null;
    nearestStation(lat, lon, { maxKm: 30, signal: ac.signal, targetElevation: ele ?? undefined })
      .then((o) => {
        if (!ok()) return;
        panel.obs = o;
        panel.obsStatus = 'done';
        panel.useObs = !!o && shouldUseObservation(o, panel.detail?.elevation ?? ele ?? null);
        renderAll();
      })
      .catch(() => {
        if (!ok()) return;
        panel.obsStatus = 'error';
        renderAll();
      });
    avalancheDanger(lat, lon, { elevation: ele, signal: ac.signal })
      .then((a) => {
        if (!ok()) return;
        panel.aval = a;
        panel.avalStatus = 'done';
        renderAll();
      })
      .catch(() => {
        if (!ok()) return;
        panel.avalStatus = 'error';
        renderAll();
      });
  }
}

function safe<T>(f: () => T): T | null {
  try {
    return f() ?? null;
  } catch {
    return null;
  }
}

/** Wetter aus der Reise als Ersatz, bis die Detaildaten da sind */
function setFallbackFromTrip(): void {
  panel.forecastMode = departOffsetH > 0;
  if (!trip || !panel.place) return;
  let best = trip.stops[0];
  let bd = Infinity;
  for (const s of trip.stops) {
    const d = haversine(s.point, panel.place.coord);
    if (d < bd) {
      bd = d;
      best = s;
    }
  }
  if (bd > 5000) return;
  panel.fallback = { sample: sampleAt(best.weather, Date.now(), true), utcOffsetSec: best.weather.utcOffsetSec, fetchedAt: best.weather.fetchedAt };
}

function routeInfo(t: Trip): PanelState['route'] {
  if (t.kind !== 'route' || !t.route) return null;
  const names = t.places.map((p) => p.name);
  const key = names.map(norm).join('|');
  return {
    profile: t.route.profile,
    modes: modesCache?.key === key ? modesCache.list : (panel.route?.modes ?? null),
    modesStatus: modesCache?.key === key ? 'done' : 'loading',
    distance: t.line!.length,
    duration: t.route.duration,
    gain: t.gain,
    note: t.note,
    places: names,
  };
}

let modesSeq = 0;
async function loadModes(places: Place[]): Promise<ModeEstimate[] | null> {
  const key = places.map((p) => norm(p.name)).join('|');
  if (modesCache?.key === key) {
    if (panel.route) {
      panel.route.modes = modesCache.list;
      panel.route.modesStatus = 'done';
    }
    renderModeList();
    return modesCache.list;
  }
  const seq = ++modesSeq;
  try {
    const list = await compareModesApi(places);
    if (seq !== modesSeq) return list;
    modesCache = { key, list };
    if (panel.route) {
      panel.route.modes = list;
      panel.route.modesStatus = 'done';
    }
    renderAll();
    renderModeList();
    return list;
  } catch (err) {
    console.warn('Reisezeiten nicht verfügbar:', err);
    if (seq === modesSeq && panel.route) {
      panel.route.modesStatus = 'error';
      renderAll();
    }
    return null;
  }
}

function setFocus(i: number): void {
  if (!trip || !trip.places[i]) return;
  focusIdx = i;
  startPanel(trip.places, trip.places[i]);
  if (sheet.snap === 'collapsed') sheet.setSnap('half');
}

let renderQueued = false;
let renderedKey = '';
let renderedTimer = 0;
function renderAll(): void {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    const hours = wxBody.querySelector<HTMLElement>('.hours');
    const sl = hours?.scrollLeft ?? 0;
    const st = wxBody.scrollTop;
    wxBody.innerHTML = renderPanel(panel);
    const h2 = wxBody.querySelector<HTMLElement>('.hours');
    if (h2) h2.scrollLeft = sl;
    wxBody.scrollTop = st;
    // Karten nur beim Ortswechsel einblenden, nicht bei jedem Nachladen
    const key = panel.place ? `${panel.place.name}|${!!panel.detail}` : '';
    if (key !== renderedKey) {
      renderedKey = key;
      wxBody.classList.remove('is-rendered');
      clearTimeout(renderedTimer);
      renderedTimer = window.setTimeout(() => wxBody.classList.add('is-rendered'), 700);
    }
    if (player.state === 'idle') renderCompact(wxCompact, compactFromState(panel));
  });
}

wxBody.addEventListener('click', (e) => {
  const el = (e.target as HTMLElement).closest<HTMLElement>('[data-action]');
  if (!el) return;
  const a = el.dataset.action;
  if (a === 'retry') {
    if (panel.place) loadPanel({ name: panel.place.name, detail: panel.place.detail ?? '', coord: panel.place.coord, kind: '' });
  } else if (a === 'mode') {
    setProfile(el.dataset.profile as Profile);
  } else if (a === 'focus') {
    setFocus(Number(el.dataset.idx));
  } else if (a === 'try') {
    input.value = el.dataset.text ?? '';
    syncSearchState();
    loadFromText(input.value, { fly: true });
  }
});

// ------------------------------------------------------------ Werkzeugleiste und Popover

const popovers: [HTMLButtonElement, HTMLElement][] = [
  [modeBtn, $('popMode')],
  [timeBtn, $('popTime')],
  [settingsBtn, $('popSettings')],
];

function closePopovers(except?: HTMLElement): void {
  for (const [btn, pop] of popovers) {
    if (pop === except) continue;
    pop.hidden = true;
    btn.setAttribute('aria-expanded', 'false');
  }
}

for (const [btn, pop] of popovers) {
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const open = pop.hidden;
    closePopovers(pop);
    pop.hidden = !open;
    btn.setAttribute('aria-expanded', String(open));
    if (open) {
      if (pop.id === 'popMode') renderModeList();
      if (pop.id === 'popTime') fillDepart();
      pop.querySelector<HTMLElement>('button[aria-checked="true"], button, select')?.focus({ preventScroll: true });
    }
  });
  pop.addEventListener('click', (e) => e.stopPropagation());
}
document.addEventListener('click', () => closePopovers());

function renderToolbar(): void {
  modeBtn.innerHTML = uiIcon(MODE_ICON[profile]);
  modeBtn.setAttribute('aria-label', `Reisemodus: ${PROFILE_LABEL[profile]}`);
  timeBtn.innerHTML = uiIcon('clock') + (timeMode === 'travel' || departOffsetH > 0 ? '<span class="tool-dot"></span>' : '');
  timeBtn.setAttribute('aria-label', `Zeit: ${timeMode === 'travel' ? 'Unterwegs' : 'Jetzt'}${departOffsetH ? `, Start in ${departOffsetH} h` : ''}`);
  chatBtn.innerHTML = uiIcon('chat');
  settingsBtn.innerHTML = uiIcon('sliders');
  settingsBtn.setAttribute('aria-label', 'Einstellungen');
}

function renderModeList(): void {
  const est = new Map((modesCache?.list ?? []).map((m) => [m.profile, m]));
  modeList.innerHTML = [...MODE_ORDER, 'flight' as Profile]
    .map((p) => {
      const m = est.get(p);
      const time = m?.status === 'ok' && m.duration != null ? durationText(m.duration) : '';
      return `<button type="button" class="mode-opt" role="radio" data-v="${p}" aria-checked="${p === profile}"><span class="m-icon">${uiIcon(MODE_ICON[p])}</span>${escapeHtml(PROFILE_LABEL[p])}<span class="m-time">${time}</span></button>`;
    })
    .join('');
}

modeList.addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-v]');
  if (!b) return;
  setProfile(b.dataset.v as Profile);
  closePopovers();
});

function setProfile(p: Profile): void {
  if (!ALL_PROFILES.includes(p)) return;
  if (p === profile && trip?.route?.profile === p) return;
  profile = p;
  persist({ profile });
  renderToolbar();
  renderModeList();
  if (panel.route) {
    panel.route.profile = p;
    renderAll();
  }
  if (trip && trip.places.length > 1) loadPlaces(trip.places, { fly: true });
}

function setSeg(seg: HTMLElement, value: string): void {
  seg.querySelectorAll<HTMLButtonElement>('button').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.v === value)));
}
setSeg(timeSeg, timeMode);

timeSeg.addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest('button');
  if (!b?.dataset.v || b.disabled) return;
  setTimeMode(b.dataset.v as TimeMode, departOffsetH);
});

function setTimeMode(mode: TimeMode, offsetH: number): void {
  timeMode = mode;
  departOffsetH = Math.max(0, Math.min(48, Math.round(offsetH)));
  setSeg(timeSeg, timeMode);
  fillDepart();
  departSel.value = String(departOffsetH);
  if (departSel.value !== String(departOffsetH)) {
    departSel.insertAdjacentHTML('beforeend', `<option value="${departOffsetH}">+${departOffsetH} h</option>`);
    departSel.value = String(departOffsetH);
  }
  persist({ timeMode });
  player.stop();
  refreshSeries();
  setIdleFocus();
  updateTimeControls();
  renderToolbar();
  setFallbackFromTrip();
  renderAll();
}

function fillDepart(): void {
  const prev = departSel.value || String(departOffsetH);
  const now = Date.now();
  const opts = [0, 1, 2, 3, 6, 9, 12, 18, 24, 36, 48];
  departSel.innerHTML = opts
    .map((h) => {
      const label = h === 0 ? 'Jetzt' : `in ${h} h · ${localTime(now + h * 3600e3, -new Date().getTimezoneOffset() * 60, h >= 12)}`;
      return `<option value="${h}">${label}</option>`;
    })
    .join('');
  departSel.value = prev;
}
fillDepart();
departSel.addEventListener('change', () => setTimeMode(timeMode, Number(departSel.value)));

function updateTimeControls(): void {
  const isPoint = trip?.kind === 'point';
  travelBtn.textContent = isPoint ? 'Nächste 24 h' : 'Unterwegs';
  timeNote.textContent =
    timeMode === 'live'
      ? isPoint
        ? 'Abspielen zeigt das aktuelle Wetter im Rundflug.'
        : 'Aktuelles Wetter an jedem Punkt der Strecke.'
      : isPoint
        ? 'Abspielen zeigt die nächsten 24 Stunden im Zeitraffer.'
        : 'Wetter zu der Zeit, zu der man dort ankommt.';
}

durSel.addEventListener('change', () => {
  persist({ dur: durSel.value });
  if (player.state !== 'idle' && trip) player.durationMs = durSel.value === 'auto' ? Player.autoDuration(trip) : Number(durSel.value) * 1000;
});

$('showHintBtn').addEventListener('click', () => {
  try {
    localStorage.removeItem(HINT_KEY);
  } catch {
    /* egal */
  }
  closePopovers();
  showHint(true);
});
$('resetBtn').addEventListener('click', () => {
  for (const k of [STATE_KEY, SNAP_KEY, RECENT_KEY, HINT_KEY]) {
    try {
      localStorage.removeItem(k);
    } catch {
      /* egal */
    }
  }
  closePopovers();
  setStatus('Gespeicherter Zustand gelöscht.', 'info');
});

/** Callback für den Chat-Knopf; setzt der Chat-Teil (Hauptagent). */
let onChatButton: (() => void) | null = null;
chatBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  closePopovers();
  if (onChatButton) onChatButton();
  else setStatus('Der Chat ist bald verfügbar.', 'info');
});

renderToolbar();

// ------------------------------------------------------------ Abspielen, Suche

playBtn.addEventListener('click', () => {
  if (player.state === 'playing') {
    player.pause();
    return;
  }
  const text = input.value.trim();
  if (!text) {
    setStatus('Ort oder Route eingeben, z. B. „Bern“ oder „Zürich nach Luzern“ – oder auf die Karte tippen.', 'info');
    input.focus();
    return;
  }
  if (trip && keyFor(parseRouteText(text), profile) === tripKey) startPlayback();
  else loadFromText(text, { autoplay: true, fly: false });
});

form.addEventListener('submit', (e) => {
  e.preventDefault();
  closeSuggest();
  const text = input.value.trim();
  if (!text) {
    setStatus('Ort oder Route eingeben, z. B. „Bern“ oder „Zürich nach Luzern“ – oder auf die Karte tippen.', 'info');
    input.focus();
    return;
  }
  dismissHint();
  input.blur();
  if (player.state === 'playing') player.pause();
  const segs = parseRouteText(text);
  if (trip && keyFor(segs, profile) === tripKey) startPlayback();
  else loadFromText(text, { autoplay: true, fly: false });
});

clearBtn.addEventListener('click', () => {
  input.value = '';
  syncSearchState();
  input.focus();
  showRecent();
});

function syncSearchState(): void {
  form.classList.toggle('has-text', input.value.length > 0);
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closePopovers();
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
  if (e.code === 'Space' && trip) {
    e.preventDefault();
    if (player.state === 'playing') player.pause();
    else startPlayback();
  } else if (e.key === '/') {
    e.preventDefault();
    input.focus();
    input.select();
  }
});

// ------------------------------------------------------------ Hinweis für den Einstieg

function showHint(force = false): void {
  let seen = false;
  try {
    seen = localStorage.getItem(HINT_KEY) === '1';
  } catch {
    /* egal */
  }
  hintEl.hidden = seen && !force;
}
function dismissHint(): void {
  hintEl.hidden = true;
  try {
    localStorage.setItem(HINT_KEY, '1');
  } catch {
    /* egal */
  }
}
$('hintClose').addEventListener('click', dismissHint);
hintEl.addEventListener('click', (e) => {
  const t = (e.target as HTMLElement).closest<HTMLElement>('[data-try]');
  if (!t) return;
  input.value = t.dataset.try!;
  syncSearchState();
  dismissHint();
  loadFromText(input.value, { autoplay: true, fly: true });
});
showHint();

// ------------------------------------------------------------ Vorschläge

let suggestAbort: AbortController | null = null;
let suggestTimer = 0;
type SuggestItem = { place: Place } | { recent: string };
let suggestItems: SuggestItem[] = [];
let activeIdx = -1;

const SEP_RE = /\s+(?:bis|nach|to|über|ueber|via)\s+|\s*(?:→|->|–|—)\s*|\s+-\s+/gi;

function lastSegment(text: string): { seg: string; start: number } {
  let start = 0;
  for (const m of text.matchAll(SEP_RE)) start = (m.index ?? 0) + m[0].length;
  return { seg: text.slice(start).replace(/^von\s+/i, ''), start };
}

function recentList(): string[] {
  return readJson<string[]>(RECENT_KEY) ?? [];
}
function pushRecent(text: string): void {
  const list = [text, ...recentList().filter((t) => norm(t) !== norm(text))].slice(0, 6);
  writeJson(RECENT_KEY, list);
}

function closeSuggest(): void {
  suggestEl.hidden = true;
  suggestItems = [];
  activeIdx = -1;
  input.setAttribute('aria-expanded', 'false');
  input.removeAttribute('aria-activedescendant');
}

function renderSuggest(): void {
  if (!suggestItems.length) return closeSuggest();
  const recent = 'recent' in suggestItems[0];
  suggestEl.innerHTML =
    (recent ? '<li class="s-head" role="presentation">Zuletzt</li>' : '') +
    suggestItems
      .map((it, i) => {
        const sel = `role="option" id="sg-${i}" aria-selected="${i === activeIdx}" data-i="${i}"`;
        if ('recent' in it) {
          return `<li ${sel}><span class="s-icon">${uiIcon(parseRouteText(it.recent).length > 1 ? 'route' : 'clock')}</span><span class="s-text"><span class="s-name">${escapeHtml(it.recent)}</span></span></li>`;
        }
        const p = it.place;
        return `<li ${sel}><span class="s-icon">${uiIcon('pin')}</span><span class="s-text"><span class="s-name">${escapeHtml(p.name)}</span>${p.detail ? `<span class="s-detail">${escapeHtml(p.detail)}</span>` : ''}</span></li>`;
      })
      .join('');
  suggestEl.hidden = false;
  input.setAttribute('aria-expanded', 'true');
}

function showRecent(): void {
  const list = recentList();
  if (!list.length || input.value.trim()) return;
  suggestItems = list.map((recent) => ({ recent }));
  activeIdx = -1;
  renderSuggest();
}

function pickSuggestion(i: number): void {
  const it = suggestItems[i];
  if (!it) return;
  closeSuggest();
  if ('recent' in it) {
    input.value = it.recent;
    syncSearchState();
    input.blur();
    loadFromText(it.recent, { fly: true });
    return;
  }
  const p = it.place;
  const { start } = lastSegment(input.value);
  input.value = input.value.slice(0, start) + p.name;
  syncSearchState();
  chosen.set(norm(p.name), p);
  input.blur();
  dismissHint();
  loadFromText(input.value, { fly: true });
}

input.addEventListener('focus', () => {
  closePopovers();
  if (!input.value.trim()) showRecent();
});

input.addEventListener('input', () => {
  syncSearchState();
  clearTimeout(suggestTimer);
  const { seg } = lastSegment(input.value);
  if (!input.value.trim()) return showRecent();
  if (seg.trim().length < 2) return closeSuggest();
  suggestTimer = window.setTimeout(async () => {
    suggestAbort?.abort();
    const ac = new AbortController();
    suggestAbort = ac;
    try {
      const c = map.getCenter();
      const res = await searchPlaces(seg, [c.lng, c.lat], ac.signal, 6);
      if (ac.signal.aborted) return;
      suggestItems = res.map((place) => ({ place }));
      activeIdx = -1;
      renderSuggest();
    } catch {
      /* Suche abgebrochen oder offline */
    }
  }, 200);
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
  const li = (e.target as HTMLElement).closest<HTMLElement>('li[data-i]');
  if (!li) return;
  e.preventDefault();
  pickSuggestion(Number(li.dataset.i));
});

input.addEventListener('blur', () => setTimeout(closeSuggest, 150));

// ------------------------------------------------------------ Live halten

setInterval(() => {
  if (player.state === 'idle' && trip && !currentFrame) setIdleFocus();
}, 60e3);

setInterval(async () => {
  if (!trip || player.state === 'playing') return;
  try {
    const t = trip;
    const res = await fetchWeather(t.stops.map((s) => ({ lat: s.point[1], lon: s.point[0] })));
    if (t !== trip) return;
    t.stops.forEach((s, i) => (s.weather = res.points[i]));
    refreshSeries();
    if (player.state === 'idle' && !currentFrame) setIdleFocus();
    const f = trip.places[focusIdx];
    if (f) loadPanel(f);
  } catch {
    /* beim nächsten Mal wieder */
  }
}, 10 * 60e3);

// ------------------------------------------------------------ Sofortstart: letzter Stand

sheet.onSnap = () => {
  if (player.state === 'idle') renderCompact(wxCompact, compactFromState(panel));
};
{
  // gespeicherten Ort sofort mit dem letzten Wetter zeigen (wird gleich aktualisiert)
  const segs = parseRouteText(initialText);
  const snap = readJson<Snapshot>(SNAP_KEY);
  const known = segs.length ? chosen.get(norm(segs[segs.length - 1])) : undefined;
  if (snap && (!known || haversine(known.coord, snap.coord) < 1500)) {
    panel.place = { name: snap.name, coord: snap.coord };
    panel.detail = snap.detail;
    panel.refreshing = true;
    panel.swiss = isInSwitzerland(snap.coord);
    if (segs.length > 1) panel.role = 'Ziel';
  } else if (known) {
    panel.place = { name: known.name, detail: known.detail, coord: known.coord };
    panel.detailStatus = 'loading';
  }
  renderAll();
  if (!panel.place) renderCompact(wxCompact, null);
}

// ------------------------------------------------------------ Steuerungs-API (für den Chat)

export interface AppState {
  place: string | null;
  route: { from: string; to: string; mode: Profile } | null;
  playing: boolean;
  timeMode: 'live' | 'travel';
  offsetHours: number;
  weatherSummary: string | null;
}

function weatherSummary(): string | null {
  if (!panel.place) return null;
  const { sample, measured } = nowSample(panel);
  if (!sample) return null;
  const night = sunTimes(Date.now(), panel.place.coord[1], panel.place.coord[0]);
  const isNight = night.sunrise && night.sunset ? Date.now() < night.sunrise || Date.now() > night.sunset : false;
  const head = `${panel.place.name}: ${Math.round(sample.temp)} °C${measured ? ' (gemessen)' : ''}, ${describe(sample.code, isNight).label}.`;
  const s = summaryText(panel);
  return s ? `${head} ${s}` : head;
}

export const app = {
  /** Text wie „Zürich nach Luzern“ laden; autoplay spielt danach ab */
  async loadText(text: string, opts: { autoplay?: boolean; fly?: boolean } = {}): Promise<void> {
    input.value = text;
    syncSearchState();
    dismissHint();
    await loadFromText(text, { autoplay: opts.autoplay, fly: opts.fly ?? true });
  },
  async loadPlace(coord: [number, number], name?: string): Promise<void> {
    const place: Place = name ? { name, detail: '', coord, kind: 'place' } : await reverseGeocode(coord);
    chosen.set(norm(place.name), place);
    input.value = place.name;
    syncSearchState();
    await loadPlaces([place], { fly: true });
  },
  flyTo(coord: [number, number], zoom = 11): void {
    player.pause();
    map.flyTo({ center: coord, zoom, pitch: Math.max(45, map.getPitch()), duration: 1600, essential: true, padding: uiPadding() });
  },
  setProfile(p: Profile): void {
    setProfile(p);
  },
  play(): void {
    if (player.state !== 'playing') startPlayback();
  },
  pause(): void {
    player.pause();
  },
  setTime(mode: 'live' | 'travel' = timeMode, offsetHours = departOffsetH): void {
    setTimeMode(mode, offsetHours);
  },
  openWeather(): void {
    sheet.setSnap(sheet.isDesktop() ? 'full' : 'half');
  },
  async compareModes(): Promise<ModeEstimate[] | null> {
    if (!trip || trip.places.length < 2) return null;
    return loadModes(trip.places);
  },
  state(): AppState {
    const r = trip?.kind === 'route' ? trip : null;
    return {
      place: panel.place?.name ?? null,
      route: r ? { from: r.places[0].name, to: r.places[r.places.length - 1].name, mode: r.route?.profile ?? profile } : null,
      playing: player.state === 'playing',
      timeMode,
      offsetHours: departOffsetH,
      weatherSummary: weatherSummary(),
    };
  },
  /** vom Chat zu setzen: wird beim Tippen auf den Chat-Knopf aufgerufen */
  get onChatButton(): (() => void) | null {
    return onChatButton;
  },
  set onChatButton(fn: (() => void) | null) {
    onChatButton = fn;
  },
};

// Chat erst beim ersten Öffnen laden (hält den Start schlank)
let chatCtl: { toggle(): void; open(): void; send(t: string): Promise<void> } | null = null;
async function openChat(): Promise<NonNullable<typeof chatCtl>> {
  if (!chatCtl) {
    const { bindChat } = await import('./chat/bind.ts');
    chatCtl = bindChat(document.getElementById('chatRoot') ?? document.body, app);
    chatCtl.open();
  } else chatCtl.toggle();
  return chatCtl;
}
app.onChatButton = () => void openChat();
// ?chat=… öffnet den Chat und stellt die Frage direkt (praktisch für Links)
const chatQ = new URLSearchParams(location.search).get('chat');
if (chatQ) openChat().then((c) => c.send(chatQ));

// für Tests, Chat und zum Ausprobieren in der Konsole
Object.assign(window, {
  wetterflug: {
    map,
    player,
    scene,
    fx,
    app,
    sheet,
    get trip() {
      return trip;
    },
    get env() {
      return currentEnv;
    },
  },
});
