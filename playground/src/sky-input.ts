/** Routes the visible hero surface to the GPU scene, without stealing UI input. */
export function bindSkyInput(surface: HTMLElement, callbacks: {
  move(x:number,y:number,pointerType?:string):void; down(x:number,y:number,pointerType?:string):void;
  up(click:boolean):void; leave():void;
}) {
  const abort=new AbortController(),signal=abort.signal;
  let active:number|null=null,startX=0,startY=0,distance=0;
  const oldTouchAction=surface.style.touchAction||'';
  surface.style.touchAction='pan-y';
  const isControl=(target:EventTarget|null)=>!!(target as Element|null)?.closest?.('a,button,input,select,textarea,summary,[role="button"],[role="tab"],[contenteditable="true"],.gpu-unavailable');
  surface.addEventListener('dragstart',event=>{if(!isControl(event.target))event.preventDefault();},{signal});
  const finish=(click:boolean)=>{if(active===null)return;const id=active;active=null;if(surface.hasPointerCapture?.(id))surface.releasePointerCapture(id);callbacks.up(click);};
  surface.addEventListener('pointerdown',event=>{
    if(event.button!==0||active!==null||isControl(event.target))return;
    active=event.pointerId;startX=event.clientX;startY=event.clientY;distance=0;
    callbacks.down(event.clientX,event.clientY,event.pointerType);
    surface.setPointerCapture(event.pointerId);
  },{signal,passive:true});
  surface.addEventListener('pointermove',event=>{
    if(active!==null&&event.pointerId!==active)return;
    if(active===null&&(isControl(event.target)||event.pointerType==='touch'))return;
    if(active!==null)distance=Math.max(distance,Math.hypot(event.clientX-startX,event.clientY-startY));
    callbacks.move(event.clientX,event.clientY,event.pointerType);
  },{signal,passive:true});
  surface.addEventListener('pointerup',event=>{if(event.pointerId!==active)return;finish(distance<6);},{signal,passive:true});
  surface.addEventListener('pointercancel',event=>{if(event.pointerId===active)finish(false);},{signal,passive:true});
  surface.addEventListener('lostpointercapture',event=>{if(event.pointerId===active)finish(false);},{signal,passive:true});
  surface.addEventListener('pointerleave',()=>{if(active===null)callbacks.leave();},{signal,passive:true});
  window.addEventListener('blur',()=>finish(false),{signal});
  document.addEventListener('visibilitychange',()=>{if(document.hidden)finish(false);},{signal});
  const unbind=()=>{abort.abort();finish(false);surface.style.touchAction=oldTouchAction;};
  unbind.cancel=()=>finish(false);
  return unbind;
}
