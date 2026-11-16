// Aus Wetter + Sonnenstand wird ein "Umgebungszustand": Licht, Farben, Nebel,
// Niederschlag. Karte und Effekte lesen nur noch diesen Zustand.

import { clearSkyGhi, illuminanceLux, moonState, sunPosition, type MoonState } from './astro/sun';
import { describe, precipKindFor, type PrecipKind } from './weather/conditions';
import type { WeatherSample } from './weather/types';
import { clamp, lerp, smoothstep } from './geo';

export type RGB = [number, number, number];

export interface Env {
  time: number;
  lat: number;
  lon: number;
  sunAz: number;
  sunAlt: number;
  moon: MoonState;

  /** Beleuchtungsstärke am Boden in Lux */
  lux: number;
  /** Globalstrahlung W/m² */
  ghi: number;
  ghiEstimated: boolean;
  /** visuelle Helligkeit 0..1 (log. aus Lux) */
  exposure: number;
  /** 0 = Tag, 1 = Nacht (Strassenlicht an) */
  night: number;
  /** Abendrot/Morgenrot 0..1 */
  golden: number;
  /** Anteil des wolkenlosen Lichts, der ankommt 0..1 */
  transmittance: number;
  /** wie hart die Schatten sind (direktes Sonnenlicht) 0..1 */
  directness: number;

  cloud: number;
  cloudLow: number;
  cloudMid: number;
  cloudHigh: number;
  /** Grauschleier durch Wolken, Nebel, Niederschlag 0..1 */
  overcast: number;

  precipKind: PrecipKind;
  precipRate: number;
  precipIntensity: number;
  thunder: boolean;

  windSpeed: number;
  windDir: number;

  visibility: number;
  visibilityEstimated: boolean;
  /** Nebeldichte 0..1 */
  fog: number;
  /** Dunst über grosse Distanzen 0..1 */
  haze: number;

  temp: number;

  skyZenith: RGB;
  skyHorizon: RGB;
  fogColor: RGB;
  sunColor: RGB;
  tint: RGB;
  tintAlpha: number;
  cloudLit: RGB;
  cloudShade: RGB;
}

const hex = (h: string): RGB => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
export const mix = (a: RGB, b: RGB, t: number): RGB => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
export const scale = (a: RGB, k: number): RGB => [a[0] * k, a[1] * k, a[2] * k];
export const css = (c: RGB, alpha = 1): string =>
  alpha >= 1
    ? `rgb(${Math.round(clamp(c[0], 0, 255))},${Math.round(clamp(c[1], 0, 255))},${Math.round(clamp(c[2], 0, 255))})`
    : `rgba(${Math.round(clamp(c[0], 0, 255))},${Math.round(clamp(c[1], 0, 255))},${Math.round(clamp(c[2], 0, 255))},${clamp(alpha, 0, 1).toFixed(3)})`;

type Key = [number, RGB];
function ramp(keys: Key[], x: number): RGB {
  if (x <= keys[0][0]) return keys[0][1];
  for (let i = 1; i < keys.length; i++) {
    if (x <= keys[i][0]) {
      const t = (x - keys[i - 1][0]) / (keys[i][0] - keys[i - 1][0]);
      return mix(keys[i - 1][1], keys[i][1], t);
    }
  }
  return keys[keys.length - 1][1];
}

// Himmelsfarben bei klarem Himmel nach Sonnenhöhe (Grad)
const ZENITH: Key[] = [
  [-18, hex('#03050d')],
  [-12, hex('#070c1f')],
  [-7, hex('#131c40')],
  [-3, hex('#24336b')],
  [0, hex('#34508f')],
  [6, hex('#3c69b8')],
  [20, hex('#2f6fd6')],
  [50, hex('#2a68d4')],
];
const HORIZON: Key[] = [
  [-18, hex('#080c1a')],
  [-12, hex('#121733')],
  [-7, hex('#3d3563')],
  [-3, hex('#a65a62')],
  [0, hex('#ff8a4c')],
  [4, hex('#ffb070')],
  [10, hex('#f2d2a8')],
  [20, hex('#bcd8f2')],
  [50, hex('#a7cdf2')],
];
const SUNLIGHT: Key[] = [
  [-6, hex('#6c7fb8')],
  [-1, hex('#ff6a35')],
  [2, hex('#ff8f4a')],
  [6, hex('#ffb56e')],
  [12, hex('#ffd8a2')],
  [25, hex('#fff0d8')],
  [50, hex('#fff9ee')],
];

