import"./modulepreload-polyfill-B5Qt9EMX.js";import{G as H,C as D,P as K,c as J,m as Y,B as E}from"./presets-CDncw6LK.js";const me={mono:"vec3f(v)",amber:`vec3f(
    1.35 * v * v,
    0.9 * v * v * v + 0.25 * v * (1.0 - v),
    0.15 * v * v * v
  )`,ice:"vec3f(0.15 * v * v, 0.55 * v * v + 0.2 * v, 1.1 * v)",duotone:"mix(vec3f(0.02, 0.03, 0.08), vec3f(0.42, 0.78, 1.0), v) + vec3f(0.9, 0.6, 0.25) * v * v * v * 0.6"};function ve(n){return`
struct VsOut {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
};
@group(0) @binding(0) var<uniform> vp: vec4f; // w, h, maxV, gamma
@group(0) @binding(1) var<storage, read> map: array<f32>;

@vertex
fn vs(@builtin(vertex_index) v: u32) -> VsOut {
  var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  var out: VsOut;
  out.pos = vec4f(p[v], 0.0, 1.0);
  out.uv = (p[v] + vec2f(1.0)) * 0.5;
  out.uv = vec2f(out.uv.x, 1.0 - out.uv.y); // buffer 行 0 = 画面顶部
  return out;
}

@fragment
fn fs(in: VsOut) -> @location(0) vec4f {
  let w = u32(vp.x);
  let x = min(u32(in.uv.x * vp.x), w - 1u);
  let y = min(u32(in.uv.y * vp.y), u32(vp.y) - 1u);
  let v = pow(clamp(abs(map[y * w + x]) * vp.z, 0.0, 1.0), vp.w);
  let c = ${me[n]};
  return vec4f(c, 1.0);
}
`}class Q{#e;#a;#t;#n;#r=new Map;#i=new WeakMap;constructor(e,a,i,u){this.#e=e,this.#a=a,this.#t=i,this.#n=u}static async create(e,a){const i=await H.get(),u=e.getContext("webgpu");if(!u)throw new Error('canvas.getContext("webgpu") 返回空');const l=navigator.gpu.getPreferredCanvasFormat();u.configure({device:i.device,format:l,alphaMode:"opaque"});const m=i.device.createShaderModule({code:ve(a.colormap),label:"life-map-render"}),s=(await m.getCompilationInfo()).messages.filter(v=>v.type==="error");if(s.length>0)throw new D("life-map-render",s.map(v=>({line:v.lineNum,msg:v.message})),0);const B=i.device.createRenderPipeline({layout:"auto",vertex:{module:m,entryPoint:"vs"},fragment:{module:m,entryPoint:"fs",targets:[{format:l}]},primitive:{topology:"triangle-list"}}),_=i.device.createBuffer({size:16,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});return i.device.queue.writeBuffer(_,0,new Float32Array([a.width,a.height,a.maxV,a.gamma??1])),new Q(i,u,B,_)}render(e){let a=this.#i.get(e.gpuBuffer);a===void 0&&(a=this.#r.size+1,this.#i.set(e.gpuBuffer,a));let i=this.#r.get(a);i||(i=this.#e.device.createBindGroup({layout:this.#t.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:this.#n}},{binding:1,resource:{buffer:e.gpuBuffer}}]}),this.#r.set(a,i));const u=this.#e.device.createCommandEncoder(),l=u.beginRenderPass({colorAttachments:[{view:this.#a.getCurrentTexture().createView(),clearValue:{r:0,g:0,b:0,a:1},loadOp:"clear",storeOp:"store"}]});l.setPipeline(this.#t),l.setBindGroup(0,i),l.draw(3),l.end(),this.#e.device.queue.submit([u.finish()])}}const he={coral:{f:.0545,k:.062},mitosis:{f:.0367,k:.0649},spots:{f:.03,k:.062},waves:{f:.014,k:.045}},ae=32;async function we(n={}){const e=n.size??512,a=n.preset??"coral",i=a==="custom"?{f:n.feed??.037,k:n.kill??.06}:he[a],u=n.steps??12,l=typeof n.seed=="string"?ye(n.seed):n.seed??42,m=n.colormap??"duotone",s=(await H.get()).device,B=await K.create({st:"vec2f"},e*e),_=B.current.st,v=B.other.st;{const g=Y(l),p=new Float32Array(e*e*2);for(let w=0;w<e*e;w++)p[w*2]=1;for(let w=0;w<10;w++){const d=40+Math.floor(g()*(e-80)),c=40+Math.floor(g()*(e-80)),r=3+Math.floor(g()*6);for(let t=c-r;t<=c+r;t++)for(let f=d-r;f<=d+r;f++){const b=(t+e)%e*e+(f+e)%e;p[b*2]=.5,p[b*2+1]=.25}}_.write(p)}const o=s.createBuffer({size:ae,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST}),y={f:i.f,k:i.k,dA:1,dB:.5,dt:1};(()=>{const g=new ArrayBuffer(ae),p=new DataView(g);p.setUint32(0,e,!0),p.setUint32(4,e,!0),p.setFloat32(8,y.f,!0),p.setFloat32(12,y.k,!0),p.setFloat32(16,y.dA,!0),p.setFloat32(20,y.dB,!0),p.setFloat32(24,y.dt,!0),s.queue.writeBuffer(o,0,g)})();const{module:C,messages:R}=await J(s,be(),"turing-update"),M=R.filter(g=>g.type==="error");if(M.length>0)throw new D("turing-update",M.map(g=>({line:g.lineNum,msg:g.message})),0);const $=s.createComputePipeline({layout:"auto",compute:{module:C,entryPoint:"main"}}),U=(g,p)=>s.createBindGroup({layout:$.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:o}},{binding:1,resource:{buffer:g.gpuBuffer}},{binding:2,resource:{buffer:p.gpuBuffer}}]}),V=U(_,v),z=U(v,_);let G=null,x=0,P=0,A=0,k=0,S=performance.now();return{config:{size:e,preset:a,feed:y.f,kill:y.k,steps:u},async attach(g){const p=Math.min(window.devicePixelRatio||1,2);g.width=Math.max(1,Math.floor(g.clientWidth*p)),g.height=Math.max(1,Math.floor(g.clientHeight*p)),G=await Q.create(g,{width:e,height:e,maxV:.9,gamma:.85,colormap:m})},tick(){const g=x*u,p=s.createCommandEncoder(),w=p.beginComputePass();w.setPipeline($);for(let c=0;c<u;c++)w.setBindGroup(0,(g+c)%2===0?V:z),w.dispatchWorkgroups(Math.ceil(e*e/64));w.end(),s.queue.submit([p.finish()]),G?.render((g+u-1)%2===0?v:_);for(let c=0;c<u;c++)B.swap();x++,A++;const d=performance.now();k+=d-S,S=d,k>=500&&(P=A/(k/1e3),A=0,k=0)},sprinkle(g=6){const p=Y(l+x>>>0),w=new Float32Array(e*e*2);for(let d=0;d<g;d++){const c=Math.floor(p()*e),r=Math.floor(p()*e),t=2+Math.floor(p()*5);for(let f=r-t;f<=r+t;f++)for(let b=c-t;b<=c+t;b++){const L=(f+e)%e*e+(b+e)%e;w[L*2]=.5,w[L*2+1]=.25}}s.queue.writeBuffer(B.current.st.gpuBuffer,0,w)},stats(){return{fps:P}},async sampleB(){const g=await B.current.st.read(),p=new Float32Array(e*e);for(let w=0;w<p.length;w++)p[w]=g[w*2+1]??0;return p},destroy(){B.destroy(),o.destroy()}}}function be(){return`
struct Params {
  w: u32, h: u32,
  f: f32, k: f32, dA: f32, dB: f32, dt: f32,
};
@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> src: array<vec2f>;
@group(0) @binding(2) var<storage, read_write> dst: array<vec2f>;

fn at(x: i32, y: i32) -> vec2f {
  let w = i32(params.w);
  let h = i32(params.h);
  let xi = (x + w) % w;
  let yi = (y + h) % h;
  return src[u32(yi) * u32(w) + u32(xi)];
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= params.w * params.h) { return; }
  let x = i32(i % params.w);
  let y = i32(i / params.w);

  // 9 点 Laplacian:正交 0.2,对角 0.05
  var lapA = -1.0 * at(x, y).x;
  var lapB = -1.0 * at(x, y).y;
  for (var dy = -1; dy <= 1; dy++) {
    for (var dx = -1; dx <= 1; dx++) {
      if (dx == 0 && dy == 0) { continue; }
      let s = at(x + dx, y + dy);
      let wgt = select(0.05, 0.2, dx == 0 || dy == 0);
      lapA = lapA + wgt * s.x;
      lapB = lapB + wgt * s.y;
    }
  }

  let a = at(x, y).x;
  let b = at(x, y).y;
  var a2 = a + (params.dA * lapA - a * b * b + params.f * (1.0 - a)) * params.dt;
  var b2 = b + (params.dB * lapB + a * b * b - (params.k + params.f) * b) * params.dt;
  a2 = clamp(a2, 0.0, 1.0);
  b2 = clamp(b2, 0.0, 1.0);
  dst[i] = vec2f(a2, b2);
}
`}function ye(n){let e=2166136261;for(let a=0;a<n.length;a++)e^=n.charCodeAt(a),e=Math.imul(e,16777619);return e>>>0}const ne=32;async function xe(n={}){const{agents:e=1e5,mapSize:a=1024,sensorAngle:i=.5,sensorDist:u=.012,turnAngle:l=.45,step:m=.003,decay:h=.06,seed:s="physarum",colormap:B="amber"}=n,_=typeof s=="string"?_e(s):s??7,o=(await H.get()).device,y=await E.create("vec2f",e),F=await E.create("f32",e);{const d=Y(_),c=new Float32Array(e*2),r=new Float32Array(e);for(let t=0;t<e;t++){const f=d()*Math.PI*2,b=Math.sqrt(d())*.08;c[t*2]=Math.cos(f)*b,c[t*2+1]=Math.sin(f)*b,r[t]=f}y.write(c),F.write(r)}const C=await K.create({t:"f32"},a*a);C.current.t,C.other.t;const R=o.createBuffer({size:ne,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});(()=>{const d=new ArrayBuffer(ne),c=new DataView(d);c.setUint32(0,e,!0),c.setUint32(4,0,!0),c.setFloat32(8,i,!0),c.setFloat32(12,u,!0),c.setFloat32(16,l,!0),c.setFloat32(20,m,!0),c.setFloat32(24,1,!0),c.setFloat32(28,1,!0),o.queue.writeBuffer(R,0,d)})();const $=o.createBuffer({size:16,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});o.queue.writeBuffer($,0,new Uint32Array([a,a])),o.queue.writeBuffer($,8,new Float32Array([1-h,0]));const U=async(d,c)=>{const{module:r,messages:t}=await J(o,d,c),f=t.filter(b=>b.type==="error");if(f.length>0)throw new D(c,f.map(b=>({line:b.lineNum,msg:b.message})),0);return r},V=await U(Be(a),"physarum-agent"),z=await U(Pe(),"physarum-diffuse"),G=o.createComputePipeline({layout:"auto",compute:{module:V,entryPoint:"main"}}),x=o.createComputePipeline({layout:"auto",compute:{module:z,entryPoint:"main"}}),P=d=>o.createBindGroup({layout:G.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:R}},{binding:1,resource:{buffer:y.gpuBuffer}},{binding:2,resource:{buffer:F.gpuBuffer}},{binding:3,resource:{buffer:d.gpuBuffer}}]}),A=(d,c)=>o.createBindGroup({layout:x.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:$}},{binding:1,resource:{buffer:d.gpuBuffer}},{binding:2,resource:{buffer:c.gpuBuffer}}]});let k=null,S=0,g=0,p=0,w=performance.now();return{async attach(d){const c=Math.min(window.devicePixelRatio||1,2);d.width=Math.max(1,Math.floor(d.clientWidth*c)),d.height=Math.max(1,Math.floor(d.clientHeight*c)),k=await Q.create(d,{width:a,height:a,maxV:6,gamma:.6,colormap:B})},tick(){const d=C.current.t,c=C.other.t,r=o.createCommandEncoder(),t=r.beginComputePass();t.setPipeline(G),t.setBindGroup(0,P(d)),t.dispatchWorkgroups(Math.ceil(e/64)),t.setPipeline(x),t.setBindGroup(0,A(d,c)),t.dispatchWorkgroups(Math.ceil(a*a/64)),t.end(),o.queue.submit([r.finish()]),k?.render(c),C.swap(),g++;const f=performance.now();p+=f-w,w=f,p>=500&&(S=g/(p/1e3),g=0,p=0)},stats(){return{fps:S}},async sampleTrail(){return await C.current.t.read()},destroy(){y.destroy(),F.destroy(),C.destroy(),R.destroy(),$.destroy()}}}function Be(n){return`
const TRAIL_W: u32 = ${n}u;
const TRAIL_MASK: u32 = ${n-1}u;
struct Params {
  count: u32, _pad: u32,
  sensorAngle: f32, sensorDist: f32, turnAngle: f32, step: f32,
  deposit: f32, worldHalf: f32,
};
@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read_write> pos: array<vec2f>;
@group(0) @binding(2) var<storage, read_write> ang: array<f32>;
@group(0) @binding(3) var<storage, read_write> trail: array<f32>;

