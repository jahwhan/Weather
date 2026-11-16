// Kachelbares Wertrauschen (fBm) für Wolken, Wolkenschatten und Nebelschwaden.

function hash(x: number, y: number, seed: number): number {
  let h = (x * 374761393 + y * 668265263 + seed * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967295;
}

const fade = (t: number) => t * t * (3 - 2 * t);

/**
 * Erzeugt fBm-Rauschen der Grösse w×h, horizontal und vertikal kachelbar.
 * Werte ungefähr 0..1.
 */
export function fbm(w: number, h: number, freqX: number, freqY: number, octaves: number, seed = 1, gain = 0.5): Float32Array {
  const out = new Float32Array(w * h);
  let amp = 1;
  let total = 0;
  for (let o = 0; o < octaves; o++) {
    const fx = freqX << o;
    const fy = freqY << o;
    const lattice = new Float32Array(fx * fy);
    for (let j = 0; j < fy; j++) for (let i = 0; i < fx; i++) lattice[j * fx + i] = hash(i, j, seed + o * 101);
    for (let y = 0; y < h; y++) {
      const gy = (y / h) * fy;
      const y0 = Math.floor(gy);
      const ty = fade(gy - y0);
      const r0 = (y0 % fy) * fx;
      const r1 = ((y0 + 1) % fy) * fx;
      for (let x = 0; x < w; x++) {
        const gx = (x / w) * fx;
        const x0 = Math.floor(gx);
        const tx = fade(gx - x0);
        const c0 = x0 % fx;
        const c1 = (x0 + 1) % fx;
        const a = lattice[r0 + c0] + (lattice[r0 + c1] - lattice[r0 + c0]) * tx;
        const b = lattice[r1 + c0] + (lattice[r1 + c1] - lattice[r1 + c0]) * tx;
        out[y * w + x] += (a + (b - a) * ty) * amp;
      }
    }
    total += amp;
    amp *= gain;
  }
  for (let i = 0; i < out.length; i++) out[i] /= total;
  return out;
}

/** Schwelle, über der ein Anteil `coverage` der Werte liegt. */
export function coverageThreshold(sorted: Float32Array, coverage: number): number {
  const c = Math.min(0.999, Math.max(0.001, coverage));
  return sorted[Math.floor((1 - c) * (sorted.length - 1))];
}

export function sortedCopy(a: Float32Array): Float32Array {
  return Float32Array.from(a).sort();
}
