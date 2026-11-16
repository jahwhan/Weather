// Kleine Netz-Helfer für alle Datenquellen.

/** Abbruch nach `ms` oder wenn `signal` abbricht. */
export function withTimeout(signal: AbortSignal | undefined, ms: number): AbortSignal {
  const t = AbortSignal.timeout(ms);
  if (!signal) return t;
  return typeof AbortSignal.any === 'function' ? AbortSignal.any([signal, t]) : signal;
}

export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** JSON laden, mit Zeitlimit. Wirft `HttpError` bei HTTP-Fehlern. */
export async function fetchJson<T>(url: string, signal: AbortSignal | undefined, ms: number, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { ...init, signal: withTimeout(signal, ms) });
  if (!res.ok) throw new HttpError(res.status, `HTTP ${res.status} für ${new URL(url).host}`);
  return (await res.json()) as T;
}
