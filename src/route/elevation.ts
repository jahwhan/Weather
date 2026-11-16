// Höhenprofil aus den Terrarium-Höhenkacheln (AWS Open Data, Mapzen),
// den gleichen Kacheln, aus denen die 3D-Karte ihr Gelände baut.

import type { LngLat } from '../geo';

export const TERRAIN_TILES = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';

const tileCache = new Map<string, Promise<ImageData | null>>();

function tileXY(lng: number, lat: number, z: number): { x: number; y: number; px: number; py: number } {
  const n = 2 ** z;
  const xf = ((lng + 180) / 360) * n;
  const latR = (Math.max(-85.0511, Math.min(85.0511, lat)) * Math.PI) / 180;
  const yf = ((1 - Math.log(Math.tan(latR) + 1 / Math.cos(latR)) / Math.PI) / 2) * n;
  const x = Math.floor(xf);
  const y = Math.floor(yf);
  return { x: ((x % n) + n) % n, y, px: Math.min(255, Math.floor((xf - x) * 256)), py: Math.min(255, Math.floor((yf - y) * 256)) };
}

function loadTile(z: number, x: number, y: number, signal?: AbortSignal): Promise<ImageData | null> {
  const key = `${z}/${x}/${y}`;
  let p = tileCache.get(key);
  if (!p) {
    p = (async () => {
      try {
        const url = TERRAIN_TILES.replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y));
        const res = await fetch(url, { signal });
        if (!res.ok) return null;
        const bmp = await createImageBitmap(await res.blob());
        const canvas = document.createElement('canvas');
        canvas.width = bmp.width;
        canvas.height = bmp.height;
        const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
        ctx.drawImage(bmp, 0, 0);
        return ctx.getImageData(0, 0, bmp.width, bmp.height);
      } catch {
        return null;
      }
    })();
    tileCache.set(key, p);
    // fehlgeschlagene Kacheln nicht ewig merken
    p.then((v) => v === null && tileCache.delete(key));
  }
  return p;
}

/** Höhen in Metern für die Punkte. Unbekannte Höhen werden aus den Nachbarn gefüllt. */
export async function elevations(points: LngLat[], signal?: AbortSignal): Promise<number[]> {
  // Zoomstufe so wählen, dass nicht zu viele Kacheln nötig sind
  let z = 12;
  for (; z > 5; z--) {
    const set = new Set(points.map((p) => {
      const t = tileXY(p[0], p[1], z);
      return `${t.x}/${t.y}`;
    }));
    if (set.size <= 40) break;
  }
  const result = await Promise.all(
    points.map(async (p) => {
      const t = tileXY(p[0], p[1], z);
      const img = await loadTile(z, t.x, t.y, signal);
      if (!img) return NaN;
      const i = (t.py * img.width + t.px) * 4;
      return img.data[i] * 256 + img.data[i + 1] + img.data[i + 2] / 256 - 32768;
    }),
  );
  // Lücken füllen
  let last = result.find((v) => Number.isFinite(v)) ?? 0;
  return result.map((v) => {
    if (Number.isFinite(v)) {
      last = v;
      return v;
    }
    return last;
  });
}
