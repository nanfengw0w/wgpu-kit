import { GpuContext, Buffer, elementKernel, PingPong, createScan, createReduce } from 'wgpu-kit';
export type DemoController={destroy():void;setPaused(v:boolean):void;reset():void;setParameter?(key:string,value:number):void};
export const DEMOS=[
 {id:'wave-field',title:'Wave interference',description:'Three sources. One field. Interference patterns computed for every pixel.',tags:['elementKernel','field','interaction'],hint:'Move across the canvas to steer the third wave source.'},
 {id:'reaction-diffusion',title:'Reaction diffusion',description:'A two-chemical system evolves through diffusion and reaction on the GPU.',tags:['PingPong','simulation','2D stencil'],hint:'Press and drag to seed new chemical reactions.'},
 {id:'image-convolution',title:'Image convolution',description:'A 3 × 3 neighborhood turns a procedural image into edges, blur, or detail.',tags:['buffers','image processing','compute'],hint:'Move horizontally to compare the original and processed image.'},
 {id:'prefix-sum',title:'Prefix sum + reduction',description:'Exclusive scan and sum use the library’s GPU primitives. Every result is checked.',tags:['u32','scan','reduce'],hint:'Edit the values, then dispatch the real GPU operations.'},
] as const;

const waveCode=`fn userFn(idx: u32, size: u32, time: f32, pointer: vec2f, gain: f32) {
  let uv = vec2f(f32(idx % size), f32(idx / size)) / f32(size);
  let p = (uv - 0.5) * 2.0;
  let a = sin(length(p - vec2f(-0.55, -0.2)) * 27.0 - time * 2.5);
  let b = sin(length(p - vec2f(0.45, 0.3)) * 30.0 - time * 2.0);
  let c = sin(length(p - pointer) * 32.0 - time * 3.0);
  let signal = (a + b + c) / 3.0;
  let ridge = pow(max(0.0, signal), 3.0);
  let phase = 0.5 + 0.5 * signal;
  let tint = 0.5 + 0.5 * cos(6.28318 * (phase * 0.55 + vec3f(0.12, 0.38, 0.68)));
  let vignette = (1.0 - smoothstep(0.25, 1.45, length(p)));
  color[idx] = vec4f((tint * (0.06 + ridge * gain * 1.8) + vec3f(ridge * 0.2)) * vignette, 1.0);
}`;
const reactionCode=`fn sampleAt(x: i32, y: i32, size: u32) -> vec2f {
  let n = i32(size);
  let xx = (x + n) % n;
  let yy = (y + n) % n;
  return previous[u32(yy * n + xx)];
}
fn userFn(idx: u32, size: u32, feed: f32, kill: f32, pointer: vec2f, press: f32) {
  let x = i32(idx % size); let y = i32(idx / size);
  let ab = previous[idx];
  var lap = -ab;
  lap += 0.2 * (sampleAt(x-1,y,size) + sampleAt(x+1,y,size) + sampleAt(x,y-1,size) + sampleAt(x,y+1,size));
  lap += 0.05 * (sampleAt(x-1,y-1,size) + sampleAt(x+1,y-1,size) + sampleAt(x-1,y+1,size) + sampleAt(x+1,y+1,size));
  let reaction = ab.x * ab.y * ab.y;
  var next = ab + vec2f(lap.x - reaction + feed*(1.0-ab.x), 0.5*lap.y + reaction - (kill+feed)*ab.y);
  let uv = vec2f(f32(x),f32(y)) / f32(size);
  if (press > 0.5 && distance(uv,pointer) < 0.04) { next = vec2f(0.4, 0.85); }
  chemicals[idx] = clamp(next,vec2f(0.0),vec2f(1.0));
}`;
const reactionColor=`fn userFn(idx: u32) {
  let a = chemical[idx].x; let b = chemical[idx].y;
  let edge = clamp((a-b)*1.3,0.0,1.0);
  let ink = mix(vec3f(0.012,0.017,0.027),vec3f(0.8,0.23,0.53),smoothstep(0.02,0.34,b));
  let rim = pow(clamp(1.0-abs(b-0.23)*8.0,0.0,1.0),3.0);
  color[idx] = vec4f(ink + vec3f(0.03,0.4,0.6)*rim + vec3f(0.02)*edge,1.0);
}`;
const convolutionCode=`fn sampleAt(x: i32, y: i32, size: u32) -> vec3f {
  let n=i32(size); let xx=clamp(x,0,n-1); let yy=clamp(y,0,n-1);
  return original[u32(yy*n+xx)].xyz;
}
fn userFn(idx: u32, size: u32, mode: u32, split: f32, strength: f32) {
  let x=i32(idx%size); let y=i32(idx/size); let center=original[idx].xyz;
  var result=center;
  if (mode==1u) {
    let gx = -sampleAt(x-1,y-1,size)-2.0*sampleAt(x-1,y,size)-sampleAt(x-1,y+1,size)+sampleAt(x+1,y-1,size)+2.0*sampleAt(x+1,y,size)+sampleAt(x+1,y+1,size);
    let gy = -sampleAt(x-1,y-1,size)-2.0*sampleAt(x,y-1,size)-sampleAt(x+1,y-1,size)+sampleAt(x-1,y+1,size)+2.0*sampleAt(x,y+1,size)+sampleAt(x+1,y+1,size);
    let edge = length(gx)+length(gy);
    result=vec3f(0.3,0.78,1.0)*edge*strength;
  } else if (mode==2u) {
    result=vec3f(0.0);
    for(var yy=-1; yy<=1; yy++){ for(var xx=-1; xx<=1; xx++){
      let weight=select(1.0,2.0,xx==0)*select(1.0,2.0,yy==0);
      result+=sampleAt(x+xx*3,y+yy*3,size)*weight/16.0;
    }}
  } else if (mode==3u) {
    let neighbors=sampleAt(x-1,y,size)+sampleAt(x+1,y,size)+sampleAt(x,y-1,size)+sampleAt(x,y+1,size);
    result=center+(4.0*center-neighbors)*strength;
  }
  if(f32(x)/f32(size)<split){result=center;}
  if(abs(f32(x)/f32(size)-split)<0.003){result=vec3f(0.9);}
  color[idx]=vec4f(clamp(result,vec3f(0.0),vec3f(1.0)),1.0);
}`;
export const DEMO_SOURCES:Record<string,string>={
 'wave-field':`import { Buffer, elementKernel } from 'wgpu-kit';\n\nconst color = await Buffer.create('vec4f', size * size);\nconst waves = elementKernel({\n  state: { color: 'vec4f' },\n  uniforms: { size: 'u32', time: 'f32', pointer: 'vec2f', gain: 'f32' },\n  code: \`${waveCode}\`,\n});\nawait waves.run({ color }, { size, time, pointer: { x: 0, y: 0 }, gain: 1.0 });`,
 'reaction-diffusion':`import { PingPong, elementKernel } from 'wgpu-kit';\n\nconst state = await PingPong.create({ chem: 'vec2f' }, size * size);\nconst step = elementKernel({\n  state: { chemicals: 'vec2f' },\n  inputs: { previous: 'vec2f' },\n  uniforms: { size: 'u32', feed: 'f32', kill: 'f32', pointer: 'vec2f', press: 'f32' },\n  code: \`${reactionCode}\`,\n});\nawait step.run({ chemicals: state.other.chem, previous: state.current.chem },\n  { size, feed: 0.0367, kill: 0.0649, pointer: { x: 0.5, y: 0.5 }, press: 0 });\nstate.swap();`,
 'image-convolution':`import { Buffer, elementKernel } from 'wgpu-kit';\n\nconst original = await Buffer.create('vec4f', size * size);\nconst color = await Buffer.create('vec4f', size * size);\noriginal.write(imagePixels);\nconst filter = elementKernel({\n  state: { color: 'vec4f' },\n  inputs: { original: 'vec4f' },\n  uniforms: { size: 'u32', mode: 'u32', split: 'f32', strength: 'f32' },\n  code: \`${convolutionCode}\`,\n});\nawait filter.run({ color, original }, { size, mode: 1, split: 0.5, strength: 1 });`,
 'prefix-sum':`import { Buffer, createScan, createReduce } from 'wgpu-kit';\n\nconst data = new Uint32Array([3, 1, 4, 1, 5, 9, 2, 6]);\nconst input = await Buffer.create('u32', data.length);\nconst output = await Buffer.create('u32', data.length);\ninput.write(data);\nconst scan = createScan();\nawait scan.run(input, output, data.length, true);\nconst prefix = await output.read();\nconst reduce = createReduce();\nconst sum = await reduce.sum(input, data.length);\n// prefix: [0, 3, 4, 8, 9, 14, 23, 25]; sum: 31\nscan.destroy(); reduce.destroy(); input.destroy(); output.destroy();`
};

