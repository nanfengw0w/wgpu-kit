import { Buffer, GpuContext, PingPong, elementKernel, rawKernel } from 'wgpu-kit';
import type { DemoController } from './examples';

export const MATERIALS = [
  { id: 'magnetic-tide', title: 'Magnetic tide', description: 'Pull a field of black-chrome spikes across a quiet circular pool.', tags: 'height field · magnetic sculpture', param: 'Magnetic strength', min: 0.35, max: 1.8, value: 1, hint: 'Move the magnet across the pool. Press to raise the peaks, then release to let the surface settle.', explanation: 'A custom elementKernel evaluates a localized magnetic envelope and a hexagonal peak pattern. PingPong relaxes the persistent height field toward that target. A native WebGPU mesh reads the height buffer directly, derives normals and reflects an authored studio environment. This is a physically inspired height-field sculpture, not a full magnetohydrodynamics solver.' },
  { id: 'pigment-marbling', title: 'Pigment marbling', description: 'Comb indigo, vermilion and gold through a bath of warm ivory.', tags: 'fluid projection · persistent pigment', param: 'Stir strength', min: 0.3, max: 1.8, value: 1, hint: 'Drag the needle to comb the ink. Switch to Drop pigment to add color, or Ivory to open a clear path. Your marks stay in the fluid.', explanation: 'A velocity grid is advected, stirred, projected through a Jacobi pressure solve and then used to advect a separate, finer pigment buffer. The full pipeline stays on the GPU. Bilinear sampling preserves smooth color bands, while a needle and pigment brush make persistent changes. This is a bounded incompressible-fluid approximation for an interactive marbling bath.' },
] as const;

