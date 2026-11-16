// Umrechnung WGS84 <-> Schweizer Landeskoordinaten LV95 (EPSG:2056).
// Näherungsformeln von swisstopo ("Näherungslösungen für die direkte Transformation
// CH1903 <=> WGS84"), Genauigkeit etwa 1 m innerhalb der Schweiz.

import type { LngLat } from '../geo';

/** [lng, lat] in Grad -> [E, N] in Metern (LV95). */
export function wgs84ToLv95([lng, lat]: LngLat): [number, number] {
  // in Bogensekunden, Hilfsgrössen bezogen auf Bern
  const phi = (lat * 3600 - 169028.66) / 10000;
  const lam = (lng * 3600 - 26782.5) / 10000;
  const E =
    2600072.37 +
    211455.93 * lam -
    10938.51 * lam * phi -
    0.36 * lam * phi * phi -
    44.54 * lam * lam * lam;
  const N =
    1200147.07 +
    308807.95 * phi +
    3745.25 * lam * lam +
    76.63 * phi * phi -
    194.56 * lam * lam * phi +
    119.79 * phi * phi * phi;
  return [E, N];
}

/** [E, N] in Metern (LV95) -> [lng, lat] in Grad. */
export function lv95ToWgs84([E, N]: [number, number]): LngLat {
  const y = (E - 2600000) / 1e6;
  const x = (N - 1200000) / 1e6;
  const lam = 2.6779094 + 4.728982 * y + 0.791484 * y * x + 0.1306 * y * x * x - 0.0436 * y * y * y;
  const phi =
    16.9023892 + 3.238272 * x - 0.270978 * y * y - 0.002528 * x * x - 0.0447 * y * y * x - 0.014 * x * x * x;
  // Einheit 10000" -> Grad
  return [(lam * 100) / 36, (phi * 100) / 36];
}
