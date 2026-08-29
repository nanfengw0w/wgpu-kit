import"./modulepreload-polyfill-B5Qt9EMX.js";import{G as K,C as Q,P as ae,m as re,B as Y}from"./presets-KjmVxDtz.js";const we={mono:"vec3f(v)",amber:`vec3f(
    1.35 * v * v,
    0.9 * v * v * v + 0.25 * v * (1.0 - v),
    0.15 * v * v * v
  )`,ice:"vec3f(0.15 * v * v, 0.55 * v * v + 0.2 * v, 1.1 * v)",duotone:"mix(vec3f(0.02, 0.03, 0.08), vec3f(0.42, 0.78, 1.0), v) + vec3f(0.9, 0.6, 0.25) * v * v * v * 0.6"};function be(r){return`
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
  let c = ${we[r]};
  return vec4f(c, 1.0);
}
`}class ne{#e;#a;#t;#n;#r=new Map;#i=new WeakMap;constructor(e,t,o,l){this.#e=e,this.#a=t,this.#t=o,this.#n=l}static async create(e,t){const o=await K.get(),l=e.getContext("webgpu");if(!l)throw new Error('canvas.getContext("webgpu") 返回空');const g=navigator.gpu.getPreferredCanvasFormat();l.configure({device:o.device,format:g,alphaMode:"opaque"});const d=o.device.createShaderModule({code:be(t.colormap),label:"life-map-render"}),c=(await d.getCompilationInfo()).messages.filter(m=>m.type==="error");if(c.length>0)throw new Q("life-map-render",c.map(m=>({line:m.lineNum,msg:m.message})),0);const x=o.device.createRenderPipeline({layout:"auto",vertex:{module:d,entryPoint:"vs"},fragment:{module:d,entryPoint:"fs",targets:[{format:g}]},primitive:{topology:"triangle-list"}}),M=o.device.createBuffer({size:16,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});return o.device.queue.writeBuffer(M,0,new Float32Array([t.width,t.height,t.maxV,t.gamma??1])),new ne(o,l,x,M)}render(e){let t=this.#i.get(e.gpuBuffer);t===void 0&&(t=this.#r.size+1,this.#i.set(e.gpuBuffer,t));let o=this.#r.get(t);o||(o=this.#e.device.createBindGroup({layout:this.#t.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:this.#n}},{binding:1,resource:{buffer:e.gpuBuffer}}]}),this.#r.set(t,o));const l=this.#e.device.createCommandEncoder(),g=l.beginRenderPass({colorAttachments:[{view:this.#a.getCurrentTexture().createView(),clearValue:{r:0,g:0,b:0,a:1},loadOp:"clear",storeOp:"store"}]});g.setPipeline(this.#t),g.setBindGroup(0,o),g.draw(3),g.end(),this.#e.device.queue.submit([l.finish()])}}const ye={coral:{f:.0545,k:.062},mitosis:{f:.0367,k:.0649},spots:{f:.03,k:.062},waves:{f:.014,k:.045}},le=32;async function xe(r={}){const e=r.size??512,t=r.preset??"coral",o=t==="custom"?{f:r.feed??.037,k:r.kill??.06}:ye[t],l=r.steps??12,g=typeof r.seed=="string"?Pe(r.seed):r.seed??42,d=r.colormap??"duotone",c=(await K.get()).device,x=await ae.create({st:"vec2f"},e*e),M=x.current.st,m=x.other.st;{const f=re(g),u=new Float32Array(e*e*2);for(let h=0;h<e*e;h++)u[h*2]=1;for(let h=0;h<10;h++){const p=40+Math.floor(f()*(e-80)),s=40+Math.floor(f()*(e-80)),i=3+Math.floor(f()*6);for(let a=s-i;a<=s+i;a++)for(let v=p-i;v<=p+i;v++){const B=(a+e)%e*e+(v+e)%e;u[B*2]=.5,u[B*2+1]=.25}}M.write(u)}const n=c.createBuffer({size:le,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST}),b={f:o.f,k:o.k,dA:1,dB:.5,dt:1};(()=>{const f=new ArrayBuffer(le),u=new DataView(f);u.setUint32(0,e,!0),u.setUint32(4,e,!0),u.setFloat32(8,b.f,!0),u.setFloat32(12,b.k,!0),u.setFloat32(16,b.dA,!0),u.setFloat32(20,b.dB,!0),u.setFloat32(24,b.dt,!0),c.queue.writeBuffer(n,0,f)})();const _=c.createShaderModule({code:Be(),label:"turing-update"}),F=(await _.getCompilationInfo()).messages.filter(f=>f.type==="error");if(F.length>0)throw new Q("turing-update",F.map(f=>({line:f.lineNum,msg:f.message})),0);const T=c.createComputePipeline({layout:"auto",compute:{module:_,entryPoint:"main"}}),U=(f,u)=>c.createBindGroup({layout:T.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:n}},{binding:1,resource:{buffer:f.gpuBuffer}},{binding:2,resource:{buffer:u.gpuBuffer}}]}),L=U(M,m),$=U(m,M);let I=null,O=0,S=0,V=0,G=0,z=performance.now();return{config:{size:e,preset:t,feed:b.f,kill:b.k,steps:l},async attach(f){const u=Math.min(window.devicePixelRatio||1,2);f.width=Math.max(1,Math.floor(f.clientWidth*u)),f.height=Math.max(1,Math.floor(f.clientHeight*u)),I=await ne.create(f,{width:e,height:e,maxV:.9,gamma:.85,colormap:d})},tick(){const f=O*l,u=c.createCommandEncoder(),h=u.beginComputePass();h.setPipeline(T);for(let s=0;s<l;s++)h.setBindGroup(0,(f+s)%2===0?L:$),h.dispatchWorkgroups(Math.ceil(e*e/64));h.end(),c.queue.submit([u.finish()]),I?.render((f+l-1)%2===0?m:M);for(let s=0;s<l;s++)x.swap();O++,V++;const p=performance.now();G+=p-z,z=p,G>=500&&(S=V/(G/1e3),V=0,G=0)},sprinkle(f=6){const u=re(g+O>>>0),h=new Float32Array(e*e*2);for(let p=0;p<f;p++){const s=Math.floor(u()*e),i=Math.floor(u()*e),a=2+Math.floor(u()*5);for(let v=i-a;v<=i+a;v++)for(let B=s-a;B<=s+a;B++){const N=(v+e)%e*e+(B+e)%e;h[N*2]=.5,h[N*2+1]=.25}}c.queue.writeBuffer(x.current.st.gpuBuffer,0,h)},stats(){return{fps:S}},async sampleB(){const f=await x.current.st.read(),u=new Float32Array(e*e);for(let h=0;h<u.length;h++)u[h]=f[h*2+1]??0;return u},destroy(){x.destroy(),n.destroy()}}}function Be(){return`
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
`}function Pe(r){let e=2166136261;for(let t=0;t<r.length;t++)e^=r.charCodeAt(t),e=Math.imul(e,16777619);return e>>>0}const fe=32;async function Fe(r={}){const{agents:e=1e5,mapSize:t=1024,sensorAngle:o=.5,sensorDist:l=.012,turnAngle:g=.45,step:d=.003,decay:P=.06,seed:c="physarum",colormap:x="amber"}=r,M=typeof c=="string"?Ce(c):c??7,n=(await K.get()).device,b=await Y.create("vec2f",e),k=await Y.create("f32",e);{const p=re(M),s=new Float32Array(e*2),i=new Float32Array(e);for(let a=0;a<e;a++){const v=p()*Math.PI*2,B=Math.sqrt(p())*.08;s[a*2]=Math.cos(v)*B,s[a*2+1]=Math.sin(v)*B,i[a]=v}b.write(s),k.write(i)}const _=await ae.create({t:"f32"},t*t);_.current.t,_.other.t;const W=n.createBuffer({size:fe,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});(()=>{const p=new ArrayBuffer(fe),s=new DataView(p);s.setUint32(0,e,!0),s.setUint32(4,0,!0),s.setFloat32(8,o,!0),s.setFloat32(12,l,!0),s.setFloat32(16,g,!0),s.setFloat32(20,d,!0),s.setFloat32(24,1,!0),s.setFloat32(28,1,!0),n.queue.writeBuffer(W,0,p)})();const T=n.createBuffer({size:16,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});n.queue.writeBuffer(T,0,new Uint32Array([t,t])),n.queue.writeBuffer(T,8,new Float32Array([1-P,0]));const U=async(p,s)=>{const i=n.createShaderModule({code:p,label:s}),v=(await i.getCompilationInfo()).messages.filter(B=>B.type==="error");if(v.length>0)throw new Q(s,v.map(B=>({line:B.lineNum,msg:B.message})),0);return i},L=await U(Me(t),"physarum-agent"),$=await U(_e(),"physarum-diffuse"),I=n.createComputePipeline({layout:"auto",compute:{module:L,entryPoint:"main"}}),O=n.createComputePipeline({layout:"auto",compute:{module:$,entryPoint:"main"}}),S=p=>n.createBindGroup({layout:I.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:W}},{binding:1,resource:{buffer:b.gpuBuffer}},{binding:2,resource:{buffer:k.gpuBuffer}},{binding:3,resource:{buffer:p.gpuBuffer}}]}),V=(p,s)=>n.createBindGroup({layout:O.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:T}},{binding:1,resource:{buffer:p.gpuBuffer}},{binding:2,resource:{buffer:s.gpuBuffer}}]});let G=null,z=0,f=0,u=0,h=performance.now();return{async attach(p){const s=Math.min(window.devicePixelRatio||1,2);p.width=Math.max(1,Math.floor(p.clientWidth*s)),p.height=Math.max(1,Math.floor(p.clientHeight*s)),G=await ne.create(p,{width:t,height:t,maxV:6,gamma:.6,colormap:x})},tick(){const p=_.current.t,s=_.other.t,i=n.createCommandEncoder(),a=i.beginComputePass();a.setPipeline(I),a.setBindGroup(0,S(p)),a.dispatchWorkgroups(Math.ceil(e/64)),a.setPipeline(O),a.setBindGroup(0,V(p,s)),a.dispatchWorkgroups(Math.ceil(t*t/64)),a.end(),n.queue.submit([i.finish()]),G?.render(s),_.swap(),f++;const v=performance.now();u+=v-h,h=v,u>=500&&(z=f/(u/1e3),f=0,u=0)},stats(){return{fps:z}},async sampleTrail(){return await _.current.t.read()},destroy(){b.destroy(),k.destroy(),_.destroy(),W.destroy(),T.destroy()}}}function Me(r){return`
const TRAIL_W: u32 = ${r}u;
const TRAIL_MASK: u32 = ${r-1}u;
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
`}function _e(){return`
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
`}function Ce(r){let e=2166136261;for(let t=0;t<r.length;t++)e^=r.charCodeAt(t),e=Math.imul(e,16777619);return e>>>0}const Z=64;async function ke(r={}){const{count:e=3e3,perception:t=.05,maxSpeed:o=.012,wSep:l=1.6,wAli:g=1,wCoh:d=.8,size:P=.009,seed:c="boids"}=r,x=typeof c=="string"?Ue(c):c??3,M=Math.max(4,Math.ceil(2/t)),n=(await K.get()).device,b=await ae.create({pos:"vec2f",vel:"vec2f"},e),k={pos:b.current.pos,vel:b.current.vel},_={pos:b.other.pos,vel:b.other.vel};{const w=re(x),y=new Float32Array(e*2),q=new Float32Array(e*2);for(let E=0;E<e;E++){const C=w()*Math.PI*2,J=Math.sqrt(w())*.6;y[E*2]=Math.cos(C)*J,y[E*2+1]=Math.sin(C)*J;const te=w()*Math.PI*2;q[E*2]=Math.cos(te)*o*.6,q[E*2+1]=Math.sin(te)*o*.6}k.pos.write(y),k.vel.write(q)}const W=48,F=n.createBuffer({size:W,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});(()=>{const w=new ArrayBuffer(W),y=new DataView(w);y.setUint32(0,e,!0),y.setUint32(4,M,!0),y.setFloat32(8,t,!0),y.setFloat32(12,o,!0),y.setFloat32(16,l,!0),y.setFloat32(20,g,!0),y.setFloat32(24,d,!0),y.setFloat32(28,1/60,!0),y.setFloat32(32,1,!0),n.queue.writeBuffer(F,0,w)})();const U=M*M,L=await Y.create("u32",U),$=await Y.create("u32",U),I=await Y.create("u32",U),O=await Y.create("u32",e);L.write(new Uint32Array(U));const S=n.createShaderModule({code:Se(P),label:"boids"}),G=(await S.getCompilationInfo()).messages.filter(w=>w.type==="error");if(G.length>0)throw new Q("boids",G.map(w=>({line:w.lineNum,msg:w.message})),0);const z=n.createComputePipeline({layout:"auto",compute:{module:S,entryPoint:"main_counts"}}),f=n.createComputePipeline({layout:"auto",compute:{module:S,entryPoint:"main_scan"}}),u=n.createComputePipeline({layout:"auto",compute:{module:S,entryPoint:"main_scatter"}}),h=n.createComputePipeline({layout:"auto",compute:{module:S,entryPoint:"main_force"}}),p=n.createRenderPipeline({layout:"auto",vertex:{module:S,entryPoint:"vs"},fragment:{module:S,entryPoint:"fs",targets:[{format:navigator.gpu.getPreferredCanvasFormat()}]},primitive:{topology:"triangle-list"}}),s=w=>n.createBindGroup({layout:z.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:F}},{binding:1,resource:{buffer:w.pos.gpuBuffer}},{binding:2,resource:{buffer:L.gpuBuffer}}]}),i=n.createBindGroup({layout:f.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:F}},{binding:2,resource:{buffer:L.gpuBuffer}},{binding:3,resource:{buffer:$.gpuBuffer}},{binding:4,resource:{buffer:I.gpuBuffer}}]}),a=w=>n.createBindGroup({layout:u.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:F}},{binding:1,resource:{buffer:w.pos.gpuBuffer}},{binding:4,resource:{buffer:I.gpuBuffer}},{binding:5,resource:{buffer:O.gpuBuffer}}]}),v=(w,y)=>n.createBindGroup({layout:h.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:F}},{binding:1,resource:{buffer:w.pos.gpuBuffer}},{binding:6,resource:{buffer:w.vel.gpuBuffer}},{binding:7,resource:{buffer:y.pos.gpuBuffer}},{binding:8,resource:{buffer:y.vel.gpuBuffer}},{binding:3,resource:{buffer:$.gpuBuffer}},{binding:4,resource:{buffer:I.gpuBuffer}},{binding:5,resource:{buffer:O.gpuBuffer}}]}),B=w=>n.createBindGroup({layout:p.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:F}},{binding:1,resource:{buffer:w.pos.gpuBuffer}},{binding:6,resource:{buffer:w.vel.gpuBuffer}}]});let N=null,H=0,j=0,oe=0,ee=0,ce=performance.now();return{async attach(w){const y=Math.min(window.devicePixelRatio||1,2);w.width=Math.max(1,Math.floor(w.clientWidth*y)),w.height=Math.max(1,Math.floor(w.clientHeight*y));const q=w.getContext("webgpu");if(!q)throw new Error('canvas.getContext("webgpu") 返回空');q.configure({device:n,format:navigator.gpu.getPreferredCanvasFormat(),alphaMode:"opaque"}),N=q},tick(){const w=H%2===0,y=w?k:_,q=w?_:k,E=n.createCommandEncoder(),C=E.beginComputePass();if(C.setPipeline(z),C.setBindGroup(0,s(y)),C.dispatchWorkgroups(Math.ceil(e/Z)),C.setPipeline(f),C.setBindGroup(0,i),C.dispatchWorkgroups(1),C.setPipeline(u),C.setBindGroup(0,a(y)),C.dispatchWorkgroups(Math.ceil(e/Z)),C.setPipeline(h),C.setBindGroup(0,v(y,q)),C.dispatchWorkgroups(Math.ceil(e/Z)),C.end(),n.queue.submit([E.finish()]),N){const te=B(q),he=Ae(n,N,p,te,e);n.queue.submit([he])}b.swap(),H++,oe++;const J=performance.now();ee+=J-ce,ce=J,ee>=500&&(j=oe/(ee/1e3),oe=0,ee=0)},stats(){return{fps:j}},buffers(){return{pos:b.current.pos,vel:b.current.vel}},destroy(){b.destroy(),L.destroy(),$.destroy(),I.destroy(),O.destroy(),F.destroy()}}}function Ae(r,e,t,o,l){const g=r.createCommandEncoder(),d=g.beginRenderPass({colorAttachments:[{view:e.getCurrentTexture().createView(),clearValue:{r:.012,g:.016,b:.03,a:1},loadOp:"clear",storeOp:"store"}]});return d.setPipeline(t),d.setBindGroup(0,o),d.draw(3,l),d.end(),g.finish()}function Se(r){return`
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

@compute @workgroup_size(${Z})
fn main_counts(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= params.count) { return; }
  atomicAdd(&cellCount[cellOf(posIn[i])], 1u);
}

