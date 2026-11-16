// Chat-Client: n8n-Webhook, bei Fehlern lokaler Intent-Parser.

import { parseIntent } from './intent.ts';
import { validateResponse, type AppContext, type ChatResponse } from './protocol.ts';

export const ENDPOINT_KEY = 'wetterflug.n8nUrl';
const SESSION_KEY = 'wetterflug.chatSession';
const TIMEOUT_MS = 20000;

export interface AskOptions {
  endpoint: string | null;
  sessionId: string;
  signal?: AbortSignal;
  history?: { role: 'user' | 'assistant'; text: string }[];
  /** nur für Tests */
  fetchImpl?: typeof fetch;
  now?: number;
}

export type AssistantAnswer = ChatResponse & { via: 'n8n' | 'lokal'; error?: string };

function safeStorage(kind: 'local' | 'session'): Storage | null {
  try {
    return kind === 'local' ? globalThis.localStorage ?? null : globalThis.sessionStorage ?? null;
  } catch {
    return null;
  }
}

/** Build-Variable (Vite); in node --test gibt es import.meta.env nicht. */
function envEndpoint(): string | null {
  try {
    const v = import.meta.env?.VITE_N8N_CHAT_URL;
    return typeof v === 'string' && v.trim() ? v.trim() : null;
  } catch {
    return null;
  }
}

export function isValidEndpoint(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || (u.protocol === 'http:' && /^(localhost|127\.0\.0\.1|\[::1\])$/.test(u.hostname));
  } catch {
    return false;
  }
}

/** Gespeicherte URL (Einstellungsfeld) vor Build-Variable. */
export function getEndpoint(): string | null {
  const stored = safeStorage('local')?.getItem(ENDPOINT_KEY)?.trim();
  if (stored && isValidEndpoint(stored)) return stored;
  return envEndpoint();
}

/** Leer/null löscht die gespeicherte URL. Gibt false zurück, wenn die URL ungültig ist. */
export function setEndpoint(url: string | null): boolean {
  const ls = safeStorage('local');
  const v = url?.trim() ?? '';
  if (!v) {
    ls?.removeItem(ENDPOINT_KEY);
    return true;
  }
  if (!isValidEndpoint(v)) return false;
  ls?.setItem(ENDPOINT_KEY, v);
  return true;
}

export function getSessionId(): string {
  const ss = safeStorage('session');
  let id = ss?.getItem(SESSION_KEY) ?? null;
  if (!id) {
    id = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    ss?.setItem(SESSION_KEY, id);
  }
  return id;
}

function combine(signal: AbortSignal | undefined, ms: number): AbortSignal {
  const t = AbortSignal.timeout(ms);
  if (!signal) return t;
  return typeof AbortSignal.any === 'function' ? AbortSignal.any([signal, t]) : signal;
}

export async function askAssistant(text: string, ctx: AppContext, opts: AskOptions): Promise<AssistantAnswer> {
  const local = (error?: string): AssistantAnswer => ({ ...parseIntent(text, ctx, opts.now), via: 'lokal', ...(error ? { error } : {}) });
  if (!opts.endpoint) return local();
  const doFetch = opts.fetchImpl ?? fetch;
  try {
    const res = await doFetch(opts.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ chatInput: text, sessionId: opts.sessionId, context: ctx, history: (opts.history ?? []).slice(-10) }),
      signal: combine(opts.signal, TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`n8n HTTP ${res.status}`);
    const body = await res.text();
    let raw: unknown = body;
    try {
      raw = JSON.parse(body);
    } catch {
      /* Text-Antwort */
    }
    const r = validateResponse(raw);
    if (!r.reply && !r.actions.length) throw new Error('n8n: leere Antwort');
    return { reply: r.reply || 'Erledigt.', actions: r.actions, via: 'n8n' };
  } catch (err) {
    if (opts.signal?.aborted) throw err;
    return local((err as Error)?.message ?? String(err));
  }
}
