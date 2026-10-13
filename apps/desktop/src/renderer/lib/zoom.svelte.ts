// Zoom and pan of one picture layer centred in a viewport, shared by the comic reader and the photo viewer
// (photos spec PH-03). Pan is the layer's offset from the centre in CSS px; zoomAt keeps the point under (cx, cy)
// still. Pointers: one drags (pans while the layer overflows), two pinch.
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export interface Drag {
  dx: number;
  dy: number;
  moved: boolean;
}

export class ZoomPan {
  zoom = $state(1);
  panX = $state(0);
  panY = $state(0);
  private pointers = new Map<number, { x: number; y: number }>();
  private drag: { x: number; y: number; panX: number; panY: number; moved: boolean } | null = null;
  private pinch: { dist: number; zoom: number } | null = null;

  private size: () => { vw: number; vh: number; w: number; h: number };
  private max: number;

  // size(): the viewport and the layer at zoom 1.
  constructor(size: () => { vw: number; vh: number; w: number; h: number }, max = 6) {
    this.size = size;
    this.max = max;
  }

  get maxX(): number {
    const s = this.size();
    return Math.max(0, (s.w * this.zoom - s.vw) / 2);
  }
  get maxY(): number {
    const s = this.size();
    return Math.max(0, (s.h * this.zoom - s.vh) / 2);
  }
  get overflows(): boolean {
    return this.maxX > 1 || this.maxY > 1;
  }

  clampPan(): void {
    this.panX = clamp(this.panX, -this.maxX, this.maxX);
    this.panY = clamp(this.panY, -this.maxY, this.maxY);
  }

  zoomAt(factor: number, cx?: number, cy?: number): void {
    const { vw, vh } = this.size();
    const z = clamp(this.zoom * factor, 1, this.max);
    const k = z / this.zoom;
    const px = (cx ?? vw / 2) - vw / 2;
    const py = (cy ?? vh / 2) - vh / 2;
    this.panX = px - (px - this.panX) * k;
    this.panY = py - (py - this.panY) * k;
    this.zoom = z;
    this.clampPan();
  }

  reset(): void {
    this.zoom = 1;
    this.panX = 0;
    this.panY = 0;
  }

  get pointerCount(): number {
    return this.pointers.size;
  }

  private span() {
    const [a, b] = [...this.pointers.values()];
    return { dist: Math.hypot(a.x - b.x, a.y - b.y), x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  }

  down(e: PointerEvent): boolean {
    if (e.button !== 0) return false;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (this.pointers.size === 2) {
      this.pinch = { dist: this.span().dist || 1, zoom: this.zoom };
      this.drag = null;
    } else if (this.pointers.size === 1) this.drag = { x: e.clientX, y: e.clientY, panX: this.panX, panY: this.panY, moved: false };
    return true;
  }

  move(e: PointerEvent): void {
    if (!this.pointers.has(e.pointerId)) return;
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const d = this.drag;
    if (this.pinch && this.pointers.size === 2) {
      const s = this.span();
      this.zoomAt((this.pinch.zoom * (s.dist / this.pinch.dist)) / this.zoom, s.x, s.y);
    } else if (d) {
      const dx = e.clientX - d.x;
      const dy = e.clientY - d.y;
      if (!d.moved && Math.hypot(dx, dy) > 6) d.moved = true;
      if (d.moved && this.overflows) {
        this.panX = clamp(d.panX + dx, -this.maxX, this.maxX);
        this.panY = clamp(d.panY + dy, -this.maxY, this.maxY);
      }
    }
  }

  // The finished one-pointer drag (a tap when !moved, a swipe otherwise); null after a pinch or a stray pointer.
  up(e: PointerEvent): Drag | null {
    if (!this.pointers.delete(e.pointerId)) return null;
    const d = this.drag;
    if (this.pointers.size === 0) this.pinch = null;
    this.drag = null;
    if (!d || this.pinch) return null;
    return { dx: e.clientX - d.x, dy: e.clientY - d.y, moved: d.moved };
  }

  // Touchpad pinch arrives as ctrl+wheel in Chromium; a plain wheel pans an overflowing layer. False: not handled.
  wheel(e: WheelEvent): boolean {
    if (e.ctrlKey) {
      this.zoomAt(Math.exp(-e.deltaY * 0.0025), e.clientX, e.clientY);
      return true;
    }
    if (!this.overflows) return false;
    this.panX = clamp(this.panX - e.deltaX, -this.maxX, this.maxX);
    this.panY = clamp(this.panY - e.deltaY, -this.maxY, this.maxY);
    return true;
  }
}
