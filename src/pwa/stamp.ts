// Antworten, die der Service Worker offline aus dem Cache liefert, tragen den Zeitpunkt
// der ursprünglichen Abfrage. Damit zeigt die App „Stand 14:20“ statt der aktuellen Uhrzeit.

import { CACHED_AT_HEADER, parseCachedAt } from './rules.ts';

/** Zeitpunkt (ms), zu dem der SW die Antwort gespeichert hat; null = frisch aus dem Netz. */
export function cachedAt(res: Response): number | null {
  return parseCachedAt(res.headers?.get?.(CACHED_AT_HEADER));
}

/** `fetchedAt` auf den Speicherzeitpunkt zurücksetzen, wenn die Antwort aus dem SW-Cache kam. */
export function stampCached<T extends { fetchedAt: number }>(d: T, res: Response): T {
  const t = cachedAt(res);
  if (t != null && t < d.fetchedAt) d.fetchedAt = t;
  return d;
}
