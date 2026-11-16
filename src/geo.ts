// Kleine Geo-Helfer: Distanzen, Peilung, Punkte entlang einer Linie.

export type LngLat = [number, number];

const R = 6371008.8; // mittlerer Erdradius in m
const rad = Math.PI / 180;

export function haversine(a: LngLat, b: LngLat): number {
  const dLat = (b[1] - a[1]) * rad;
  const dLng = (b[0] - a[0]) * rad;
  const s =
    Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * rad) * Math.cos(b[1] * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** Anfangspeilung von a nach b in Grad ab Nord (0..360). */
export function bearing(a: LngLat, b: LngLat): number {
  const f1 = a[1] * rad;
  const f2 = b[1] * rad;
  const dl = (b[0] - a[0]) * rad;
  const y = Math.sin(dl) * Math.cos(f2);
  const x = Math.cos(f1) * Math.sin(f2) - Math.sin(f1) * Math.cos(f2) * Math.cos(dl);
  return ((Math.atan2(y, x) / rad) % 360 + 360) % 360;
}

/** Kürzeste Winkeldifferenz b - a in Grad (-180..180). */
export function angleDiff(a: number, b: number): number {
  return ((((b - a) % 360) + 540) % 360) - 180;
}

export function lerpAngle(a: number, b: number, t: number): number {
  return a + angleDiff(a, b) * t;
}

/** Punkte auf dem Großkreis zwischen a und b (für Flugrouten). */
export function greatCircle(a: LngLat, b: LngLat, segments = 128): LngLat[] {
  const f1 = a[1] * rad, l1 = a[0] * rad, f2 = b[1] * rad, l2 = b[0] * rad;
  const d = haversine(a, b) / R;
  if (d < 1e-9) return [a, b];
  const out: LngLat[] = [];
  let prevLng = a[0];
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    const A = Math.sin((1 - t) * d) / Math.sin(d);
    const B = Math.sin(t * d) / Math.sin(d);
    const x = A * Math.cos(f1) * Math.cos(l1) + B * Math.cos(f2) * Math.cos(l2);
    const y = A * Math.cos(f1) * Math.sin(l1) + B * Math.cos(f2) * Math.sin(l2);
    const z = A * Math.sin(f1) + B * Math.sin(f2);
    let lng = Math.atan2(y, x) / rad;
    const lat = Math.atan2(z, Math.sqrt(x * x + y * y)) / rad;
    // über die Datumsgrenze hinweg stetig bleiben
    while (lng - prevLng > 180) lng -= 360;
    while (lng - prevLng < -180) lng += 360;
    prevLng = lng;
    out.push([lng, lat]);
  }
  return out;
}

/** Linie mit vorberechneten Teillängen für schnelles Abfragen entlang der Strecke. */
export class Polyline {
  readonly coords: LngLat[];
  readonly cum: Float64Array;
  readonly length: number;

  constructor(coords: LngLat[]) {
    // doppelte Punkte entfernen
    const clean: LngLat[] = [];
    for (const c of coords) {
      const last = clean[clean.length - 1];
      if (!last || last[0] !== c[0] || last[1] !== c[1]) clean.push(c);
    }
    if (clean.length === 1) clean.push([clean[0][0] + 1e-6, clean[0][1]]);
    this.coords = clean;
    this.cum = new Float64Array(clean.length);
    for (let i = 1; i < clean.length; i++) {
      this.cum[i] = this.cum[i - 1] + haversine(clean[i - 1], clean[i]);
    }
    this.length = this.cum[clean.length - 1];
  }

  private segmentAt(dist: number): number {
    let lo = 0;
    let hi = this.cum.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (this.cum[mid] <= dist) lo = mid;
      else hi = mid;
    }
    return lo;
  }

  /** Punkt bei Distanz `dist` (Meter ab Start). */
  pointAt(dist: number): LngLat {
    const d = Math.max(0, Math.min(this.length, dist));
    const i = this.segmentAt(d);
    const a = this.coords[i];
    const b = this.coords[Math.min(i + 1, this.coords.length - 1)];
    const segLen = this.cum[i + 1] - this.cum[i] || 1;
    const t = (d - this.cum[i]) / segLen;
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  }

  /** Koordinaten von Start bis `dist` (für die wachsende Spur). */
  sliceTo(dist: number): LngLat[] {
    const d = Math.max(0, Math.min(this.length, dist));
    const i = this.segmentAt(d);
    const out = this.coords.slice(0, i + 1);
    out.push(this.pointAt(d));
    return out;
  }

  /** Gleichmäßig verteilte Stützpunkte (inklusive Start und Ziel). */
  sample(n: number): { point: LngLat; dist: number }[] {
    const out: { point: LngLat; dist: number }[] = [];
    for (let i = 0; i < n; i++) {
      const dist = n === 1 ? 0 : (this.length * i) / (n - 1);
      out.push({ point: this.pointAt(dist), dist });
    }
    return out;
  }

  bounds(): [LngLat, LngLat] {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const [x, y] of this.coords) {
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
    return [[minX, minY], [maxX, maxY]];
  }
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function smoothstep(e0: number, e1: number, x: number): number {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function formatDistance(m: number): string {
  if (m < 1000) return `${Math.round(m)} m`;
  if (m < 10000) return `${(m / 1000).toFixed(1).replace('.', ',')} km`;
  return `${Math.round(m / 1000).toLocaleString('de-CH')} km`;
}
