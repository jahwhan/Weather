// Abspielen: Kamerafahrt entlang der Route (Verfolgerkamera) oder Orbit um einen Ort.
// Die Zeitachse ist deterministisch: jeder Fortschrittswert ergibt dieselbe Kamera,
// darum funktioniert Spulen im Höhenprofil.

import type { Map as MlMap } from 'maplibre-gl';
import { angleDiff, bearing as geoBearing, clamp, lerp, lerpAngle, smoothstep, type LngLat } from './geo';
import type { Trip } from './trip';

export interface Pad {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

export interface Cam {
  center: LngLat;
  zoom: number;
  pitch: number;
  bearing: number;
  /** Innenabstand verschiebt den Fluchtpunkt: mehr Himmel, Punkt im unteren Drittel */
  pad: Pad;
}

const lerpPad = (a: Pad, b: Pad, t: number): Pad => ({
  top: lerp(a.top, b.top, t),
  bottom: lerp(a.bottom, b.bottom, t),
  left: lerp(a.left, b.left, t),
  right: lerp(a.right, b.right, t),
});

export type TimeMode = 'live' | 'travel';

export interface Frame {
  /** Fortschritt der gesamten Animation 0..1 */
  t: number;
  /** Distanz entlang der Route in m (bei einem Ort 0) */
  dist: number;
  /** Anteil der Route 0..1 */
  routeFrac: number;
  /** Zeitpunkt, dessen Wetter und Sonnenstand gezeigt werden */
  time: number;
  cam: Cam;
  /** Kamerageschwindigkeit 0..1 */
  motion: number;
  phase: 'intro' | 'main' | 'outro';
}

const INTRO = 0.1;
const OUTRO = 0.88;

const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const easeSine = (t: number) => -(Math.cos(Math.PI * t) - 1) / 2;

function mercX(lng: number) {
  return (lng + 180) / 360;
}
function mercY(lat: number) {
  const s = Math.sin((clamp(lat, -85, 85) * Math.PI) / 180);
  return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
}
function unMercY(y: number) {
  return (Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180) / Math.PI;
}

/** Kamera zwischen zwei Zuständen, mit Herauszoomen bei weiten Sprüngen. */
export function interpolateCam(a: Cam, b: Cam, t: number): Cam {
  const e = easeInOut(clamp(t, 0, 1));
  let bx = mercX(b.center[0]);
  const ax = mercX(a.center[0]);
  if (bx - ax > 0.5) bx -= 1;
  if (ax - bx > 0.5) bx += 1;
  const ay = mercY(a.center[1]);
  const by = mercY(b.center[1]);
  const distW = Math.hypot(bx - ax, by - ay); // in Weltbreiten
  // Zoom, auf dem beide Punkte bequem sichtbar sind
  const zFit = Math.log2(1.2 / Math.max(distW, 1e-6)) - 0.5;
  const zMid = Math.min(a.zoom, b.zoom, zFit);
  const bump = Math.max(0, Math.min(a.zoom, b.zoom) - zMid);
  const zoom = lerp(a.zoom, b.zoom, e) - bump * Math.sin(Math.PI * e);
  // bei grossem Bogen erst rauszoomen, dann verschieben
  const ce = bump > 0.5 ? smoothstep(0.15, 0.85, e) : e;
  const x = lerp(ax, bx, ce);
  const y = lerp(ay, by, ce);
  return {
    center: [x * 360 - 180, unMercY(y)],
    zoom,
    pitch: lerp(a.pitch, b.pitch, e),
    bearing: lerpAngle(a.bearing, b.bearing, e),
    pad: lerpPad(a.pad, b.pad, e),
  };
}

export class Player {
  private map: MlMap;
  trip: Trip | null = null;
  durationMs = 12000;
  mode: TimeMode = 'live';
  /** Startzeit für den Modus "Unterwegs" / "24 h" */
  departure = Date.now();
  state: 'idle' | 'playing' | 'paused' = 'idle';
  t = 0;
  private startCam: Cam | null = null;
  private endCam: Cam | null = null;
  private lastNow = 0;
  private raf = 0;
  private filteredBearing: number | null = null;
  onFrame: (f: Frame) => void = () => {};
  onState: (s: Player['state']) => void = () => {};

  constructor(map: MlMap) {
    this.map = map;
  }

  /** Dauer automatisch nach Routenlänge: 8 s (kurz) bis 16 s (sehr lang). */
  static autoDuration(trip: Trip): number {
    if (trip.kind === 'point') return 12000;
    const km = (trip.line?.length ?? 1000) / 1000;
    return Math.round((8 + 8 * clamp(Math.log10(Math.max(km, 1)) / 3, 0, 1)) * 1000);
  }

  /** Route im Gebirge: Kamera steiler und höher, sonst verdecken Talhänge die Position */
  private mountain = false;

