// Bergbericht: Gipfel finden, Wetter und Lawinen parallel laden, einschätzen.

import { searchPeak, type Peak } from './peaks.ts';
import { fetchMountainWeather } from './fetch.ts';
import { assessMountain, type MountainReport } from './assess.ts';
import { avalancheDanger } from '../swiss/slf.ts';

export type { Peak } from './peaks.ts';
export type { MountainReport, Verdict } from './assess.ts';
export { findPeak, searchPeak, PEAKS } from './peaks.ts';
export { assessMountain } from './assess.ts';

/** null, wenn kein Gipfel gefunden wurde; wirft, wenn kein Wetter geladen werden kann. */
export async function mountainReport(query: string | Peak, signal?: AbortSignal): Promise<MountainReport | null> {
  const peak = typeof query === 'string' ? await searchPeak(query, signal) : query;
  if (!peak) return null;
  const [weather, avalanche] = await Promise.all([
    fetchMountainWeather(peak, signal),
    avalancheDanger(peak.lat, peak.lon, { elevation: peak.elevation, signal }).catch(() => null),
  ]);
  return assessMountain({ peak, now: Date.now(), hourly: weather.hourly, avalanche, pastKnown: weather.pastKnown });
}
