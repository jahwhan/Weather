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
  /** Luftdruck auf Meereshöhe in hPa (Open-Meteo/MET: MSL aus dem Modell; SwissMetNet: QFF) */
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
  /** Lesbares Modell, z. B. "MeteoSchweiz ICON-CH1" (fehlt, wenn die Quelle es nicht nennt) */
  model?: string;
  /** Der "jetzt"-Zustand enthält Messwerte dieser SwissMetNet-Station */
  observed?: { station: string; name: string; distanceM: number; time: number };
}

/** Open-Meteo-Modellnamen -> Anzeige */
export const MODEL_LABEL: Record<string, string> = {
  meteoswiss_icon_ch1: 'MeteoSchweiz ICON-CH1',
  meteoswiss_icon_ch2: 'MeteoSchweiz ICON-CH2',
  meteoswiss_icon_seamless: 'MeteoSchweiz ICON (nahtlos)',
  best_match: 'Open-Meteo Best Match',
  'met-no': 'ECMWF über MET Norway',
};

export const SOURCE_LABEL: Record<WeatherSource, string> = {
  'open-meteo': 'Open-Meteo',
  'met-no': 'MET Norway',
};
