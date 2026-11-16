// Himmelsrichtungen (Azimut/Höhe) auf Bildschirmkoordinaten abbilden,
// passend zur perspektivischen Kamera von MapLibre.

import type { Map as MlMap } from 'maplibre-gl';

export interface CameraFrame {
  width: number;
  height: number;
  cx: number;
  cy: number;
  /** Brennweite in px */
  f: number;
  bearing: number;
  pitch: number;
  // Kamerabasis in ENU (x Ost, y Nord, z oben)
  fwd: [number, number, number];
  right: [number, number, number];
  up: [number, number, number];
}

const rad = Math.PI / 180;

/** Gewicht der lokalen Wetterdarstellung: 0 auf dem Globus, 1 in Bodennähe. */
export function zoomBlend(zoom: number): number {
  const t = Math.min(1, Math.max(0, (zoom - 4.2) / (6.8 - 4.2)));
  return t * t * (3 - 2 * t);
}

export function cameraFrame(map: MlMap): CameraFrame {
  const el = map.getContainer();
  const width = el.clientWidth;
  const height = el.clientHeight;
  const p = map.getPadding();
  const pl = p.left ?? 0;
  const pr = p.right ?? 0;
  const pt = p.top ?? 0;
  const pb = p.bottom ?? 0;
  const cx = pl + (width - pl - pr) / 2;
  const cy = pt + (height - pt - pb) / 2;
  const fov = (map.getVerticalFieldOfView?.() ?? 36.87) * rad;
  const f = height / 2 / Math.tan(fov / 2);
  const bearing = map.getBearing();
  const pitch = map.getPitch();
  const B = bearing * rad;
  const E = (pitch - 90) * rad;
  const fwd: [number, number, number] = [Math.sin(B) * Math.cos(E), Math.cos(B) * Math.cos(E), Math.sin(E)];
  const right: [number, number, number] = [Math.cos(B), -Math.sin(B), 0];
  const up: [number, number, number] = [-Math.sin(B) * Math.sin(E), -Math.cos(B) * Math.sin(E), Math.cos(E)];
  return { width, height, cx, cy, f, bearing, pitch, fwd, right, up };
}

export interface ScreenPoint {
  x: number;
  y: number;
  /** liegt vor der Kamera */
  front: boolean;
}

export function skyToScreen(cam: CameraFrame, azimuthDeg: number, altitudeDeg: number): ScreenPoint {
  const a = azimuthDeg * rad;
  const h = altitudeDeg * rad;
  const s: [number, number, number] = [Math.sin(a) * Math.cos(h), Math.cos(a) * Math.cos(h), Math.sin(h)];
  const z = s[0] * cam.fwd[0] + s[1] * cam.fwd[1] + s[2] * cam.fwd[2];
  const x = s[0] * cam.right[0] + s[1] * cam.right[1] + s[2] * cam.right[2];
  const y = s[0] * cam.up[0] + s[1] * cam.up[1] + s[2] * cam.up[2];
  if (z <= 0.02) {
    // hinter der Kamera: Richtung trotzdem liefern, weit ausserhalb
    const len = Math.hypot(x, y) || 1;
    return { x: cam.cx + (x / len) * cam.width * 3, y: cam.cy - (y / len) * cam.height * 3, front: false };
  }
  return { x: cam.cx + (x / z) * cam.f, y: cam.cy - (y / z) * cam.f, front: true };
}

/** Bildschirmhöhe des mathematischen Horizonts geradeaus. */
export function horizonY(cam: CameraFrame): number {
  const p = cam.pitch * rad;
  if (p < 0.01) return -1e6;
  return cam.cy - (cam.f * Math.cos(p)) / Math.sin(p);
}