/** Sichtweite schätzen, wenn die Quelle keine liefert (MET Norway). */
export function estimateVisibility(s: WeatherSample, kind: PrecipKind): number {
  let vis = 40000;
  const h = s.humidity ?? 70;
  if (h > 88) vis = lerp(40000, 7000, clamp((h - 88) / 12, 0, 1));
  if (s.fog != null && s.fog > 0) vis = Math.min(vis, lerp(4000, 120, clamp(s.fog / 100, 0, 1)));
  const c = describe(s.code);
  if (c.fog) vis = Math.min(vis, 500);
  if (s.precip > 0.05) {
    if (kind === 'snow') vis = Math.min(vis, 9000 / (1 + 2.2 * s.precip));
    else if (kind === 'sleet') vis = Math.min(vis, 14000 / (1 + 1.8 * s.precip));
    else if (kind === 'drizzle') vis = Math.min(vis, 9000);
    else vis = Math.min(vis, 28000 / (1 + 1.3 * s.precip));
  }
  return vis;
}

/** mm/h auf eine visuelle Stärke 0..1 abbilden (logarithmisch). */
export function precipIntensity(rate: number, strengthHint: number): number {
  if (rate <= 0.02) return strengthHint * 0.35;
  const v = clamp((Math.log10(rate) + 1.3) / 2.5, 0.08, 1);
  return Math.max(v, strengthHint * 0.5);
}