fn texel(p: vec2f) -> u32 {
  let x = min(u32((p.x * 0.5 + 0.5) * f32(TRAIL_W)), TRAIL_MASK);
  let y = min(u32((p.y * 0.5 + 0.5) * f32(TRAIL_W)), TRAIL_MASK);
  return y * TRAIL_W + x;
}

fn sense(p: vec2f, a: f32) -> f32 {
  return trail[texel(p + vec2f(cos(a), sin(a)) * params.sensorDist)];
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= params.count) { return; }
  let p = pos[i];
  var a = ang[i];

  let fwd = sense(p, a);
  let left = sense(p, a - params.sensorAngle);
  let right = sense(p, a + params.sensorAngle);

  let jitter = (f32((i * 2654435761u + 1u) % 100u) / 100.0 - 0.5) * 0.1;
  if (fwd > left && fwd > right) {
    // 直行
  } else if (left > right) {
    a = a - params.turnAngle;
  } else if (right > left) {
    a = a + params.turnAngle;
  }
  a = a + jitter * 0.1;

  var np = p + vec2f(cos(a), sin(a)) * params.step;
  let h = params.worldHalf;
  if (abs(np.x) > h || abs(np.y) > h) {
    np = clamp(np, vec2f(-h), vec2f(h));
    a = a + 3.14159265; // 撞墙掉头
  }
  pos[i] = np;
  ang[i] = a;
  let t = texel(np);
  trail[t] = trail[t] + params.deposit;
}
`}function Pe(){return`
@group(0) @binding(0) var<uniform> vp: vec4f; // w, h, keep(1-decay), pad
@group(0) @binding(1) var<storage, read> src: array<f32>;
@group(0) @binding(2) var<storage, read_write> dst: array<f32>;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  let w = u32(vp.x);
  let h = u32(vp.y);
  if (i >= w * h) { return; }
  let x = i32(i % w);
  let y = i32(i / w);

  // 4 邻域 + 自身 混合(扩散),再乘 keep(衰减)
  let c = src[i];
  var s = c * 2.0;
  s = s + src[u32(clamp(y - 1, 0, i32(h) - 1)) * w + u32(clamp(x, 0, i32(w) - 1))];
  s = s + src[u32(clamp(y + 1, 0, i32(h) - 1)) * w + u32(clamp(x, 0, i32(w) - 1))];
  s = s + src[u32(clamp(y, 0, i32(h) - 1)) * w + u32(clamp(x - 1, 0, i32(w) - 1))];
  s = s + src[u32(clamp(y, 0, i32(h) - 1)) * w + u32(clamp(x + 1, 0, i32(w) - 1))];
  let blurred = s / 6.0;
  dst[i] = mix(blurred, c, 0.5) * vp.z;
}
`}function _e(n){let e=2166136261;for(let a=0;a<n.length;a++)e^=n.charCodeAt(a),e=Math.imul(e,16777619);return e>>>0}const Z=64,te=256,ie=32;async function Fe(n){const{count:e,worldHalf:a,cellSize:i}=n;if(!Number.isInteger(e)||e<=0)throw new Error(`count must be a positive integer, got ${String(e)}`);if(!(i>0))throw new Error(`cellSize must be positive, got ${String(i)}`);const u=Math.max(1,Math.ceil(2*a/i)),l=u*u,h=(await H.get()).device,s=h.createBuffer({size:ie,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST,label:"ngrid-params"}),B=()=>{const x=new ArrayBuffer(ie),P=new DataView(x);P.setUint32(0,e,!0),P.setUint32(4,0,!0),P.setFloat32(8,a,!0),P.setUint32(12,u,!0),P.setUint32(16,l,!0),P.setUint32(20,0,!0),P.setUint32(24,0,!0),P.setUint32(28,0,!0),h.queue.writeBuffer(s,0,x)};B();const _=await E.create("u32",l),v=await E.create("u32",l),o=await E.create("u32",l),y=await E.create("u32",e);_.write(new Uint32Array(l));const{module:F,messages:C}=await J(h,Ce(),"ngrid"),R=C.filter(x=>x.type==="error");if(R.length>0)throw new D("ngrid",R.map(x=>({line:x.lineNum,msg:x.message})),0);const M=h.createComputePipeline({layout:"auto",compute:{module:F,entryPoint:"main_counts"}}),$=h.createComputePipeline({layout:"auto",compute:{module:F,entryPoint:"main_scan"}}),U=h.createComputePipeline({layout:"auto",compute:{module:F,entryPoint:"main_scatter"}}),V=x=>h.createBindGroup({layout:M.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:s}},{binding:1,resource:{buffer:x.gpuBuffer}},{binding:2,resource:{buffer:_.gpuBuffer}}]}),z=h.createBindGroup({layout:$.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:s}},{binding:1,resource:{buffer:_.gpuBuffer}},{binding:2,resource:{buffer:v.gpuBuffer}},{binding:3,resource:{buffer:o.gpuBuffer}}]}),G=x=>h.createBindGroup({layout:U.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:s}},{binding:1,resource:{buffer:x.gpuBuffer}},{binding:2,resource:{buffer:o.gpuBuffer}},{binding:3,resource:{buffer:y.gpuBuffer}}]});return{gridSize:u,cells:l,cellStart:v,cellFill:o,order:y,update(x){B();const P=h.createCommandEncoder(),A=P.beginComputePass();A.setPipeline(M),A.setBindGroup(0,V(x)),A.dispatchWorkgroups(Math.ceil(e/Z)),A.end();const k=P.beginComputePass();k.setPipeline($),k.setBindGroup(0,z),k.dispatchWorkgroups(1),k.end();const S=P.beginComputePass();S.setPipeline(U),S.setBindGroup(0,G(x)),S.dispatchWorkgroups(Math.ceil(e/Z)),S.end(),h.queue.submit([P.finish()])},destroy(){_.destroy(),v.destroy(),o.destroy(),y.destroy(),s.destroy()}}}function Ce(){return`
struct Params {
  count: u32, _pad0: u32,
  worldHalf: f32, gridSize: u32, cells: u32,
  _p0: u32, _p1: u32, _p2: u32,
};
@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> posIn: array<vec2f>;
@group(0) @binding(2) var<storage, read_write> cellCount: array<atomic<u32>>;
@group(0) @binding(3) var<storage, read_write> cellStart: array<u32>;
@group(0) @binding(4) var<storage, read_write> cellFill: array<atomic<u32>>;
@group(0) @binding(5) var<storage, read_write> order: array<u32>;

