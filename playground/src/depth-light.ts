/** One measured perspective light feeds the sky and every selected homepage surface. */
export type LightRect = { left: number; top: number; width: number; height: number };
export type LightSurface = { canvas: HTMLCanvasElement; rect: [number, number, number, number] };
export type DepthLightState = {
  source: [number, number, number, number];
  cards: [number, number, number, number][];
  pageProgress: number;
  cameraDistance: number;
  focus: number;
  reducedMotion: boolean;
};
const clamp = (x: number, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, x));
const smooth = (x: number) => { const t = clamp(x); return t * t * (3 - 2 * t); };
const mix = (a: number, b: number, t: number) => a + (b - a) * t;

export function measureDepthLight(view: LightRect, cards: LightRect[], scroll: number, reducedMotion: boolean, documentHeight = view.height * 5): DepthLightState {
  const width = Math.max(1, view.width), height = Math.max(1, view.height);
  const pageProgress = clamp(scroll / Math.max(height, documentHeight - height));
  // Keep a real source and visible medium through the whole homepage, even between objects.
  const travel = reducedMotion ? 0.45 : pageProgress;
  const source: DepthLightState['source'] = [mix(0.73, 0.62, travel), mix(0.23, 0.35, travel), mix(2.1, 1.65, travel), 1.1];
  const nearby = cards.filter(r => r.width > 0 && r.height > 0 && r.top + r.height > view.top - height * 0.45 && r.top < view.top + height * 1.35).slice(0, 10);
  const rectangles = nearby.map(r => [(r.left - view.left) / width, (r.top - view.top) / height, r.width / width, r.height / height] as [number, number, number, number]);
  let proximity = 0;
  for (const r of nearby) {
    const top = r.top - view.top, bottom = top + r.height;
    proximity = Math.max(proximity, smooth((height * 1.12 - top) / (height * 0.65)) * smooth((bottom + height * 0.28) / (height * 0.5)));
  }
  return {source, cards: rectangles, focus: 0.46 + 0.54 * proximity, pageProgress: reducedMotion ? 0 : pageProgress, cameraDistance: 2.6, reducedMotion};
}

export function bindDepthLight(canvas: HTMLCanvasElement, cards: HTMLElement[], onChange: (state: DepthLightState, surfaces: LightSurface[]) => void, reducedMotion: boolean) {
  let frame = 0, dead = false, layoutDirty = true;
  const abort = new AbortController();
  const main = cards[0]?.closest<HTMLElement>('.home-main');
  // Transparent GPU overlays preserve each card's original CSS and thumbnail.
  const surfaces = cards.map(card => {
    const overlay = document.createElement('canvas');
    overlay.className = 'card-light-surface';
    overlay.setAttribute('aria-hidden', 'true');
    card.append(overlay);
    card.classList.add('depth-lit');
    return overlay;
  });
  const headings = [...(main?.querySelectorAll<HTMLElement>('.section-heading,.docs-teaser>h2') ?? [])];
  let view = canvas.getBoundingClientRect();
  let documentHeight = 0;
  let geometry: { card: LightRect; surface: LightRect }[] = [];
  let headingRects: LightRect[] = [];
  const offsets = new Map<HTMLElement, number>();
  const absoluteRect = (element: HTMLElement): LightRect => {
    const r = element.getBoundingClientRect();
    return {left:r.left,top:r.top+window.scrollY-(offsets.get(element)??0),width:r.width,height:r.height};
  };
  function measure() {
    view = canvas.getBoundingClientRect();
    geometry = cards.map((card,i)=>{
      const c=absoluteRect(card),s=surfaces[i].getBoundingClientRect();
      return {card:c,surface:{left:s.left,top:s.top+window.scrollY-(offsets.get(card)??0),width:s.width,height:s.height}};
    });
    headingRects = headings.map(absoluteRect);
    const mainRect = main?.getBoundingClientRect();
    documentHeight = Math.max(document.documentElement.scrollHeight||0,document.body.scrollHeight||0,(mainRect?.bottom??view.height)+window.scrollY);
    layoutDirty = false;
  }
  function update() {
    frame = 0;if(dead)return;
    // Layout is read only after resize/content changes. Scroll uses cached document
    // coordinates, then applies the exact same small entrance offset to DOM + GPU.
    if(layoutDirty)measure();
    const scroll = window.scrollY;
    const lift = (top:number,amount:number)=>reducedMotion?0:amount*(1-smooth((view.height-(top-scroll))/(view.height*.24)));
    const rectangles = geometry.map(({card},i)=>{
      const y=lift(card.top,12);offsets.set(cards[i],y);
      cards[i].style.setProperty('--entry-y',`${y.toFixed(3)}px`);
      return {...card,top:card.top-scroll+y};
    });
    headings.forEach((heading,i)=>{
      const y=lift(headingRects[i].top,18);offsets.set(heading,y);
      heading.style.setProperty('--entry-y',`${y.toFixed(3)}px`);
    });
    const state=measureDepthLight(view,rectangles,scroll,reducedMotion,documentHeight);
    const targets:LightSurface[]=[];
    rectangles.forEach((r,i)=>{
      if(r.width>0&&r.height>0&&r.top+r.height>view.top&&r.top<view.top+view.height){
        const s=geometry[i].surface,y=offsets.get(cards[i])??0;
        targets.push({canvas:surfaces[i],rect:[(s.left-view.left)/view.width,(s.top-scroll+y-view.top)/view.height,s.width/view.width,s.height/view.height]});
      }
    });
    main?.classList.add('depth-light-region');onChange(state,targets);
  }
  function request() { if (!frame && !dead) frame = requestAnimationFrame(update); }
  window.addEventListener('scroll', request, { passive: true, signal: abort.signal });
  const invalidate=()=>{layoutDirty=true;request();};
  window.addEventListener('resize', invalidate, { passive: true, signal: abort.signal });
  document.addEventListener('languagechange',invalidate,{signal:abort.signal});
  const observer = new ResizeObserver(invalidate);
  observer.observe(canvas);
  for (const card of cards) observer.observe(card);
  if (main) observer.observe(main);
  update();
  return () => {
    dead = true;
    if (frame) cancelAnimationFrame(frame);
    abort.abort(); observer.disconnect();
    for (const card of cards) {card.classList.remove('depth-lit');card.style.removeProperty('--entry-y');}
    for (const heading of headings) heading.style.removeProperty('--entry-y');
    for (const surface of surfaces) surface.remove();
    main?.classList.remove('depth-light-region'); main?.style.removeProperty('--featured-clear');
  };
}