  setTrip(trip: Trip | null): void {
    this.stop();
    this.trip = trip;
    const ele = trip?.profile.map((p) => p.ele) ?? [];
    this.mountain = ele.length > 0 && (Math.max(...ele) > 900 || (trip?.gain ?? 0) > 450);
    this.t = 0;
    this.filteredBearing = null;
  }

  play(): void {
    if (!this.trip) return;
    if (this.state === 'paused') {
      this.state = 'playing';
      this.onState(this.state);
      this.lastNow = performance.now();
      this.loop();
      return;
    }
    this.t = 0;
    this.filteredBearing = null;
    this.startCam = this.currentCam();
    this.endCam = null;
    this.state = 'playing';
    this.onState(this.state);
    this.lastNow = performance.now();
    this.loop();
  }

  pause(): void {
    if (this.state !== 'playing') return;
    this.state = 'paused';
    cancelAnimationFrame(this.raf);
    this.onState(this.state);
  }

  stop(): void {
    cancelAnimationFrame(this.raf);
    if (this.state !== 'idle') {
      this.state = 'idle';
      this.onState(this.state);
    }
  }

  toggle(): void {
    if (this.state === 'playing') this.pause();
    else this.play();
  }

  /** Spulen: t in 0..1. Startet bei Bedarf eine pausierte Wiedergabe. */
  seek(t: number): void {
    if (!this.trip) return;
    if (this.state === 'idle') {
      this.startCam = this.currentCam();
      this.state = 'paused';
      this.onState(this.state);
    }
    this.t = clamp(t, 0, 1);
    this.filteredBearing = null;
    this.render(0);
  }

  private currentCam(): Cam {
    const c = this.map.getCenter();
    const p = this.map.getPadding();
    return {
      center: [c.lng, c.lat],
      zoom: this.map.getZoom(),
      pitch: this.map.getPitch(),
      bearing: this.map.getBearing(),
      pad: { top: p.top ?? 0, bottom: p.bottom ?? 0, left: p.left ?? 0, right: p.right ?? 0 },
    };
  }

  private loop(): void {
    this.raf = requestAnimationFrame((now) => {
      // grosszügige Obergrenze: auch auf langsamen Geräten bleibt die Dauer 8–16 s
      const dt = Math.min(0.25, (now - this.lastNow) / 1000);
      this.lastNow = now;
      this.t = Math.min(1, this.t + (dt * 1000) / this.durationMs);
      this.render(dt);
      if (this.t >= 1) {
        this.state = 'idle';
        this.onState(this.state);
        return;
      }
      if (this.state === 'playing') this.loop();
    });
  }

  private render(dt: number): void {
    const f = this.frameAt(this.t, dt);
    if (!f) return;
    this.map.jumpTo({ center: f.cam.center, zoom: f.cam.zoom, pitch: f.cam.pitch, bearing: f.cam.bearing, padding: f.cam.pad });
    this.onFrame(f);
  }

  // ------------------------------------------------------------ Kamera

  private followZoom(): number {
    const trip = this.trip!;
    const km = Math.max(0.3, (trip.line?.length ?? 1000) / 1000);
    const w = this.map.getContainer().clientWidth;
    const flight = trip.route?.profile === 'flight';
    const z = 17.4 - Math.log2(km) + Math.log2(Math.max(360, w) / 1400) * 0.8;
    return clamp(z, flight ? 4.2 : 7.5, 15.6);
  }

  /** Blickrichtung aus der Routengeometrie, über ein Fenster gemittelt. */
  private routeBearing(dist: number): number {
    const line = this.trip!.line!;
    const L = line.length;
    const W = clamp(L * 0.035, 120, 90000);
    let sx = 0;
    let sy = 0;
    const n = 10;
    let prev = line.pointAt(dist - W * 0.6);
    for (let i = 1; i <= n; i++) {
      const d = dist - W * 0.6 + (W * 2.4 * i) / n;
      const cur = line.pointAt(d);
      if (cur[0] !== prev[0] || cur[1] !== prev[1]) {
        const b = (geoBearing(prev, cur) * Math.PI) / 180;
        const wgt = i > n / 3 ? 1.2 : 0.8;
        sx += Math.sin(b) * wgt;
        sy += Math.cos(b) * wgt;
      }
      prev = cur;
    }
    if (sx === 0 && sy === 0) return this.map.getBearing();
    return ((Math.atan2(sx, sy) * 180) / Math.PI + 360) % 360;
  }

  private chaseCam(dist: number, dt: number): Cam {
    const line = this.trip!.line!;
    let b = this.routeBearing(dist);
    if (this.filteredBearing == null || dt === 0) this.filteredBearing = b;
    else {
      this.filteredBearing = this.filteredBearing + angleDiff(this.filteredBearing, b) * Math.min(1, dt * 4);
      b = this.filteredBearing;
    }
    const flight = this.trip!.route?.profile === 'flight';
    const pitch = flight ? 70 : this.mountain ? 63 : 74;
    const zoom = this.followZoom() - (this.mountain ? 0.35 : 0);
    return { center: line.pointAt(dist), zoom, pitch, bearing: b, pad: this.chasePad() };
  }

