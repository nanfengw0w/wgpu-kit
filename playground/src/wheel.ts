/** A short settling pass for recognizable desktop mouse-wheel detents. */
export interface DiscreteWheelOptions {
  /** Settling time, clamped to 100–140 ms. Default: 120 ms. */
  durationMs?: number;
  /** Dispatch this on document before every SPA navigation. */
  beforeRouteEvent?: string;
  /** Optional window, useful for an embedded document or deterministic tests. */
  window?: Window & typeof globalThis;
}

/** Call to unbind. Call .cancel() before imperative navigation/scroll changes. */
export type DiscreteWheelCleanup = (() => void) & { cancel(): void };

const NATIVE_TARGETS =
  'pre,code,input,textarea,select,option,button,[contenteditable]:not([contenteditable="false"]),[data-native-wheel]';
const clamp = (value: number, low: number, high: number) =>
  Math.min(high, Math.max(low, value));

export function bindDiscreteWheel(options: DiscreteWheelOptions = {}): DiscreteWheelCleanup {
  const win = options.window ?? window;
  const doc = win.document;
  const duration = clamp(options.durationMs ?? 120, 100, 140);
  const reducedMotion = win.matchMedia('(prefers-reduced-motion: reduce)');
  const desktopPointer = win.matchMedia('(hover: hover) and (pointer: fine)');
  const removals: (() => void)[] = [];
  let disposed = false;
  let frame = 0;
  let active = false;
  let startY = 0;
  let targetY = 0;
  let lastWrittenY = 0;
  let startedAt = 0;
  let nativePixelUntil = 0;
  let nativeCache = new WeakMap<Element, boolean>();

  function cancel() {
    active = false;
    if (frame) win.cancelAnimationFrame(frame);
    frame = 0;
  }

  function listen(target: EventTarget, type: string, handler: EventListener, passive = true) {
    target.addEventListener(type, handler, { capture: true, passive });
    removals.push(() => target.removeEventListener(type, handler, true));
  }

  function enabled() {
    return !disposed && !reducedMotion.matches && desktopPointer.matches && !doc.hidden;
  }

  // Two root geometry reads, without traversing or measuring nested containers.
  function bounds() {
    const root = doc.scrollingElement ?? doc.documentElement;
    const height = root.clientHeight || win.innerHeight;
    return { maximum: Math.max(0, root.scrollHeight - height), height };
  }

  function isNativeTarget(event: WheelEvent) {
    // The composed path includes scroll containers inside open shadow roots.
    for (const node of event.composedPath()) {
      if (node === doc || node === win) break;
      if (!(node instanceof win.Element)) continue;
      const element = node as Element;
      if (element.matches(NATIVE_TARGETS)) return true;
      if (element === doc.documentElement || element === doc.body) continue;
      let native = nativeCache.get(element);
      if (native === undefined) {
        const style = win.getComputedStyle(element);
        // Preserve the container even at its edge, including its native chaining.
        native = /^(auto|scroll|overlay)$/.test(style.overflowY) ||
          /^(auto|scroll|overlay)$/.test(style.overflowX);
        nativeCache.set(element, native);
      }
      if (native) return true;
    }
    return false;
  }

  function animate(now: number) {
    frame = 0;
    if (!active || !enabled()) { cancel(); return; }
    const currentY = win.scrollY;
    // Native scrollbar, keyboard, or external script movement takes precedence.
    if (Math.abs(currentY - lastWrittenY) > 1) { cancel(); return; }
    const { maximum } = bounds();
    targetY = clamp(targetY, 0, maximum);
    const progress = clamp((now - startedAt) / duration, 0, 1);
    const ease = 1 - Math.pow(1 - progress, 3);
    const finished = progress === 1 || Math.abs(targetY - currentY) < 0.5;
    const nextY = finished ? targetY : clamp(startY + (targetY - startY) * ease, 0, maximum);
    lastWrittenY = nextY;
    win.scrollTo({ left: win.scrollX, top: nextY, behavior: 'instant' });
    // Keep the browser's actual subpixel/rounded result as the next-frame baseline.
    lastWrittenY = win.scrollY;
    if (finished) active = false;
    else frame = win.requestAnimationFrame(animate);
  }

  function wheel(event: WheelEvent) {
    const now = win.performance.now();
    const touchSource = (event as WheelEvent & { sourceCapabilities?: { firesTouchEvents?: boolean } }).sourceCapabilities;
    if (event.deltaMode === 0 && (event.deltaX !== 0 || touchSource?.firesTouchEvents)) nativePixelUntil = now + 400;
    if (!enabled() || event.defaultPrevented || !event.cancelable ||
        event.ctrlKey || event.metaKey || event.shiftKey || event.altKey ||
        event.deltaX !== 0 || event.deltaZ !== 0 || !Number.isFinite(event.deltaY) ||
        event.deltaY === 0 || touchSource?.firesTouchEvents) {
      cancel();
      return;
    }

    const amount = Math.abs(event.deltaY);
    // Pixel mode has no device ID. Only exact common coarse detent quanta qualify.
    // A preceding fine/ambiguous packet keeps the entire trackpad burst native.
    const coarsePixel = Number.isInteger(amount) && amount >= 80 &&
      (amount % 100 === 0 || amount % 120 === 0 || amount % 80 === 0);
    if (event.deltaMode === 0 && !coarsePixel) {
      nativePixelUntil = now + 400;
      cancel();
      return;
    }
    // Line/page units use platform-specific native distances. Do not replace
    // them with a guessed line height or a capped fraction of a page.
    if (event.deltaMode !== 0 || now < nativePixelUntil || isNativeTarget(event)) {
      cancel();
      return;
    }

    const { maximum } = bounds();
    const currentY = win.scrollY;
    const delta = event.deltaY;
    if (active && Math.abs(currentY - lastWrittenY) > 1) cancel();
    // Reversals discard the previous destination immediately, for the next paint.
    const sameDirection = active && Math.sign(targetY - currentY) === Math.sign(delta);
    const destination = (sameDirection ? targetY : currentY) + delta;
    // Smoothing changes only timing. Preserve every accepted pixel of a burst;
    // the document edge is the only distance limit.
    const nextTarget = clamp(destination, 0, maximum);
    if (Math.abs(nextTarget - currentY) < 0.5) { cancel(); return; }

    event.preventDefault();
    if (!event.defaultPrevented) { cancel(); return; }
    cancel();
    startY = lastWrittenY = currentY;
    targetY = nextTarget;
    startedAt = now;
    active = true;
    frame = win.requestAnimationFrame(animate);
  }

  const cancelListener: EventListener = cancel;
  const invalidate: EventListener = () => { cancel(); nativeCache = new WeakMap(); };
  listen(win, 'wheel', wheel as EventListener, false);
  for (const type of ['keydown', 'pointerdown', 'touchstart', 'touchmove', 'popstate', 'hashchange', 'pagehide', 'blur']) {
    listen(win, type, cancelListener);
  }
  listen(win, 'resize', invalidate);
  listen(doc, 'visibilitychange', cancelListener);
  listen(doc, options.beforeRouteEvent ?? 'before-route-change', invalidate);
  listen(doc, 'routechange', invalidate);
  listen(win, 'scroll', () => {
    if (active && Math.abs(win.scrollY - lastWrittenY) > 1) cancel();
  });
  listen(reducedMotion, 'change', invalidate);
  listen(desktopPointer, 'change', invalidate);
  // The router emits before-route-change for real navigation. Do not subscribe
  // to Navigation API "navigate": its scroll-position history.replaceState
  // also emits that event, which would cancel our own animation every frame.

  // One observer; cached overflow checks avoid repeated style reads per detent.
  // Bounds are read fresh at each animation frame, so resizing content cannot
  // leave an obsolete lower-page target queued.
  const observer = new win.MutationObserver(() => { nativeCache = new WeakMap(); });
  observer.observe(doc.documentElement, {
    subtree: true, childList: true, attributes: true,
    attributeFilter: ['class', 'style', 'contenteditable', 'data-native-wheel'],
  });

  const cleanup = (() => {
    if (disposed) return;
    disposed = true;
    cancel();
    observer.disconnect();
    for (const remove of removals) remove();
    removals.length = 0;
  }) as DiscreteWheelCleanup;
  cleanup.cancel = cancel;
  return cleanup;
}
