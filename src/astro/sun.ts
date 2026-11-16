// Sonnen- und Mondstand.
// Formeln nach SunCalc von Vladimir Agafonkin (BSD-2-Clause),
// https://github.com/mourner/suncalc — auf TypeScript portiert und um
// Grad-Ausgabe mit Azimut ab Nord ergänzt.

const PI = Math.PI;
const rad = PI / 180;
const dayMs = 864e5;
const J1970 = 2440588;
const J2000 = 2451545;
const e = rad * 23.4397; // Schiefe der Ekliptik

const toJulian = (ms: number) => ms / dayMs - 0.5 + J1970;
const fromJulian = (j: number) => (j + 0.5 - J1970) * dayMs;
const toDays = (ms: number) => toJulian(ms) - J2000;

const rightAscension = (l: number, b: number) =>
  Math.atan2(Math.sin(l) * Math.cos(e) - Math.tan(b) * Math.sin(e), Math.cos(l));
const declination = (l: number, b: number) =>
  Math.asin(Math.sin(b) * Math.cos(e) + Math.cos(b) * Math.sin(e) * Math.sin(l));
const azimuthOf = (H: number, phi: number, dec: number) =>
  Math.atan2(Math.sin(H), Math.cos(H) * Math.sin(phi) - Math.tan(dec) * Math.cos(phi));
const altitudeOf = (H: number, phi: number, dec: number) =>
  Math.asin(Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(H));
const siderealTime = (d: number, lw: number) => rad * (280.16 + 360.9856235 * d) - lw;

function astroRefraction(h: number): number {
  if (h < 0) h = 0;
  return 0.0002967 / Math.tan(h + 0.00312536 / (h + 0.08901179));
}

const solarMeanAnomaly = (d: number) => rad * (357.5291 + 0.98560028 * d);

function eclipticLongitude(M: number): number {
  const C = rad * (1.9148 * Math.sin(M) + 0.02 * Math.sin(2 * M) + 0.0003 * Math.sin(3 * M));
  const P = rad * 102.9372;
  return M + C + P + PI;
}

function sunCoords(d: number) {
  const M = solarMeanAnomaly(d);
  const L = eclipticLongitude(M);
  return { dec: declination(L, 0), ra: rightAscension(L, 0) };
}

/** Azimut in Grad ab Nord im Uhrzeigersinn (0 = N, 90 = O, 180 = S, 270 = W). */
const toNorthAzimuthDeg = (azFromSouth: number) => (((azFromSouth / rad + 180) % 360) + 360) % 360;

export interface SkyPosition {
  /** Azimut in Grad ab Nord im Uhrzeigersinn */
  azimuth: number;
  /** Höhe über dem Horizont in Grad (negativ = unter dem Horizont) */
  altitude: number;
}

export function sunPosition(ms: number, lat: number, lng: number): SkyPosition {
  const lw = rad * -lng;
  const phi = rad * lat;
  const d = toDays(ms);
  const c = sunCoords(d);
  const H = siderealTime(d, lw) - c.ra;
  return {
    azimuth: toNorthAzimuthDeg(azimuthOf(H, phi, c.dec)),
    altitude: altitudeOf(H, phi, c.dec) / rad,
  };
}

const J0 = 0.0009;
const julianCycle = (d: number, lw: number) => Math.round(d - J0 - lw / (2 * PI));
const approxTransit = (Ht: number, lw: number, n: number) => J0 + (Ht + lw) / (2 * PI) + n;
const solarTransitJ = (ds: number, M: number, L: number) =>
  J2000 + ds + 0.0053 * Math.sin(M) - 0.0069 * Math.sin(2 * L);
const hourAngle = (h: number, phi: number, d: number) =>
  Math.acos((Math.sin(h) - Math.sin(phi) * Math.sin(d)) / (Math.cos(phi) * Math.cos(d)));

function getSetJ(h: number, lw: number, phi: number, dec: number, n: number, M: number, L: number) {
  const w = hourAngle(h, phi, dec);
  const a = approxTransit(w, lw, n);
  return solarTransitJ(a, M, L);
}

export interface SunTimes {
  sunrise: number | null;
  sunset: number | null;
  solarNoon: number;
  /** Ende der bürgerlichen Dämmerung am Abend */
  dusk: number | null;
  /** Beginn der bürgerlichen Dämmerung am Morgen */
  dawn: number | null;
}

