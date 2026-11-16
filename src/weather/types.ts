export type WeatherSource = 'open-meteo' | 'met-no';

/** Ein Wetterzustand zu einem Zeitpunkt an einem Ort, quellenunabhängig. */
export interface WeatherSample {
  /** UTC-Zeitstempel in ms */
  time: number;
  /** Lufttemperatur in °C (2 m) */
  temp: number;
  feelsLike: number | null;
  /** relative Feuchte in % */
  humidity: number | null;
  dewPoint: number | null;
  /** Luftdruck auf Meereshöhe in hPa */
  pressure: number | null;
  /** Gesamtbewölkung in % */
  cloud: number;
  cloudLow: number | null;
  cloudMid: number | null;
  cloudHigh: number | null;
  /** Niederschlag in mm/h */
  precip: number;
  /** Schneefall in cm/h, falls die Quelle ihn liefert */
  snowfall: number | null;
  /** Wettercode nach WMO 4677 (Open-Meteo-Untermenge, ergänzt um 68/69/83/84 für Schneeregen) */
  code: number;
  /** Wind in km/h */
  windSpeed: number;
  /** Windrichtung in Grad, aus der der Wind kommt */
  windDir: number;
  windGust: number | null;
  /** Sichtweite in m */
  visibility: number | null;
  /** Globalstrahlung in W/m² */
  shortwave: number | null;
  direct: number | null;
  diffuse: number | null;
  /** Nebelanteil in % (MET Norway) */
  fog: number | null;
}

export interface PointWeather {
  lat: number;
  lon: number;
  elevation: number | null;
  source: WeatherSource;
  /** Abstand der Ortszeit zu UTC in Sekunden */
  utcOffsetSec: number;
  timezone: string | null;
  current: WeatherSample;
  hourly: WeatherSample[];
  fetchedAt: number;
}

export const SOURCE_LABEL: Record<WeatherSource, string> = {
  'open-meteo': 'Open-Meteo',
  'met-no': 'MET Norway',
};
