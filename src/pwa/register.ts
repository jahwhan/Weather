// PWA im Browser: Service Worker registrieren, Update-Hinweis, Installationshinweis,
// Offline-Hinweis mit dem Stand der zuletzt gespeicherten Wetterdaten.

import './pwa.css';
import { uiIcon } from '../ui/icons';
import { PROBE_PARAM } from './rules';

const INSTALL_KEY = 'wetterflug.install.v1';
/** von main.ts geschrieben: letzter Ort mit Wetter (detail.fetchedAt = Zeitpunkt der Abfrage) */
const SNAP_KEY = 'wetterflug.snapshot.v1';

let refreshFn: (() => void) | null = null;

export interface PwaOptions {
  /** Daten neu laden, wenn die Verbindung zurück ist */
  refresh?: () => void;
}

export function initPwa(opts: PwaOptions = {}): void {
  refreshFn = opts.refresh ?? null;
  document.documentElement.classList.toggle('pwa-standalone', isStandalone());
  setupOffline();
  setupInstallHint();
  if (import.meta.env.PROD && 'serviceWorker' in navigator) {
    afterLoadIdle(() => void registerSw());
  }
}

// ------------------------------------------------------------ Hilfen

export function isStandalone(): boolean {
  return (
    window.matchMedia?.('(display-mode: standalone)').matches ||
    window.matchMedia?.('(display-mode: fullscreen)').matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

function isIos(): boolean {
  const ua = navigator.userAgent;
  return /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
}

function afterLoadIdle(fn: () => void): void {
  const idle = () => {
    const ric = (window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }).requestIdleCallback;
    if (ric) ric(fn, { timeout: 5000 });
    else setTimeout(fn, 1500);
  };
  if (document.readyState === 'complete') idle();
  else window.addEventListener('load', idle, { once: true });
}

function readSnapshotTime(): number | null {
  try {
    const raw = localStorage.getItem(SNAP_KEY);
    if (!raw) return null;
    const t = (JSON.parse(raw) as { detail?: { fetchedAt?: number } }).detail?.fetchedAt;
    return typeof t === 'number' && Number.isFinite(t) ? t : null;
  } catch {
    return null;
  }
}

/** „14:20“ für heute, sonst „16.11., 14:20“ (Ortszeit des Geräts). */
export function standText(t: number, now = Date.now()): string {
  const d = new Date(t);
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const n = new Date(now);
  const sameDay = d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate();
  return sameDay ? hm : `${d.getDate()}.${d.getMonth() + 1}., ${hm}`;
}

function notices(): HTMLElement {
  return document.getElementById('notices') ?? document.body;
}

const CLOSE_BTN = (label: string) =>
  `<button type="button" class="pwa-close" data-pwa="close" aria-label="${label}">${uiIcon('close')}</button>`;

function makeNote(id: string, cls: string, html: string, role: 'status' | 'note' = 'note'): HTMLElement {
  let el = document.getElementById(id);
  if (!el) {
    el = document.createElement('div');
    el.id = id;
    notices().prepend(el);
  }
  el.className = `glass pwa-note ${cls}`;
  el.setAttribute('role', role);
  if (role === 'status') el.setAttribute('aria-live', 'polite');
  el.innerHTML = html;
  el.hidden = false;
  return el;
}

// ------------------------------------------------------------ Offline

let offlineShown = false;
let probeTimer = 0;

function setupOffline(): void {
  window.addEventListener('offline', () => showOffline());
  window.addEventListener('online', () => backOnline());
  if (navigator.onLine === false) showOffline();
}

function showOffline(): void {
  const t = readSnapshotTime();
  const text = t ? `Offline – Stand ${standText(t)}` : 'Offline – keine gespeicherten Wetterdaten';
  const el = makeNote(
    'pwaOffline',
    'is-offline',
    `<span class="pwa-icon" aria-hidden="true">${OFFLINE_ICON}</span><span class="pwa-text">${text}</span>`,
    'status',
  );
  el.title = 'Ohne Internetverbindung. Sobald sie zurück ist, wird aktualisiert.';
  // eine Fehlermeldung „Laden fehlgeschlagen“ wäre jetzt doppelt
  const status = document.getElementById('status');
  if (status?.classList.contains('is-error')) status.hidden = true;
  offlineShown = true;
  // navigator.onLine lügt manchmal: regelmässig selbst nachsehen
  clearInterval(probeTimer);
  probeTimer = window.setInterval(async () => {
    if (navigator.onLine !== false && (await probe())) backOnline();
  }, 20000);
}

function backOnline(): void {
  clearInterval(probeTimer);
  const el = document.getElementById('pwaOffline');
  if (el) el.hidden = true;
  if (!offlineShown) return;
  offlineShown = false;
  refreshFn?.();
}

/** Kurzer Test, ob das Netz wirklich erreichbar ist (am Service Worker vorbei). */
async function probe(): Promise<boolean> {
  try {
    const url = new URL('manifest.webmanifest', document.baseURI);
    url.searchParams.set(PROBE_PARAM, String(Date.now()));
    const res = await fetch(url, { method: 'HEAD', cache: 'no-store', signal: AbortSignal.timeout(4000) });
    return res.status > 0;
  } catch {
    return false;
  }
}

/**
 * Eine Abfrage ist fehlgeschlagen: wenn das Netz weg ist, den Offline-Hinweis zeigen.
 * Kann gefahrlos oft aufgerufen werden. Gibt true zurück, wenn sicher offline – dann
 * braucht es keine eigene Fehlermeldung mehr (der Offline-Hinweis sagt schon alles).
 */
export function netFailed(): boolean {
  if (offlineShown) return true;
  if (navigator.onLine === false) {
    showOffline();
    return true;
  }
  void probe().then((ok) => {
    if (!ok && !offlineShown) showOffline();
  });
  return false;
}

const OFFLINE_ICON =
  '<svg class="ui-icon" viewBox="0 0 24 24"><path d="M7 17.5a4.5 4.5 0 0 1-.4-9 5.5 5.5 0 0 1 9.6-1.6M18.6 9.6a3.9 3.9 0 0 1-1.1 7.9H11"/><path d="M4 4l16 16"/></svg>';

// ------------------------------------------------------------ Update

let userAskedUpdate = false;

async function registerSw(): Promise<void> {
  let reg: ServiceWorkerRegistration;
  try {
    reg = await navigator.serviceWorker.register('./sw.js', { scope: './', updateViaCache: 'none' });
  } catch (err) {
    console.warn('Service Worker nicht registriert:', err);
    return;
  }
  const watch = (w: ServiceWorker | null) => {
    w?.addEventListener('statechange', () => {
      if (w.state === 'installed' && navigator.serviceWorker.controller) showUpdate(reg);
    });
  };
  if (reg.waiting && navigator.serviceWorker.controller) showUpdate(reg);
  watch(reg.installing);
  reg.addEventListener('updatefound', () => watch(reg.installing));

  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    // nur neu laden, wenn der Nutzer „Aktualisieren“ gewählt hat (nicht bei der Erstinstallation)
    if (!userAskedUpdate || reloading) return;
    reloading = true;
    location.reload();
  });

  // regelmässig nach einer neuen Version sehen
  let lastCheck = Date.now();
  const check = () => {
    if (Date.now() - lastCheck < 5 * 60e3 || navigator.onLine === false) return;
    lastCheck = Date.now();
    reg.update().catch(() => {});
  };
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') check();
  });
  setInterval(check, 60 * 60e3);
}