/** Sonnenauf- und -untergang für den Tag, der `ms` enthält (UTC-Zeitstempel). */
export function sunTimes(ms: number, lat: number, lng: number): SunTimes {
  const lw = rad * -lng;
  const phi = rad * lat;
  const d = toDays(ms);
  const n = julianCycle(d, lw);
  const ds = approxTransit(0, lw, n);
  const M = solarMeanAnomaly(ds);
  const L = eclipticLongitude(M);
  const dec = declination(L, 0);
  const Jnoon = solarTransitJ(ds, M, L);
  const pair = (angleDeg: number): [number | null, number | null] => {
    const Jset = getSetJ(angleDeg * rad, lw, phi, dec, n, M, L);
    if (!Number.isFinite(Jset)) return [null, null];
    const Jrise = Jnoon - (Jset - Jnoon);
    return [fromJulian(Jrise), fromJulian(Jset)];
  };
  const [sunrise, sunset] = pair(-0.833);
  const [dawn, dusk] = pair(-6);
  return { sunrise, sunset, solarNoon: fromJulian(Jnoon), dawn, dusk };
}

function moonCoords(d: number) {
  const L = rad * (218.316 + 13.176396 * d);
  const M = rad * (134.963 + 13.064993 * d);
  const F = rad * (93.272 + 13.22935 * d);
  const l = L + rad * 6.289 * Math.sin(M);
  const b = rad * 5.128 * Math.sin(F);
  const dt = 385001 - 20905 * Math.cos(M);
  return { ra: rightAscension(l, b), dec: declination(l, b), dist: dt };
}

export interface MoonState extends SkyPosition {
  /** beleuchteter Anteil 0..1 */
  fraction: number;
  /** Phase 0..1 (0 Neumond, 0.25 erstes Viertel, 0.5 Vollmond, 0.75 letztes Viertel) */
  phase: number;
  /** Drehwinkel der beleuchteten Seite gegenüber dem Zenit, in Radiant */
  brightLimbAngle: number;
}

export function moonState(ms: number, lat: number, lng: number): MoonState {
  const lw = rad * -lng;
  const phi = rad * lat;
  const d = toDays(ms);
  const c = moonCoords(d);
  const H = siderealTime(d, lw) - c.ra;
  let h = altitudeOf(H, phi, c.dec);
  h = h + astroRefraction(h);
  const pa = Math.atan2(Math.sin(H), Math.tan(phi) * Math.cos(c.dec) - Math.sin(c.dec) * Math.cos(H));

  const s = sunCoords(d);
  const sdist = 149598000;
  const phiI = Math.acos(
    Math.sin(s.dec) * Math.sin(c.dec) + Math.cos(s.dec) * Math.cos(c.dec) * Math.cos(s.ra - c.ra),
  );
  const inc = Math.atan2(sdist * Math.sin(phiI), c.dist - sdist * Math.cos(phiI));
  const angle = Math.atan2(
    Math.cos(s.dec) * Math.sin(s.ra - c.ra),
    Math.sin(s.dec) * Math.cos(c.dec) - Math.cos(s.dec) * Math.sin(c.dec) * Math.cos(s.ra - c.ra),
  );
  return {
    azimuth: toNorthAzimuthDeg(azimuthOf(H, phi, c.dec)),
    altitude: h / rad,
    fraction: (1 + Math.cos(inc)) / 2,
    phase: 0.5 + (0.5 * inc * (angle < 0 ? -1 : 1)) / PI,
    brightLimbAngle: angle - pa,
  };
}

/**
 * Wolkenlose Globalstrahlung auf die Horizontale in W/m² (Haurwitz-Modell).
 * Gute Näherung für klare Luft, reicht für eine Helligkeitsschätzung.
 */
export function clearSkyGhi(sunAltitudeDeg: number): number {
  if (sunAltitudeDeg <= 0) return 0;
  const s = Math.sin(sunAltitudeDeg * rad);
  return 1098 * s * Math.exp(-0.057 / s);
}

/**
 * Beleuchtungsstärke am Boden in Lux.
 * Tagsüber aus der Globalstrahlung (~120 lm/W), in der Dämmerung aus einer
 * an Messwerte angelehnten Kurve, nachts mit Mondlicht.
 */
export function illuminanceLux(sunAltDeg: number, ghi: number, moon?: MoonState, cloud = 0): number {
  const daylight = ghi * 120;
  // Dämmerung: ~400 lx bei 0°, ~3 lx bei -6°, ~0.008 lx bei -12°
  const twilight = sunAltDeg > -18 ? Math.pow(10, 2.6 + 0.42 * Math.min(sunAltDeg, 0)) * (1 - 0.6 * cloud) : 0;
  let moonLux = 0;
  if (moon && moon.altitude > 0) {
    moonLux = 0.27 * moon.fraction * Math.sin(moon.altitude * rad) * (1 - 0.85 * cloud);
  }
  const starlight = 0.002;
  return Math.max(daylight, twilight) + moonLux + starlight;
}
