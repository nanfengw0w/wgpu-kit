import { siteRoutePath } from './paths';
/** Small document router: stable shell/preferences, real links, disposable route scopes. */
export function startRouter(hooks:{
  mount(root:HTMLElement):()=>void;
  prepare(root:HTMLElement,title:string):void;
  navigated():void;failed():void;
}){
  let root=document.querySelector<HTMLElement>('#route-view')!;
  let dispose=hooks.mount(root),sequence=0,pending:AbortController|undefined;
  let current=new URL(location.href);
  const cache=new Map<string,string>();
  history.scrollRestoration='manual';
  history.replaceState({...history.state,scroll:[scrollX,scrollY]},'',location.href);
  const routePath=(url:URL)=>{const path=siteRoutePath(url.pathname);return url.origin===location.origin&&path!==null&&/^\/(?:$|examples\/(?:[a-z0-9-]+\/)?$|docs\/(?:api\/(?:[a-z0-9-]+\/)?)?$)/.test(path);};
  function saveScroll(){history.replaceState({...history.state,scroll:[scrollX,scrollY]},'',location.href);}
  function position(url:URL,restore?:number[],smooth=false){
    let target:HTMLElement|null=null;try{if(url.hash)target=document.getElementById(decodeURIComponent(url.hash.slice(1)));}catch{}
    if(target)target.scrollIntoView({behavior:smooth&&!matchMedia('(prefers-reduced-motion: reduce)').matches?'smooth':'instant',block:'start'});
    else window.scrollTo({left:restore?.[0]??0,top:restore?.[1]??0,behavior:'instant'});
  }
  function navState(url:URL){for(const link of document.querySelectorAll<HTMLAnchorElement>('.nav-links a')){const path=siteRoutePath(new URL(link.href).pathname);const currentPath=siteRoutePath(url.pathname)??'';const selected=path==='/examples/'?currentPath.startsWith('/examples/'):path==='/docs/api/'?currentPath.startsWith('/docs/api/'):currentPath==='/docs/';if(selected)link.setAttribute('aria-current','page');else link.removeAttribute('aria-current');}}
  async function navigate(url:URL,pop=false,restore?:number[]){
    document.dispatchEvent(new Event('before-route-change'));
    const id=++sequence;pending?.abort();pending=new AbortController();
    if(url.pathname===current.pathname&&url.search===current.search){
      if(!pop){saveScroll();history.pushState({scroll:[0,0]},'',url);}
      current=url;document.documentElement.removeAttribute('data-route-loading');position(url,restore,!pop);hooks.navigated();return;
    }
    document.documentElement.setAttribute('data-route-loading','');
    try{
      const key=url.pathname+url.search;
      let html=cache.get(key);
      if(!html){const response=await fetch(key,{signal:pending.signal,headers:{Accept:'text/html'}});if(!response.ok)throw new Error('Route request failed');html=await response.text();cache.set(key,html);if(cache.size>12)cache.delete(cache.keys().next().value!);}
      if(id!==sequence)return;
      const parsed=new DOMParser().parseFromString(html,'text/html');
      const next=parsed.querySelector<HTMLElement>('#route-view');if(!next)throw new Error('Route content unavailable');
      // Localize while detached, before the browser can paint a new route.
      hooks.prepare(next,parsed.title);
      // Keep the example directory's DOM and scroll position across example routes.
      const oldSide=root.querySelector<HTMLElement>('.examples-sidebar'),newSide=next.querySelector<HTMLElement>('.examples-sidebar');
      dispose();
      if(oldSide&&newSide){const selected=newSide.querySelector('a[aria-current]')?.getAttribute('href');for(const link of oldSide.querySelectorAll('a')){if(link.getAttribute('href')===selected)link.setAttribute('aria-current','page');else link.removeAttribute('aria-current');}newSide.replaceWith(oldSide);}
      if(!pop){saveScroll();history.pushState({scroll:[0,0]},'',url);}
      root.replaceWith(next);root=next;document.body.className=parsed.body.className;
      current=url;navState(url);dispose=hooks.mount(root);hooks.navigated();
      position(url,restore);
      const heading=root.querySelector<HTMLElement>('h1');if(heading){heading.tabIndex=-1;heading.focus({preventScroll:true});}
      document.dispatchEvent(new CustomEvent('routechange',{detail:{path:url.pathname}}));
    }catch(error){if(id!==sequence||(error as Error).name==='AbortError')return;if(pop)history.replaceState(history.state,'',current);hooks.failed();}
    finally{if(id===sequence)document.documentElement.removeAttribute('data-route-loading');}
  }
  document.addEventListener('click',event=>{
    if(event.defaultPrevented||event.button!==0||event.metaKey||event.ctrlKey||event.shiftKey||event.altKey)return;
    const link=(event.target as Element|null)?.closest<HTMLAnchorElement>('a[href]');
    if(!link||link.hasAttribute('download')||(link.target&&link.target!=='_self')||link.hasAttribute('data-native-navigation'))return;
    const url=new URL(link.href,location.href);if(!routePath(url))return;
    event.preventDefault();void navigate(url);
  });
  window.addEventListener('popstate',event=>{const url=new URL(location.href);if(routePath(url))void navigate(url,true,event.state?.scroll);});
  let scrollFrame=0;window.addEventListener('scroll',()=>{if(scrollFrame)return;scrollFrame=requestAnimationFrame(()=>{scrollFrame=0;saveScroll();});},{passive:true});
  window.addEventListener('pagehide',()=>{sequence++;pending?.abort();dispose();});
  window.addEventListener('pageshow',event=>{if(event.persisted)dispose=hooks.mount(root);});
  navState(current);if(current.hash)requestAnimationFrame(()=>position(current));
}
