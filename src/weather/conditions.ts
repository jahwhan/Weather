// WMO-Wettercodes deuten: Text, Niederschlagsart, Gewitter, Nebel.

export type PrecipKind = 'none' | 'drizzle' | 'rain' | 'snow' | 'sleet' | 'hail';
export type IconKind =
  | 'clear'
  | 'partly'
  | 'cloudy'
  | 'fog'
  | 'drizzle'
  | 'rain'
  | 'snow'
  | 'sleet'
  | 'thunder';

export interface Condition {
  label: string;
  icon: IconKind;
  precip: PrecipKind;
  thunder: boolean;
  fog: boolean;
  /** grobe Stärke aus dem Code, 0..1 */
  strength: number;
}

const C = (
  label: string,
  icon: IconKind,
  precip: PrecipKind = 'none',
  strength = 0,
  thunder = false,
  fog = false,
): Condition => ({ label, icon, precip, strength, thunder, fog });

const TABLE: Record<number, Condition> = {
  0: C('Klar', 'clear'),
  1: C('Überwiegend klar', 'clear'),
  2: C('Teilweise bewölkt', 'partly'),
  3: C('Bedeckt', 'cloudy'),
  45: C('Nebel', 'fog', 'none', 0, false, true),
  48: C('Nebel mit Raureif', 'fog', 'none', 0, false, true),
  51: C('Leichter Nieselregen', 'drizzle', 'drizzle', 0.15),
  53: C('Nieselregen', 'drizzle', 'drizzle', 0.3),
  55: C('Starker Nieselregen', 'drizzle', 'drizzle', 0.45),
  56: C('Gefrierender Nieselregen', 'drizzle', 'drizzle', 0.3),
  57: C('Starker gefrierender Nieselregen', 'drizzle', 'drizzle', 0.5),
  61: C('Leichter Regen', 'rain', 'rain', 0.3),
  63: C('Regen', 'rain', 'rain', 0.55),
  65: C('Starker Regen', 'rain', 'rain', 0.85),
  66: C('Gefrierender Regen', 'rain', 'rain', 0.45),
  67: C('Starker gefrierender Regen', 'rain', 'rain', 0.8),
  68: C('Leichter Schneeregen', 'sleet', 'sleet', 0.3),
  69: C('Schneeregen', 'sleet', 'sleet', 0.6),
  71: C('Leichter Schneefall', 'snow', 'snow', 0.3),
  73: C('Schneefall', 'snow', 'snow', 0.55),
  75: C('Starker Schneefall', 'snow', 'snow', 0.9),
  77: C('Schneegriesel', 'snow', 'snow', 0.25),
  80: C('Leichte Regenschauer', 'rain', 'rain', 0.35),
  81: C('Regenschauer', 'rain', 'rain', 0.6),
  82: C('Heftige Regenschauer', 'rain', 'rain', 0.95),
  83: C('Leichte Schneeregenschauer', 'sleet', 'sleet', 0.35),
  84: C('Schneeregenschauer', 'sleet', 'sleet', 0.65),
  85: C('Leichte Schneeschauer', 'snow', 'snow', 0.4),
  86: C('Starke Schneeschauer', 'snow', 'snow', 0.85),
  95: C('Gewitter', 'thunder', 'rain', 0.7, true),
  96: C('Gewitter mit Hagel', 'thunder', 'hail', 0.85, true),
  97: C('Starkes Gewitter', 'thunder', 'rain', 0.95, true),
  99: C('Schweres Gewitter mit Hagel', 'thunder', 'hail', 1, true),
};

export function describe(code: number, isNight = false): Condition {
  const c = TABLE[code] ?? TABLE[nearestKnown(code)];
  if (isNight && code <= 1) return { ...c, label: code === 0 ? 'Klare Nacht' : 'Überwiegend klare Nacht' };
  return c;
}

function nearestKnown(code: number): number {
  const keys = Object.keys(TABLE).map(Number);
  let best = 0;
  for (const k of keys) if (k <= code) best = k;
  return best;
}

/**
 * MET-Norway-Symbolcode (z. B. "lightrainshowers_day") auf einen WMO-Code abbilden.
 * https://api.met.no/weatherapi/weathericon/2.0/documentation
 */
export function metSymbolToWmo(symbol: string | undefined): number {
  if (!symbol) return 3;
  const s = symbol.replace(/_(day|night|polartwilight)$/, '');
  const light = s.startsWith('light');
  const heavy = s.startsWith('heavy');
  const showers = s.includes('showers');
  const thunder = s.includes('thunder');
  if (thunder) {
    if (s.includes('snow') || s.includes('sleet')) return heavy ? 97 : 95;
    return heavy ? 97 : 95;
  }
  if (s.includes('sleet')) return showers ? (light ? 83 : 84) : light ? 68 : 69;
  if (s.includes('snow')) {
    if (showers) return heavy ? 86 : 85;
    return light ? 71 : heavy ? 75 : 73;
  }
  if (s.includes('rain')) {
    if (showers) return light ? 80 : heavy ? 82 : 81;
    return light ? 61 : heavy ? 65 : 63;
  }
  switch (s) {
    case 'clearsky':
      return 0;
    case 'fair':
      return 1;
    case 'partlycloudy':
      return 2;
    case 'cloudy':
      return 3;
    case 'fog':
      return 45;
    default:
      return 3;
  }
}

/** Niederschlagsart aus Code und, falls vorhanden, Temperatur und Schneefall. */
export function precipKindFor(code: number, temp: number, snowfall: number | null, precip: number): PrecipKind {
  const c = describe(code);
  if (c.precip !== 'none') return c.precip;
  if (precip <= 0.02) return 'none';
  if (snowfall != null && snowfall > 0) return temp > 1.5 ? 'sleet' : 'snow';
  if (temp < -0.5) return 'snow';
  if (temp < 1.5) return 'sleet';
  return 'rain';
}

/** Beaufort-Stufe aus km/h */
export function beaufort(kmh: number): number {
  const limits = [1, 6, 12, 20, 29, 39, 50, 62, 75, 89, 103, 118];
  let b = 0;
  while (b < limits.length && kmh >= limits[b]) b++;
  return b;
}

const BEAUFORT_LABEL = [
  'Windstille',
  'Leiser Zug',
  'Leichte Brise',
  'Schwache Brise',
  'Mässige Brise',
  'Frische Brise',
  'Starker Wind',
  'Steifer Wind',
  'Stürmischer Wind',
  'Sturm',
  'Schwerer Sturm',
  'Orkanartiger Sturm',
  'Orkan',
];

export function beaufortLabel(kmh: number): string {
  return BEAUFORT_LABEL[beaufort(kmh)];
}

const DIRS = ['N', 'NNO', 'NO', 'ONO', 'O', 'OSO', 'SO', 'SSO', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
export function compass(deg: number): string {
  return DIRS[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16];
}

/** Bewölkung in Achteln (Okta), wie in Wettermeldungen üblich. */
export function okta(cloudPercent: number): number {
  if (cloudPercent <= 0) return 0;
  if (cloudPercent >= 100) return 8;
  return Math.min(7, Math.max(1, Math.round((cloudPercent / 100) * 8)));
}

const OKTA_LABEL = ['wolkenlos', 'sonnig', 'heiter', 'leicht bewölkt', 'wolkig', 'bewölkt', 'stark bewölkt', 'fast bedeckt', 'bedeckt'];
export function oktaLabel(cloudPercent: number): string {
  return OKTA_LABEL[okta(cloudPercent)];
}