export function computeEnv(s: WeatherSample, lat: number, lon: number, time: number): Env {
  const sun = sunPosition(time, lat, lon);
  const moon = moonState(time, lat, lon);
  const sunAlt = sun.altitude;
  const sunUp = smoothstep(-1.5, 4, sunAlt);

  const cloud = clamp(s.cloud / 100, 0, 1);
  const cloudLow = clamp((s.cloudLow ?? s.cloud * 0.6) / 100, 0, 1);
  const cloudMid = clamp((s.cloudMid ?? s.cloud * 0.5) / 100, 0, 1);
  const cloudHigh = clamp((s.cloudHigh ?? s.cloud * 0.4) / 100, 0, 1);

  const cond = describe(s.code, sunAlt < -0.8);
  const precipKind = precipKindFor(s.code, s.temp, s.snowfall, s.precip);
  const pI = precipKind === 'none' ? 0 : precipIntensity(s.precip, cond.strength);
  const thunder = cond.thunder;

  const visibilityEstimated = s.visibility == null;
  const visibility = s.visibility ?? estimateVisibility(s, precipKind);
  const fog = clamp(1 - (Math.log10(Math.max(visibility, 20)) - 2.2) / 2.3, 0, 1);
  const haze = clamp(1 - (Math.log10(Math.max(visibility, 20)) - 3.4) / 1.3, 0, 1);

  // Strahlung: gemessen/modelliert, sonst aus Bewölkung geschätzt
  const ghiClear = clearSkyGhi(sunAlt);
  const modelT = clamp(
    (1 - 0.75 * Math.pow(cloud, 3.4)) * (1 - 0.25 * cloudLow * cloud) * (1 - 0.35 * pI) * (1 - 0.4 * fog),
    0.04,
    1,
  );
  let ghi: number;
  let transmittance: number;
  let ghiEstimated = false;
  if (s.shortwave != null && ghiClear > 40) {
    ghi = s.shortwave;
    transmittance = clamp(ghi / ghiClear, 0.03, 1.05);
  } else {
    ghiEstimated = s.shortwave == null;
    transmittance = modelT;
    ghi = ghiClear * modelT;
  }
  let directness: number;
  if (s.direct != null && s.shortwave != null && s.shortwave > 25) {
    directness = clamp(s.direct / s.shortwave / 0.8, 0, 1);
  } else {
    directness = clamp((transmittance - 0.3) / 0.6, 0, 1) * (1 - 0.6 * cloudLow * cloud);
  }
  directness *= sunUp;

  const lux = illuminanceLux(sunAlt, ghi, moon, cloud);
  const exposure = clamp((Math.log10(lux) + 1.2) / 5.6, 0, 1);
  const night = smoothstep(1, -9, sunAlt);
  let golden = smoothstep(-5, 0.5, sunAlt) * (1 - smoothstep(4, 16, sunAlt));
  golden *= clamp(1 - 0.85 * cloudLow * cloud - 0.5 * fog, 0, 1) * (1 + 0.35 * cloudHigh);
  golden = clamp(golden, 0, 1);

  const overcast = clamp(Math.pow(cloud, 1.25) * 0.85 + 0.25 * pI + 0.6 * fog + (thunder ? 0.2 : 0), 0, 1);

  // Himmel
  let zenith = ramp(ZENITH, sunAlt);
  let horizon = ramp(HORIZON, sunAlt);
  const grayLevel = lerp(14, 205, Math.pow(exposure, 1.3)) * (thunder ? 0.62 : 1) * (1 - 0.25 * pI);
  const gray: RGB = [grayLevel * 0.97, grayLevel, grayLevel * 1.04];
  zenith = mix(zenith, gray, overcast * 0.92);
  horizon = mix(horizon, mix(gray, horizon, golden * 0.4), overcast * 0.85);
  // Lichtverschmutzung: nachts leuchten tiefe Wolken warm von unten
  const skyglow = night * cloud * (0.5 + 0.5 * cloudLow);
  zenith = mix(zenith, hex('#2a2330'), skyglow * 0.55);
  horizon = mix(horizon, hex('#4a3a3a'), skyglow * 0.6);

  const fogBase: RGB = mix(hex('#0d1220'), hex('#d4d9df'), Math.pow(exposure, 1.1));
  // Luftperspektive: ferner Dunst hat die Farbe des Horizonts, dichter Nebel seine eigene
  const fogColor = mix(mix(horizon, fogBase, 0.3), fogBase, fog);

  let sunColor = ramp(SUNLIGHT, sunAlt);
  if (sunAlt < -1) sunColor = mix(hex('#8ea3d8'), sunColor, smoothstep(-6, -1, sunAlt));
  sunColor = mix(sunColor, hex('#e9eef5'), overcast * 0.6);

  // Farbstich über der Karte: Nacht, Abendlicht, Grau, Nebel, Schnee
  const parts: { c: RGB; a: number }[] = [
    { c: hex('#0a1430'), a: 0.46 * Math.pow(1 - exposure, 1.6) },
    { c: hex('#ff7128'), a: 0.26 * golden * Math.max(directness, 0.35) },
    { c: hex('#59626e'), a: 0.16 * overcast * exposure },
    { c: fogColor, a: 0.5 * fog },
  ];
  if (precipKind === 'snow' || (precipKind === 'sleet' && s.temp < 1)) {
    parts.push({ c: hex('#eef3f8'), a: 0.28 * pI * (0.4 + 0.6 * exposure) });
  } else if (pI > 0) {
    parts.push({ c: hex('#151d28'), a: 0.14 * pI });
  }
  let keep = 1;
  let tint: RGB = [0, 0, 0];
  let wsum = 0;
  for (const p of parts) {
    const a = clamp(p.a, 0, 1);
    tint = [tint[0] + p.c[0] * a, tint[1] + p.c[1] * a, tint[2] + p.c[2] * a];
    wsum += a;
    keep *= 1 - a;
  }
  tint = wsum > 0 ? scale(tint, 1 / wsum) : [0, 0, 0];
  const tintAlpha = 1 - keep;

  const cloudLitBase = mix(hex('#ffffff'), sunColor, 0.35 + 0.5 * golden);
  const cloudLit = scale(cloudLitBase, lerp(0.12, 1, Math.pow(exposure, 0.9)));
  const cloudShade = scale(mix(hex('#8a93a3'), hex('#3d4350'), clamp(cloudLow * 0.6 + pI * 0.5 + (thunder ? 0.4 : 0), 0, 1)), lerp(0.18, 1, Math.pow(exposure, 1.1)));

  return {
    time,
    lat,
    lon,
    sunAz: sun.azimuth,
    sunAlt,
    moon,
    lux,
    ghi,
    ghiEstimated,
    exposure,
    night,
    golden,
    transmittance,
    directness,
    cloud,
    cloudLow,
    cloudMid,
    cloudHigh,
    overcast,
    precipKind,
    precipRate: s.precip,
    precipIntensity: pI,
    thunder,
    windSpeed: s.windSpeed,
    windDir: s.windDir,
    visibility,
    visibilityEstimated,
    fog,
    haze,
    temp: s.temp,
    skyZenith: zenith,
    skyHorizon: horizon,
    fogColor,
    sunColor,
    tint,
    tintAlpha,
    cloudLit,
    cloudShade,
  };
}

/** Helligkeit als Text, z. B. "38 000 lx". */
export function formatLux(lux: number): string {
  if (lux >= 10000) return `${(Math.round(lux / 1000) * 1000).toLocaleString('de-CH')} lx`;
  if (lux >= 100) return `${(Math.round(lux / 10) * 10).toLocaleString('de-CH')} lx`;
  if (lux >= 1) return `${Math.round(lux)} lx`;
  if (lux >= 0.01) return `${lux.toFixed(2).replace('.', ',')} lx`;
  return '< 0,01 lx';
}

/** Einordnung der Helligkeit für Menschen. */
export function luxLabel(lux: number): string {
  if (lux >= 50000) return 'volle Sonne';
  if (lux >= 15000) return 'hell';
  if (lux >= 3000) return 'trüber Tag';
  if (lux >= 400) return 'sehr trüb / Dämmerung';
  if (lux >= 10) return 'Dämmerung';
  if (lux >= 1) return 'späte Dämmerung';
  if (lux >= 0.1) return 'Mondlicht';
  return 'dunkle Nacht';
}
