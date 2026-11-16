// Bergbericht als Glas-Karte.

import './mountain.css';
import type { MountainReport } from './assess.ts';

const SVG = (body: string) =>
  `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

const ICON = {
  ok: SVG('<circle cx="12" cy="12" r="9"/><path d="m8 12.5 2.6 2.6L16 9.5"/>'),
  warn: SVG('<path d="M12 3.5 21.5 20h-19z"/><path d="M12 10v4.5"/><circle cx="12" cy="17.3" r=".6" fill="currentColor"/>'),
  bad: SVG('<circle cx="12" cy="12" r="9"/><path d="m9 9 6 6M15 9l-6 6"/>'),
  peak: SVG('<path d="m3 20 6.5-11 3.5 5.5 2.5-3.5L21 20z"/><path d="m8 11.5 1.5 1 1.5-1"/>'),
  clock: SVG('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'),
};

const VERDICT_LABEL: Record<MountainReport['verdict'], string> = {
  gut: 'Gut',
  bedingt: 'Bedingt',
  abraten: 'Abraten',
};

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

export function renderMountainCard(r: MountainReport): HTMLElement {
  const card = el('article', `mtn-card mtn-${r.verdict}`);
  card.setAttribute('aria-label', `Bergwetter ${r.peak.name}: ${VERDICT_LABEL[r.verdict]}`);

  const head = el('header', 'mtn-head');
  const title = el('div', 'mtn-title');
  const icon = el('span', 'mtn-peak-icon');
  icon.innerHTML = ICON.peak;
  const name = el('div', 'mtn-name');
  name.append(el('strong', undefined, r.peak.name), el('span', 'mtn-elev', `${r.peak.elevation} m`));
  title.append(icon, name);
  const badge = el('span', 'mtn-badge');
  badge.append(el('span', 'mtn-dot'), document.createTextNode(VERDICT_LABEL[r.verdict]));
  head.append(title, badge);

  const headline = el('p', 'mtn-headline', r.headline);
  const summary = el('p', 'mtn-summary', r.summary);

  const list = el('ul', 'mtn-reasons');
  for (const reason of r.reasons) {
    const li = el('li', `mtn-reason mtn-${reason.kind}`);
    const ic = el('span', 'mtn-ricon');
    ic.innerHTML = ICON[reason.kind];
    li.append(ic, el('span', undefined, reason.text));
    list.append(li);
  }

  const facts = el('dl', 'mtn-facts');
  for (const f of r.facts) {
    const d = el('div', 'mtn-fact');
    d.append(el('dt', undefined, f.label), el('dd', undefined, f.value));
    facts.append(d);
  }

  card.append(head, headline, summary);
  if (r.bestWindow) {
    const w = el('div', 'mtn-window');
    const ic = el('span', 'mtn-ricon');
    ic.innerHTML = ICON.clock;
    w.append(ic, el('span', undefined, 'Bestes Zeitfenster: '), el('strong', undefined, r.bestWindow.label));
    card.append(w);
  }
  card.append(list, facts, el('p', 'mtn-disclaimer', r.disclaimer));
  return card;
}
