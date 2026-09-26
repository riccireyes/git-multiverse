import type { Histogram } from './model';

const DAY = 86400000;

export interface TimeBarEvents {
  /** Drag-selected a new timeframe [a, b]. */
  select(a: number, b: number): void;
  /** Clicked a date. */
  jump(date: number): void;
  /** Dragged the view bracket by `delta` ms. */
  pan(delta: number): void;
  /** Resized the loaded window via its handles. */
  resizeWindow(a: number, b: number): void;
  /** Moved the replay playhead. */
  scrub(date: number): void;
}

type Drag =
  | { kind: 'select'; from: number; to: number }
  | { kind: 'pan'; last: number }
  | { kind: 'handle'; side: 'a' | 'b'; a: number; b: number }
  | { kind: 'scrub' };

const css = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

/** Full-history timeline strip: commit density, loaded window, camera view and replay playhead. */
export class TimeBar {
  private ctx: CanvasRenderingContext2D;
  private hist: Histogram | null = null;
  private domain: [number, number] = [Date.now() - 365 * DAY, Date.now()];
  private win: [number, number] | null = null;
  private view: [number, number] | null = null;
  private playhead: number | null = null;
  private drag: Drag | null = null;
  private downX = 0;
  private hover: number | null = null;
  private dirty = true;

  constructor(
    private canvas: HTMLCanvasElement,
    private on: TimeBarEvents,
  ) {
    this.ctx = canvas.getContext('2d')!;
    new ResizeObserver(() => this.resize()).observe(canvas);
    canvas.addEventListener('pointerdown', (e) => this.down(e));
    canvas.addEventListener('pointermove', (e) => this.move(e));
    canvas.addEventListener('pointerup', (e) => this.up(e));
    canvas.addEventListener('pointerleave', () => {
      this.hover = null;
      this.dirty = true;
    });
    this.resize();
  }

  setHistogram(h: Histogram) {
    this.hist = h;
    const end = Math.max(h.start + h.counts.length * h.bucket, h.start + DAY);
    const pad = (end - h.start) * 0.02;
    this.domain = [h.start - pad, end + pad];
    this.dirty = true;
  }

  setWindow(a: number, b: number) {
    this.win = [a, b];
    this.dirty = true;
  }

  setView(a: number, b: number) {
    if (this.view && Math.abs(this.view[0] - a) < 1000 && Math.abs(this.view[1] - b) < 1000) return;
    this.view = [a, b];
    this.dirty = true;
  }

  setPlayhead(d: number | null) {
    if (this.playhead === d) return;
    this.playhead = d;
    this.dirty = true;
  }

