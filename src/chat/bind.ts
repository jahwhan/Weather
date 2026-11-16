// Verbindet das Chat-Panel mit der App-Steuerung. Wird erst beim ersten Öffnen geladen.

import { mountChat, type ChatController } from './ui.ts';
import type { AppContext, ChatAction } from './protocol.ts';
import { formatDuration, type ModeEstimate } from '../route/modes.ts';
import type { Profile } from '../route/routing.ts';

export interface AppControl {
  loadText(text: string, opts?: { autoplay?: boolean; fly?: boolean }): Promise<void>;
  flyTo(coord: [number, number], zoom?: number): void;
  setProfile(p: Profile): void;
  play(): void;
  pause(): void;
  setTime(mode?: 'live' | 'travel', offsetHours?: number): void;
  openWeather(): void;
  compareModes(): Promise<ModeEstimate[] | null>;
  state(): AppContext;
}

const MODE_NAME: Record<string, string> = { car: 'Auto', transit: 'ÖV', bike: 'Velo', foot: 'Zu Fuss', flight: 'Flug' };

export function modesText(list: ModeEstimate[] | null): string {
  if (!list?.length) return 'Für einen Vergleich brauche ich eine Route, z. B. „Zürich nach Luzern“.';
  return list
    .map((m) => `${MODE_NAME[m.profile] ?? m.profile}: ${m.status === 'ok' && m.duration != null ? formatDuration(m.duration) : 'nicht verfügbar'}`)
    .join(' · ');
}

export function bindChat(root: HTMLElement, app: AppControl): ChatController {
  return mountChat(root, {
    context: () => app.state(),
    async execute(a: ChatAction) {
      switch (a.type) {
        case 'flyTo':
          if (a.lat != null && a.lon != null) app.flyTo([a.lon, a.lat], a.zoom ?? 11);
          else if (a.place) await app.loadText(a.place, { fly: true });
          return;
        case 'showPlace':
          await app.loadText(a.place, { fly: true });
          app.openWeather();
          return;
        case 'setRoute': {
          if (a.mode) app.setProfile(a.mode);
          await app.loadText([a.from, ...(a.via ?? []), a.to].join(' bis '), { fly: true });
          return;
        }
        case 'play':
          app.play();
          return;
        case 'pause':
          app.pause();
          return;
        case 'setMode':
          app.setProfile(a.mode);
          return;
        case 'setTime':
          app.setTime(a.mode ?? (a.offsetHours ? 'travel' : 'live'), a.offsetHours ?? 0);
          return;
        case 'openWeather':
          app.openWeather();
          return;
        case 'compareModes':
          return modesText(await app.compareModes());
        default:
          return;
      }
    },
  });
}