const magneticCode = `
fn userFn(i:u32,size:u32,hand:vec2f,strength:f32,press:f32,dt:f32) {
  let uv=vec2f(f32(i%size),f32(i/size))/f32(size-1u);
  let p=(uv-0.5)*2.6;
  let rim=1.0-smoothstep(1.10,1.20,length(p));
  let q=p-hand;
  let envelope=exp(-dot(q,q)*2.4);
  let a=cos(p.x*23.0);
  let b=cos(dot(p,vec2f(11.5,19.9186)));
  let c=cos(dot(p,vec2f(-11.5,19.9186)));
  let hex=pow(max(0.0,(a+b+c)/3.0),2.1);
  let desired=rim*(0.018+strength*envelope*(0.05+hex*(0.48+press*0.32)));
  next[i]=mix(previous[i],desired,1.0-exp(-dt*8.0));
}`;
const magneticView = `
struct View { viewport:vec4f, settings:vec4f };
@group(0) @binding(0) var<storage,read> heights:array<f32>;
@group(0) @binding(1) var<uniform> view:View;
struct Vertex { @builtin(position) clip:vec4f, @location(0) world:vec3f, @location(1) normal:vec3f };
fn sampleHeight(x:i32,y:i32)->f32 {
  let n=i32(view.settings.x);
  return heights[u32(clamp(y,0,n-1)*n+clamp(x,0,n-1))];
}
@vertex fn vs(@builtin(vertex_index) id:u32)->Vertex {
  let n=u32(view.settings.x);let cell=id/6u;let k=id%6u;
  let corners=array<vec2u,6>(vec2u(0,0),vec2u(1,0),vec2u(0,1),vec2u(0,1),vec2u(1,0),vec2u(1,1));
  let xy=vec2u(cell%(n-1u),cell/(n-1u))+corners[k];
  let p=(vec2f(xy)/f32(n-1u)-0.5)*2.6;
  let height=sampleHeight(i32(xy.x),i32(xy.y));
  let step=2.6/f32(n-1u);
  let dx=sampleHeight(i32(xy.x)+1,i32(xy.y))-sampleHeight(i32(xy.x)-1,i32(xy.y));
  let dz=sampleHeight(i32(xy.x),i32(xy.y)+1)-sampleHeight(i32(xy.x),i32(xy.y)-1);
  let world=vec3f(p.x,height,p.y);
  let right=vec3f(0.88,0.0,-0.475);let up=vec3f(-0.307,0.763,-0.568);let forward=normalize(cross(right,up));
  let aspect=view.viewport.x/view.viewport.y;
  var out:Vertex;out.world=world;out.normal=normalize(vec3f(-dx,2.0*step,-dz));
  out.clip=vec4f(dot(world,right)*0.72/aspect,(dot(world,up)-0.12)*0.72,0.50-dot(world,forward)*0.13,1.0);
  return out;
}
@fragment fn fs(v:Vertex)->@location(0) vec4f {
  let radius=length(v.world.xz);if(radius>1.20){discard;}
  let normal=normalize(v.normal);let eye=normalize(vec3f(2.1,3.8,4.0)-v.world);let r=reflect(-eye,normal);
  let warm=exp(-pow((r.y-0.65)/0.12,2.0))*smoothstep(-0.85,-0.30,r.x)*(1.0-smoothstep(0.55,0.90,r.x));
  let cold=exp(-pow((r.x+0.72)/0.055,2.0))*smoothstep(-0.2,0.35,r.y);
  let edge=pow(1.0-max(0.0,dot(normal,eye)),3.0);
  var metal=vec3f(0.012,0.018,0.024)+vec3f(0.91,0.72,0.44)*warm+vec3f(0.35,0.67,0.87)*cold*1.2+vec3f(0.09,0.16,0.22)*edge;
  let rim=smoothstep(1.165,1.193,radius);metal=mix(metal,vec3f(0.38,0.29,0.17)*(0.60+0.4*normal.y),rim);
  return vec4f(pow(metal/(metal+0.6),vec3f(0.70)),1.0);
}`;
const advectVelocity = `
fn at(p:vec2f,size:u32)->vec2f {
  let xy=clamp(p,vec2f(0),vec2f(f32(size)-1.001));let a=vec2u(xy);let f=fract(xy);
  return mix(mix(previous[a.y*size+a.x].xy,previous[a.y*size+a.x+1u].xy,f.x),mix(previous[(a.y+1u)*size+a.x].xy,previous[(a.y+1u)*size+a.x+1u].xy,f.x),f.y);
}
fn userFn(i:u32,size:u32,dt:f32,hand:vec2f,movement:vec2f,press:f32,strength:f32) {
  let xy=vec2f(f32(i%size),f32(i/size));let uv=(xy+0.5)/f32(size);
  let v=previous[i].xy;let back=xy-v*dt*f32(size);
  let weight=exp(-dot(uv-hand,uv-hand)*1600.0)*press;
  let force=movement*weight*strength*24.0;
  var value=at(back,size)*0.992+force;
  let speed=length(value);if(speed>1.5){value*=1.5/speed;}
  if(i%size<2u||i%size>size-3u){value.x=0.0;}if(i/size<2u||i/size>size-3u){value.y=0.0;}
  next[i]=vec4f(value,0,0);
}`;
const divergenceCode = `
fn at(x:i32,y:i32,size:u32)->vec2f {return velocity[u32(clamp(y,0,i32(size)-1))*size+u32(clamp(x,0,i32(size)-1))].xy;}
fn userFn(i:u32,size:u32){let x=i32(i%size);let y=i32(i/size);divergence[i]=(at(x+1,y,size).x-at(x-1,y,size).x+at(x,y+1,size).y-at(x,y-1,size).y)*0.5*f32(size);}
`;
const pressureCode = `
fn at(x:i32,y:i32,size:u32)->f32{return previous[u32(clamp(y,0,i32(size)-1))*size+u32(clamp(x,0,i32(size)-1))];}
fn userFn(i:u32,size:u32){let x=i32(i%size);let y=i32(i/size);next[i]=(at(x-1,y,size)+at(x+1,y,size)+at(x,y-1,size)+at(x,y+1,size)-divergence[i]/f32(size*size))*0.25;}
`;
const projectCode = `
fn at(x:i32,y:i32,size:u32)->f32{return pressure[u32(clamp(y,0,i32(size)-1))*size+u32(clamp(x,0,i32(size)-1))];}
fn userFn(i:u32,size:u32){let x=i32(i%size);let y=i32(i/size);let gradient=vec2f(at(x+1,y,size)-at(x-1,y,size),at(x,y+1,size)-at(x,y-1,size))*0.5*f32(size);next[i]=vec4f(velocity[i].xy-gradient,0,0);}
`;
const pigmentCode = `
struct Params { sizes:vec4u, brush:vec4f, step:vec4f };
@group(0) @binding(0) var<storage,read> previous:array<vec4f>;
@group(0) @binding(1) var<storage,read> velocity:array<vec4f>;
@group(0) @binding(2) var<storage,read_write> next:array<vec4f>;
@group(0) @binding(3) var<uniform> params:Params;
fn flow(uv:vec2f)->vec2f{let n=params.sizes.y;let p=clamp(uv*f32(n)-0.5,vec2f(0),vec2f(f32(n)-1.001));let a=vec2u(p);let f=fract(p);return mix(mix(velocity[a.y*n+a.x].xy,velocity[a.y*n+a.x+1u].xy,f.x),mix(velocity[(a.y+1u)*n+a.x].xy,velocity[(a.y+1u)*n+a.x+1u].xy,f.x),f.y);}
fn pigment(uv:vec2f)->vec4f{let n=params.sizes.x;let p=clamp(uv*f32(n)-0.5,vec2f(0),vec2f(f32(n)-1.001));let a=vec2u(p);let f=fract(p);return mix(mix(previous[a.y*n+a.x],previous[a.y*n+a.x+1u],f.x),mix(previous[(a.y+1u)*n+a.x],previous[(a.y+1u)*n+a.x+1u],f.x),f.y);}
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id:vec3u){let n=params.sizes.x;let i=id.x;if(i>=n*n){return;}let uv=(vec2f(f32(i%n),f32(i/n))+0.5)/f32(n);var color=pigment(uv-flow(uv)*params.step.x);let q=uv-params.brush.xy;let brush=exp(-dot(q,q)*3200.0)*params.brush.z;let cream=vec3f(0.95,0.92,0.83);let phase=u32(params.step.y*0.4)%3u;let colors=array<vec3f,3>(vec3f(0.035,0.105,0.20),vec3f(0.72,0.18,0.105),vec3f(0.75,0.48,0.15));if(params.brush.w>0.5){let ink=select(colors[phase],cream,params.brush.w>1.5);color=vec4f(mix(color.rgb,ink,brush*0.5),1);}next[i]=clamp(color,vec4f(0),vec4f(1));}
`;
const pigmentView = `
@group(0) @binding(0) var<storage,read> pigment:array<vec4f>;
@group(0) @binding(1) var<uniform> sizes:vec4u;
struct Out { @builtin(position) p:vec4f,@location(0) uv:vec2f };
@vertex fn vs(@builtin(vertex_index)i:u32)->Out{let p=array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3));var o:Out;o.p=vec4f(p[i],0,1);o.uv=p[i]*vec2f(0.5,-0.5)+0.5;return o;}
@fragment fn fs(v:Out)->@location(0)vec4f{let n=sizes.x;let p=clamp(v.uv*f32(n)-0.5,vec2f(0),vec2f(f32(n)-1.001));let a=vec2u(p);let f=fract(p);return mix(mix(pigment[a.y*n+a.x],pigment[a.y*n+a.x+1u],f.x),mix(pigment[(a.y+1u)*n+a.x],pigment[(a.y+1u)*n+a.x+1u],f.x),f.y);}
`;