var<workgroup> partial: array<u32, 256>;
@compute @workgroup_size(256)
fn main_scan(@builtin(local_invocation_id) lid: vec3u) {
  let tid = lid.x;
  let cells = params.gridSize * params.gridSize;
  let chunks = (cells + 255u) / 256u;
  var local = 0u;
  for (var c = 0u; c < chunks; c++) {
    let idx = c * 256u + tid;
    if (idx < cells) { local = local + atomicLoad(&cellCount[idx]); }
  }
  partial[tid] = local;
  workgroupBarrier();
  var offset = 1u;
  loop {
    if (offset >= 256u) { break; }
    var v = 0u;
    if (tid >= offset) { v = partial[tid - offset]; }
    workgroupBarrier();
    if (tid >= offset) { partial[tid] = partial[tid] + v; }
    workgroupBarrier();
    offset = offset << 1u;
  }
  var run = 0u;
  if (tid > 0u) { run = partial[tid - 1u]; }
  for (var c = 0u; c < chunks; c++) {
    let idx = c * 256u + tid;
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

@compute @workgroup_size(${Z})
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
  var shape = array<vec2f, 3>(vec2f(${(r*1.6).toFixed(4)}, 0.0), vec2f(${(-r).toFixed(4)}, ${(r*.45).toFixed(4)}), vec2f(${(-r).toFixed(4)}, ${(-r*.45).toFixed(4)}));
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
`}function Ue(r){let e=2166136261;for(let t=0;t<r.length;t++)e^=r.charCodeAt(t),e=Math.imul(e,16777619);return e>>>0}const pe=32;async function Ie(r={}){const{chains:e=48,segments:t=64,segLen:o=.018,gravity:l=35e-5,damping:g=.985,iterations:d=10,thickness:P=.006,colorCycle:c=.35}=r,x=e*t,m=(await K.get()).device,n=await ae.create({pos:"vec2f"},x),b=await Y.create("vec2f",x);{const i=new Float32Array(x*2);n.current.pos.write(i),b.write(i)}const k=m.createBuffer({size:pe,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});let _=0;const W=()=>{const i=new ArrayBuffer(pe),a=new DataView(i);a.setUint32(0,x,!0),a.setUint32(4,t,!0),a.setFloat32(8,o,!0),a.setFloat32(12,l,!0),a.setFloat32(16,g,!0),a.setFloat32(20,_,!0),a.setFloat32(24,.45,!0),a.setUint32(28,d,!0),m.queue.writeBuffer(k,0,i)},F=m.createShaderModule({code:Ge(P,c),label:"tentacles"}),U=(await F.getCompilationInfo()).messages.filter(i=>i.type==="error");if(U.length>0)throw new Q("tentacles",U.map(i=>({line:i.lineNum,msg:i.message})),0);const L=m.createComputePipeline({layout:"auto",compute:{module:F,entryPoint:"main_integrate"}}),$=m.createComputePipeline({layout:"auto",compute:{module:F,entryPoint:"main_constraint"}}),I=m.createRenderPipeline({layout:"auto",vertex:{module:F,entryPoint:"vs"},fragment:{module:F,entryPoint:"fs",targets:[{format:navigator.gpu.getPreferredCanvasFormat()}]},primitive:{topology:"triangle-list"}}),O=(i,a)=>m.createBindGroup({layout:L.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:k}},{binding:1,resource:{buffer:i.gpuBuffer}},{binding:2,resource:{buffer:b.gpuBuffer}},{binding:3,resource:{buffer:a.gpuBuffer}}]}),S=(i,a)=>m.createBindGroup({layout:$.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:k}},{binding:1,resource:{buffer:i.gpuBuffer}},{binding:2,resource:{buffer:a.gpuBuffer}}]}),V=new Map,G=new WeakMap,z=i=>{let a=G.get(i.gpuBuffer);a===void 0&&(a=V.size+1,G.set(i.gpuBuffer,a));let v=V.get(a);return v||(v=m.createBindGroup({layout:I.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:k}},{binding:1,resource:{buffer:i.gpuBuffer}}]}),V.set(a,v)),v};let f=null,u=0,h=0,p=0,s=performance.now();return{async attach(i){const a=Math.min(window.devicePixelRatio||1,2);i.width=Math.max(1,Math.floor(i.clientWidth*a)),i.height=Math.max(1,Math.floor(i.clientHeight*a));const v=i.getContext("webgpu");if(!v)throw new Error('canvas.getContext("webgpu") 返回空');v.configure({device:m,format:navigator.gpu.getPreferredCanvasFormat(),alphaMode:"opaque"}),f=v},tick(){_+=1/60,W();const i=m.createCommandEncoder(),a=i.beginComputePass();a.setPipeline(L),a.setBindGroup(0,O(n.current.pos,n.other.pos)),a.dispatchWorkgroups(Math.ceil(x/64)),a.end(),m.queue.submit([i.finish()]),n.swap();const v=m.createCommandEncoder(),B=v.beginComputePass();B.setPipeline($);for(let H=0;H<d;H++)B.setBindGroup(0,S(n.current.pos,n.other.pos)),B.dispatchWorkgroups(Math.ceil(x/64)),n.swap();if(B.end(),m.queue.submit([v.finish()]),f){const H=m.createCommandEncoder(),j=H.beginRenderPass({colorAttachments:[{view:f.getCurrentTexture().createView(),clearValue:{r:.012,g:.016,b:.03,a:1},loadOp:"clear",storeOp:"store"}]});j.setPipeline(I),j.setBindGroup(0,z(n.current.pos)),j.draw(6,x),j.end(),m.queue.submit([H.finish()])}h++;const N=performance.now();p+=N-s,s=N,p>=500&&(u=h/(p/1e3),h=0,p=0)},stats(){return{fps:u}},buffers(){return{pos:n.current.pos}},destroy(){n.destroy(),b.destroy(),k.destroy()}}}function Ge(r,e){return`
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
  let r = ${(r*1.1).toFixed(5)} * (0.25 + 0.75 * taper);
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
`}const ge=new URLSearchParams(location.search),X=r=>document.getElementById(r),ie=X("sim"),me=X("stats"),se=[];window.__results=se;const D=(r,e,t="")=>se.push({name:r,pass:e,detail:t});let A=null,R=ge.get("sim")??ie.value;async function ue(){A?.destroy(),R=ie.value;const r=X("cv");R==="turing"?A=await xe({preset:"coral",seed:"life"}):R==="physarum"?A=await Fe({agents:1e5,seed:"life"}):R==="boids"?A=await ke({count:3e3,seed:"life"}):A=await Ie({chains:48}),await A.attach(r)}ie.onchange=()=>{ue()};X("reload").onclick=()=>{ue()};X("sprinkle").onclick=()=>{R==="turing"&&A.sprinkle(8)};try{ie.value=R,await ue(),D("life-boot",!0,R)}catch(r){D("life-boot",!1,String(r.message??r)),me.textContent=`启动失败: ${String(r.message??r)}`,window.__done=!0}async function ve(){A?.tick();const{fps:r}=A.stats(),e=await K.get();me.innerHTML=`<b>${r.toFixed(0)}</b> fps / ${R.toUpperCase()} / ${e.adapterInfo}`,requestAnimationFrame(ve)}requestAnimationFrame(ve);const de=Number(ge.get("verify")??0);de>0&&setTimeout(async()=>{D("life-running",(A.stats().fps??0)>10,`${A.stats().fps.toFixed(1)} fps · ${R}`);try{if(R==="turing"){const e=await A.sampleB();let t=!0,o=0;for(let d=0;d<e.length;d+=97){const P=e[d];if(!Number.isFinite(P)){t=!1;break}o+=P}o/=Math.ceil(e.length/97);let l=0;for(let d=0;d<e.length;d+=97){const P=e[d]-o;l+=P*P}const g=Math.sqrt(l/Math.ceil(e.length/97));D("life-turing-pattern",t&&g>.05,`B-channel std ${g.toFixed(3)} (threshold 0.05)`)}else if(R==="physarum"){const e=await A.sampleTrail();let t=!0,o=0;for(let l=0;l<e.length;l+=89){const g=e[l];if(!Number.isFinite(g)){t=!1;break}g>o&&(o=g)}D("life-physarum-trail",t&&o>3,`trail peak ${o.toFixed(1)} (threshold 3)`)}else if(R==="boids"){const{pos:e,vel:t}=A.buffers(),o=await e.read(),l=await t.read();let g=!0,d=!0,P=0;for(let c=0;c<l.length;c+=2){if(!Number.isFinite(o[c])||!Number.isFinite(l[c])){g=!1;break}(Math.abs(o[c])>1.01||Math.abs(o[c+1])>1.01)&&(d=!1),P+=Math.hypot(l[c],l[c+1])}D("life-boids-flock",g&&d&&P>0,`finite=${g} inBounds=${d} meanSpeed=${(P/(l.length/2)).toFixed(4)}`)}else{const{pos:e}=A.buffers(),t=await e.read(),o=64,l=.018;let g=!0,d=0,P=0;for(let c=1;c<t.length/2;c++){if(c%o===0)continue;const x=t[c*2]-t[(c-1)*2],M=t[c*2+1]-t[(c-1)*2+1],m=Math.abs(Math.hypot(x,M)-l);if(!Number.isFinite(m)){g=!1;break}m>d&&(d=m),P++}D("life-tentacles-constraint",g&&d<.01,`max constraint residual ${d.toFixed(5)} (threshold 0.01, ${P} nodes)`)}const r=await K.get();window.__adapter=r.adapterInfo}catch(r){D("life-probe-error",!1,String(r.message??r))}window.__done=!0,console.log("[RESULT]",JSON.stringify(se))},de*1e3);