function showUpdate(reg: ServiceWorkerRegistration): void {
  const el = makeNote(
    'pwaUpdate',
    'is-update',
    `<span class="pwa-icon" aria-hidden="true">${uiIcon('sparkle')}</span>
     <span class="pwa-text">Neue Version verfügbar</span>
     <button type="button" class="pwa-btn" data-pwa="update">${uiIcon('refresh')}Aktualisieren</button>
     ${CLOSE_BTN('Hinweis schliessen')}`,
  );
  el.onclick = (e) => {
    const a = (e.target as HTMLElement).closest<HTMLElement>('[data-pwa]')?.dataset.pwa;
    if (a === 'close') el.hidden = true;
    if (a === 'update') {
      const w = reg.waiting;
      if (!w) {
        location.reload();
        return;
      }
      userAskedUpdate = true;
      el.querySelector<HTMLButtonElement>('[data-pwa="update"]')!.disabled = true;
      w.postMessage({ type: 'SKIP_WAITING' });
    }
  };
}

// ------------------------------------------------------------ Installationshinweis

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

function installSeen(): boolean {
  try {
    return localStorage.getItem(INSTALL_KEY) != null;
  } catch {
    return true;
  }
}
function markInstallSeen(v: string): void {
  try {
    localStorage.setItem(INSTALL_KEY, v);
  } catch {
    /* gesperrt */
  }
}