export const MATERIAL_SOURCES:Record<string,string>={
  'magnetic-tide':`import { PingPong, elementKernel } from 'wgpu-kit';\n\n// A persistent height field follows a localized magnetic target.\nconst size = 160;\nconst field = await PingPong.create({ height: 'f32' }, size * size);\nconst sculpt = elementKernel({\n  state: { next: 'f32' },\n  inputs: { previous: 'f32' },\n  uniforms: { size: 'u32', hand: 'vec2f', strength: 'f32', press: 'f32', dt: 'f32' },\n  code: \`${magneticCode}\`,\n});\nawait sculpt.prepare();\n\n// Submit one step, then render directly from field.current.height.gpuBuffer.\nawait sculpt.run({ next: field.other.height, previous: field.current.height }, {\n  size, hand: { x: 0, y: 0 }, strength: 1, press: 0, dt: 1 / 60,\n});\nfield.swap();`,
  'pigment-marbling':`import { rawKernel } from 'wgpu-kit';\n\n// Velocity and pigment have different resolutions, so use explicit raw bindings.\n// The full module first advects velocity, solves pressure, and projects flow.\nconst advectPigment = rawKernel(\`${pigmentCode}\`);\nawait advectPigment.prepare();\n\n// In each frame, bind previous pigment, projected velocity, next pigment and\n// the parameter buffer, then encode into the same command encoder.\n// Download materials.ts for the complete fluid solver and resource lifecycle.`,
};