  private chasePad(): Pad {
    const h = this.map.getContainer().clientHeight;
    return { top: Math.round(h * 0.3), bottom: 0, left: 0, right: 0 };
  }

  private overviewCam(endBearing: number): Cam {
    const trip = this.trip!;
    const [sw, ne] = trip.line!.bounds();
    const el = this.map.getContainer();
    const pad = {
      top: Math.round(el.clientHeight * 0.22),
      bottom: Math.round(el.clientHeight * 0.3),
      left: Math.round(el.clientWidth * 0.12),
      right: Math.round(el.clientWidth * 0.12),
    };
    const bearing = endBearing - 25;
    const opts = this.map.cameraForBounds([sw, ne], { padding: pad, bearing, pitch: 50, absolutePadding: true });
    const c = opts?.center as { lng: number; lat: number } | undefined;
    const rp = opts?.padding;
    return {
      center: c ? [c.lng, c.lat] : trip.line!.pointAt(trip.line!.length / 2),
      zoom: Math.min(opts?.zoom ?? 8, 15),
      pitch: 50,
      bearing,
      pad: rp ? { top: rp.top ?? 0, bottom: rp.bottom ?? 0, left: rp.left ?? 0, right: rp.right ?? 0 } : pad,
    };
  }

  private orbitBase(): Cam {
    const p = this.trip!.places[0].coord;
    const h = this.map.getContainer().clientHeight;
    // nicht zu tief: in engen Tälern stünde die Kamera sonst vor einer Felswand
    return { center: p, zoom: 12.4, pitch: 68, bearing: 0, pad: { top: Math.round(h * 0.22), bottom: 0, left: 0, right: 0 } };
  }

  /** Startblick beim Orbit: zur Sonne bzw. zum Mond, damit sie ins Bild kommen. */
  orbitStartBearing = 0;

  frameAt(t: number, dt = 0): Frame | null {
    const trip = this.trip;
    if (!trip) return null;
    const startCam = this.startCam ?? this.currentCam();
    const now = Date.now();

    if (trip.kind === 'point') {
      const base = this.orbitBase();
      const sweep = 220;
      const b0 = this.orbitStartBearing - 70;
      const orbitT = clamp((t - INTRO) / (OUTRO - INTRO), 0, 1);
      const orbitCam = (u: number): Cam => ({ ...base, bearing: b0 + sweep * u, zoom: base.zoom - 0.4 * Math.sin(Math.PI * u) });
      let cam: Cam;
      let phase: Frame['phase'];
      if (t < INTRO) {
        cam = interpolateCam(startCam, orbitCam(0), t / INTRO);
        phase = 'intro';
      } else if (t <= OUTRO) {
        cam = orbitCam(easeSine(orbitT));
        phase = 'main';
      } else {
        const end = orbitCam(1);
        const out: Cam = { ...end, zoom: end.zoom - 1.6, pitch: 55, bearing: end.bearing + 20, pad: { top: 0, bottom: 0, left: 0, right: 0 } };
        cam = interpolateCam(end, out, (t - OUTRO) / (1 - OUTRO));
        phase = 'outro';
      }
      const time = this.mode === 'travel' ? this.departure + orbitT * 24 * 3600e3 : now;
      return { t, dist: 0, routeFrac: orbitT, time, cam, motion: phase === 'main' ? 0.3 : 0.5, phase };
    }

    const line = trip.line!;
    const L = line.length;
    const routeT = clamp((t - INTRO) / (OUTRO - INTRO), 0, 1);
    const frac = easeInOut(routeT) * 0.7 + routeT * 0.3; // sanft anfahren, nicht zu träge
    const dist = frac * L;
    let cam: Cam;
    let phase: Frame['phase'];
    if (t < INTRO) {
      cam = interpolateCam(startCam, this.chaseCam(0, 0), t / INTRO);
      phase = 'intro';
    } else if (t <= OUTRO) {
      cam = this.chaseCam(dist, dt);
      phase = 'main';
    } else {
      const from = this.chaseCam(L, 0);
      if (!this.endCam) this.endCam = this.overviewCam(from.bearing);
      cam = interpolateCam(from, this.endCam, (t - OUTRO) / (1 - OUTRO));
      phase = 'outro';
    }
    const travel = trip.route?.duration ?? 0;
    const time = this.mode === 'travel' ? this.departure + frac * travel : now;
    // Geschwindigkeit der Kamera (für Regen-Streifen)
    const speed = phase === 'main' ? clamp(Math.sin(Math.PI * routeT) * 1.2, 0, 1) : 0.2;
    return { t, dist, routeFrac: frac, time, cam, motion: speed, phase };
  }
}
