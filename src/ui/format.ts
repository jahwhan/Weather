// Kleine Formatierhilfen für die Wetteranzeige (Schweizer Schreibweise).

export const MINUS = '−';

/** Temperatur gerundet, mit echtem Minuszeichen, ohne Einheit */
export function t0(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return '–';
  const r = Math.round(v);
  return (r === 0 ? 0 : r).toString().replace('-', MINUS);
}

/** Zahl mit einer Nachkommastelle und Komma */
export function n1(v: number): string {
  return (Math.round(v * 10) / 10).toFixed(1).replace('.', ',').replace('-', MINUS);
}

/** Zahl mit bis zu einer Nachkommastelle (ohne ",0") */
export function n1s(v: number): string {
  const s = n1(v);
  return s.endsWith(',0') ? s.slice(0, -2) : s;
}

/** Tausendertrennung nach Schweizer Art (2’650) */
export function thousands(v: number): string {
  return Math.round(v)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, '’');
}

export function localDate(ms: number, offsetSec: number): Date {
  return new Date(ms + offsetSec * 1000);
}

export function hhmm(ms: number, offsetSec: number): string {
  const d = localDate(ms, offsetSec);
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}

export function hourOf(ms: number, offsetSec: number): number {
  return localDate(ms, offsetSec).getUTCHours();
}

export const WEEKDAYS = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];
export const WEEKDAYS_LONG = ['Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag'];

/** beliebiger Zeitwert (ms, s, ISO-String) → ms oder null */
export function toMs(v: unknown): number | null {
  if (v == null) return null;
  if (typeof v === 'number') return v < 1e11 ? v * 1000 : v;
  if (typeof v === 'string') {
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : null;
  }
  if (v instanceof Date) return v.getTime();
  return null;
}

export function formatVisibility(m: number): string {
  if (m >= 20000) return `${Math.round(m / 1000)} km`;
  if (m >= 1000) return `${n1s(m / 1000)} km`;
  return `${Math.round(m / 10) * 10} m`;
}

export function formatDistanceM(m: number): string {
  if (m < 1000) return `${Math.round(m / 10) * 10} m`;
  if (m < 10000) return `${n1s(m / 1000)} km`;
  return `${Math.round(m / 1000)} km`;
}

/** "vor 6 min", "vor 2 h" */
export function ago(ms: number, now = Date.now()): string {
  const min = Math.max(0, Math.round((now - ms) / 60000));
  if (min < 1) return 'gerade eben';
  if (min < 60) return `vor ${min} min`;
  const h = Math.round(min / 60);
  return `vor ${h} h`;
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/** Farbe für eine Temperatur (kalt → warm), für Spannbalken */
export function tempColor(t: number): string {
  const stops: [number, [number, number, number]][] = [
    [-15, [120, 110, 230]],
    [-5, [70, 150, 245]],
    [3, [80, 200, 230]],
    [10, [110, 210, 140]],
    [17, [235, 215, 80]],
    [24, [250, 160, 60]],
    [32, [240, 80, 70]],
  ];
  if (t <= stops[0][0]) return `rgb(${stops[0][1].join(',')})`;
  for (let i = 1; i < stops.length; i++) {
    if (t <= stops[i][0]) {
      const [t0_, a] = stops[i - 1];
      const [t1, b] = stops[i];
      const u = (t - t0_) / (t1 - t0_);
      return `rgb(${a.map((v, k) => Math.round(v + (b[k] - v) * u)).join(',')})`;
    }
  }
  return `rgb(${stops[stops.length - 1][1].join(',')})`;
}
