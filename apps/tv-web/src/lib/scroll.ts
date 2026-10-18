// How far a scroller moves to show the focused element (Android Components.kt BringIntoViewSpec). Offsets are the
// element's position in the scroller's viewport; the result is added to the scroll position.

// EdgeSpec: scroll only when the element comes within [margin] of an edge (rows: 56 dp).
export function edgeDelta(offset: number, size: number, container: number, margin: number): number {
  const end = offset + size;
  if (offset < margin) return offset - margin;
  if (end > container - margin) return Math.min(end - (container - margin), offset - margin);
  return 0;
}

// PivotSpec: the element settles at a fixed line, like tvOS (home rows: 26 % from the top).
export function pivotDelta(offset: number, container: number, fraction: number): number {
  return offset - container * fraction;
}

export function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}
