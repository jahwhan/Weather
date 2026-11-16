// Profil-Zeitleiste: Höhe, Temperatur, Niederschlag, Bewölkung und Tag/Nacht entlang
// der Route (oder über 24 h bei einem Ort). Klicken/Ziehen spult die Animation.

import { sunPosition } from '../astro/sun';
import { clamp, smoothstep } from '../geo';
import { weatherAt, type Trip } from '../trip';
import { describe, precipKindFor } from '../weather/conditions';
import { sampleAt } from '../weather/fetch';

export interface ProfileSeries {
  /** x-Positionen 0..1 */
  x: number[];
  ele: number[] | null;
  temp: number[];
  precip: number[];
  snow: boolean[];
  cloud: number[];
  sunAlt: number[];
  thunder: boolean[];
  labels: [string, string];
}

/** Datenreihen für das Profil berechnen (einmal pro Reise / Zeitmodus). */
export function buildSeries(trip: Trip, departure: number, travel: boolean, live: boolean): ProfileSeries {
  const n = 120;
  const x: number[] = [];
  const temp: number[] = [];
  const precip: number[] = [];
  const snow: boolean[] = [];
  const cloud: number[] = [];
  const sunAlt: number[] = [];
  const thunder: boolean[] = [];
  let ele: number[] | null = null;

  if (trip.kind === 'point') {
    // ein Ort: die nächsten 24 Stunden
    const stop = trip.stops[0];
    for (let i = 0; i < n; i++) {
      const f = i / (n - 1);
      const t = departure + f * 24 * 3600e3;
      const s = sampleAt(stop.weather, t, live && i === 0);
      x.push(f);
      temp.push(s.temp);
      precip.push(s.precip);
      const k = precipKindFor(s.code, s.temp, s.snowfall, s.precip);
      snow.push(k === 'snow' || k === 'sleet');
      cloud.push(s.cloud / 100);
      thunder.push(describe(s.code).thunder);
      sunAlt.push(sunPosition(t, stop.point[1], stop.point[0]).altitude);
    }
    return { x, ele: null, temp, precip, snow, cloud, sunAlt, thunder, labels: ['jetzt', '+24 h'] };
  }

  const L = trip.line!.length;
  const dur = trip.route?.duration ?? 0;
  for (let i = 0; i < n; i++) {
    const f = i / (n - 1);
    const t = travel ? departure + f * dur : departure;
    const w = weatherAt(trip, f * L, t, live && (!travel || f === 0));
    x.push(f);
    temp.push(w.sample.temp);
    precip.push(w.sample.precip);
    const k = precipKindFor(w.sample.code, w.sample.temp, w.sample.snowfall, w.sample.precip);
    snow.push(k === 'snow' || k === 'sleet');
    cloud.push(w.sample.cloud / 100);
    thunder.push(describe(w.sample.code).thunder);
    sunAlt.push(sunPosition(t, w.lat, w.lon).altitude);
  }
  if (trip.profile.length) {
    ele = x.map((f) => {
      const d = f * L;
      const p = trip.profile;
      let j = 0;
      while (j < p.length - 2 && p[j + 1].dist < d) j++;
      const a = p[j];
      const b = p[Math.min(j + 1, p.length - 1)];
      const u = clamp((d - a.dist) / (b.dist - a.dist || 1), 0, 1);
      return a.ele + (b.ele - a.ele) * u;
    });
  }
  const names = trip.places.map((p) => p.name);
  return { x, ele, temp, precip, snow, cloud, sunAlt, thunder, labels: [names[0], names[names.length - 1]] };
}

function tempColor(t: number): string {
  // kalt blau → mild weiss → warm orange → heiss rot
  const stops: [number, [number, number, number]][] = [
    [-15, [120, 150, 255]],
    [0, [124, 196, 255]],
    [10, [220, 236, 245]],
    [20, [255, 196, 110]],
    [30, [255, 120, 80]],
  ];
  let c = stops[0][1];
  for (let i = 1; i < stops.length; i++) {
    if (t <= stops[i][0]) {
      const u = (t - stops[i - 1][0]) / (stops[i][0] - stops[i - 1][0]);
      const a = stops[i - 1][1];
      const b = stops[i][1];
      c = [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u];
      break;
    }
    c = stops[i][1];
  }
  return `rgb(${c.map(Math.round).join(',')})`;
}

