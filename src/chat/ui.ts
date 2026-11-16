// Chat-Panel („Liquid Glass“): Nachrichten, Vorschläge, Eingabe, n8n-Einstellung.

import './chat.css';
import { askAssistant, getEndpoint, getSessionId, isValidEndpoint, setEndpoint } from './client.ts';
import { EXAMPLES } from './intent.ts';
import type { AppContext, ChatAction } from './protocol.ts';
import { mountainReport } from '../mountain/index.ts';
import { renderMountainCard } from '../mountain/card.ts';
import type { MountainReport } from '../mountain/assess.ts';

export interface ChatHost {
  execute(action: ChatAction): Promise<string | void>;
  context(): AppContext;
  showMountain?(r: MountainReport): void;
}

export interface ChatController {
  open(): void;
  close(): void;
  toggle(): void;
  isOpen(): boolean;
  send(text: string): Promise<void>;
}

const SVG = (body: string, size = 18) =>
  `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
const ICON = {
  close: SVG('<path d="M6 6l12 12M18 6 6 18"/>'),
  send: SVG('<path d="M12 19V5"/><path d="m5.5 11.5 6.5-6.5 6.5 6.5"/>'),
  gear: SVG('<circle cx="12" cy="12" r="3"/><path d="M12 2.8v2.4M12 18.8v2.4M4.2 7.5l2 1.2M17.8 15.3l2 1.2M4.2 16.5l2-1.2M17.8 8.7l2-1.2"/>'),
  spark: SVG('<path d="M12 3.5c.6 3.9 2.6 5.9 6.5 6.5-3.9.6-5.9 2.6-6.5 6.5-.6-3.9-2.6-5.9-6.5-6.5 3.9-.6 5.9-2.6 6.5-6.5z"/><path d="M19 15.5c.3 1.6 1 2.3 2.5 2.5-1.5.3-2.2 1-2.5 2.5-.3-1.5-1-2.2-2.5-2.5 1.5-.2 2.2-.9 2.5-2.5z"/>', 16),
};

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

export function mountChat(root: HTMLElement, host: ChatHost): ChatController {
  const panel = el('section', 'chat-panel');
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', 'Wetterflug-Assistent');
  panel.hidden = true;

  // Kopf
  const head = el('header', 'chat-head');
  const titleBox = el('div', 'chat-titlebox');
  const avatar = el('span', 'chat-avatar');
  avatar.innerHTML = ICON.spark;
  const titles = el('div', 'chat-titles');
  const title = el('strong', 'chat-title', 'Assistent');
  const status = el('span', 'chat-status');
  const statusDot = el('span', 'chat-status-dot');
  const statusText = el('span', undefined, '');
  status.append(statusDot, statusText);
  titles.append(title, status);
  titleBox.append(avatar, titles);
  const gearBtn = el('button', 'chat-icon-btn');
  gearBtn.type = 'button';
  gearBtn.innerHTML = ICON.gear;
  gearBtn.setAttribute('aria-label', 'Einstellungen');
  gearBtn.setAttribute('aria-expanded', 'false');
  const closeBtn = el('button', 'chat-icon-btn');
  closeBtn.type = 'button';
  closeBtn.innerHTML = ICON.close;
  closeBtn.setAttribute('aria-label', 'Chat schliessen');
  const headBtns = el('div', 'chat-head-btns');
  headBtns.append(gearBtn, closeBtn);
  head.append(titleBox, headBtns);

  // Einstellungen
  const settings = el('form', 'chat-settings');
  settings.hidden = true;
  const settingsId = `chat-n8n-${Math.random().toString(36).slice(2, 8)}`;
  const label = el('label', 'chat-settings-label', 'n8n-Webhook-URL');
  label.htmlFor = settingsId;
  const urlInput = el('input', 'chat-settings-input');
  urlInput.id = settingsId;
  urlInput.type = 'url';
  urlInput.placeholder = 'https://…/webhook/wetterflug-chat';
  urlInput.autocomplete = 'off';
  urlInput.spellcheck = false;
  const settingsRow = el('div', 'chat-settings-row');
  const saveBtn = el('button', 'chat-pill chat-pill-accent', 'Speichern');
  saveBtn.type = 'submit';
  const clearBtn = el('button', 'chat-pill', 'Lokal verwenden');
  clearBtn.type = 'button';
  settingsRow.append(saveBtn, clearBtn);
  const settingsHint = el('p', 'chat-settings-hint', 'Ohne URL antwortet der lokale Assistent direkt im Browser.');
  settings.append(label, urlInput, settingsRow, settingsHint);

  // Nachrichten
  const log = el('div', 'chat-log');
  log.setAttribute('role', 'log');
  log.setAttribute('aria-live', 'polite');
  log.setAttribute('aria-relevant', 'additions');

  const chips = el('div', 'chat-chips');
  for (const ex of EXAMPLES) {
    const c = el('button', 'chat-chip', ex);
    c.type = 'button';
    c.addEventListener('click', () => void send(ex));
    chips.append(c);
  }

  // Eingabe
  const form = el('form', 'chat-form');
  const input = el('input', 'chat-input');
  input.type = 'text';
  input.placeholder = 'Frag mich etwas …';
  input.setAttribute('aria-label', 'Nachricht');
  input.autocomplete = 'off';
  input.enterKeyHint = 'send';
  const sendBtn = el('button', 'chat-send');
  sendBtn.type = 'submit';
  sendBtn.innerHTML = ICON.send;
  sendBtn.setAttribute('aria-label', 'Senden');
  form.append(input, sendBtn);

  panel.append(head, settings, log, chips, form);
  root.append(panel);

  // ---------- Zustand ----------
  const history: { role: 'user' | 'assistant'; text: string }[] = [];
  let busy = false;
  let lastError: string | null = null;
  let controller: AbortController | null = null;

  function updateStatus(): void {
    const ep = getEndpoint();
    const connected = !!ep && !lastError;
    panel.classList.toggle('chat-remote', connected);
    panel.classList.toggle('chat-degraded', !!ep && !!lastError);
    statusText.textContent = !ep ? 'Lokaler Assistent' : lastError ? 'n8n nicht erreichbar – lokal' : 'n8n verbunden';
  }

  function scroll(): void {
    log.scrollTop = log.scrollHeight;
  }

  function bubble(role: 'user' | 'assistant' | 'note', text: string): HTMLElement {
    const b = el('div', `chat-msg chat-${role}`);
    b.textContent = text;
    log.append(b);
    scroll();
    return b;
  }

  function typing(): HTMLElement {
    const t = el('div', 'chat-msg chat-assistant chat-typing');
    t.setAttribute('aria-label', 'Assistent schreibt');
    t.append(el('span'), el('span'), el('span'));
    log.append(t);
    scroll();
    return t;
  }

  async function runMountain(peakName: string, signal: AbortSignal): Promise<void> {
    const t = typing();
    try {
      const r = await mountainReport(peakName, signal);
      t.remove();
      if (!r) {
        bubble('note', `Den Gipfel „${peakName}“ habe ich nicht gefunden.`);
        return;
      }
      const wrap = el('div', 'chat-msg chat-card');
      wrap.append(renderMountainCard(r));
      log.append(wrap);
      scroll();
      host.showMountain?.(r);
      await host.execute({ type: 'flyTo', place: r.peak.name, lat: r.peak.lat, lon: r.peak.lon, zoom: 12 }).catch(() => undefined);
    } catch (err) {
      t.remove();
      if (signal.aborted) return;
      bubble('note', 'Das Bergwetter konnte gerade nicht geladen werden. Bitte versuch es später nochmals.');
      console.warn('Bergwetter', err);
    }
  }

  async function runActions(actions: ChatAction[], signal: AbortSignal): Promise<void> {
    for (const a of actions) {
      if (signal.aborted) return;
      if (a.type === 'showMountain') {
        await runMountain(a.peak, signal);
        continue;
      }
      try {
        const note = await host.execute(a);
        if (typeof note === 'string' && note.trim()) bubble('note', note.trim());
      } catch (err) {
        bubble('note', `Das hat nicht geklappt: ${(err as Error)?.message ?? err}`);
      }
    }
  }

  async function send(text: string): Promise<void> {
    const msg = text.trim();
    if (!msg) return;
    if (!isOpen()) open();
    controller?.abort();
    controller = new AbortController();
    const { signal } = controller;
    chips.hidden = true;
    bubble('user', msg);
    input.value = '';
    busy = true;
    panel.classList.add('chat-busy');
    const t = typing();
    try {
      const ans = await askAssistant(msg, host.context(), {
        endpoint: getEndpoint(),
        sessionId: getSessionId(),
        signal,
        history: history.slice(-10),
      });
      lastError = ans.via === 'lokal' && getEndpoint() ? (ans.error ?? 'Fehler') : null;
      updateStatus();
      t.remove();
      history.push({ role: 'user', text: msg }, { role: 'assistant', text: ans.reply });
      if (ans.reply) bubble('assistant', ans.reply);
      await runActions(ans.actions, signal);
    } catch (err) {
      t.remove();
      if (!signal.aborted) bubble('note', `Fehler: ${(err as Error)?.message ?? err}`);
    } finally {
      if (controller?.signal === signal) {
        busy = false;
        panel.classList.remove('chat-busy');
      }
    }
  }

  // ---------- Öffnen/Schliessen ----------
  let lastFocus: Element | null = null;
  function isOpen(): boolean {
    return !panel.hidden;
  }
  function open(): void {
    if (isOpen()) return;
    lastFocus = document.activeElement;
    panel.hidden = false;
    requestAnimationFrame(() => panel.classList.add('chat-open'));
    if (!log.childElementCount) {
      bubble('assistant', 'Hoi! Ich zeige dir Orte, Routen und das Wetter – und sage dir, ob es am Berg passt. Was möchtest du wissen?');
    }
    updateStatus();
    setTimeout(() => input.focus({ preventScroll: true }), 50);
  }
  function close(): void {
    if (!isOpen()) return;
    panel.classList.remove('chat-open');
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
    setTimeout(() => {
      if (!panel.classList.contains('chat-open')) panel.hidden = true;
    }, reduce ? 0 : 260);
    if (lastFocus instanceof HTMLElement) lastFocus.focus({ preventScroll: true });
  }
  function toggle(): void {
    if (isOpen()) close();
    else open();
  }

  // ---------- Ereignisse ----------
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (busy && !input.value.trim()) return;
    void send(input.value);
  });
  closeBtn.addEventListener('click', close);
  panel.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      if (!settings.hidden) {
        settings.hidden = true;
        gearBtn.setAttribute('aria-expanded', 'false');
        input.focus();
      } else close();
    }
  });
  gearBtn.addEventListener('click', () => {
    settings.hidden = !settings.hidden;
    gearBtn.setAttribute('aria-expanded', String(!settings.hidden));
    if (!settings.hidden) {
      urlInput.value = localStorageUrl() ?? '';
      urlInput.focus();
    }
  });
  settings.addEventListener('submit', (e) => {
    e.preventDefault();
    const v = urlInput.value.trim();
    if (v && !isValidEndpoint(v)) {
      settingsHint.textContent = 'Bitte eine gültige https-URL eingeben.';
      urlInput.setAttribute('aria-invalid', 'true');
      return;
    }
    urlInput.removeAttribute('aria-invalid');
    setEndpoint(v || null);
    lastError = null;
    settingsHint.textContent = v ? 'Gespeichert – Fragen gehen jetzt an n8n.' : 'Ohne URL antwortet der lokale Assistent direkt im Browser.';
    updateStatus();
  });
  clearBtn.addEventListener('click', () => {
    urlInput.value = '';
    setEndpoint(null);
    lastError = null;
    settingsHint.textContent = getEndpoint()
      ? 'Eigene URL entfernt – es gilt die URL aus dem Build.'
      : 'Ohne URL antwortet der lokale Assistent direkt im Browser.';
    updateStatus();
  });

  function localStorageUrl(): string | null {
    try {
      return localStorage.getItem('wetterflug.n8nUrl');
    } catch {
      return null;
    }
  }

  updateStatus();
  return { open, close, toggle, isOpen, send };
}
