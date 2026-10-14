/** View transform: document px → screen (CSS) px. screen = pan + R(θ)·S(zoom)·doc */
import { Affine, apply, invert, multiply, Point, rotation, scaling, translation } from '../image-engine/matrix';

export const ZOOM_STEPS = [0.01, 0.02, 0.03, 0.04, 0.05, 0.0625, 0.0833, 0.125, 0.1667, 0.25, 0.3333, 0.5, 0.6667, 1, 1.5, 2, 3, 4, 5, 6, 7, 8, 12, 16, 24, 32, 64];

export class ViewTransform {
  zoom = 1;
  rotation = 0;
  panX = 0;
  panY = 0;
  flipH = false;

  clone(): ViewTransform {
    const v = new ViewTransform();
    Object.assign(v, this);
    return v;
  }

  matrix(): Affine {
    let m = translation(this.panX, this.panY);
    if (this.rotation) m = multiply(m, rotation(this.rotation));
    m = multiply(m, scaling(this.zoom * (this.flipH ? -1 : 1), this.zoom));
    return m;
  }

  inverse(): Affine {
    return invert(this.matrix());
  }

  docToScreen(x: number, y: number): Point {
    return apply(this.matrix(), x, y);
  }

  screenToDoc(x: number, y: number): Point {
    return apply(this.inverse(), x, y);
  }

  /** Zooms keeping the document point under (sx, sy) fixed. */
  zoomAt(sx: number, sy: number, zoom: number): void {
    const z = Math.max(0.005, Math.min(128, zoom));
    const d = this.screenToDoc(sx, sy);
    this.zoom = z;
    const p = this.docToScreen(d.x, d.y);
    this.panX += sx - p.x;
    this.panY += sy - p.y;
  }

  zoomStep(sx: number, sy: number, dir: 1 | -1): void {
    const z = this.zoom;
    let next: number;
    if (dir > 0) next = ZOOM_STEPS.find((s) => s > z * 1.001) ?? z * 2;
    else next = [...ZOOM_STEPS].reverse().find((s) => s < z / 1.001) ?? z / 2;
    this.zoomAt(sx, sy, next);
  }

  rotateAround(sx: number, sy: number, angle: number): void {
    const d = this.screenToDoc(sx, sy);
    this.rotation = angle;
    const p = this.docToScreen(d.x, d.y);
    this.panX += sx - p.x;
    this.panY += sy - p.y;
  }

  /** Fits (or fills) the document into a viewport. */
  /** Fits the document in the view. `maxZoom` caps enlargement (documents open at most at 100%). */
  fit(docW: number, docH: number, viewW: number, viewH: number, fill = false, margin = 24, maxZoom = Infinity): void {
    const sx = (viewW - margin * 2) / docW, sy = (viewH - margin * 2) / docH;
    this.rotation = 0;
    this.zoom = Math.min(maxZoom, Math.max(0.005, fill ? Math.max(sx, sy) : Math.min(sx, sy)));
    this.panX = (viewW - docW * this.zoom) / 2;
    this.panY = (viewH - docH * this.zoom) / 2;
  }

  /** Sets an absolute zoom centered on the viewport. */
  setZoomCentered(zoom: number, viewW: number, viewH: number): void {
    this.zoomAt(viewW / 2, viewH / 2, zoom);
  }

  /** Pyramid level to render for the current zoom (level L renders at 1/2^L). */
  level(maxLevel: number): number {
    if (this.zoom >= 1) return 0;
    return Math.max(0, Math.min(maxLevel, Math.floor(Math.log2(1 / this.zoom) + 1e-6)));
  }

  /** Visible document-space bounding box for a viewport of the given size. */
  visibleDocRect(viewW: number, viewH: number): { x: number; y: number; w: number; h: number } {
    const inv = this.inverse();
    const pts = [apply(inv, 0, 0), apply(inv, viewW, 0), apply(inv, viewW, viewH), apply(inv, 0, viewH)];
    const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
    const x0 = Math.floor(Math.min(...xs)), y0 = Math.floor(Math.min(...ys));
    return { x: x0, y: y0, w: Math.ceil(Math.max(...xs)) - x0, h: Math.ceil(Math.max(...ys)) - y0 };
  }
}