  private resize() {
    const r = this.canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio, 2);
    this.canvas.width = Math.max(1, Math.round(r.width * dpr));
    this.canvas.height = Math.max(1, Math.round(r.height * dpr));
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.dirty = true;
  }

  private get w() {
    return this.canvas.clientWidth;
  }
  private get h() {
    return this.canvas.clientHeight;
  }
  private toX(d: number) {
    return ((d - this.domain[0]) / (this.domain[1] - this.domain[0])) * this.w;
  }
  private toDate(x: number) {
    return this.domain[0] + (x / this.w) * (this.domain[1] - this.domain[0]);
  }
  private localX(e: PointerEvent) {
    return e.clientX - this.canvas.getBoundingClientRect().left;
  }

  // -------------------------------------------------------------------------

  private down(e: PointerEvent) {
    const x = this.localX(e);
    this.downX = x;
    this.canvas.setPointerCapture(e.pointerId);
    if (this.playhead !== null && Math.abs(this.toX(this.playhead) - x) < 8) this.drag = { kind: 'scrub' };
    else if (this.win && Math.abs(this.toX(this.win[0]) - x) < 7) this.drag = { kind: 'handle', side: 'a', a: this.win[0], b: this.win[1] };
    else if (this.win && Math.abs(this.toX(this.win[1]) - x) < 7) this.drag = { kind: 'handle', side: 'b', a: this.win[0], b: this.win[1] };
    else if (this.view && x > this.toX(this.view[0]) && x < this.toX(this.view[1]) && e.offsetY > this.h * 0.45)
      this.drag = { kind: 'pan', last: this.toDate(x) };
    else this.drag = { kind: 'select', from: this.toDate(x), to: this.toDate(x) };
  }

  private move(e: PointerEvent) {
    const x = this.localX(e);
    const d = this.toDate(x);
    this.hover = d;
    this.dirty = true;
    const drag = this.drag;
    const nearHandle = this.win && (Math.abs(this.toX(this.win[0]) - x) < 7 || Math.abs(this.toX(this.win[1]) - x) < 7);
    this.canvas.style.cursor = drag?.kind === 'pan' ? 'grabbing' : nearHandle ? 'ew-resize' : 'crosshair';
    if (!drag) return;
    if (drag.kind === 'select') drag.to = d;
    else if (drag.kind === 'pan') {
      this.on.pan(d - drag.last);
      drag.last = d;
    } else if (drag.kind === 'handle') {
      if (drag.side === 'a') drag.a = Math.min(d, drag.b - DAY);
      else drag.b = Math.max(d, drag.a + DAY);
      this.win = [drag.a, drag.b];
    } else if (drag.kind === 'scrub') {
      this.on.scrub(d);
    }
  }

  private up(e: PointerEvent) {
    const drag = this.drag;
    this.drag = null;
    if (!drag) return;
    const x = this.localX(e);
    if (drag.kind === 'select') {
      if (Math.abs(x - this.downX) < 4) this.on.jump(this.toDate(x));
      else this.on.select(Math.min(drag.from, drag.to), Math.max(drag.from, drag.to));
    } else if (drag.kind === 'handle') {
      this.on.resizeWindow(drag.a, drag.b);
    }
    this.dirty = true;
  }

  // -------------------------------------------------------------------------

  draw() {
    if (!this.dirty) return;
    this.dirty = false;
    const { ctx, w, h } = this;
    const gold = css('--gold') || '#ff9a2e';
    ctx.clearRect(0, 0, w, h);
    const top = 14;
    const base = h - 16;

    // histogram
    if (this.hist && this.hist.counts.length) {
      const { start, bucket, counts } = this.hist;
      const max = Math.max(...counts);
      const bw = Math.max(1, this.toX(start + bucket) - this.toX(start));
      for (let i = 0; i < counts.length; i++) {
        if (!counts[i]) continue;
        const x = this.toX(start + i * bucket);
        const bh = Math.max(1.5, (Math.sqrt(counts[i] / max) * (base - top)) | 0);
        const d = start + i * bucket;
        const inWin = this.win && d >= this.win[0] - bucket && d <= this.win[1];
        ctx.fillStyle = inWin ? 'rgba(255,170,90,0.85)' : 'rgba(170,160,190,0.35)';
        ctx.fillRect(x, base - bh, Math.max(1, bw - 0.5), bh);
      }
    }

    // ticks
    ctx.font = '10px Inter, system-ui, sans-serif';
    ctx.textBaseline = 'alphabetic';
    const ticks = tickDates(this.domain[0], this.domain[1], Math.max(2, Math.floor(w / 90)));
    for (const t of ticks.dates) {
      const x = this.toX(t);
      ctx.fillStyle = 'rgba(255,255,255,0.14)';
      ctx.fillRect(x, top, 1, base - top);
      ctx.fillStyle = 'rgba(220,214,235,0.6)';
      ctx.fillText(ticks.format(t), x + 3, h - 4);
    }

    // loaded window
    if (this.win) {
      const a = this.toX(this.win[0]);
      const b = this.toX(this.win[1]);
      ctx.fillStyle = 'rgba(255,154,46,0.09)';
      ctx.fillRect(a, 2, b - a, base - 2);
      ctx.strokeStyle = 'rgba(255,154,46,0.55)';
      ctx.lineWidth = 1;
      ctx.strokeRect(a + 0.5, 2.5, Math.max(1, b - a - 1), base - 3);
      for (const x of [a, b]) {
        ctx.fillStyle = gold;
        ctx.fillRect(x - 2, base / 2 - 8, 4, 16);
      }
    }

    // selection in progress
    if (this.drag?.kind === 'select') {
      const a = this.toX(Math.min(this.drag.from, this.drag.to));
      const b = this.toX(Math.max(this.drag.from, this.drag.to));
      ctx.fillStyle = 'rgba(120,180,255,0.18)';
      ctx.fillRect(a, 0, b - a, base);
      ctx.strokeStyle = 'rgba(140,190,255,0.9)';
      ctx.strokeRect(a + 0.5, 0.5, b - a, base);
    }

    // camera view bracket
    if (this.view) {
      const a = this.toX(this.view[0]);
      const b = Math.max(a + 3, this.toX(this.view[1]));
      ctx.fillStyle = 'rgba(255,255,255,0.1)';
      ctx.fillRect(a, top - 6, b - a, base - top + 6);
      ctx.strokeStyle = '#fff4e0';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(a + 4, top - 6);
      ctx.lineTo(a, top - 6);
      ctx.lineTo(a, base);
      ctx.lineTo(a + 4, base);
      ctx.moveTo(b - 4, top - 6);
      ctx.lineTo(b, top - 6);
      ctx.lineTo(b, base);
      ctx.lineTo(b - 4, base);
      ctx.stroke();
    }

    // playhead
    if (this.playhead !== null) {
      const x = this.toX(this.playhead);
      ctx.fillStyle = '#ff3355';
      ctx.fillRect(x - 1, 0, 2, base);
      ctx.beginPath();
      ctx.moveTo(x - 6, 0);
      ctx.lineTo(x + 6, 0);
      ctx.lineTo(x, 7);
      ctx.fill();
    }

    // hover date
    if (this.hover !== null) {
      const x = this.toX(this.hover);
      const label = new Date(this.hover).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
      ctx.font = '600 10.5px Inter, system-ui, sans-serif';
      const tw = ctx.measureText(label).width + 10;
      const lx = Math.min(w - tw, Math.max(0, x - tw / 2));
      ctx.fillStyle = 'rgba(8,8,18,0.92)';
      ctx.fillRect(lx, 0, tw, 15);
      ctx.fillStyle = '#fff';
      ctx.fillText(label, lx + 5, 11);
    }
  }
}

