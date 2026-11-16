// Aktionsprotokoll zwischen Chat-Assistent (n8n oder lokal) und App.

export type ChatMode = 'car' | 'transit' | 'bike' | 'foot' | 'flight';
export const CHAT_MODES: readonly ChatMode[] = ['car', 'transit', 'bike', 'foot', 'flight'];

export const MODE_LABEL: Record<ChatMode, string> = {
  car: 'Auto',
  transit: 'ÖV',
  bike: 'Velo',
  foot: 'zu Fuss',
  flight: 'Flugzeug',
};

/** "mit dem Auto", "zu Fuss" … */
export function modePhrase(m: ChatMode): string {
  return m === 'foot' ? 'zu Fuss' : `mit dem ${MODE_LABEL[m]}`;
}

export type ChatAction =
  | { type: 'flyTo'; place?: string; lat?: number; lon?: number; zoom?: number }
  | { type: 'showPlace'; place: string }
  | { type: 'setRoute'; from: string; to: string; via?: string[]; mode?: ChatMode }
  | { type: 'play' }
  | { type: 'pause' }
  | { type: 'setMode'; mode: ChatMode }
  | { type: 'setTime'; mode?: 'live' | 'travel'; offsetHours?: number }
  | { type: 'showMountain'; peak: string }
  | { type: 'openWeather' }
  | { type: 'compareModes' };

export interface ChatResponse {
  reply: string;
  actions: ChatAction[];
}

export interface AppContext {
  place: string | null;
  route: { from: string; to: string; mode: ChatMode } | null;
  playing: boolean;
  timeMode: 'live' | 'travel';
  offsetHours: number;
  weatherSummary: string | null;
}

const MODE_ALIASES: Record<string, ChatMode> = {
  car: 'car',
  auto: 'car',
  driving: 'car',
  transit: 'transit',
  train: 'transit',
  zug: 'transit',
  oev: 'transit',
  öv: 'transit',
  pt: 'transit',
  bike: 'bike',
  bicycle: 'bike',
  cycling: 'bike',
  velo: 'bike',
  foot: 'foot',
  walk: 'foot',
  walking: 'foot',
  fuss: 'foot',
  flight: 'flight',
  plane: 'flight',
  flug: 'flight',
};

export function toMode(v: unknown): ChatMode | undefined {
  if (typeof v !== 'string') return undefined;
  return MODE_ALIASES[v.trim().toLowerCase()];
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const num = (v: unknown): number | undefined => {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined;
};

/** Eine Aktion prüfen und normalisieren; null = verwerfen. */
export function validateAction(raw: unknown): ChatAction | null {
  if (!raw || typeof raw !== 'object') return null;
  const a = raw as Record<string, unknown>;
  const type = str(a.type) ?? str(a.action) ?? str(a.name);
  switch (type) {
    case 'flyTo': {
      const place = str(a.place);
      const lat = num(a.lat);
      const lon = num(a.lon ?? a.lng);
      const zoom = num(a.zoom);
      const hasCoord = lat != null && lon != null && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;
      if (!place && !hasCoord) return null;
      const out: ChatAction = { type: 'flyTo' };
      if (place) out.place = place;
      if (hasCoord) {
        out.lat = lat;
        out.lon = lon;
      }
      if (zoom != null) out.zoom = Math.max(1, Math.min(18, zoom));
      return out;
    }
    case 'showPlace': {
      const place = str(a.place);
      return place ? { type: 'showPlace', place } : null;
    }
    case 'setRoute': {
      const from = str(a.from);
      const to = str(a.to);
      if (!from || !to) return null;
      const out: ChatAction = { type: 'setRoute', from, to };
      if (Array.isArray(a.via)) {
        const via = a.via.map(str).filter((x): x is string => !!x);
        if (via.length) out.via = via;
      }
      const mode = toMode(a.mode);
      if (mode) out.mode = mode;
      return out;
    }
    case 'play':
    case 'pause':
    case 'openWeather':
    case 'compareModes':
      return { type };
    case 'setMode': {
      const mode = toMode(a.mode);
      return mode ? { type: 'setMode', mode } : null;
    }
    case 'setTime': {
      const out: ChatAction = { type: 'setTime' };
      if (a.mode === 'live' || a.mode === 'travel') out.mode = a.mode;
      const off = num(a.offsetHours);
      if (off != null) out.offsetHours = Math.max(-72, Math.min(240, off));
      if (!out.mode && out.offsetHours == null) return null;
      return out;
    }
    case 'showMountain': {
      const peak = str(a.peak) ?? str(a.place);
      return peak ? { type: 'showMountain', peak } : null;
    }
    default:
      return null;
  }
}

/** JSON aus einem Text holen: rein, in ```-Codeblock oder zwischen den äussersten Klammern. */
function parseJsonText(s: string): unknown | undefined {
  const t = s.trim();
  if (!t) return undefined;
  try {
    return JSON.parse(t);
  } catch {
    /* weiter */
  }
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(t);
  if (fence) {
    try {
      return JSON.parse(fence[1].trim());
    } catch {
      /* weiter */
    }
  }
  const a = t.indexOf('{');
  const b = t.lastIndexOf('}');
  if (a >= 0 && b > a) {
    try {
      return JSON.parse(t.slice(a, b + 1));
    } catch {
      /* weiter */
    }
  }
  return undefined;
}

const WRAPPER_KEYS = ['output', 'text', 'response', 'message', 'data', 'result', 'json', 'body', 'content'];

function unwrap(raw: unknown, depth: number): { reply?: string; actions?: unknown } | string | null {
  if (depth > 6 || raw == null) return null;
  if (typeof raw === 'string') {
    const parsed = parseJsonText(raw);
    if (parsed !== undefined && typeof parsed === 'object' && parsed !== null) return unwrap(parsed, depth + 1) ?? raw;
    return raw;
  }
  if (Array.isArray(raw)) return raw.length ? unwrap(raw[0], depth + 1) : null;
  if (typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if ('reply' in o || 'actions' in o) {
    const reply = typeof o.reply === 'string' ? o.reply : undefined;
    return { reply, actions: o.actions };
  }
  for (const k of WRAPPER_KEYS) if (k in o) return unwrap(o[k], depth + 1);
  return null;
}

/** Tolerant: JSON als String, Markdown-Codeblock, n8n-Hüllen ({output}, {text}, Array) usw. */
export function validateResponse(raw: unknown): ChatResponse {
  const u = unwrap(raw, 0);
  if (u == null) return { reply: '', actions: [] };
  if (typeof u === 'string') return { reply: u.trim(), actions: [] };
  let list: unknown[] = [];
  if (Array.isArray(u.actions)) list = u.actions;
  else if (u.actions && typeof u.actions === 'object') list = [u.actions];
  else if (typeof u.actions === 'string') {
    const p = parseJsonText(u.actions);
    if (Array.isArray(p)) list = p;
  }
  const actions = list.map(validateAction).filter((x): x is ChatAction => !!x).slice(0, 8);
  return { reply: (u.reply ?? '').trim(), actions };
}