const viewShader=`struct Screen { size: u32, width:f32, height:f32, pad:f32 };\n@group(0) @binding(0) var<storage,read> pixels:array<vec4f>;\n@group(0) @binding(1) var<uniform> screen:Screen;\nstruct Out{ @builtin(position) position:vec4f, @location(0) uv:vec2f };\n@vertex fn vs(@builtin(vertex_index) i:u32)->Out{ var p=array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3));var o:Out;o.position=vec4f(p[i],0,1);o.uv=p[i]*vec2f(0.5,-0.5)+0.5;return o;}\n@fragment fn fs(v:Out)->@location(0) vec4f{let x=min(u32(clamp(v.uv.x,0.0,0.999)*f32(screen.size)),screen.size-1u);let y=min(u32(clamp(v.uv.y,0.0,0.999)*f32(screen.size)),screen.size-1u);let c=pixels[y*screen.size+x];return vec4f(mix(c.xyz,c.xyz*.84+vec3f(.86,.90,.94)*.16,screen.pad),1.0);}`;

export async function mountExample(id:string,canvas:HTMLCanvasElement,onStatus:(s:string)=>void,options:{theme?:string}={}):Promise<DemoController>{
 if(id==='prefix-sum')throw new Error('Use runPrimitives for this example.');
 const ctx=await GpuContext.get(),device=ctx.device,size=256;
 const surface=canvas.getContext('webgpu');if(!surface)throw new Error('A WebGPU canvas is not available.');
 const format=navigator.gpu.getPreferredCanvasFormat();surface.configure({device,format,alphaMode:'opaque'});
 const output=await Buffer.create('vec4f',size*size);const screen=device.createBuffer({size:16,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});
 const shader=device.createShaderModule({code:viewShader,label:'wgpu-kit-example-view'});
 const pipeline=await device.createRenderPipelineAsync({layout:'auto',vertex:{module:shader,entryPoint:'vs'},fragment:{module:shader,entryPoint:'fs',targets:[{format}]},primitive:{topology:'triangle-list'}});
 const group=device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:output.gpuBuffer}},{binding:1,resource:{buffer:screen}}]});
 let paused=false,dead=false,frame=0,t=0,last=0,pointer={x:0,y:0},press=0,visible=true;const params={feed:.035,kill:.062,gain:1,mode:1,strength:1,split:.5,theme:options.theme==='light'?1:0};
 let ping:Awaited<ReturnType<typeof PingPong.create<'chem'>>>|null=null,input:Buffer|null=null;let kernel:ReturnType<typeof elementKernel>,colorize:ReturnType<typeof elementKernel>|null=null;
 const initialize=()=>{if(ping){const data=new Float32Array(size*size*2);for(let y=0;y<size;y++)for(let x=0;x<size;x++){const i=(y*size+x)*2;const seed=Math.abs((Math.sin(x*15.13+y*37.2)*43758.5453)%1);let active=false;for(let n=0;n<30;n++){const sx=size*(.1+(((n*37+17)%97)/97)*.8),sy=size*(.1+(((n*61+31)%89)/89)*.8);if(Math.hypot(x-sx,y-sy)<5+(n%3)){active=true;break;}}data[i]=active?.5:1;data[i+1]=active?.28+seed*.1:0;}ping.current.chem.write(data);ping.other.chem.write(data);}};
 if(id==='wave-field'){kernel=elementKernel({name:'wave-interference',state:{color:'vec4f'},uniforms:{size:'u32',time:'f32',pointer:'vec2f',gain:'f32'},code:waveCode});}
 else if(id==='reaction-diffusion'){ping=await PingPong.create({chem:'vec2f'},size*size);initialize();pointer={x:.5,y:.5};kernel=elementKernel({name:'gray-scott',state:{chemicals:'vec2f'},inputs:{previous:'vec2f'},uniforms:{size:'u32',feed:'f32',kill:'f32',pointer:'vec2f',press:'f32'},code:reactionCode});colorize=elementKernel({name:'chemical-color',state:{color:'vec4f'},inputs:{chemical:'vec2f'},code:reactionColor});await colorize.prepare();}
 else{input=await Buffer.create('vec4f',size*size);const values=new Float32Array(size*size*4);for(let y=0;y<size;y++)for(let x=0;x<size;x++){const u=x/size,v=y/size,i=(y*size+x)*4;const circle=Math.hypot(u-.57,v-.49)<.285;const stripe=(Math.floor(u*24)+Math.floor(v*24))%2;const ring=Math.sin(Math.hypot(u-.57,v-.49)*130)*.04;values[i]=circle?.95:u*.44+.025;values[i+1]=circle?.18+v*.45:.08+v*.45+stripe*.12;values[i+2]=circle?.14+ring:.35+u*.28+stripe*.16;values[i+3]=1;if(Math.abs(v-.77)<.055&&u>.12&&u<.82){values[i]=.86;values[i+1]=.93;values[i+2]=.54;}}input.write(values);kernel=elementKernel({name:'image-convolution',state:{color:'vec4f'},inputs:{original:'vec4f'},uniforms:{size:'u32',mode:'u32',split:'f32',strength:'f32'},code:convolutionCode});}
 await kernel.prepare();
 const resize=()=>{const r=canvas.getBoundingClientRect(),d=Math.min(devicePixelRatio||1,1.5);const w=Math.max(1,Math.floor(r.width*d)),h=Math.max(1,Math.floor(r.height*d));if(canvas.width!==w||canvas.height!==h){canvas.width=w;canvas.height=h;}const data=new ArrayBuffer(16);new Uint32Array(data)[0]=size;const f=new Float32Array(data);f[1]=w;f[2]=h;f[3]=params.theme;device.queue.writeBuffer(screen,0,data);};
 const draw=(now:number)=>{if(dead)return;frame=requestAnimationFrame(draw);if(!visible||document.hidden||(paused&&last!==0))return;last=now;resize();t+=1/60;try{
  if(ping){for(let i=0;i<3;i++){const encoder=device.createCommandEncoder();kernel.encode(encoder,{chemicals:ping.other.chem,previous:ping.current.chem},{size,feed:params.feed,kill:params.kill,pointer,press});device.queue.submit([encoder.finish()]);kernel.endSubmit();ping.swap();}}
  const encoder=device.createCommandEncoder();if(id==='wave-field')kernel.encode(encoder,{color:output},{size,time:t,pointer,gain:params.gain});else if(ping)colorize!.encode(encoder,{color:output,chemical:ping.current.chem});else kernel.encode(encoder,{color:output,original:input!},{size,mode:params.mode,split:params.split,strength:params.strength});
  const pass=encoder.beginRenderPass({colorAttachments:[{view:surface.getCurrentTexture().createView(),clearValue:{r:0,g:0,b:0,a:1},loadOp:'clear',storeOp:'store'}]});pass.setPipeline(pipeline);pass.setBindGroup(0,group);pass.draw(3);pass.end();device.queue.submit([encoder.finish()]);kernel.endSubmit();colorize?.endSubmit();
 }catch(e){paused=true;onStatus('GPU error: '+(e instanceof Error?e.message:String(e)));}};
 const point=(e:PointerEvent)=>{const r=canvas.getBoundingClientRect();const x=Math.max(0,Math.min(1,(e.clientX-r.left)/r.width)),y=Math.max(0,Math.min(1,(e.clientY-r.top)/r.height));pointer=id==='wave-field'?{x:(x-.5)*2,y:(y-.5)*2}:{x,y};params.split=x;if(paused)last=0;};
 const down=(e:PointerEvent)=>{press=1;point(e);canvas.setPointerCapture(e.pointerId);};const up=()=>{press=0;};
 canvas.addEventListener('pointermove',point);canvas.addEventListener('pointerdown',down);canvas.addEventListener('pointerup',up);canvas.addEventListener('pointercancel',up);canvas.style.touchAction='none';const observer=new IntersectionObserver(es=>{visible=es[0].isIntersecting;});observer.observe(canvas);
 // A paused preview still needs a fresh backing buffer after its layout changes.
 const resizeObserver=new ResizeObserver(()=>{last=0;});resizeObserver.observe(canvas);
 const onError=(event:GPUUncapturedErrorEvent)=>{paused=true;onStatus('GPU error: '+event.error.message);};device.addEventListener('uncapturederror',onError);ctx.lost.then(()=>{if(!dead){paused=true;onStatus('GPU device lost. Reload to reconnect.');}});resize();frame=requestAnimationFrame(draw);onStatus('Live WebGPU · wgpu-kit 2.0.1');
 return{destroy(){dead=true;cancelAnimationFrame(frame);observer.disconnect();resizeObserver.disconnect();canvas.removeEventListener('pointermove',point);canvas.removeEventListener('pointerdown',down);canvas.removeEventListener('pointerup',up);canvas.removeEventListener('pointercancel',up);device.removeEventListener('uncapturederror',onError);kernel.destroy();colorize?.destroy();ping?.destroy();input?.destroy();output.destroy();screen.destroy();surface.unconfigure();},setPaused(v){paused=v;if(!v)last=0;},reset(){t=0;initialize();last=0;},setParameter(key,value){if(key in params)(params as any)[key]=value;last=0;}};
}

export async function runPrimitives(values:Uint32Array<ArrayBuffer>){const input=await Buffer.create('u32',values.length),output=await Buffer.create('u32',values.length);const scan=createScan(),reduce=createReduce();try{input.write(values);await scan.run(input,output,values.length,true);const prefix=Array.from(await output.read());const total=await reduce.sum(input,values.length);let expected=0;const correct=prefix.every((n,i)=>{const match=n===expected;expected=(expected+values[i])>>>0;return match;})&&expected===total;return{prefix,total,correct};}finally{input.destroy();output.destroy();scan.destroy();reduce.destroy();}}
