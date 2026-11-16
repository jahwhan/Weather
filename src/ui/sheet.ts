// Ziehbares Bottom-Sheet mit Rastpunkten (eingeklappt, halb, voll).
// Mobil: Pointer Events, Schwung (Velocity), Feder-Einrasten per CSS-Übergang.
// Desktop (≥ 900 px): festes Seitenpanel; "eingeklappt" zeigt nur die kompakte Zeile.

export type Snap = 'collapsed' | 'half' | 'full';

const DESKTOP = '(min-width: 900px)';

export class BottomSheet {
  readonly el: HTMLElement;
  private grip: HTMLElement;
  private body: HTMLElement;
  private compact: HTMLElement;
  snap: Snap = 'half';
  /** Rückmeldung bei jedem Rastwechsel */
  onSnap: (s: Snap) => void = () => {};
  private y = 0;
  private mq = window.matchMedia(DESKTOP);
  private drag: {
    id: number;
    startY: number;
    startX: number;
    startSheetY: number;
    samples: { t: number; y: number }[];
    decided: boolean;
    vertical: boolean;
    moved: boolean;
    onGrip: boolean;
    onCompact: boolean;
  } | null = null;

  constructor(el: HTMLElement) {
    this.el = el;
    this.grip = el.querySelector('.sheet-grip')!;
    this.body = el.querySelector('.sheet-body')!;
    this.compact = el.querySelector('.sheet-compact')!;

    el.addEventListener('pointerdown', (e) => this.down(e));
    el.addEventListener('pointermove', (e) => this.move(e));
    el.addEventListener('pointerup', (e) => this.up(e));
    el.addEventListener('pointercancel', (e) => this.up(e, true));
    this.grip.addEventListener('click', (e) => {
      // Tastatur (Enter/Leertaste); Tippen ohne Ziehen erledigt up()
      if ((e as MouseEvent).detail === 0 || this.isDesktop()) this.cycle();
    });
    this.grip.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        this.setSnap(this.snap === 'collapsed' ? 'half' : 'full');
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        this.setSnap(this.snap === 'full' ? 'half' : 'collapsed');
      }
    });
    window.addEventListener('resize', () => this.layout(false));
    this.mq.addEventListener?.('change', () => this.layout(false));
    new ResizeObserver(() => this.layout(false)).observe(this.compact);
    this.layout(false);
  }


  isDesktop(): boolean {
    return this.mq.matches;
  }

  /** sichtbare Höhe je Rastpunkt (mobil) */
  private heights(): Record<Snap, number> {
    const H = this.el.offsetHeight || window.innerHeight * 0.9;
    const vh = window.innerHeight;
    const compactH = Math.max(96, this.compact.offsetHeight + 6);
    return {
      collapsed: Math.min(H, compactH + safeBottom()),
      half: Math.min(H, Math.max(compactH + 160, Math.round(vh * 0.52))),
      full: H,
    };
  }

  private yFor(s: Snap): number {
    const H = this.el.offsetHeight || window.innerHeight * 0.9;
    return H - this.heights()[s];
  }

  setSnap(s: Snap, animate = true): void {
    const changed = s !== this.snap;
    this.snap = s;
    this.layout(animate);
    if (changed) this.onSnap(s);
  }

  cycle(): void {
    this.setSnap(this.snap === 'collapsed' ? 'half' : this.snap === 'half' ? 'full' : 'collapsed');
  }

  private layout(animate: boolean): void {
    const el = this.el;
    el.dataset.snap = this.snap;
    document.body.classList.toggle('sheet-full', this.snap === 'full' && !this.isDesktop());
    document.body.classList.toggle('sheet-half', this.snap === 'half' && !this.isDesktop());
    document.body.classList.toggle('sheet-collapsed', this.snap === 'collapsed');
    if (this.isDesktop()) {
      el.style.removeProperty('--sheet-y');
      el.style.setProperty('--open', this.snap === 'collapsed' ? '0' : '1');
      document.documentElement.style.setProperty('--sheet-visible', '0px');
      return;
    }
    if (!animate) el.classList.add('is-dragging');
    this.applyY(this.yFor(this.snap));
    if (this.snap !== 'full') this.body.scrollTop = 0;
    if (!animate) {
      void el.offsetHeight;
      el.classList.remove('is-dragging');
    }
  }

  private applyY(y: number): void {
    const H = this.el.offsetHeight || 1;
    const h = this.heights();
    this.y = y;
    const visible = H - y;
    this.el.style.setProperty('--sheet-y', `${Math.round(y)}px`);
    const open = Math.max(0, Math.min(1, (visible - h.collapsed) / Math.max(1, h.half - h.collapsed)));
    this.el.style.setProperty('--open', open.toFixed(3));
    // Abspielknopf und Profil-Leiste folgen dem Sheet (nur bis zur halben Höhe)
    document.documentElement.style.setProperty('--sheet-visible', `${Math.round(Math.min(visible, h.half))}px`);
  }

  // ------------------------------------------------------------ Ziehen

  private down(e: PointerEvent): void {
    if (this.isDesktop() || e.button > 0) return;
    const t = e.target as HTMLElement;
    const inBody = this.body.contains(t);
    // im vollen Zustand scrollt der Inhalt nativ; ziehen nur über Griff/Kopf
    if (inBody && this.snap === 'full') return;
    if (t.closest('input, select, textarea')) return;
    this.drag = {
      id: e.pointerId,
      startY: e.clientY,
      startX: e.clientX,
      startSheetY: this.y,
      samples: [{ t: e.timeStamp, y: e.clientY }],
      decided: false,
      vertical: false,
      moved: false,
      onGrip: !!t.closest('.sheet-grip'),
      onCompact: this.compact.contains(t),
    };
    // Griff und Kopf gleich einfangen: auch wenn der Zeiger das Sheet verlässt, gehören die Bewegungen dazu.
    // (Im Inhalt erst beim Ziehen, sonst kämen Klicks auf Knöpfe nicht mehr an.)
    if (this.drag.onGrip || this.drag.onCompact) {
      try {
        this.el.setPointerCapture(e.pointerId);
      } catch {
        /* egal */
      }
    }
  }

  private move(e: PointerEvent): void {
    const d = this.drag;
    if (!d || e.pointerId !== d.id) return;
    const dy = e.clientY - d.startY;
    const dx = e.clientX - d.startX;
    if (!d.decided) {
      if (Math.abs(dy) < 6 && Math.abs(dx) < 6) return;
      d.decided = true;
      d.vertical = Math.abs(dy) > Math.abs(dx);
      if (!d.vertical) {
        this.drag = null; // horizontales Wischen (Stundenleiste) dem Browser überlassen
        if (this.el.hasPointerCapture(e.pointerId)) this.el.releasePointerCapture(e.pointerId);
        return;
      }
      if (!this.el.hasPointerCapture(e.pointerId)) this.el.setPointerCapture(e.pointerId);
      this.el.classList.add('is-dragging');
    }
    d.moved = true;
    const H = this.el.offsetHeight;
    const minY = this.yFor('full');
    const maxY = this.yFor('collapsed');
    let y = d.startSheetY + dy;
    // Gummiband an den Enden
    if (y < minY) y = minY - rubber(minY - y);
    if (y > maxY) y = maxY + rubber(y - maxY);
    y = Math.max(-40, Math.min(H, y));
    this.applyY(y);
    d.samples.push({ t: e.timeStamp, y: e.clientY });
    if (d.samples.length > 6) d.samples.shift();
  }

  private up(e: PointerEvent, cancel = false): void {
    const d = this.drag;
    if (!d || e.pointerId !== d.id) return;
    this.drag = null;
    if (!d.moved) {
      if (d.onGrip && !cancel) this.cycle();
      else if (!cancel && this.snap === 'collapsed' && d.onCompact) this.setSnap('half');
      return;
    }
    this.el.classList.remove('is-dragging');
    // Geschwindigkeit in px/ms aus den letzten Punkten
    const s = d.samples;
    let v = 0;
    if (s.length >= 2) {
      const a = s[0];
      const b = s[s.length - 1];
      v = (b.y - a.y) / Math.max(1, b.t - a.t);
    }
    if (cancel) v = 0;
    const projected = this.y + v * 220;
    const opts: Snap[] = ['full', 'half', 'collapsed'];
    let best: Snap = this.snap;
    let bd = Infinity;
    for (const o of opts) {
      const dd = Math.abs(this.yFor(o) - projected);
      if (dd < bd) {
        bd = dd;
        best = o;
      }
    }
    // schnelles Wischen überspringt höchstens einen Rastpunkt
    if (Math.abs(v) > 0.5) {
      const order: Snap[] = ['collapsed', 'half', 'full'];
      const cur = order.indexOf(this.snapAt(d.startSheetY));
      const dir = v < 0 ? 1 : -1;
      const idx = order.indexOf(best);
      if (Math.abs(idx - cur) > 1 && Math.abs(v) < 1.6) best = order[cur + dir];
    }
    this.setSnap(best);
    if (best === this.snap) this.layout(true);
  }

  private snapAt(y: number): Snap {
    let best: Snap = 'half';
    let bd = Infinity;
    for (const o of ['full', 'half', 'collapsed'] as Snap[]) {
      const d = Math.abs(this.yFor(o) - y);
      if (d < bd) {
        bd = d;
        best = o;
      }
    }
    return best;
  }
}

function rubber(over: number): number {
  return 40 * (1 - Math.exp(-over / 120));
}

function safeBottom(): number {
  const v = getComputedStyle(document.documentElement).getPropertyValue('--safe-bottom');
  return parseFloat(v) || 0;
}