fn cellOf(p: vec2f) -> u32 {
  let g = i32(params.gridSize);
  let span = params.worldHalf * 2.0;
  let cx = clamp(i32(floor((p.x + params.worldHalf) / span * f32(g))), 0, g - 1);
  let cy = clamp(i32(floor((p.y + params.worldHalf) / span * f32(g))), 0, g - 1);
  return u32(cy) * u32(g) + u32(cx);
}

@compute @workgroup_size(${Z})
fn main_counts(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= params.count) { return; }
  atomicAdd(&cellCount[cellOf(posIn[i])], 1u);
}

var<workgroup> partial: array<u32, ${te}>;
@compute @workgroup_size(${te})
fn main_scan(@builtin(local_invocation_id) lid: vec3u, @builtin(workgroup_id) wid: vec3u) {
  let tid = lid.x;
  let cells = params.cells;
  let wg = ${te}u;
  let chunks = (cells + wg - 1u) / wg;

  // ① 本 workgroup 负责的 chunk 局部和
  var local = 0u;
  for (var c = 0u; c < chunks; c++) {
    let idx = c * wg + tid;
    if (idx < cells) { local = local + atomicLoad(&cellCount[idx]); }
  }
  partial[tid] = local;
  workgroupBarrier();

  // ② 局部和的含前缀扫描(Hillis-Steele)
  var offset = 1u;
  loop {
    if (offset >= wg) { break; }
    var v = 0u;
    if (tid >= offset) { v = partial[tid - offset]; }
    workgroupBarrier();
    if (tid >= offset) { partial[tid] = partial[tid] + v; }
    workgroupBarrier();
    offset = offset << 1u;
  }

  // ③ chunk 基址 → start/fill,顺带把 count 归零给下一帧
  var run = 0u;
  if (tid > 0u) { run = partial[tid - 1u]; }
  for (var c = 0u; c < chunks; c++) {
    let idx = c * wg + tid;
    if (idx < cells) {
      cellStart[idx] = run;
      atomicStore(&cellFill[idx], run);
      run = run + atomicLoad(&cellCount[idx]);
      atomicStore(&cellCount[idx], 0u);
    }
  }
}