// The reading view includes every numerical stage used by the live fluid.
MATERIAL_SOURCES['pigment-marbling'] = `import { Buffer, PingPong, elementKernel, rawKernel } from 'wgpu-kit';

const size = 128;
const pigmentSize = 512;
const velocity = await PingPong.create({ flow: 'vec4f' }, size * size);
const pressure = await PingPong.create({ value: 'f32' }, size * size);
const divergence = await Buffer.create('f32', size * size);
const pigment = await PingPong.create({ color: 'vec4f' }, pigmentSize * pigmentSize);

// 1. Trace velocity backward through the previous field, then add the needle force.
const advect = elementKernel({
  state: { next: 'vec4f' }, inputs: { previous: 'vec4f' },
  uniforms: { size: 'u32', dt: 'f32', hand: 'vec2f', movement: 'vec2f', press: 'f32', strength: 'f32' },
  code: \`${advectVelocity}\`,
});

// 2. Measure local expansion and compression in the velocity field.
const measure = elementKernel({
  state: { divergence: 'f32' }, inputs: { velocity: 'vec4f' },
  uniforms: { size: 'u32' }, code: \`${divergenceCode}\`,
});

// 3. Solve pressure with 20 Jacobi iterations.
// Distinct instances respect elementKernel's one-encode-per-submit constraint.
const pressureSteps = Array.from({ length: 20 }, () => elementKernel({
  state: { next: 'f32' }, inputs: { previous: 'f32', divergence: 'f32' },
  uniforms: { size: 'u32' }, code: \`${pressureCode}\`,
}));

// 4. Remove the pressure gradient to approximate incompressible flow.
const project = elementKernel({
  state: { next: 'vec4f' }, inputs: { velocity: 'vec4f', pressure: 'f32' },
  uniforms: { size: 'u32' }, code: \`${projectCode}\`,
});

// 5. Advect the finer pigment grid with that projected velocity.
// rawKernel permits different buffer lengths and explicit bindings.
const transport = rawKernel(\`${pigmentCode}\`);
await Promise.all([
  advect.prepare(), measure.prepare(), project.prepare(), transport.prepare(),
  ...pressureSteps.map(step => step.prepare()),
]);

// Each frame uses one command encoder and no simulation readback.
// Seed both pigment buffers before the first frame; the live study uses
// indigo, vermilion, gold and ivory bands as its initial condition.
function encodeFlow(encoder: GPUCommandEncoder, dt: number,
  hand: { x: number; y: number }, movement: { x: number; y: number },
  pressed: boolean, strength: number, parameters: GPUBuffer) {
  advect.encode(encoder, {
    next: velocity.other.flow, previous: velocity.current.flow,
  }, { size, dt, hand, movement, press: pressed ? 1 : 0, strength });
  velocity.swap();

  measure.encode(encoder, { divergence, velocity: velocity.current.flow }, { size });
  for (const solve of pressureSteps) {
    solve.encode(encoder, {
      next: pressure.other.value, previous: pressure.current.value, divergence,
    }, { size });
    pressure.swap();
  }

  project.encode(encoder, {
    next: velocity.other.flow, velocity: velocity.current.flow,
    pressure: pressure.current.value,
  }, { size });
  velocity.swap();

  transport.encode(encoder, [
    { binding: 0, resource: { buffer: pigment.current.color.gpuBuffer } },
    { binding: 1, resource: { buffer: velocity.current.flow.gpuBuffer } },
    { binding: 2, resource: { buffer: pigment.other.color.gpuBuffer } },
    { binding: 3, resource: { buffer: parameters } },
  ], Math.ceil(pigmentSize * pigmentSize / 64));
  pigment.swap();
}
// After queue.submit(), call endSubmit() on every encoded elementKernel.
// Download materials.ts for parameter packing, rendering, input and cleanup.
`;