function setupInstallHint(): void {
  let deferred: BeforeInstallPromptEvent | null = null;
  window.addEventListener('beforeinstallprompt', (e) => {
    // eigener, dezenter Hinweis statt der Browser-Leiste
    e.preventDefault();
    deferred = e as BeforeInstallPromptEvent;
  });
  window.addEventListener('appinstalled', () => {
    markInstallSeen('installed');
    document.getElementById('pwaInstall')?.remove();
  });
  if (isStandalone() || installSeen()) return;

  // nicht gleich beim Start: nach der ersten Interaktion (+ kurz warten) oder nach 20 s
  let timer = 0;
  let waits = 0;
  const arm = (ms: number) => {
    clearTimeout(timer);
    timer = window.setTimeout(tryShow, ms);
  };
  const onFirst = () => arm(4000);
  window.addEventListener('pointerdown', onFirst, { once: true, capture: true });
  window.addEventListener('keydown', onFirst, { once: true, capture: true });
  arm(20000);

  function tryShow(): void {
    if (isStandalone() || installSeen()) return;
    // Einführungshinweis oder Fehlermeldung zuerst fertig lesen lassen (höchstens dreimal warten)
    const hintOpen = document.getElementById('hint')?.hidden === false;
    const status = document.getElementById('status');
    const errOpen = !!status && !status.hidden && status.classList.contains('is-error');
    if ((hintOpen || errOpen) && waits++ < 3) return arm(10000);
    if (deferred) showAndroid(deferred);
    else if (isIos()) showIos();
    // sonst: Browser kann (noch) nicht installieren – vielleicht kommt beforeinstallprompt später
    else window.addEventListener('beforeinstallprompt', () => setTimeout(tryShow, 500), { once: true });
  }

  function showAndroid(ev: BeforeInstallPromptEvent): void {
    markInstallSeen('shown');
    const el = makeNote(
      'pwaInstall',
      'is-install',
      `<img class="pwa-app-icon" src="icons/icon-192.png" alt="" width="36" height="36" />
       <span class="pwa-text">Wetterflug als App auf dem Home-Bildschirm</span>
       <button type="button" class="pwa-btn" data-pwa="install">Installieren</button>
       ${CLOSE_BTN('Installationshinweis schliessen')}`,
    );
    el.onclick = async (e) => {
      const a = (e.target as HTMLElement).closest<HTMLElement>('[data-pwa]')?.dataset.pwa;
      if (a === 'close') el.remove();
      if (a === 'install') {
        el.remove();
        try {
          await ev.prompt();
          const c = await ev.userChoice;
          if (c.outcome === 'accepted') markInstallSeen('installed');
        } catch {
          /* schon benutzt */
        }
      }
    };
  }

  function showIos(): void {
    markInstallSeen('shown');
    const el = makeNote(
      'pwaInstall',
      'is-install',
      `<img class="pwa-app-icon" src="icons/icon-192.png" alt="" width="36" height="36" />
       <span class="pwa-text">Als App installieren: Teilen-Symbol <span class="pwa-share" aria-label="Teilen">${SHARE_ICON}</span> antippen → <b>Zum Home-Bildschirm</b></span>
       ${CLOSE_BTN('Installationshinweis schliessen')}`,
    );
    el.onclick = (e) => {
      if ((e.target as HTMLElement).closest('[data-pwa="close"]')) el.remove();
    };
  }
}

const SHARE_ICON =
  '<svg class="ui-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.5v11M8.2 7.2 12 3.5l3.8 3.7"/><path d="M8 10.5H6.5a1.5 1.5 0 0 0-1.5 1.5v7a1.5 1.5 0 0 0 1.5 1.5h11a1.5 1.5 0 0 0 1.5-1.5v-7a1.5 1.5 0 0 0-1.5-1.5H16"/></svg>';