@compute @workgroup_size(${Z})
fn main_scatter(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= params.count) { return; }
  let slot = atomicAdd(&cellFill[cellOf(posIn[i])], 1u);
  order[slot] = i;
}
`}const ue=64;async function Me(n={}){const{count:e=1200,perception:a=.05,maxSpeed:i=.012,wSep:u=1.6,wAli:l=1,wCoh:m=.8,size:h=.009,seed:s="boids"}=n,B=typeof s=="string"?Se(s):s??3,_=Math.max(4,Math.ceil(2/a)),o=(await H.get()).device,y=await K.create({pos:"vec2f",vel:"vec2f"},e),F={pos:y.current.pos,vel:y.current.vel},C={pos:y.other.pos,vel:y.other.vel};{const r=Y(B),t=new Float32Array(e*2),f=new Float32Array(e*2);for(let b=0;b<e;b++){const L=r()*Math.PI*2,N=Math.sqrt(r())*.6;t[b*2]=Math.cos(L)*N,t[b*2+1]=Math.sin(L)*N;const q=r()*Math.PI*2;f[b*2]=Math.cos(q)*i*.6,f[b*2+1]=Math.sin(q)*i*.6}F.pos.write(t),F.vel.write(f)}const R=48,M=o.createBuffer({size:R,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});(()=>{const r=new ArrayBuffer(R),t=new DataView(r);t.setUint32(0,e,!0),t.setUint32(4,_,!0),t.setFloat32(8,a,!0),t.setFloat32(12,i,!0),t.setFloat32(16,u,!0),t.setFloat32(20,l,!0),t.setFloat32(24,m,!0),t.setFloat32(28,1/60,!0),t.setFloat32(32,1,!0),o.queue.writeBuffer(M,0,r)})();const{module:U,messages:V}=await J(o,Ae(h),"boids"),z=V.filter(r=>r.type==="error");if(z.length>0)throw new D("boids",z.map(r=>({line:r.lineNum,msg:r.message})),0);const G=await Fe({count:e,worldHalf:1,cellSize:a}),x=o.createComputePipeline({layout:"auto",compute:{module:U,entryPoint:"main_force"}}),P=o.createRenderPipeline({layout:"auto",vertex:{module:U,entryPoint:"vs"},fragment:{module:U,entryPoint:"fs",targets:[{format:navigator.gpu.getPreferredCanvasFormat()}]},primitive:{topology:"triangle-list"}}),A=(r,t)=>o.createBindGroup({layout:x.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:M}},{binding:1,resource:{buffer:r.pos.gpuBuffer}},{binding:6,resource:{buffer:r.vel.gpuBuffer}},{binding:7,resource:{buffer:t.pos.gpuBuffer}},{binding:8,resource:{buffer:t.vel.gpuBuffer}},{binding:3,resource:{buffer:G.cellStart.gpuBuffer}},{binding:4,resource:{buffer:G.cellFill.gpuBuffer}},{binding:5,resource:{buffer:G.order.gpuBuffer}}]}),k=r=>o.createBindGroup({layout:P.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:M}},{binding:1,resource:{buffer:r.pos.gpuBuffer}},{binding:6,resource:{buffer:r.vel.gpuBuffer}}]});let S=null,g=0,p=0,w=0,d=0,c=performance.now();return{async attach(r){const t=Math.min(window.devicePixelRatio||1,2);r.width=Math.max(1,Math.floor(r.clientWidth*t)),r.height=Math.max(1,Math.floor(r.clientHeight*t));const f=r.getContext("webgpu");if(!f)throw new Error('canvas.getContext("webgpu") 返回空');f.configure({device:o,format:navigator.gpu.getPreferredCanvasFormat(),alphaMode:"opaque"}),S=f},tick(){const r=g%2===0,t=r?F:C,f=r?C:F,b=o.createCommandEncoder(),L=b.beginComputePass();if(L.setPipeline(x),L.setBindGroup(0,A(t,f)),L.dispatchWorkgroups(Math.ceil(e/ue)),L.end(),o.queue.submit([b.finish()]),S){const q=k(f),ge=ke(o,S,P,q,e);o.queue.submit([ge])}y.swap(),g++,w++;const N=performance.now();d+=N-c,c=N,d>=500&&(p=w/(d/1e3),w=0,d=0)},stats(){return{fps:p}},buffers(){return{pos:y.current.pos,vel:y.current.vel}},destroy(){y.destroy(),G.destroy(),M.destroy()}}}function ke(n,e,a,i,u){const l=n.createCommandEncoder(),m=l.beginRenderPass({colorAttachments:[{view:e.getCurrentTexture().createView(),clearValue:{r:.012,g:.016,b:.03,a:1},loadOp:"clear",storeOp:"store"}]});return m.setPipeline(a),m.setBindGroup(0,i),m.draw(3,u),m.end(),l.finish()}function Ae(n){return`
struct Params {
  count: u32, gridSize: u32,
  perception: f32, maxSpeed: f32, wSep: f32, wAli: f32, wCoh: f32,
  dt: f32, worldHalf: f32, _p: f32,
};
// 统一绑定布局(模块级唯一声明,四个入口按需引用):
// 0 uniform | 1 posIn | 2 cellCount(atomic) | 3 cellStart | 4 cellFill(atomic)
// 5 order   | 6 velIn | 7 posOut | 8 velOut
@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> posIn: array<vec2f>;
@group(0) @binding(2) var<storage, read_write> cellCount: array<atomic<u32>>;
@group(0) @binding(3) var<storage, read_write> cellStart: array<u32>;
@group(0) @binding(4) var<storage, read_write> cellFill: array<atomic<u32>>;
@group(0) @binding(5) var<storage, read_write> order: array<u32>;
@group(0) @binding(6) var<storage, read> velIn: array<vec2f>;
@group(0) @binding(7) var<storage, read_write> posOut: array<vec2f>;
@group(0) @binding(8) var<storage, read_write> velOut: array<vec2f>;

