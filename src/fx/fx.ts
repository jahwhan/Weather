// Wettereffekte über der 3D-Karte: Sonne, Mond, Sterne, Wolkenhimmel,
// Nebel, Regen, Schnee, Hagel, Blitze. Drei Canvas-Ebenen:
//   shade (multiply)  – Vignette, Abdunklung
//   fx    (normal)    – Sterne, Mond, Wolken, Nebel, Niederschlag, Blitz
//   glow  (screen)    – Sonnenlicht, Mondschein, Blitzlicht

import { Point, type Map as MlMap } from 'maplibre-gl';
import { cameraFrame, horizonY, skyToScreen, zoomBlend, type CameraFrame } from '../map/camera';
import { css, mix, type Env, type RGB } from '../env';
import { clamp, smoothstep } from '../geo';
import { coverageThreshold, fbm, sortedCopy } from './noise';

interface Particle {
  x: number;
  y: number;
  z: number; // Tiefe 0.25..1 (1 = nah)
  s: number; // Zufallswert pro Teilchen
}

interface Star {
  az: number;
  alt: number;
  mag: number;
  tw: number;
}

const rad = Math.PI / 180;
const SKY_W = 1024;
const SKY_H = 256;
const SKY_TOP_ALT = 38; // so hoch reicht die Wolkenkuppel

/** Aufgabe im Leerlauf ausführen (Rückfall: kurzer Timeout, z. B. Safari) */
function idle(fn: () => void): void {
  const w = window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number };
  if (w.requestIdleCallback) w.requestIdleCallback(fn, { timeout: 1500 });
  else setTimeout(fn, 120);
}

export class WeatherFx {
  private map: MlMap;
  private shade: HTMLCanvasElement;
  private fx: HTMLCanvasElement;
  private glow: HTMLCanvasElement;
  private cShade: CanvasRenderingContext2D;
  private cFx: CanvasRenderingContext2D;
  private cGlow: CanvasRenderingContext2D;
  private skyBuf = document.createElement('canvas');
  private cloudTex = document.createElement('canvas');
  private wispTex = document.createElement('canvas');
  private flake = document.createElement('canvas');
  private skyNoise: Float32Array | null = null;
  private skySorted: Float32Array | null = null;
  private wispNoise: Float32Array | null = null;
  private stars: Star[] = [];
  private rain: Particle[] = [];
  private snow: Particle[] = [];
  private env: Env | null = null;
  private k = 0;
  private motion = 0;
  private cinematic = 0;
  private cinematicTarget = 0;
  private cloudKey = '';
  private cloudBuiltAt = 0;
  private wispKey = '';
  private drift = 0;
  private lightning = { next: 0, start: -1e9, bolt: null as [number, number][][] | null };
  private dpr = 1;
  private w = 0;
  private h = 0;
  private last = 0;
  private raf = 0;
  private occl = { sun: 0, moon: 0, sunAt: 0, moonAt: 0, sunHit: false, moonHit: false };
  private reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

  constructor(map: MlMap) {
    this.map = map;
    const mk = (cls: string) => {
      const c = document.createElement('canvas');
      c.className = `fx-layer ${cls}`;
      return c;
    };
    this.shade = mk('fx-shade');
    this.fx = mk('fx-main');
    this.glow = mk('fx-glow');
    const container = map.getCanvasContainer();
    const mapCanvas = map.getCanvas();
    // direkt nach der Karten-Canvas einfügen, damit Marker darüber liegen
    mapCanvas.after(this.shade, this.fx, this.glow);
    this.cShade = this.shade.getContext('2d')!;
    this.cFx = this.fx.getContext('2d')!;
    this.cGlow = this.glow.getContext('2d')!;
    void container;

    // Teure Vorberechnungen (Rauschtexturen ~1 Mio. Werte, Sterne) erst im Leerlauf und
    // in einzelnen Häppchen, damit die erste Karte nicht auf sie wartet.
    idle(() => {
      this.skyNoise = fbm(SKY_W, SKY_H, 7, 2, 6, 7, 0.52);
      idle(() => {
        this.skySorted = sortedCopy(this.skyNoise!);
        this.cloudKey = '';
        idle(() => {
          this.wispNoise = fbm(512, 256, 3, 2, 5, 23, 0.55);
          this.wispKey = '';
        });
      });
    });
  }

