import type { DemoController } from './gpu/examples';

/** Exactly one lazy runtime per featured canvas, with explicit links outside gestures. */
export function bindLiveStudies(root: HTMLElement, options: {
  reducedMotion: boolean;
  coarsePointer: boolean;
  translate: (s: string) => string;
  mount: (id: string, canvas: HTMLCanvasElement, onStatus: (s: string) => void, onFrame: () => void) => Promise<DemoController>;
  register: (controller: DemoController) => () => void;
}) {
  let dead = false;
  const abort = new AbortController();
  const {signal} = abort;
  const slots = [...root.querySelectorAll<HTMLElement>('[data-live-study]')].map(card => ({
    card, canvas: card.querySelector<HTMLCanvasElement>('canvas[data-live-canvas]')!,
    controller: null as DemoController | null, unregister: null as (() => void) | null,
    loading: false, ready: false, visible: false, paused: options.reducedMotion, failed: false,
  }));
  const text = options.translate;
  function sync(slot: typeof slots[number]) {
    slot.controller?.setPaused(slot.paused || !slot.visible || document.hidden);
    const pause = slot.card.querySelector<HTMLButtonElement>('[data-live-pause]')!;
    pause.textContent = slot.paused ? '▶' : 'Ⅱ';
    pause.setAttribute('aria-label', text(slot.paused ? 'Play preview' : 'Pause preview'));
    pause.setAttribute('aria-pressed', String(slot.paused));
  }
  async function start(slot: typeof slots[number]) {
    if (slot.loading || slot.controller || slot.failed || dead) return;
    slot.loading = true;
    const label = slot.card.querySelector<HTMLElement>('[data-live-status]')!;
    try {
      const controller = await options.mount(slot.card.dataset.liveStudy!, slot.canvas, status => {
        if (dead) return;
        if (/error|lost|unavailable/i.test(status)) {
          slot.failed = true;slot.card.classList.remove('live-ready');
          label.textContent = text('Preview unavailable · Open experiment');
        }
      }, () => {
        if (!dead && !slot.failed && !slot.ready) {
          slot.ready = true;
          slot.card.classList.add('live-ready');
          label.textContent = text('Live · Drag to explore');
        }
      });
      if (dead) { controller.destroy(); return; }
      slot.controller = controller;
      slot.unregister = options.register(controller);
      slot.canvas.style.touchAction = 'pan-y';
      sync(slot);
    } catch {
      if (dead) return;
      slot.failed = true;
      label.textContent = text('Preview unavailable · Open experiment');
      slot.card.classList.remove('live-ready');
      slot.card.querySelectorAll<HTMLButtonElement>('.live-actions button').forEach(b => b.disabled = true);
    } finally { slot.loading = false; }
  }
  const observer = new IntersectionObserver(entries => {
    for (const entry of entries) {
      const slot = slots.find(x => x.card === entry.target);if (!slot) continue;
      slot.visible = entry.isIntersecting;
      if (slot.visible) void start(slot);
      sync(slot);
    }
  }, {threshold: 0.01});
  for (const slot of slots) {
    observer.observe(slot.card);
    const pause = slot.card.querySelector<HTMLButtonElement>('[data-live-pause]')!;
    pause.addEventListener('click', () => {slot.paused = !slot.paused;sync(slot);}, {signal});
    slot.card.querySelector('[data-live-reset]')!.addEventListener('click', () => slot.controller?.reset(), {signal});
    const interact = slot.card.querySelector<HTMLButtonElement>('[data-live-interact]')!;
    interact.hidden = !options.coarsePointer;
    slot.canvas.style.pointerEvents = options.coarsePointer ? 'none' : 'auto';
    interact.addEventListener('click', () => {
      const active = interact.getAttribute('aria-pressed') !== 'true';
      interact.setAttribute('aria-pressed', String(active));
      interact.textContent = text(active ? 'Done' : 'Interact');
      slot.canvas.style.pointerEvents = active ? 'auto' : 'none';
      slot.canvas.style.touchAction = active ? 'none' : 'pan-y';
      if (active) {slot.paused = false;sync(slot);slot.canvas.focus();}
    }, {signal});
    sync(slot);
  }
  document.addEventListener('visibilitychange', () => slots.forEach(sync), {signal});
  document.addEventListener('languagechange', () => slots.forEach(sync), {signal});
  return () => {
    dead = true;abort.abort();observer.disconnect();
    for (const slot of slots) {slot.unregister?.();slot.controller?.destroy();slot.card.classList.remove('live-ready');}
  };
}