fn cellOf(p: vec2f) -> u32 {
  let g = i32(params.gridSize);
  let span = params.worldHalf * 2.0;
  let cx = clamp(i32(floor((p.x + params.worldHalf) / span * f32(g))), 0, g - 1);
  let cy = clamp(i32(floor((p.y + params.worldHalf) / span * f32(g))), 0, g - 1);
  return u32(cy) * u32(g) + u32(cx);
}

@compute @workgroup_size(${ue})
fn main_force(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= params.count) { return; }
  let myPos = posIn[i];
  let myVel = velIn[i];
  var sep = vec2f(0.0);
  var ali = vec2f(0.0);
  var coh = vec2f(0.0);
  var n = 0u;
  let g = i32(params.gridSize);
  let cellSize = params.worldHalf * 2.0 / f32(g);
  var cx = clamp(i32(floor((myPos.x + params.worldHalf) / cellSize)), 0, g - 1);
  var cy = clamp(i32(floor((myPos.y + params.worldHalf) / cellSize)), 0, g - 1);
  let p2 = params.perception * params.perception;

  for (var dy = -1; dy <= 1; dy++) {
    for (var dx = -1; dx <= 1; dx++) {
      let nx = cx + dx;
      let ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= g || ny >= g) { continue; }
      let c = u32(ny) * u32(g) + u32(nx);
      let s = cellStart[c];
      let e = atomicLoad(&cellFill[c]);
      for (var k = s; k < e; k++) {
        let j = order[k];
        if (j == i) { continue; }
        let rel = posIn[j] - myPos;
        let d2 = dot(rel, rel);
        if (d2 > p2) { continue; }
        let d = sqrt(d2) + 1e-5;
        sep = sep + (myPos - posIn[j]) / d;
        ali = ali + velIn[j];
        coh = coh + posIn[j];
        n = n + 1u;
      }
    }
  }

  var vel = myVel;
  if (n > 0u) {
    let nf = f32(n);
    ali = ali / nf;
    coh = coh / nf - myPos;
    vel = myVel + (sep * params.wSep + ali * params.wAli + coh * params.wCoh) * 0.016;
  }
  let sp = length(vel);
  if (sp > params.maxSpeed) { vel = vel / sp * params.maxSpeed; }
  if (sp < params.maxSpeed * 0.35) { vel = vel / max(sp, 1e-5) * params.maxSpeed * 0.35; }

  var pos = myPos + vel;
  let h = params.worldHalf;
  pos = ((pos + h) % (2.0 * h) + 2.0 * h) % (2.0 * h) - h;
  posOut[i] = pos;
  velOut[i] = vel;
}