export class ProfileChart {
  private canvas: HTMLCanvasElement;
  private series: ProfileSeries | null = null;
  private cursor = 0;
  onSeek: (frac: number) => void = () => {};

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    let dragging = false;
    const toFrac = (e: PointerEvent) => {
      const r = canvas.getBoundingClientRect();
      return clamp((e.clientX - r.left - 6) / (r.width - 12), 0, 1);
    };
    canvas.addEventListener('pointerdown', (e) => {
      if (!this.series) return;
      dragging = true;
      canvas.setPointerCapture(e.pointerId);
      this.onSeek(toFrac(e));
    });
    canvas.addEventListener('pointermove', (e) => dragging && this.onSeek(toFrac(e)));
    const end = () => (dragging = false);
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', end);
    new ResizeObserver(() => this.draw()).observe(canvas);
  }

  setSeries(s: ProfileSeries | null): void {
    this.series = s;
    this.draw();
  }

  setCursor(frac: number): void {
    if (Math.abs(frac - this.cursor) < 0.0005) return;
    this.cursor = frac;
    this.draw();
  }

  draw(): void {
    const c = this.canvas;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const W = c.clientWidth;
    const H = c.clientHeight;
    if (!W || !H) return;
    if (c.width !== Math.round(W * dpr) || c.height !== Math.round(H * dpr)) {
      c.width = Math.round(W * dpr);
      c.height = Math.round(H * dpr);
    }
    const g = c.getContext('2d')!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    const s = this.series;
    const padX = 6;
    const top = 12; // Wolkenstreifen
    const bottom = H - 16; // Tag/Nacht-Streifen + Beschriftung
    const innerW = W - padX * 2;
    const X = (f: number) => padX + f * innerW;

    // Gitter
    g.strokeStyle = 'rgba(190,210,255,0.08)';
    g.lineWidth = 1;
    for (let i = 1; i < 4; i++) {
      const y = top + ((bottom - top) * i) / 4;
      g.beginPath();
      g.moveTo(padX, y + 0.5);
      g.lineTo(W - padX, y + 0.5);
      g.stroke();
    }
    if (!s) return;
    const n = s.x.length;
    const colW = innerW / (n - 1);

    // Bewölkung oben
    for (let i = 0; i < n; i++) {
      g.fillStyle = `rgba(214,222,234,${(0.08 + 0.75 * s.cloud[i]).toFixed(3)})`;
      g.fillRect(X(s.x[i]) - colW / 2, 1, colW + 0.5, 7);
    }
    // Tag/Nacht unten
    for (let i = 0; i < n; i++) {
      const a = s.sunAlt[i];
      const day = smoothstep(-6, 4, a);
      const golden = smoothstep(-4, 1, a) * (1 - smoothstep(3, 12, a));
      const r = Math.round(20 + 200 * day + 35 * golden);
      const gg = Math.round(28 + 180 * day - 40 * golden);
      const b = Math.round(60 + 120 * day - 90 * golden);
      g.fillStyle = `rgb(${r},${gg},${b})`;
      g.fillRect(X(s.x[i]) - colW / 2, bottom + 3, colW + 0.5, 3);
    }

    // Höhe
    if (s.ele) {
      let lo = Math.min(...s.ele);
      let hi = Math.max(...s.ele);
      if (hi - lo < 60) {
        const m = (hi + lo) / 2;
        lo = m - 30;
        hi = m + 30;
      }
      const Y = (e: number) => bottom - ((e - lo) / (hi - lo)) * (bottom - top - 18) - 2;
      const grad = g.createLinearGradient(0, top, 0, bottom);
      grad.addColorStop(0, 'rgba(238,242,248,0.28)');
      grad.addColorStop(1, 'rgba(238,242,248,0.03)');
      g.beginPath();
      g.moveTo(X(0), bottom);
      for (let i = 0; i < n; i++) g.lineTo(X(s.x[i]), Y(s.ele[i]));
      g.lineTo(X(1), bottom);
      g.closePath();
      g.fillStyle = grad;
      g.fill();
      g.beginPath();
      for (let i = 0; i < n; i++) (i ? g.lineTo : g.moveTo).call(g, X(s.x[i]), Y(s.ele[i]));
      g.strokeStyle = 'rgba(238,242,248,0.55)';
      g.lineWidth = 1.2;
      g.stroke();
      g.font = '500 9.5px -apple-system, BlinkMacSystemFont, system-ui, "Segoe UI", Roboto, sans-serif';
      g.fillStyle = 'rgba(154,167,188,0.9)';
      g.textAlign = 'left';
      g.fillText(`${Math.round(Math.max(...s.ele))} m`, padX + 2, top + 10);
      g.fillText(`${Math.round(Math.min(...s.ele))} m`, padX + 2, bottom - 4);
    }

    // Niederschlag als Balken von oben
    const maxP = Math.max(2, ...s.precip);
    for (let i = 0; i < n; i++) {
      if (s.precip[i] < 0.05) continue;
      const h = Math.sqrt(s.precip[i] / maxP) * (bottom - top) * 0.55;
      g.fillStyle = s.snow[i] ? 'rgba(255,255,255,0.55)' : s.thunder[i] ? 'rgba(255,224,102,0.6)' : 'rgba(95,176,255,0.55)';
      g.fillRect(X(s.x[i]) - colW / 2, top, colW + 0.5, h);
    }

    // Temperatur
    let tLo = Math.min(...s.temp);
    let tHi = Math.max(...s.temp);
    if (tHi - tLo < 6) {
      const m = (tHi + tLo) / 2;
      tLo = m - 3;
      tHi = m + 3;
    }
    const TY = (t: number) => bottom - 6 - ((t - tLo) / (tHi - tLo)) * (bottom - top - 22);
    g.lineWidth = 2;
    g.lineCap = 'round';
    for (let i = 1; i < n; i++) {
      g.strokeStyle = tempColor((s.temp[i] + s.temp[i - 1]) / 2);
      g.beginPath();
      g.moveTo(X(s.x[i - 1]), TY(s.temp[i - 1]));
      g.lineTo(X(s.x[i]), TY(s.temp[i]));
      g.stroke();
    }
    const fmt = (t: number) => `${Math.round(t)}°`.replace('-', '−');
    const iMax = s.temp.indexOf(Math.max(...s.temp));
    const iMin = s.temp.indexOf(Math.min(...s.temp));
    g.font = '600 10px -apple-system, BlinkMacSystemFont, system-ui, "Segoe UI", Roboto, sans-serif';
    g.textAlign = 'center';
    g.fillStyle = tempColor(s.temp[iMax]);
    g.fillText(fmt(s.temp[iMax]), clamp(X(s.x[iMax]), 14, W - 14), TY(s.temp[iMax]) - 5);
    if (iMin !== iMax) {
      g.fillStyle = tempColor(s.temp[iMin]);
      g.fillText(fmt(s.temp[iMin]), clamp(X(s.x[iMin]), 14, W - 14), TY(s.temp[iMin]) + 13);
    }

    // Beschriftung Start/Ziel
    g.font = '500 10px -apple-system, BlinkMacSystemFont, system-ui, "Segoe UI", Roboto, sans-serif';
    g.fillStyle = 'rgba(154,167,188,0.95)';
    g.textAlign = 'left';
    g.fillText(s.labels[0], padX, H - 1);
    g.textAlign = 'right';
    g.fillText(s.labels[1], W - padX, H - 1);

    // Fortschritt
    const cx = X(this.cursor);
    g.fillStyle = 'rgba(255,46,147,0.12)';
    g.fillRect(padX, top, cx - padX, bottom - top);
    g.strokeStyle = '#ff2e93';
    g.lineWidth = 2;
    g.beginPath();
    g.moveTo(cx, 0);
    g.lineTo(cx, bottom + 6);
    g.stroke();
    if (s.ele) {
      const i = Math.round(this.cursor * (n - 1));
      let lo = Math.min(...s.ele);
      let hi = Math.max(...s.ele);
      if (hi - lo < 60) {
        const m = (hi + lo) / 2;
        lo = m - 30;
        hi = m + 30;
      }
      const y = bottom - ((s.ele[i] - lo) / (hi - lo)) * (bottom - top - 18) - 2;
      g.fillStyle = '#ffffff';
      g.beginPath();
      g.arc(cx, y, 4, 0, Math.PI * 2);
      g.fill();
      g.strokeStyle = '#ff2e93';
      g.lineWidth = 2.5;
      g.stroke();
    }
  }
}