  private ensureStatic(): void {
    if (this.staticReady) return;
    this.staticReady = true;
    this.makeFlake();
    this.makeStars();
  }
  private staticReady = false;

  start(): void {
    const loop = (t: number) => {
      this.raf = requestAnimationFrame(loop);
      this.frame(t);
    };
    this.raf = requestAnimationFrame(loop);
  }

  stop(): void {
    cancelAnimationFrame(this.raf);
  }

  setEnv(env: Env): void {
    this.env = env;
  }

  /** Kamerabewegung 0..1, lässt Regen schneller streifen */
  setMotion(m: number): void {
    this.motion = clamp(m, 0, 1);
  }

  setCinematic(on: boolean): void {
    this.cinematicTarget = on ? 1 : 0;
  }

  // ------------------------------------------------------------ Aufbau

  private makeFlake(): void {
    const s = 32;
    this.flake.width = this.flake.height = s;
    const c = this.flake.getContext('2d')!;
    const g = c.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.35, 'rgba(255,255,255,0.85)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    c.fillStyle = g;
    c.fillRect(0, 0, s, s);
  }

  private makeStars(): void {
    let seed = 42;
    const rnd = () => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    };
    for (let i = 0; i < 650; i++) {
      const alt = Math.asin(rnd()) / rad; // gleichmässig auf der Halbkugel
      this.stars.push({ az: rnd() * 360, alt, mag: Math.pow(rnd(), 3.2), tw: rnd() * Math.PI * 2 });
    }
  }

  private resize(): boolean {
    const el = this.map.getContainer();
    const w = el.clientWidth;
    const h = el.clientHeight;
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    if (w === this.w && h === this.h && dpr === this.dpr) return false;
    this.w = w;
    this.h = h;
    this.dpr = dpr;
    for (const c of [this.shade, this.fx, this.glow]) {
      c.width = Math.round(w * dpr);
      c.height = Math.round(h * dpr);
      c.style.width = `${w}px`;
      c.style.height = `${h}px`;
    }
    return true;
  }

  /** Wolkentextur mit Licht und Bedeckungsgrad einfärben (gedrosselt). */
  private buildClouds(env: Env, now: number): void {
    if (!this.skyNoise || !this.skySorted) return;
    const cover = clamp(env.cloud, 0, 1);
    const key = [cover.toFixed(2), env.cloudLit.map((v) => Math.round(v / 6)).join(','), env.cloudShade.map((v) => Math.round(v / 6)).join(',')].join('|');
    if (key === this.cloudKey || now - this.cloudBuiltAt < 220) return;
    this.cloudKey = key;
    this.cloudBuiltAt = now;
    const tex = this.cloudTex;
    tex.width = SKY_W;
    tex.height = SKY_H;
    const c = tex.getContext('2d')!;
    const img = c.createImageData(SKY_W, SKY_H);
    const d = img.data;
    const th = coverageThreshold(this.skySorted, cover * 0.92 + 0.02);
    const lit = env.cloudLit;
    const shade = env.cloudShade;
    const sheet = smoothstep(0.75, 1, cover); // geschlossene Decke
    const n = this.skyNoise;
    for (let y = 0; y < SKY_H; y++) {
      const vy = y / SKY_H; // 0 oben, 1 am Horizont
      for (let x = 0; x < SKY_W; x++) {
        const i = y * SKY_W + x;
        const v = n[i];
        let a = smoothstep(th - 0.05, th + 0.16, v);
        a = a * (1 - sheet) + sheet * (0.82 + 0.18 * smoothstep(th - 0.2, th + 0.2, v));
        const dens = clamp((v - th) / 0.3, 0, 1);
        // Unterseite dichter Wolken dunkler, Ränder heller
        const t = clamp(dens * 0.85 + sheet * 0.35 + vy * 0.15, 0, 1);
        const o = i * 4;
        d[o] = lit[0] + (shade[0] - lit[0]) * t;
        d[o + 1] = lit[1] + (shade[1] - lit[1]) * t;
        d[o + 2] = lit[2] + (shade[2] - lit[2]) * t;
        d[o + 3] = 255 * a * 0.95;
      }
    }
    c.putImageData(img, 0, 0);
    this.cloudReady = true;
  }
  private cloudReady = false;
  private wispReady = false;

  private buildWisps(color: RGB): void {
    if (!this.wispNoise) return;
    const key = color.map((v) => Math.round(v / 8)).join(',');
    if (key === this.wispKey) return;
    this.wispKey = key;
    const W = 512;
    const H = 256;
    this.wispTex.width = W;
    this.wispTex.height = H;
    const c = this.wispTex.getContext('2d')!;
    const img = c.createImageData(W, H);
    for (let i = 0; i < W * H; i++) {
      const a = smoothstep(0.42, 0.75, this.wispNoise[i]);
      img.data[i * 4] = color[0];
      img.data[i * 4 + 1] = color[1];
      img.data[i * 4 + 2] = color[2];
      img.data[i * 4 + 3] = 255 * a;
    }
    c.putImageData(img, 0, 0);
    this.wispReady = true;
  }

  /**
   * Liegt der Bildpunkt auf Gelände (Berg vor Sonne/Mond)? Nutzt die Gelände-Abfrage von MapLibre,
   * die eine Pixel-Rücklesung braucht, darum nur gedrosselt aufrufen.
   */
  private onTerrain(x: number, y: number): boolean {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const m = this.map as any;
      const tr = m.transform;
      const terrain = m.terrain;
      if (!terrain || typeof tr?.isPointOnMapSurface !== 'function') return false;
      if (x < 0 || y < 0 || x > this.w || y > this.h) return false;
      return !!tr.isPointOnMapSurface(new Point(x, y), terrain);
    } catch {
      return false;
    }
  }

  private occlusion(kind: 'sun' | 'moon', x: number, y: number, t: number, dt: number): number {
    const o = this.occl;
    const atKey = kind === 'sun' ? 'sunAt' : 'moonAt';
    const hitKey = kind === 'sun' ? 'sunHit' : 'moonHit';
    if (t - o[atKey] > 150) {
      o[atKey] = t;
      o[hitKey] = this.onTerrain(x, y);
    }
    o[kind] += ((o[hitKey] ? 1 : 0) - o[kind]) * Math.min(1, dt * 7);
    return o[kind];
  }

  // ------------------------------------------------------------ Frame

  private frame(t: number): void {
    const dt = this.last ? Math.min(0.05, (t - this.last) / 1000) : 0.016;
    this.last = t;
    this.resize();
    const { cShade, cFx, cGlow, dpr } = this;
    for (const c of [cShade, cFx, cGlow]) {
      c.setTransform(1, 0, 0, 1, 0, 0);
      c.clearRect(0, 0, c.canvas.width, c.canvas.height);
      c.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    this.cinematic += (this.cinematicTarget - this.cinematic) * Math.min(1, dt * 3);
    const env = this.env;
    this.k = zoomBlend(this.map.getZoom());
    if (!env || this.k < 0.01) return;
    this.ensureStatic();
    const k = this.k;
    const cam = cameraFrame(this.map);
    const hY = horizonY(cam);

    this.buildClouds(env, t);
    this.drift += dt * (env.windSpeed / 3.6) * 0.05 * Math.sin(((env.windDir + 180 - cam.bearing) % 360) * rad);

    if (hY > -10) {
      this.drawStars(cam, hY, env, k, t);
      this.drawMoon(cam, hY, env, k, t, dt);
      this.drawSkyClouds(cam, hY, env, k);
    }
    this.drawSun(cam, hY, env, k, t, dt);
    this.drawFog(cam, hY, env, k, dt);
    this.drawPrecip(cam, env, k, dt, t);
    this.drawLightning(cam, hY, env, k, t);
    this.drawVignette(env, k);
  }

  private drawStars(cam: CameraFrame, hY: number, env: Env, k: number, t: number): void {
    const moonWash = env.moon.altitude > 0 ? env.moon.fraction * 0.6 : 0;
    const vis = k * Math.pow(env.night, 2) * Math.pow(1 - env.cloud, 1.6) * (1 - env.fog) * (1 - 0.6 * env.haze);
    if (vis < 0.02) return;
    const c = this.cFx;
    c.fillStyle = '#ffffff';
    for (const s of this.stars) {
      if (s.mag < moonWash * 0.5) continue;
      const p = skyToScreen(cam, s.az, s.alt);
      if (!p.front || p.y > hY - 2 || p.x < 0 || p.x > cam.width || p.y < 0) continue;
      const tw = this.reducedMotion ? 1 : 0.75 + 0.25 * Math.sin(t * 0.003 + s.tw * 7);
      // Sterne nahe am Horizont verschwinden im Dunst
      const hz = smoothstep(hY, hY - 60, p.y);
      c.globalAlpha = clamp(vis * (0.25 + 0.75 * s.mag) * tw * hz, 0, 1);
      const sz = 0.7 + s.mag * 1.6;
      c.fillRect(p.x, p.y, sz, sz);
    }
    c.globalAlpha = 1;
  }

  private drawMoon(cam: CameraFrame, hY: number, env: Env, k: number, t: number, dt: number): void {
    const m = env.moon;
    if (m.altitude < -1) return;
    const p = skyToScreen(cam, m.azimuth, m.altitude);
    const r = Math.max(7, cam.height * 0.014);
    if (!p.front || p.x < -r * 4 || p.x > cam.width + r * 4 || p.y < -r * 4 || p.y > hY + r) return;
    let vis = k * (0.3 + 0.7 * env.night) * (1 - 0.92 * Math.pow(env.cloud, 1.4)) * (1 - env.fog) * smoothstep(-1, 2, m.altitude);
    if (vis < 0.02) return;
    vis *= 1 - this.occlusion('moon', p.x, p.y, t, dt);
    if (vis < 0.02) return;
    const c = this.cFx;
    c.save();
    c.translate(p.x, p.y);
    // beleuchtete Seite zeigt grob zur Sonne
    c.rotate(-m.brightLimbAngle);
    // Erdschein
    c.globalAlpha = vis * 0.18 * env.night;
    c.fillStyle = '#9fb0d0';
    c.beginPath();
    c.arc(0, 0, r, 0, Math.PI * 2);
    c.fill();
    // beleuchteter Teil: Halbkreis +/- Ellipse (Terminator)
    const f = m.fraction;
    c.globalAlpha = vis;
    c.fillStyle = '#f3f1e6';
    c.beginPath();
    c.arc(0, 0, r, Math.PI, 0, false); // obere Hälfte = beleuchtete Seite
    const ex = r * Math.abs(1 - 2 * f);
    c.ellipse(0, 0, r, ex, 0, 0, Math.PI, f < 0.5);
    c.fill();
    c.restore();
    // Mondschein-Halo
    const g = this.cGlow;
    const halo = g.createRadialGradient(p.x, p.y, r, p.x, p.y, r * 10);
    const a = 0.22 * vis * f * env.night;
    halo.addColorStop(0, `rgba(190,205,235,${a})`);
    halo.addColorStop(1, 'rgba(190,205,235,0)');
    g.fillStyle = halo;
    g.fillRect(p.x - r * 10, p.y - r * 10, r * 20, r * 20);
  }

  private drawSkyClouds(cam: CameraFrame, hY: number, env: Env, k: number): void {
    if (!this.cloudReady || env.cloud < 0.03) return;
    const W = cam.width;
    const bandTop = Math.max(0, hY - cam.f * Math.tan(SKY_TOP_ALT * rad));
    const bandBottom = Math.min(cam.height, hY + 6);
    const bandH = bandBottom - bandTop;
    if (bandH < 4) return;
    // Berge ragen über den mathematischen Horizont: Wolken etwas darüber ausblenden
    const hzStart = clamp((hY - bandTop - cam.height * 0.15) / bandH, 0, 1);
    const hzEnd = clamp((hY - bandTop - cam.height * 0.045) / bandH, 0, 1);
    if (hzEnd <= 0.002) return; // sichtbarer Himmel zu schmal
    const buf = this.skyBuf;
    const bw = Math.ceil(W);
    const bh = Math.ceil(bandH);
    if (buf.width !== bw || buf.height !== bh) {
      buf.width = bw;
      buf.height = bh;
    }
    const b = buf.getContext('2d')!;
    b.setTransform(1, 0, 0, 1, 0, 0);
    b.clearRect(0, 0, bw, bh);
    const ppd = cam.f * rad; // Pixel pro Grad in Bildmitte
    const strips = 7;
    for (let j = 0; j < strips; j++) {
      // Streifen von oben (hoch am Himmel) nach unten (Horizont)
      const a0 = SKY_TOP_ALT * (1 - j / strips);
      const a1 = SKY_TOP_ALT * (1 - (j + 1) / strips);
      const y0 = hY - cam.f * Math.tan(a0 * rad) - bandTop;
      const y1 = hY - cam.f * Math.tan(a1 * rad) - bandTop;
      if (y1 < 0 || y0 > bh) continue;
      const ty0 = (j / strips) * SKY_H;
      const th = SKY_H / strips;
      // weiter entfernte Wolken (nahe Horizont) wirken kleiner
      const sc = 0.3 + 0.7 * Math.sqrt(Math.max(0.05, (a0 + a1) / 2 / SKY_TOP_ALT));
      const P = 360 * ppd * sc * 0.55;
      let x0 = -(((cam.bearing + this.drift * 40) / 360) * P) % P;
      if (x0 > 0) x0 -= P;
      for (let x = x0; x < bw; x += P) {
        b.drawImage(this.cloudTex, 0, ty0, SKY_W, th, x, y0, P + 1, y1 - y0 + 1);
      }
    }
    // zum Horizont hin im Dunst auflösen
    b.globalCompositeOperation = 'destination-in';
    const g = b.createLinearGradient(0, 0, 0, bh);
    g.addColorStop(0, 'rgba(0,0,0,1)');
    g.addColorStop(clamp(Math.min(hzStart, hzEnd - 0.001), 0, 1), 'rgba(0,0,0,0.95)');
    g.addColorStop(hzEnd, 'rgba(0,0,0,0)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    b.fillStyle = g;
    b.fillRect(0, 0, bw, bh);
    b.globalCompositeOperation = 'source-over';
    this.cFx.globalAlpha = k * clamp(0.35 + env.cloud * 0.9, 0, 1) * (1 - 0.7 * env.fog);
    this.cFx.drawImage(buf, 0, bandTop, bw, bh);
    this.cFx.globalAlpha = 1;
  }

  private drawSun(cam: CameraFrame, hY: number, env: Env, k: number, t: number, dt: number): void {
    const vis = k * smoothstep(-4, 1, env.sunAlt);
    if (vis < 0.01) return;
    const p = skyToScreen(cam, env.sunAz, env.sunAlt);
    const g = this.cGlow;
    const H = cam.height;
    const col = env.sunColor;
    // Himmel zur Sonne hin heller (Aureole), auch wenn die Sonne ausserhalb des Bildes steht
    if (p.front && hY > 0) {
      const R = H * (0.9 + 0.6 * env.golden);
      const a = vis * (0.1 + 0.22 * env.transmittance) * (1 - 0.5 * env.fog);
      const gr = g.createRadialGradient(p.x, p.y, 0, p.x, p.y, R);
      gr.addColorStop(0, css(col, a));
      gr.addColorStop(0.4, css(col, a * 0.35));
      gr.addColorStop(1, css(col, 0));
      g.fillStyle = gr;
      g.fillRect(0, 0, cam.width, Math.min(cam.height, hY + H * 0.25));
    }
    if (!p.front) return;
    const onScreen = p.x > -H * 0.2 && p.x < cam.width + H * 0.2 && p.y > -H * 0.2 && p.y < hY + H * 0.05;
    if (!onScreen) return;
    // hinter einem Berg: Scheibe weg, nur ein Rest Streulicht am Grat
    const hidden = this.occlusion('sun', p.x, p.y, t, dt);
    const direct = env.directness * (1 - hidden);
    const rd = Math.max(6, H * 0.013);
    // Scheibe: hinter Wolken nur ein heller Fleck
    const core = vis * (0.18 + 0.82 * direct) * (1 - 0.8 * env.fog) * (1 - 0.85 * hidden);
    const gl = H * (0.05 + 0.12 * direct);
    const gr = g.createRadialGradient(p.x, p.y, 0, p.x, p.y, gl);
    gr.addColorStop(0, css([255, 252, 240], core));
    gr.addColorStop(rd / gl, css([255, 246, 225], core * 0.95));
    gr.addColorStop(Math.min(0.99, (rd * 2.2) / gl), css(col, core * 0.45));
    gr.addColorStop(1, css(col, 0));
    g.fillStyle = gr;
    g.beginPath();
    g.arc(p.x, p.y, gl, 0, Math.PI * 2);
    g.fill();
    // Blendenflecke bei direkter Sonne
    if (direct > 0.45 && p.x > 0 && p.x < cam.width && p.y > 0) {
      const dx = cam.cx - p.x;
      const dy = cam.cy - p.y;
      const ghosts: [number, number, RGB][] = [
        [0.55, 0.03, [255, 200, 140]],
        [1.15, 0.06, [140, 200, 255]],
        [1.5, 0.018, [255, 160, 220]],
        [1.9, 0.09, [180, 255, 200]],
      ];
      for (const [s, r, c] of ghosts) {
        const x = p.x + dx * s;
        const y = p.y + dy * s;
        const rr = H * r;
        const a = 0.07 * (direct - 0.4) * vis;
        const gg = g.createRadialGradient(x, y, 0, x, y, rr);
        gg.addColorStop(0, css(c, a));
        gg.addColorStop(0.7, css(c, a * 0.6));
        gg.addColorStop(1, css(c, 0));
        g.fillStyle = gg;
        g.fillRect(x - rr, y - rr, rr * 2, rr * 2);
      }
    }
  }

  private drawFog(cam: CameraFrame, hY: number, env: Env, k: number, dt: number): void {
    const fog = env.fog * k;
    const haze = env.haze * k;
    const c = this.cFx;
    const H = cam.height;
    if (haze > 0.02 && hY > -H) {
      // Dunstband am Horizont
      const y = clamp(hY, -H, H * 2);
      const g = c.createLinearGradient(0, y - H * 0.18, 0, y + H * 0.3);
      g.addColorStop(0, css(env.fogColor, 0));
      g.addColorStop(0.38, css(env.fogColor, 0.45 * haze));
      g.addColorStop(1, css(env.fogColor, 0));
      c.fillStyle = g;
      c.fillRect(0, y - H * 0.18, cam.width, H * 0.48);
    }
    if (fog < 0.02) return;
    // Nebel: oben (Ferne) dicht, unten (nah) lichter
    const g = c.createLinearGradient(0, 0, 0, H);
    const top = Math.max(0, Math.min(1, hY / H));
    g.addColorStop(0, css(env.fogColor, 0.92 * fog));
    g.addColorStop(top, css(env.fogColor, 0.88 * fog));
    g.addColorStop(1, css(env.fogColor, 0.38 * fog * fog));
    c.fillStyle = g;
    c.fillRect(0, 0, cam.width, H);
    // ziehende Nebelschwaden
    this.buildWisps(env.fogColor);
    if (!this.wispReady) return;
    const speed = 8 + env.windSpeed * 1.2;
    this.wispOffset = (this.wispOffset + dt * speed * Math.sign(Math.sin(((env.windDir + 180 - cam.bearing) % 360) * rad) || 1)) % 2048;
    const tw = cam.width * 1.4;
    const th = H * 0.75;
    c.globalAlpha = 0.5 * fog;
    let x = -((this.wispOffset % tw) + tw) % tw;
    for (; x < cam.width; x += tw) c.drawImage(this.wispTex, x, Math.max(hY, 0) - th * 0.15, tw + 1, th);
    c.globalAlpha = 1;
  }
  private wispOffset = 0;

  private drawPrecip(cam: CameraFrame, env: Env, k: number, dt: number, t: number): void {
    const area = (cam.width * cam.height) / (1280 * 800);
    const I = env.precipIntensity * k;
    const kind = env.precipKind;
    const rainShare = kind === 'rain' || kind === 'drizzle' ? 1 : kind === 'sleet' ? 0.55 : kind === 'hail' ? 1 : 0;
    const snowShare = kind === 'snow' ? 1 : kind === 'sleet' ? 0.45 : 0;
    const baseRain = kind === 'drizzle' ? 900 : kind === 'hail' ? 420 : 1100;
    const nRain = Math.round(I * rainShare * baseRain * area * (this.reducedMotion ? 0.4 : 1));
    const nSnow = Math.round(I * snowShare * 900 * area * (this.reducedMotion ? 0.4 : 1));
    this.resizePool(this.rain, nRain, cam);
    this.resizePool(this.snow, nSnow, cam);

    // Wind relativ zur Blickrichtung: positiv = nach rechts
    const rel = (env.windDir + 180 - cam.bearing) * rad;
    const side = Math.sin(rel);
    const windK = clamp(env.windSpeed / 45, 0, 1.3);
    const lightLevel = 0.35 + 0.65 * env.exposure;

    if (this.rain.length) {
      const c = this.cFx;
      const isHail = kind === 'hail';
      const isDrizzle = kind === 'drizzle';
      const col: RGB = mix([120, 132, 150], [225, 232, 242], lightLevel);
      const fall = (isDrizzle ? 520 : isHail ? 1500 : 1250) * (1 + 0.35 * this.motion);
      const slant = side * windK * 0.55;
      for (let layer = 0; layer < 3; layer++) {
        const zMin = layer / 3;
        const zMax = (layer + 1) / 3;
        c.beginPath();
        for (const p of this.rain) {
          if (p.z < zMin || p.z >= zMax) continue;
          const v = fall * (0.45 + 0.55 * p.z);
          p.y += v * dt;
          p.x += v * slant * dt;
          if (p.y > cam.height + 40) {
            p.y = -40 - Math.random() * 80;
            p.x = Math.random() * (cam.width + 200) - 100;
          }
          if (p.x > cam.width + 100) p.x -= cam.width + 200;
          if (p.x < -100) p.x += cam.width + 200;
          if (isHail) {
            c.rect(p.x, p.y, 1.5 + p.z * 2, 1.5 + p.z * 2);
          } else {
            const len = (isDrizzle ? 6 : 14) + 22 * p.z * (1 + 0.6 * this.motion);
            c.moveTo(p.x, p.y);
            c.lineTo(p.x - slant * len, p.y - len);
          }
        }
        const a = (isDrizzle ? 0.22 : 0.3) * (0.4 + 0.6 * zMax) * (0.55 + 0.45 * I);
        if (isHail) {
          c.fillStyle = css(mix(col, [255, 255, 255], 0.5), a * 2);
          c.fill();
        } else {
          c.strokeStyle = css(col, a);
          c.lineWidth = 0.6 + zMax * 1.1;
          c.stroke();
        }
      }
    }

    if (this.snow.length) {
      const c = this.cFx;
      const brightness = lightLevel;
      for (const p of this.snow) {
        const v = 38 + 75 * p.z;
        p.y += v * dt * (1 + 0.3 * this.motion);
        p.x += (side * windK * 90 * p.z + Math.sin(t * 0.0012 + p.s * 40) * 18 * p.z) * dt;
        if (p.y > cam.height + 20) {
          p.y = -20 - Math.random() * 40;
          p.x = Math.random() * (cam.width + 100) - 50;
        }
        if (p.x > cam.width + 50) p.x -= cam.width + 100;
        if (p.x < -50) p.x += cam.width + 100;
        const size = 2 + p.z * 6.5;
        c.globalAlpha = clamp((0.35 + 0.6 * p.z) * brightness, 0, 1);
        c.drawImage(this.flake, p.x - size / 2, p.y - size / 2, size, size);
      }
      c.globalAlpha = 1;
    }
  }

  private resizePool(pool: Particle[], n: number, cam: CameraFrame): void {
    while (pool.length < n) {
      pool.push({
        x: Math.random() * (cam.width + 200) - 100,
        y: Math.random() * cam.height,
        z: Math.pow(Math.random(), 0.7),
        s: Math.random(),
      });
    }
    if (pool.length > n) pool.length = n;
  }

  private drawLightning(cam: CameraFrame, hY: number, env: Env, k: number, t: number): void {
    const L = this.lightning;
    if (!env.thunder || k < 0.2) {
      L.next = t + 1500;
      return;
    }
    if (t > L.next) {
      L.start = t;
      L.next = t + 1800 + Math.random() * 4500;
      L.bolt = Math.random() < 0.75 ? this.makeBolt(cam, hY) : null;
    }
    const dt = t - L.start;
    if (dt > 700) return;
    // Doppelblitz
    const f = Math.exp(-dt / 70) + (dt > 160 ? 0.7 * Math.exp(-(dt - 160) / 90) : 0);
    const g = this.cGlow;
    g.fillStyle = `rgba(215,225,255,${clamp(0.5 * f * k, 0, 0.85)})`;
    g.fillRect(0, 0, cam.width, cam.height);
    if (L.bolt && !this.reducedMotion) {
      const c = this.cFx;
      c.save();
      c.strokeStyle = `rgba(245,248,255,${clamp(f * 1.2, 0, 1)})`;
      c.shadowColor = 'rgba(180,200,255,0.9)';
      c.shadowBlur = 18;
      L.bolt.forEach((branch, i) => {
        c.lineWidth = i === 0 ? 2.6 : 1.2;
        c.beginPath();
        branch.forEach(([x, y], j) => (j ? c.lineTo(x, y) : c.moveTo(x, y)));
        c.stroke();
      });
      c.restore();
    }
  }

  private makeBolt(cam: CameraFrame, hY: number): [number, number][][] {
    const x0 = cam.width * (0.15 + Math.random() * 0.7);
    const yEnd = clamp(hY + cam.height * 0.08, cam.height * 0.25, cam.height * 0.8);
    const main: [number, number][] = [[x0, -10]];
    let x = x0;
    const steps = 14;
    for (let i = 1; i <= steps; i++) {
      x += (Math.random() - 0.5) * cam.width * 0.05;
      main.push([x, -10 + ((yEnd + 10) * i) / steps]);
    }
    const branches: [number, number][][] = [main];
    for (let b = 0; b < 3; b++) {
      const start = main[2 + Math.floor(Math.random() * (steps - 5))];
      const br: [number, number][] = [start];
      let bx = start[0];
      let by = start[1];
      const dir = Math.random() < 0.5 ? -1 : 1;
      for (let i = 0; i < 5; i++) {
        bx += dir * Math.random() * cam.width * 0.03;
        by += cam.height * 0.03;
        br.push([bx, by]);
      }
      branches.push(br);
    }
    return branches;
  }

  private drawVignette(env: Env, k: number): void {
    const c = this.cShade;
    const w = this.w;
    const h = this.h;
    const strength = clamp(0.1 + 0.22 * this.cinematic + 0.18 * env.night * k + 0.12 * env.overcast * k, 0, 0.55);
    const v = Math.round(255 * (1 - strength));
    c.fillStyle = '#ffffff';
    c.fillRect(0, 0, w, h);
    const g = c.createRadialGradient(w / 2, h * 0.55, Math.min(w, h) * 0.35, w / 2, h * 0.55, Math.hypot(w, h) * 0.62);
    g.addColorStop(0, '#ffffff');
    g.addColorStop(1, `rgb(${v},${v},${Math.min(255, v + 8)})`);
    c.fillStyle = g;
    c.fillRect(0, 0, w, h);
  }
}