// ---- 渲染:朝向速度方向的三角 ----
struct VsOut {
  @builtin(position) clip: vec4f,
  @location(0) color: vec3f,
};

@vertex
fn vs(@builtin(vertex_index) v: u32, @builtin(instance_index) inst: u32) -> VsOut {
  var shape = array<vec2f, 3>(vec2f(${(n*1.6).toFixed(4)}, 0.0), vec2f(${(-n).toFixed(4)}, ${(n*.45).toFixed(4)}), vec2f(${(-n).toFixed(4)}, ${(-n*.45).toFixed(4)}));
  let a = atan2(velIn[inst].y, velIn[inst].x);
  let c = cos(a);
  let s = sin(a);
  let l = shape[v];
  var out: VsOut;
  out.clip = vec4f(posIn[inst] + vec2f(l.x * c - l.y * s, l.x * s + l.y * c), 0.0, 1.0);
  let sp = length(velIn[inst]) / params.maxSpeed;
  out.color = mix(vec3f(0.12, 0.2, 0.45), vec3f(0.4, 0.9, 1.0), clamp(sp, 0.0, 1.0));
  return out;
}

@fragment
fn fs(in: VsOut) -> @location(0) vec4f {
  return vec4f(in.color, 1.0);
}
`}function Se(n){let e=2166136261;for(let a=0;a<n.length;a++)e^=n.charCodeAt(a),e=Math.imul(e,16777619);return e>>>0}const oe=32;async function Ue(n={}){const{chains:e=48,segments:a=64,segLen:i=.018,gravity:u=35e-5,damping:l=.985,iterations:m=10,thickness:h=.006,colorCycle:s=.35}=n,B=e*a,v=(await H.get()).device,o=await K.create({pos:"vec2f"},B),y=await E.create("vec2f",B);{const r=new Float32Array(B*2);o.current.pos.write(r),y.write(r)}const F=v.createBuffer({size:oe,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});let C=0;const R=()=>{const r=new ArrayBuffer(oe),t=new DataView(r);t.setUint32(0,B,!0),t.setUint32(4,a,!0),t.setFloat32(8,i,!0),t.setFloat32(12,u,!0),t.setFloat32(16,l,!0),t.setFloat32(20,C,!0),t.setFloat32(24,.45,!0),t.setUint32(28,m,!0),v.queue.writeBuffer(F,0,r)},M=v.createShaderModule({code:Ge(h,s),label:"tentacles"}),U=(await M.getCompilationInfo()).messages.filter(r=>r.type==="error");if(U.length>0)throw new D("tentacles",U.map(r=>({line:r.lineNum,msg:r.message})),0);const V=v.createComputePipeline({layout:"auto",compute:{module:M,entryPoint:"main_integrate"}}),z=v.createComputePipeline({layout:"auto",compute:{module:M,entryPoint:"main_constraint"}}),G=v.createRenderPipeline({layout:"auto",vertex:{module:M,entryPoint:"vs"},fragment:{module:M,entryPoint:"fs",targets:[{format:navigator.gpu.getPreferredCanvasFormat()}]},primitive:{topology:"triangle-list"}}),x=(r,t)=>v.createBindGroup({layout:V.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:F}},{binding:1,resource:{buffer:r.gpuBuffer}},{binding:2,resource:{buffer:y.gpuBuffer}},{binding:3,resource:{buffer:t.gpuBuffer}}]}),P=(r,t)=>v.createBindGroup({layout:z.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:F}},{binding:1,resource:{buffer:r.gpuBuffer}},{binding:2,resource:{buffer:t.gpuBuffer}}]}),A=new Map,k=new WeakMap,S=r=>{let t=k.get(r.gpuBuffer);t===void 0&&(t=A.size+1,k.set(r.gpuBuffer,t));let f=A.get(t);return f||(f=v.createBindGroup({layout:G.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:F}},{binding:1,resource:{buffer:r.gpuBuffer}}]}),A.set(t,f)),f};let g=null,p=0,w=0,d=0,c=performance.now();return{async attach(r){const t=Math.min(window.devicePixelRatio||1,2);r.width=Math.max(1,Math.floor(r.clientWidth*t)),r.height=Math.max(1,Math.floor(r.clientHeight*t));const f=r.getContext("webgpu");if(!f)throw new Error('canvas.getContext("webgpu") 返回空');f.configure({device:v,format:navigator.gpu.getPreferredCanvasFormat(),alphaMode:"opaque"}),g=f},tick(){C+=1/60,R();const r=v.createCommandEncoder(),t=r.beginComputePass();t.setPipeline(V),t.setBindGroup(0,x(o.current.pos,o.other.pos)),t.dispatchWorkgroups(Math.ceil(B/64)),t.end(),v.queue.submit([r.finish()]),o.swap();const f=v.createCommandEncoder(),b=f.beginComputePass();b.setPipeline(z);for(let N=0;N<m;N++)b.setBindGroup(0,P(o.current.pos,o.other.pos)),b.dispatchWorkgroups(Math.ceil(B/64)),o.swap();if(b.end(),v.queue.submit([f.finish()]),g){const N=v.createCommandEncoder(),q=N.beginRenderPass({colorAttachments:[{view:g.getCurrentTexture().createView(),clearValue:{r:.012,g:.016,b:.03,a:1},loadOp:"clear",storeOp:"store"}]});q.setPipeline(G),q.setBindGroup(0,S(o.current.pos)),q.draw(6,B),q.end(),v.queue.submit([N.finish()])}w++;const L=performance.now();d+=L-c,c=L,d>=500&&(p=w/(d/1e3),w=0,d=0)},stats(){return{fps:p}},buffers(){return{pos:o.current.pos}},destroy(){o.destroy(),y.destroy(),F.destroy()}}}function Ge(n,e){return`
struct Params {
  count: u32, segments: u32,
  segLen: f32, gravity: f32, damping: f32, time: f32,
  anchorR: f32, iterations: u32,
};
@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> posIn: array<vec2f>;
@group(0) @binding(2) var<storage, read_write> posOut: array<vec2f>;
@group(0) @binding(3) var<storage, read_write> prev: array<vec2f>;

