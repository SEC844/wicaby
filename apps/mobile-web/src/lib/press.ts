// A long press (Android's combinedClickable onLongClick): held still for 480 ms, it runs [fn] and the click that
// would follow the release is swallowed. A move of more than 10 px (a scroll) cancels it.
export function longpress(node: HTMLElement, fn: () => void) {
  let timer = 0;
  let start: { x: number; y: number } | null = null;
  let fired = false;
  let run = fn;
  const cancel = () => {
    clearTimeout(timer);
    start = null;
  };
  const down = (e: PointerEvent) => {
    fired = false;
    start = { x: e.clientX, y: e.clientY };
    timer = window.setTimeout(() => {
      fired = true;
      start = null;
      run();
    }, 480);
  };
  const move = (e: PointerEvent) => {
    if (start && Math.hypot(e.clientX - start.x, e.clientY - start.y) > 10) cancel();
  };
  const click = (e: MouseEvent) => {
    if (!fired) return;
    fired = false;
    e.preventDefault();
    e.stopImmediatePropagation();
  };
  node.addEventListener('pointerdown', down);
  node.addEventListener('pointermove', move);
  node.addEventListener('pointerup', cancel);
  node.addEventListener('pointercancel', cancel);
  node.addEventListener('click', click, true);
  node.addEventListener('contextmenu', (e) => e.preventDefault());
  return {
    update(next: () => void) {
      run = next;
    },
    destroy() {
      cancel();
      node.removeEventListener('pointerdown', down);
      node.removeEventListener('pointermove', move);
      node.removeEventListener('pointerup', cancel);
      node.removeEventListener('pointercancel', cancel);
      node.removeEventListener('click', click, true);
    },
  };
}
