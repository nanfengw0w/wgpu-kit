import { sitePath } from './paths';
import { MATERIALS, mountMaterial } from './gpu/materials';
import { SILK_METADATA, mountSilk } from './gpu/silk';
import formattedSources from '../content/formatted-sources.json';
import { startRouter } from './router';
import { bindDiscreteWheel } from './wheel';
import { bindLiveStudies } from './live-studies';
import { bindDepthLight } from './depth-light';
import { highlightSource, highlightPre } from './highlight';
import { TACTILE, TACTILE_SOURCES, mountTactile } from './gpu/tactile';
import { mountCosmos } from './gpu/cosmic';
import { LABS, LAB_SOURCES, mountLab } from './gpu/labs';
import { initPreferences, applyLanguage, t, theme, themeProgress, language, setPageTitle, updateThemeAssets } from './i18n';
import { mountHero } from './gpu/hero';
import { DEMOS, DEMO_SOURCES, mountExample, runPrimitives, type DemoController } from './gpu/examples';
const $=<T extends HTMLElement=HTMLElement>(s:string)=>document.querySelector<T>(s)!;
const $$=<T extends HTMLElement=HTMLElement>(s:string)=>[...document.querySelectorAll<T>(s)];
let wheelCleanup=bindDiscreteWheel();
window.addEventListener('pagehide',()=>wheelCleanup());
window.addEventListener('pageshow',event=>{if(event.persisted)wheelCleanup=bindDiscreteWheel();});
const reduced=matchMedia('(prefers-reduced-motion: reduce)').matches;
const controllers:(DemoController & {setTheme?:(value:'dark'|'light')=>void;setThemeProgress?:(value:number)=>void})[]=[];
initPreferences(value=>{for(const c of controllers)c.setTheme?.(value);});
document.addEventListener('themeprogress',event=>{const p=(event as CustomEvent<number>).detail;for(const c of controllers){c.setThemeProgress?.(p);c.setParameter?.('theme',p);}});
let toastTimer:ReturnType<typeof setTimeout>;
const tTranslate=t;
function toast(t:string){$('#toast').textContent=tTranslate(t);$('#toast').classList.add('show');clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('#toast').classList.remove('show'),2200);}
const copiedTimers=new WeakMap<HTMLElement,ReturnType<typeof setTimeout>>();
async function copy(t:string,button?:HTMLElement){try{await navigator.clipboard.writeText(t);toast('Copied to clipboard');if(button){clearTimeout(copiedTimers.get(button));button.dataset.copied='true';copiedTimers.set(button,setTimeout(()=>{delete button.dataset.copied;copiedTimers.delete(button);},2200));}}catch{if(button){clearTimeout(copiedTimers.get(button));delete button.dataset.copied;copiedTimers.delete(button);}toast('Clipboard unavailable. Select the source text to copy.');}}
function setTab(button:HTMLElement){const p=button.parentElement!;p.querySelectorAll<HTMLElement>('[role=tab]').forEach(t=>{t.setAttribute('aria-selected',String(t===button));t.tabIndex=t===button?0:-1;});}
window.addEventListener('scroll',()=>$('#header').classList.toggle('scrolled',scrollY>24),{passive:true});
$('#menu-toggle').addEventListener('click',()=>{const state=$('.nav-links').classList.toggle('open');$('#menu-toggle').setAttribute('aria-expanded',String(state));});
$$('.nav-links a').forEach(a=>a.addEventListener('click',()=>{$('.nav-links').classList.remove('open');$('#menu-toggle').setAttribute('aria-expanded','false');}));
const searchItems=[['Getting started','Install wgpu-kit. First compute kernel. npm','/docs/#getting-started'],['Element kernels','elementKernel WGSL userFn prepare run encode','/docs/#kernels'],['GPU buffers','Buffer create write read destroy storage','/docs/#buffers'],['Typed schemas','defineSchema TypeScript schema inference','/docs/#schemas'],['Ping-pong state','PingPong double buffer simulation','/docs/#ping-pong'],['Composition','prepare encode submit endSubmit pipelines','/docs/#composition'],['Shared devices','GpuContext adopt existing GPUDevice rendering','/docs/#shared-device'],['Scan and reduce','u32 primitives prefix sum reduce','/docs/#primitives'],['API reference','Core functions entry points types methods','/docs/#api-reference'],['Browser support','WebGPU hardware browser GPU unavailable','/docs/#browser-support'],['Sculpted ribbon','Interactive 3D compute geometry normals','/examples/sculpted-ribbon/'],...[...DEMOS,...MATERIALS,SILK_METADATA,...TACTILE,...LABS].map(d=>[d.title,d.description,`/examples/${d.id}/`])];
if(document.documentElement.dataset.apiReady==='true')fetch(sitePath('/api-search.json?v='+document.documentElement.dataset.assets)).then(r=>r.ok?r.json():[]).then(items=>{searchItems.push(...items);if(dialog.open)results();}).catch(()=>{});
const dialog=$<HTMLDialogElement>('#search-dialog');const search=$<HTMLInputElement>('#doc-search');
function results(){const q=search.value.toLowerCase().trim();const matches=searchItems.filter(x=>(x[0]+' '+x[1]+' '+(x[3]??'')+' '+(x[4]??'')+' '+t(x[0])+' '+t(x[1])).toLowerCase().includes(q)).slice(0,9);$('#search-results').replaceChildren(...matches.map(x=>{const a=document.createElement('a');a.href=sitePath(x[2]);const b=document.createElement('strong');b.textContent=t(x[0]);const p=document.createElement('span');p.textContent=language==='zh'&&x[3]?x[3]:t(x[1]);a.append(b,p);return a;}));if(!matches.length)$('#search-results').textContent=t('No matching pages. Try “kernel”, “buffer”, or “WebGPU”.');}
function openSearch(){dialog.showModal();search.focus();results();}
$('#search-trigger').addEventListener('click',openSearch);search.addEventListener('input',results);dialog.addEventListener('click',e=>{if(e.target===dialog)dialog.close();});window.addEventListener('keydown',e=>{if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==='k'){e.preventDefault();openSearch();}});
const escape=(s:string)=>s.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
function highlight(text:string){return highlightSource(text,'typescript');}
const homeCode={kernel:`import { Buffer, elementKernel } from 'wgpu-kit';

const data = await Buffer.create('f32', 4);
data.write(new Float32Array([1, 2, 3, 4]));

const scale = elementKernel({
  state: { data: 'f32' },
  uniforms: { factor: 'f32' },
  code: \`fn userFn(i: u32, factor: f32) {
    data[i] = data[i] * factor;
  }\`,
});
await scale.run({ data }, { factor: 3 });
console.log(await data.read()); // [3, 6, 9, 12]`,compose:`// Prepare once, then compose your frame.
await Promise.all([geometry.prepare(), normals.prepare()]);

const encoder = device.createCommandEncoder();
geometry.encode(encoder, geometryBuffers, { time });
normals.encode(encoder, normalBuffers);

// Your native render pass reads the same GPU storage.
const pass = encoder.beginRenderPass(renderDescriptor);
pass.setPipeline(renderPipeline);
pass.setBindGroup(0, sharedStorageBindings);
pass.draw(vertexCount);
pass.end();
device.queue.submit([encoder.finish()]);
geometry.endSubmit(); normals.endSubmit();`,device:`import { GpuContext, Buffer } from 'wgpu-kit';

// Before any wgpu-kit allocation:
GpuContext.adopt(yourExistingDevice);

const vertices = await Buffer.create('vec4f', vertexCount);

// Bind the storage buffer in a native WebGPU pipeline.
const bindings = yourExistingDevice.createBindGroup({
  layout: pipeline.getBindGroupLayout(0),
  entries: [{
    binding: 0,
    resource: { buffer: vertices.gpuBuffer },
  }],
});`};
function mountRoute(root:HTMLElement){
 const $=<T extends HTMLElement=HTMLElement>(selector:string)=>root.querySelector<T>(selector)!;
 const $$=<T extends HTMLElement=HTMLElement>(selector:string)=>[...root.querySelectorAll<T>(selector)];
 let alive=true;const abort=new AbortController(),signal=abort.signal;
 const owned=new Set<(typeof controllers)[number]>(),disposers:(()=>void)[]=[];
 const track=(controller:(typeof controllers)[number])=>{if(!alive){controller.destroy();return false;}owned.add(controller);controllers.push(controller);controller.setTheme?.(theme);controller.setThemeProgress?.(themeProgress);controller.setParameter?.('theme',themeProgress);return true;};
$$('[role=tablist]').forEach(list=>{const tabs=[...list.querySelectorAll<HTMLElement>('[role=tab]')];tabs.forEach((t,i)=>t.addEventListener('keydown',e=>{let j=i;if(e.key==='ArrowRight')j=(i+1)%tabs.length;else if(e.key==='ArrowLeft')j=(i-1+tabs.length)%tabs.length;else if(e.key==='Home')j=0;else if(e.key==='End')j=tabs.length-1;else return;e.preventDefault();tabs[j].focus();tabs[j].click();}));});
let activeCode:keyof typeof homeCode='kernel';
if($('#home-code')){$('#home-code').innerHTML=highlight(homeCode.kernel);$$<HTMLButtonElement>('[data-home-code]').forEach(b=>b.addEventListener('click',()=>{activeCode=b.dataset.homeCode as keyof typeof homeCode;setTab(b);$('#home-code').innerHTML=highlight(homeCode[activeCode]);}));$('#home-copy').addEventListener('click',event=>copy(homeCode[activeCode],event.currentTarget as HTMLElement));}
let install='npm i wgpu-kit';if($('#setup-command')){$$<HTMLButtonElement>('[data-manager]').forEach(b=>b.addEventListener('click',()=>{setTab(b);install=b.dataset.manager==='npm'?'npm i wgpu-kit':`${b.dataset.manager} add wgpu-kit`;$('#setup-command code').textContent=install;}));$('#setup-command').addEventListener('click',event=>copy(install,event.currentTarget as HTMLElement));}

function statusIsError(s:string){return/error|lost|unavailable|could not/i.test(s);}
async function initHero(){if(!$('#hero-canvas'))return;try{const controller=await mountCosmos($<HTMLCanvasElement>('#hero-canvas'),s=>{if(!alive)return;$('#hero-status').textContent=t(s);$('#hero-canvas').dataset.runtime=statusIsError(s)?'error':'live';if(statusIsError(s)){const el=$('#hero-unavailable');el.hidden=false;el.querySelector('p')!.textContent=s;}},{reducedMotion:reduced,theme,interactionTarget:$<HTMLElement>('.hero')});if(!track(controller))return;disposers.push(bindDepthLight($<HTMLCanvasElement>('#hero-canvas'),$$<HTMLElement>('.home-main .example-card,.home-main .code-showcase,.home-main .docs-teaser>div>a'),(state,surfaces)=>controller.setDepthLight(state,surfaces),reduced));controller.setThemeProgress(themeProgress);let paused=reduced;if(reduced){controller.setPaused(true);$('#hero-pause').textContent='▶';$('#hero-pause').setAttribute('aria-label',t('Resume sky'));}$('#hero-pause').addEventListener('click',()=>{paused=!paused;controller.setPaused(paused);$('#hero-pause').textContent=paused?'▶':'Ⅱ';$('#hero-pause').setAttribute('aria-label',paused?'Resume sky':'Pause sky');});$('#hero-reset').addEventListener('click',()=>controller.reset());}catch(e){if(!alive)return;$('#hero-status').textContent=t('WebGPU unavailable');$('#hero-canvas').dataset.runtime='unavailable';$('#hero-unavailable').hidden=false;$('#hero-unavailable p').textContent=e instanceof Error?e.message:String(e);}}
void initHero();
if($('.featured-studies'))disposers.push(bindLiveStudies(root,{
 reducedMotion:reduced,coarsePointer:matchMedia('(pointer: coarse)').matches,translate:t,
 mount:(id,canvas,status,onFrame)=>id==='silk-cloth'?mountSilk(canvas,status,{reducedMotion:reduced,theme,onFrame}):mountTactile(id,canvas,status,{reducedMotion:reduced,theme,onFrame}),
 register:controller=>{controllers.push(controller);controller.setParameter?.('theme',themeProgress);return()=>{const i=controllers.indexOf(controller);if(i>=0)controllers.splice(i,1);};},
}));


// Preview cards use the same real GPU applications as the full examples.
const previewObserver=new IntersectionObserver(entries=>{if(!alive)return;for(const entry of entries){if(!entry.isIntersecting)continue;previewObserver.unobserve(entry.target);const c=entry.target as HTMLCanvasElement;const id=c.dataset.preview!;const label=c.parentElement!.querySelector<HTMLElement>('.preview-state')!;const update=(s:string)=>{if(!alive)return;label.textContent=s;const error=statusIsError(s);label.classList.toggle('error',error);c.dataset.runtime=error?'error':'live';};const mount=id==='sculpted-ribbon'?mountHero(c,update,{reducedMotion:reduced}):mountExample(id,c,update);mount.then(controller=>{if(!track(controller))return;if(reduced)controller.setPaused(true);}).catch(e=>{if(!alive)return;c.dataset.runtime='unavailable';label.textContent=t('WebGPU unavailable · Open source');label.classList.add('error');});}},{rootMargin:'40px'});
$$<HTMLCanvasElement>('[data-preview]').forEach(c=>previewObserver.observe(c));

const detail=$('.demo-page');if(detail){const id=detail.dataset.example!;let source=(formattedSources as Record<string,string>)[id]??TACTILE_SOURCES[id]??LAB_SOURCES[id]??DEMO_SOURCES[id]??'';const sourceElement=$('#example-source');const setSource=()=>{sourceElement.innerHTML=highlight(source);};if(id==='sculpted-ribbon'&&!source){fetch(sitePath('/source/hero.ts'),{signal}).then(r=>{if(!r.ok)throw Error('Source unavailable');return r.text();}).then(s=>{if(!alive)return;source=s;setSource();}).catch(()=>{if(!alive)return;source='Could not load the source file. Use the download link above.';setSource();});}else setSource();$('#copy-example').addEventListener('click',event=>copy(source,event.currentTarget as HTMLElement));$$<HTMLButtonElement>('[data-view]').forEach(b=>b.addEventListener('click',()=>{setTab(b);const preview=b.dataset.view==='preview';$('#preview-pane').hidden=!preview;$('#source-pane').hidden=preview;}));
 if(id!=='prefix-sum'){let controller:DemoController|null=null,paused=false;const status=$('#demo-status'),canvas=$<HTMLCanvasElement>('#demo-canvas');const update=(s:string)=>{if(!alive)return;status.textContent=t(s);canvas.dataset.runtime=statusIsError(s)?'error':'live';if(statusIsError(s)){$('#demo-unavailable').hidden=false;$('#demo-error-message').textContent=s;}};const mount=id==='sculpted-ribbon'?mountHero(canvas,update,{reducedMotion:reduced}):id==='silk-cloth'?mountSilk(canvas,update,{reducedMotion:reduced,theme}):MATERIALS.some(l=>l.id===id)?mountMaterial(id,canvas,update,{reducedMotion:reduced,theme}):TACTILE.some(l=>l.id===id)?mountTactile(id,canvas,update,{reducedMotion:reduced,theme}):LABS.some(l=>l.id===id)?mountLab(id,canvas,update,{reducedMotion:reduced,theme}):mountExample(id,canvas,update,{theme});mount.then(c=>{controller=c;if(!track(c))return;if(reduced&&id!=='sculpted-ribbon'){paused=true;c.setPaused(true);$('#demo-pause').textContent=t('▶ Resume');}}).catch(e=>{if(!alive)return;canvas.dataset.runtime='unavailable';status.textContent=t('WebGPU unavailable');$('#demo-unavailable').hidden=false;$('#demo-error-message').textContent=e instanceof Error?e.message:String(e);$<HTMLButtonElement>('#demo-pause').disabled=true;});$('#demo-reset').addEventListener('click',()=>{controller?.reset();$$<HTMLInputElement|HTMLSelectElement>('[data-param]').forEach(input=>{input.value=input.dataset.initialValue??(input as HTMLInputElement).defaultValue;controller?.setParameter?.(input.dataset.param!,Number(input.value));const out=input.parentElement?.querySelector('output');if(out)out.textContent=input.value;});});$('#demo-pause').addEventListener('click',()=>{if(!controller)return;paused=!paused;controller.setPaused(paused);$('#demo-pause').textContent=t(paused?'▶ Resume':'Ⅱ Pause');});$$<HTMLInputElement|HTMLSelectElement>('[data-param]').forEach(input=>{input.dataset.initialValue=input.value;input.addEventListener('input',()=>{controller?.setParameter?.(input.dataset.param!,Number(input.value));const out=input.parentElement?.querySelector('output');if(out)out.textContent=Number(input.value).toFixed(2).replace(/\.?0+$/,'');});});
 }else{$('#run-compute').addEventListener('click',async()=>{const tokens=$<HTMLInputElement>('#numbers').value.split(',').map(x=>x.trim());if(!tokens.length||tokens.length>16||tokens.some(x=>!/^\d+$/.test(x)||Number(x)>4294967295)){toast('Enter 1–16 u32 integers, separated by commas.');return;}const btn=$<HTMLButtonElement>('#run-compute');btn.disabled=true;$('#demo-status').textContent=t('Dispatching WebGPU…');try{const r=await runPrimitives(new Uint32Array(tokens.map(Number)));if(!alive)return;$('#scan-result').style.gridTemplateColumns=`repeat(${Math.min(8,r.prefix.length)},minmax(0,1fr))`;$('#scan-result').innerHTML=r.prefix.map(n=>`<span title="${n}">${n.toLocaleString('en-US')}</span>`).join('');$('#reduce-result').textContent=r.total.toLocaleString('en-US');$('#demo-status').textContent=t(r.correct?'WebGPU · Result verified':'GPU result mismatch');$('#compute-note').textContent=t(r.correct?'GPU output matches u32 CPU reference arithmetic. Values wrap at 2³².':'The GPU output did not match expected values.');}catch(e){if(!alive)return;$('#demo-status').textContent=t('WebGPU unavailable');$('#compute-note').textContent=e instanceof Error?e.message:String(e);}finally{btn.disabled=false;}});}}

const apiContent=$('#api-content');
if(apiContent){const english=apiContent.innerHTML;const chinese=$<HTMLTemplateElement>('#api-chinese').innerHTML;const renderApi=()=>{apiContent.innerHTML=language==='zh'?chinese:english;apiContent.querySelectorAll<HTMLElement>('pre').forEach(pre=>{const raw=highlightPre(pre);const b=document.createElement('button');b.type='button';b.className='code-copy';b.textContent='⧉';b.setAttribute('aria-label',t('Copy code sample'));b.addEventListener('click',()=>copy(raw,b));pre.append(b);});document.dispatchEvent(new Event('apidocsrendered'));};renderApi();document.addEventListener('languagechange',renderApi,{signal});}
if($('#copy-docs')){$('#copy-docs').addEventListener('click',event=>copy($('.docs-article').innerText,event.currentTarget as HTMLElement));$$<HTMLElement>('.docs-article pre').forEach(pre=>{if(pre.querySelector('.code-copy'))return;const b=document.createElement('button');b.className='code-copy';b.type='button';b.textContent=t('⧉');b.setAttribute('aria-label','Copy code sample');const code=highlightPre(pre);b.addEventListener('click',()=>copy(code,b));pre.append(b);});const heads=$$<HTMLElement>('.docs-article section[id]');const spy=new IntersectionObserver(entries=>{for(const e of entries){if(e.isIntersecting){$$<HTMLAnchorElement>('.docs-sidebar a,.docs-toc a').forEach(a=>a.classList.toggle('active',a.hash==='#'+e.target.id));}}},{rootMargin:'-90px 0px -65% 0px'});heads.forEach(h=>spy.observe(h));disposers.push(()=>spy.disconnect());document.addEventListener('apidocsrendered',()=>{spy.disconnect();$$<HTMLElement>('.docs-article section[id]').forEach(h=>spy.observe(h));},{signal});}

 applyLanguage(root);updateThemeAssets(root);
 return()=>{alive=false;abort.abort();previewObserver.disconnect();for(const dispose of disposers)dispose();for(const controller of owned){controller.destroy();const index=controllers.indexOf(controller);if(index>=0)controllers.splice(index,1);}owned.clear();};
}
startRouter({
 mount:mountRoute,
 prepare(root,title){setPageTitle(title);applyLanguage(root);updateThemeAssets(root);},
 navigated(){dialog.close();$('.nav-links').classList.remove('open');$('#menu-toggle').setAttribute('aria-expanded','false');},
 failed(){toast('Could not load this page. Please try again.');},
});
applyLanguage();document.documentElement.removeAttribute('data-locale-pending');