fn anchorPos(chain: u32, t: f32) -> vec2f {
  let phase = f32(chain) * 2.399963; // 黄金角:链与链永不重叠排布
  let x = cos(t * 0.7 + phase) * params.anchorR;
  let y = sin(t * 1.13 + phase * 1.7) * params.anchorR * 0.55;
  return vec2f(x, y);
}

@compute @workgroup_size(64)
fn main_integrate(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= params.count) { return; }
  let segs = params.segments;
  let k = i % segs;
  let chain = i / segs;
  if (k == 0u) {
    let anchor = anchorPos(chain, params.time);
    posOut[i] = anchor;
    prev[i] = anchor;
    return;
  }
  let vel = (posIn[i] - prev[i]) * params.damping;
  prev[i] = posIn[i];
  posOut[i] = posIn[i] + vel + vec2f(0.0, -params.gravity);
}

// 跟随约束:读 posIn 写 posOut(单线程单数据,零竞态)
@compute @workgroup_size(64)
fn main_constraint(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= params.count) { return; }
  let segs = params.segments;
  let k = i % segs;
  if (k == 0u) { posOut[i] = posIn[i]; return; }
  let d = posIn[i] - posIn[i - 1u];
  let l = length(d) + 1e-6;
  posOut[i] = posIn[i - 1u] + d / l * params.segLen;
}