function tickDates(a: number, b: number, maxTicks: number) {
  const span = b - a;
  const steps: [number, 'day' | 'month' | 'year'][] = [
    [1, 'day'],
    [7, 'day'],
    [1, 'month'],
    [3, 'month'],
    [6, 'month'],
    [1, 'year'],
    [2, 'year'],
    [5, 'year'],
    [10, 'year'],
  ];
  const approx = (n: number, u: string) => n * (u === 'day' ? DAY : u === 'month' ? 30.4 * DAY : 365.25 * DAY);
  const [n, unit] = steps.find(([n, u]) => span / approx(n, u) <= maxTicks) ?? steps[steps.length - 1];
  const d = new Date(a);
  if (unit === 'year') d.setMonth(0, 1);
  else if (unit === 'month') d.setDate(1);
  d.setHours(0, 0, 0, 0);
  if (unit === 'year') d.setFullYear(Math.ceil(d.getFullYear() / n) * n);
  const dates: number[] = [];
  for (let guard = 0; guard < 200 && d.getTime() <= b; guard++) {
    if (d.getTime() >= a) dates.push(d.getTime());
    if (unit === 'day') d.setDate(d.getDate() + n);
    else if (unit === 'month') d.setMonth(d.getMonth() + n);
    else d.setFullYear(d.getFullYear() + n);
  }
  const format = (t: number) => {
    const x = new Date(t);
    if (unit === 'year') return String(x.getFullYear());
    if (unit === 'month') return x.toLocaleDateString(undefined, { month: 'short', year: n >= 3 || x.getMonth() === 0 ? '2-digit' : undefined });
    return x.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  };
  return { dates, format };
}