export async function mountMaterial(id:string,canvas:HTMLCanvasElement,onStatus:(s:string)=>void,options:{reducedMotion?:boolean;theme?:string}={}):Promise<DemoController>{
  const fluid=id==='pigment-marbling';const spec=MATERIALS.find(x=>x.id===id);if(!spec)throw Error('Unknown material study');
  const ctx=await GpuContext.get(),device=ctx.device;const surface=canvas.getContext('webgpu');if(!surface)throw Error('WebGPU canvas unavailable');const format=navigator.gpu.getPreferredCanvasFormat();surface.configure({device,format,alphaMode:'opaque'});
  const size=fluid?128:160,dyeSize=512;
  const field=await PingPong.create({height:'f32'},size*size);
  const velocity=fluid?await PingPong.create({flow:'vec4f'},size*size):null;
  const pigment=fluid?await PingPong.create({color:'vec4f'},dyeSize*dyeSize):null;
  const divergence=fluid?await Buffer.create('f32',size*size):null;
  const uniform=device.createBuffer({size:48,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});
  const view=device.createBuffer({size:32,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});
  const magnetic=!fluid?elementKernel({name:'magnetic-height-field',state:{next:'f32'},inputs:{previous:'f32'},uniforms:{size:'u32',hand:'vec2f',strength:'f32',press:'f32',dt:'f32'},code:magneticCode}):null;
  const advect=fluid?elementKernel({name:'marbling-velocity-advection',state:{next:'vec4f'},inputs:{previous:'vec4f'},uniforms:{size:'u32',dt:'f32',hand:'vec2f',movement:'vec2f',press:'f32',strength:'f32'},code:advectVelocity}):null;
  const div=fluid?elementKernel({name:'marbling-divergence',state:{divergence:'f32'},inputs:{velocity:'vec4f'},uniforms:{size:'u32'},code:divergenceCode}):null;
  const pressure=fluid?Array.from({length:20},(_,i)=>elementKernel({name:'marbling-pressure-'+i,state:{next:'f32'},inputs:{previous:'f32',divergence:'f32'},uniforms:{size:'u32'},code:pressureCode})):[];
  const project=fluid?elementKernel({name:'marbling-project',state:{next:'vec4f'},inputs:{velocity:'vec4f',pressure:'f32'},uniforms:{size:'u32'},code:projectCode}):null;
  const dye=fluid?rawKernel(pigmentCode,'main','marbling-pigment-advection'):null;
  const kernels=[magnetic,advect,div,...pressure,project].filter(Boolean) as NonNullable<typeof magnetic>[];
  await Promise.all([...kernels.map(k=>k.prepare()),dye?.prepare()]);
  const module=device.createShaderModule({code:fluid?pigmentView:magneticView});
  const pipeline=await device.createRenderPipelineAsync({layout:'auto',vertex:{module,entryPoint:'vs'},fragment:{module,entryPoint:'fs',targets:[{format}]},primitive:{topology:'triangle-list',cullMode:'none'},...(!fluid?{depthStencil:{format:'depth24plus' as GPUTextureFormat,depthWriteEnabled:true,depthCompare:'less' as GPUCompareFunction}}:{})});
  const bindings=new Map<GPUBuffer,GPUBindGroup>();for(const buffer of fluid?[pigment!.current.color.gpuBuffer,pigment!.other.color.gpuBuffer]:[field.current.height.gpuBuffer,field.other.height.gpuBuffer])bindings.set(buffer,device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer}},{binding:1,resource:{buffer:fluid?uniform:view,offset:0,size:fluid?16:32}}]}));
  let dead=false,paused=!!options.reducedMotion,dirty=true,visible=true,frame=0,last=0,time=0,amount:number=spec.value,tool=0,light=options.theme==='light'?1:0,down=false;
  let hand={x:0.5,y:0.5},movement={x:0,y:0};let depth:GPUTexture|undefined,w=0,h=0;
  const seed=()=>{for(const side of[field.current,field.other])side.height.write(new Float32Array(size*size));if(fluid){for(const side of[velocity!.current,velocity!.other])side.flow.write(new Float32Array(size*size*4));const data=new Float32Array(dyeSize*dyeSize*4);const colors=[[0.95,0.92,0.83],[0.035,0.105,0.20],[0.95,0.92,0.83],[0.72,0.18,0.105],[0.95,0.92,0.83],[0.75,0.48,0.15]];for(let y=0;y<dyeSize;y++)for(let x=0;x<dyeSize;x++){const u=x/dyeSize,v=y/dyeSize;const bands=(u+0.19*Math.sin(v*8.0)+0.028*Math.cos(v*39.0+u*4.0))*16;const k=((Math.floor(bands)%6)+6)%6;const i=(y*dyeSize+x)*4;const f=bands-Math.floor(bands);const t=Math.min(1,f/0.045);const blend=t*t*(3-2*t);const previous=colors[(k+5)%6];data.set([...colors[k].map((c,j)=>previous[j]+(c-previous[j])*blend),1],i);}for(const side of[pigment!.current,pigment!.other])side.color.write(data);}};seed();
  const request=()=>{if(!frame&&!dead&&visible&&!document.hidden)frame=requestAnimationFrame(draw);};
  function draw(now:number){frame=0;if(dead||!visible||document.hidden)return;if(paused&&!dirty)return;const dt=last?Math.min(1/30,(now-last)/1000):1/60;last=now;time+=dt;dirty=false;const r=canvas.getBoundingClientRect(),dpr=Math.min(devicePixelRatio||1,1.5);const width=Math.max(1,Math.round(r.width*dpr)),height=Math.max(1,Math.round(r.height*dpr));if(width!==w||height!==h){canvas.width=w=width;canvas.height=h=height;depth?.destroy();if(!fluid)depth=device.createTexture({size:[w,h],format:'depth24plus',usage:GPUTextureUsage.RENDER_ATTACHMENT});}
    try{const enc=device.createCommandEncoder();if(fluid){advect!.encode(enc,{next:velocity!.other.flow,previous:velocity!.current.flow},{size,dt,hand,movement,press:down?1:0,strength:amount});velocity!.swap();div!.encode(enc,{divergence:divergence!,velocity:velocity!.current.flow},{size});for(const solve of pressure){solve.encode(enc,{next:field.other.height,previous:field.current.height,divergence:divergence!},{size});field.swap();}project!.encode(enc,{next:velocity!.other.flow,velocity:velocity!.current.flow,pressure:field.current.height},{size});velocity!.swap();const bytes=new ArrayBuffer(48);new Uint32Array(bytes,0,4).set([dyeSize,size,0,0]);new Float32Array(bytes,16,8).set([hand.x,hand.y,down?1:0,tool,dt,time,0,0]);device.queue.writeBuffer(uniform,0,bytes);dye!.encode(enc,[{binding:0,resource:{buffer:pigment!.current.color.gpuBuffer}},{binding:1,resource:{buffer:velocity!.current.flow.gpuBuffer}},{binding:2,resource:{buffer:pigment!.other.color.gpuBuffer}},{binding:3,resource:{buffer:uniform}}],Math.ceil(dyeSize*dyeSize/64));pigment!.swap();}else{magnetic!.encode(enc,{next:field.other.height,previous:field.current.height},{size,hand:{x:(hand.x-0.5)*2.0,y:(hand.y-0.5)*2.0},strength:amount,press:down?1:0,dt:paused&&time<=dt+0.000001?1:dt});field.swap();device.queue.writeBuffer(view,0,new Float32Array([w,h,time,light,size,0,0,0]));}
    const clear=light>0.5?{r:0.94,g:0.925,b:0.88,a:1}:{r:0.025,g:0.033,b:0.046,a:1};const pass=enc.beginRenderPass({colorAttachments:[{view:surface!.getCurrentTexture().createView(),loadOp:'clear',storeOp:'store',clearValue:clear}],...(!fluid?{depthStencilAttachment:{view:depth!.createView(),depthClearValue:1,depthLoadOp:'clear' as GPULoadOp,depthStoreOp:'store' as GPUStoreOp}}:{})});pass.setPipeline(pipeline);pass.setBindGroup(0,bindings.get(fluid?pigment!.current.color.gpuBuffer:field.current.height.gpuBuffer)!);pass.draw(fluid?3:(size-1)*(size-1)*6);pass.end();device.queue.submit([enc.finish()]);for(const kernel of kernels)kernel.endSubmit();movement.x*=0.3;movement.y*=0.3;if(!paused)request();}
    catch(e){for(const kernel of kernels)kernel.endSubmit();paused=true;onStatus('GPU error: '+String(e));}
  }
  const abort=new AbortController(),signal=abort.signal;const previousTouch=canvas.style.touchAction;canvas.style.touchAction='none';
  const pointer=(event:PointerEvent)=>{const r=canvas.getBoundingClientRect(),x=Math.max(0,Math.min(1,(event.clientX-r.left)/r.width)),y=Math.max(0,Math.min(1,(event.clientY-r.top)/r.height));movement={x:Math.max(-0.04,Math.min(0.04,x-hand.x)),y:Math.max(-0.04,Math.min(0.04,y-hand.y))};hand={x,y};dirty=true;request();};
  canvas.addEventListener('pointermove',pointer,{signal});canvas.addEventListener('pointerdown',e=>{pointer(e);down=true;movement={x:0,y:0};canvas.setPointerCapture(e.pointerId);dirty=true;request();},{signal});for(const type of['pointerup','pointercancel','lostpointercapture'])canvas.addEventListener(type,()=>{down=false;movement={x:0,y:0};dirty=true;request();},{signal});
  canvas.addEventListener('keydown',e=>{let dx=0,dy=0;if(e.key==='ArrowLeft')dx=-0.025;else if(e.key==='ArrowRight')dx=0.025;else if(e.key==='ArrowUp')dy=-0.025;else if(e.key==='ArrowDown')dy=0.025;else return;e.preventDefault();hand={x:Math.max(0,Math.min(1,hand.x+dx)),y:Math.max(0,Math.min(1,hand.y+dy))};movement={x:dx,y:dy};down=true;dirty=true;request();},{signal});canvas.addEventListener('keyup',()=>{down=false;},{signal});
  const observer=new IntersectionObserver(entries=>{visible=entries[0]?.isIntersecting??true;last=0;if(!visible&&frame){cancelAnimationFrame(frame);frame=0;}else request();});observer.observe(canvas);const resize=new ResizeObserver(()=>{dirty=true;request();});resize.observe(canvas);document.addEventListener('visibilitychange',()=>{last=0;if(document.hidden&&frame){cancelAnimationFrame(frame);frame=0;}else{dirty=true;request();}},{signal});const error=(e:GPUUncapturedErrorEvent)=>{paused=true;onStatus('GPU error: '+e.error.message);};device.addEventListener('uncapturederror',error);request();onStatus('Live WebGPU · wgpu-kit 2.0.1');
  return{destroy(){if(dead)return;dead=true;cancelAnimationFrame(frame);abort.abort();observer.disconnect();resize.disconnect();device.removeEventListener('uncapturederror',error);canvas.style.touchAction=previousTouch;for(const k of kernels)k.destroy();dye?.destroy();field.destroy();velocity?.destroy();pigment?.destroy();divergence?.destroy();uniform.destroy();view.destroy();depth?.destroy();surface.unconfigure();},setPaused(value){paused=value;last=0;dirty=true;request();},reset(){seed();time=0;hand={x:0.5,y:0.5};movement={x:0,y:0};amount=spec.value;dirty=true;request();},setParameter(key,value){if(key==='amount')amount=value;if(key==='tool')tool=value;if(key==='theme')light=value;dirty=true;request();}};
}
