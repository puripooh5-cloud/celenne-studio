/** Vector path model (cubic Bézier), shared by shapes, pen tool, paths panel and vector masks. */
export interface PathKnot {
  /** Anchor point (document pixels). */
  x: number;
  y: number;
  /** Incoming control point (towards the previous knot). */
  inX: number;
  inY: number;
  /** Outgoing control point (towards the next knot). */
  outX: number;
  outY: number;
  /** Smooth points keep their handles collinear while editing. */
  smooth: boolean;
}

export type PathOperation = 'combine' | 'subtract' | 'intersect' | 'exclude';

export interface SubPath {
  knots: PathKnot[];
  closed: boolean;
  op: PathOperation;
}

export interface VectorPath {
  subpaths: SubPath[];
  fillRule: 'nonzero' | 'evenodd';
}

export type ShapeKind = 'rectangle' | 'roundedRectangle' | 'ellipse' | 'polygon' | 'star' | 'line' | 'custom';

/** "Live shape" parameters — lets the Properties panel edit a rectangle as a rectangle. */
export interface ShapeOrigin {
  kind: ShapeKind;
  /** Bounding box in document pixels before any transform. */
  x: number;
  y: number;
  w: number;
  h: number;
  radii?: [number, number, number, number];
  sides?: number;
  starRatio?: number;
  lineWidth?: number;
  rotation?: number;
}

export type StrokeAlignment = 'inside' | 'center' | 'outside';
export type LineCap = 'butt' | 'round' | 'square';
export type LineJoin = 'miter' | 'round' | 'bevel';

export function emptyPath(): VectorPath {
  return { subpaths: [], fillRule: 'nonzero' };
}

export function knot(x: number, y: number): PathKnot {
  return { x, y, inX: x, inY: y, outX: x, outY: y, smooth: false };
}

export function clonePath(p: VectorPath): VectorPath {
  return {
    fillRule: p.fillRule,
    subpaths: p.subpaths.map((s) => ({ closed: s.closed, op: s.op, knots: s.knots.map((k) => ({ ...k })) })),
  };
}