struct VsOut {
  @builtin(position) clip: vec4f,
  @location(0) color: vec3f,
};
@group(0) @binding(0) var<uniform> vp: Params;
@group(0) @binding(1) var<storage, read> posR: array<vec2f>;

@vertex
fn vs(@builtin(vertex_index) v: u32, @builtin(instance_index) inst: u32) -> VsOut {
  let segs = vp.segments;
  let k = inst % segs;
  let chain = inst / segs;
  let taper = 1.0 - f32(k) / f32(segs);
  let r = ${(n*1.1).toFixed(5)} * (0.25 + 0.75 * taper);
  var corner = array<vec2f, 6>(
    vec2f(-r, -r), vec2f(r, -r), vec2f(-r, r),
    vec2f(-r, r), vec2f(r, -r), vec2f(r, r)
  );
  var out: VsOut;
  out.clip = vec4f(posR[inst] + corner[v], 0.0, 1.0);
  out.color = 0.5 + 0.5 * cos(f32(chain) * ${e.toFixed(3)} + vec3f(0.0, 2.1, 4.2)) * (0.4 + 0.6 * taper);
  return out;
}

@fragment
fn fs(in: VsOut) -> @location(0) vec4f {
  return vec4f(in.color, 1.0);
}
`}const ce=new URLSearchParams(location.search),T=n=>document.getElementById(n),X=T("sim"),le=T("stats"),j=T("birds"),fe=T("birdsN"),re=[];window.__results=re;const W=(n,e,a="")=>re.push({name:n,pass:e,detail:a});let I=null,O=ce.get("sim")??X.value;async function ee(){I?.destroy(),O=X.value;const n=T("cv");O==="turing"?I=await we({preset:"coral",seed:"life"}):O==="physarum"?I=await xe({agents:1e5,seed:"life"}):O==="boids"?I=await Me({count:Number(j.value),seed:"life"}):I=await Ue({chains:48}),await I.attach(n)}X.onchange=()=>{pe(),ee()};T("reload").onclick=()=>{ee()};const pe=()=>{T("birdsRow").style.display=O==="boids"?"":"none"};j.oninput=()=>{fe.textContent=Number(j.value).toLocaleString()};j.onchange=()=>{O==="boids"&&ee()};T("sprinkle").onclick=()=>{O==="turing"&&I.sprinkle(8)};try{X.value=O,pe(),fe.textContent=Number(j.value).toLocaleString(),await ee(),W("life-boot",!0,O)}catch(n){W("life-boot",!1,String(n.message??n)),le.textContent=`启动失败: ${String(n.message??n)}`,window.__done=!0}async function de(){I?.tick();const{fps:n}=I.stats(),e=await H.get();le.innerHTML=`<b>${n.toFixed(0)}</b> fps / ${O.toUpperCase()} / ${e.adapterInfo}`,requestAnimationFrame(de)}requestAnimationFrame(de);const se=Number(ce.get("verify")??0);se>0&&setTimeout(async()=>{W("life-running",(I.stats().fps??0)>10,`${I.stats().fps.toFixed(1)} fps · ${O}`);try{if(O==="turing"){const e=await I.sampleB();let a=!0,i=0;for(let m=0;m<e.length;m+=97){const h=e[m];if(!Number.isFinite(h)){a=!1;break}i+=h}i/=Math.ceil(e.length/97);let u=0;for(let m=0;m<e.length;m+=97){const h=e[m]-i;u+=h*h}const l=Math.sqrt(u/Math.ceil(e.length/97));W("life-turing-pattern",a&&l>.05,`B-channel std ${l.toFixed(3)} (threshold 0.05)`)}else if(O==="physarum"){const e=await I.sampleTrail();let a=!0,i=0;for(let u=0;u<e.length;u+=89){const l=e[u];if(!Number.isFinite(l)){a=!1;break}l>i&&(i=l)}W("life-physarum-trail",a&&i>3,`trail peak ${i.toFixed(1)} (threshold 3)`)}else if(O==="boids"){const{pos:e,vel:a}=I.buffers(),i=await e.read(),u=await a.read();let l=!0,m=!0,h=0;for(let s=0;s<u.length;s+=2){if(!Number.isFinite(i[s])||!Number.isFinite(u[s])){l=!1;break}(Math.abs(i[s])>1.01||Math.abs(i[s+1])>1.01)&&(m=!1),h+=Math.hypot(u[s],u[s+1])}W("life-boids-flock",l&&m&&h>0,`finite=${l} inBounds=${m} meanSpeed=${(h/(u.length/2)).toFixed(4)}`)}else{const{pos:e}=I.buffers(),a=await e.read(),i=64,u=.018;let l=!0,m=0,h=0;for(let s=1;s<a.length/2;s++){if(s%i===0)continue;const B=a[s*2]-a[(s-1)*2],_=a[s*2+1]-a[(s-1)*2+1],v=Math.abs(Math.hypot(B,_)-u);if(!Number.isFinite(v)){l=!1;break}v>m&&(m=v),h++}W("life-tentacles-constraint",l&&m<.01,`max constraint residual ${m.toFixed(5)} (threshold 0.01, ${h} nodes)`)}const n=await H.get();window.__adapter=n.adapterInfo}catch(n){W("life-probe-error",!1,String(n.message??n))}window.__done=!0,console.log("[RESULT]",JSON.stringify(re))},se*1e3);
