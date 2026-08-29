import{U as z,h as W,r as ue,G as le,C as fe,P as me,B as h,m as be,c as ve}from"./presets-KjmVxDtz.js";const ie=["n2","tiled","grid"];function ye(p={}){const{count:e=8192,forces:c="cells",mode:t="grid",color:l="species",bounds:s="wrap",seed:u="wgpu-kit",rMax:f=.12,beta:y=.3,forceFactor:w=10,frictionHalfLife:d=.04,dt:g=.02,pointSize:S=.004,maxNeighbors:b=32768}=p;if(!Number.isInteger(e)||e<=0||e>1e6)throw new z(`count 必须是 1..1_000_000 的整数,收到: ${String(e)}`);if(!ie.includes(t))throw new z(`mode 必须是 ${ie.join(" | ")},收到: "${String(t)}"`);if(t==="n2"&&e>32e3)throw new z(`mode='n2' 建议 count ≤ 20000(当前 ${e});大规模请用 mode='tiled' 或 'grid'`);const k=String(u);return{count:e,forces:ue(c,W(k)),forcesName:typeof c=="string"?c:"custom",mode:t,color:l,bounds:s,seed:k,seedHash:W(k),rMax:f,beta:y,forceFactor:w,friction:Math.exp(-g/d),dt:g,pointSize:S,maxNeighbors:b}}const m=64;function we(p,e){const c=p==="tiled",t=`
struct Params {
  count: u32,
  _pad0: u32,
  dt: f32,
  rMax: f32,
  beta: f32,
  forceFactor: f32,
  friction: f32,
  worldHalf: f32,
  wrapEdge: f32,
  gridSize: u32,
  cells: u32,
  maxCand: u32,
};
@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> matrix: array<f32>;
@group(0) @binding(2) var<storage, read> species: array<u32>;
@group(0) @binding(3) var<storage, read> posIn: array<vec2f>;
@group(0) @binding(4) var<storage, read> velIn: array<vec2f>;
@group(0) @binding(5) var<storage, read_write> posOut: array<vec2f>;
@group(0) @binding(6) var<storage, read_write> velOut: array<vec2f>;

fn force(r: f32, a: f32) -> f32 {
  if (r < params.beta) { return a / params.beta - 1.0; }
  if (r < 1.0) { return a * (1.0 - abs(2.0 * r - 1.0 - params.beta) / (1.0 - params.beta)); }
  return 0.0;
}
`,l=c?"fn interact(myIdx: u32, mySp: u32, myPos: vec2f, lid: u32) -> vec2f {":"fn interact(myIdx: u32, mySp: u32, myPos: vec2f) -> vec2f {",s=c?he(e):xe(e),u=`
@compute @workgroup_size(${m})
fn main(@builtin(global_invocation_id) gid: vec3u${c?", @builtin(local_invocation_id) lid: vec3u":""}) {
  let i = gid.x;
  // 注意:workgroupBarrier 要求 uniform control flow——
  // 越界线程也必须参与 barrier 循环,只能在最终写入处 guard(tiled 尾部 workgroup 的经典坑)
  let ok = i < params.count;
  let myIdx = min(i, params.count - 1u);
  let mySp = species[myIdx];
  let myPos = posIn[myIdx];
  var accel = interact(myIdx, mySp, myPos${c?", lid.x":""});
  accel = accel * params.forceFactor * params.rMax;
  if (ok) {
    var vel = (velIn[i] + accel * params.dt) * params.friction;
    var pos = myPos + vel * params.dt;
    let span = params.worldHalf * 2.0;
    if (params.wrapEdge > 0.5) {
      pos = ((pos + params.worldHalf) % span + span) % span - params.worldHalf;
    } else {
      pos = clamp(pos, vec2f(-params.worldHalf), vec2f(params.worldHalf));
    }
    posOut[i] = pos;
    velOut[i] = vel;
  }
}
`;return`${t}${c?Be:""}
${l}${s}
}
${u}`}function xe(p){return`
  var accel = vec2f(0.0, 0.0);
  let rMax2 = params.rMax * params.rMax;
  for (var j = 0u; j < params.count; j++) {
    if (j == myIdx) { continue; }
    let rel = posIn[j] - myPos;
    let d2 = dot(rel, rel);
    if (d2 > rMax2) { continue; }   // 距离平方 early-out:绝大多数对免开方
    let d = sqrt(d2);
    let r = d / params.rMax;
    if (r > 0.0 && r < 1.0) {
      let f = force(r, matrix[mySp * ${p}u + species[j]]);
      accel = accel + rel / d * f;
    }
  }
  return accel;
  `}function he(p){return`
  var accel = vec2f(0.0, 0.0);
  let rMax2 = params.rMax * params.rMax;
  let tiles = (params.count + ${m}u - 1u) / ${m}u;
  for (var t = 0u; t < tiles; t++) {
    let loadIdx = t * ${m}u + lid;
    tilePos[lid] = posIn[min(loadIdx, params.count - 1u)];
    tileSp[lid] = species[min(loadIdx, params.count - 1u)];
    workgroupBarrier();
    let tileLen = min(${m}u, params.count - t * ${m}u);
    for (var k = 0u; k < ${m}u; k++) {
      if (k >= tileLen) { break; }
      let j = t * ${m}u + k;
      if (j == myIdx) { continue; }
      let rel = tilePos[k] - myPos;
      let d2 = dot(rel, rel);
      if (d2 > rMax2) { continue; } // 距离平方 early-out
      let d = sqrt(d2);
      let r = d / params.rMax;
      if (r > 0.0 && r < 1.0) {
        let f = force(r, matrix[mySp * ${p}u + tileSp[k]]);
        accel = accel + rel / d * f;
      }
    }
    workgroupBarrier();
  }
  return accel;
  `}const Be=`
var<workgroup> tilePos: array<vec2f, ${m}>;
var<workgroup> tileSp: array<u32, ${m}>;
`;function Se(p,e,c){const t=e==="species"?`const PALETTE = array<vec3f, ${p}>(
  vec3f(1.00, 0.42, 0.24),
  vec3f(0.36, 0.86, 0.56),
  vec3f(0.36, 0.58, 1.00),
  vec3f(0.98, 0.80, 0.30),
);`:"",l=e==="velocity"?`
  let speed = length(vel[inst]);
  let t = 1.0 - exp(-speed * 40.0);
  out.color = mix(vec3f(0.20, 0.32, 0.55), vec3f(1.0, 0.85, 0.45), t);
  out.color = mix(out.color, vec3f(1.0, 0.95, 0.9), smoothstep(0.6, 1.0, t));`:`
  let sp = min(species[inst], ${p-1}u);
  out.color = PALETTE[sp];`;return`
struct VsOut {
  @builtin(position) clip: vec4f,
  @location(0) uv: vec2f,
  @location(1) color: vec3f,
};
${t}
@group(0) @binding(0) var<storage, read> pos: array<vec2f>;
@group(0) @binding(1) var<storage, read> species: array<u32>;${e==="velocity"?`
@group(0) @binding(2) var<storage, read> vel: array<vec2f>;`:""}
@group(0) @binding(3) var<uniform> rs: vec4f; // x = 1/worldHalf(相机缩放;binding 2 留给 velocity 模式的 vel)

@vertex
fn vs(@location(0) corner: vec2f, @builtin(instance_index) inst: u32) -> VsOut {
  var out: VsOut;
  out.clip = vec4f((pos[inst] + corner * ${c.toFixed(4)}) * rs.x, 0.0, 1.0);
  out.uv = corner;
  ${l}
  return out;
}

@fragment
fn fs(in: VsOut) -> @location(0) vec4f {
  let d = length(in.uv);
  if (d > 1.0) { discard; }
  let alpha = smoothstep(1.0, 0.35, d);
  return vec4f(in.color * alpha, alpha);
}
`}const de=64,_=256,pe=`
fn cellOf(p: vec2f) -> u32 {
  let g = i32(params.gridSize);
  let span = params.worldHalf * 2.0;
  let cx = clamp(i32(floor((p.x + params.worldHalf) / span * f32(g))), 0, g - 1);
  let cy = clamp(i32(floor((p.y + params.worldHalf) / span * f32(g))), 0, g - 1);
  return u32(cy) * params.gridSize + u32(cx);
}
`;function Pe(){return`
struct Params {
  count: u32, _pad0: u32,
  dt: f32, rMax: f32, beta: f32, forceFactor: f32, friction: f32,
  worldHalf: f32, wrapEdge: f32,
  gridSize: u32, cells: u32, maxCand: u32,
};
@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> posIn: array<vec2f>;
@group(0) @binding(2) var<storage, read_write> cellCount: array<atomic<u32>>;
${pe}
@compute @workgroup_size(${de})
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= params.count) { return; }
  atomicAdd(&cellCount[cellOf(posIn[i])], 1u);
}
`}function _e(){return`
struct Params {
  count: u32, _pad0: u32,
  dt: f32, rMax: f32, beta: f32, forceFactor: f32, friction: f32,
  worldHalf: f32, wrapEdge: f32,
  gridSize: u32, cells: u32, maxCand: u32,
};
@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read_write> cellCount: array<atomic<u32>>;
@group(0) @binding(2) var<storage, read_write> cellStart: array<u32>;
@group(0) @binding(3) var<storage, read_write> cellFill: array<u32>;
var<workgroup> partial: array<u32, ${_}>;

@compute @workgroup_size(${_})
fn main(@builtin(local_invocation_id) lid: vec3u) {
  let tid = lid.x;
  let cells = params.cells;
  let chunks = (cells + ${_}u - 1u) / ${_}u;

  // 每线程串行求自己 chunk 的局部和
  var local = 0u;
  for (var c = 0u; c < chunks; c++) {
    let idx = c * ${_}u + tid;
    if (idx < cells) { local = local + atomicLoad(&cellCount[idx]); }
  }
  partial[tid] = local;
  workgroupBarrier();

  // 256 个局部和做 Hillis-Steele 含前缀扫描
  var offset = 1u;
  loop {
    if (offset >= ${_}u) { break; }
    var v = 0u;
    if (tid >= offset) { v = partial[tid - offset]; }
    workgroupBarrier();
    if (tid >= offset) { partial[tid] = partial[tid] + v; }
    workgroupBarrier();
    offset = offset << 1u;
  }

  // chunk 基址 = 前面所有 chunk 的总和;重走 chunk 写 start/fill,并归零 count 给下一帧
  var run = 0u;
  if (tid > 0u) { run = partial[tid - 1u]; }
  for (var c = 0u; c < chunks; c++) {
    let idx = c * ${_}u + tid;
    if (idx < cells) {
      cellStart[idx] = run;
      cellFill[idx] = run;
      run = run + atomicLoad(&cellCount[idx]);
      atomicStore(&cellCount[idx], 0u);
    }
  }
}
`}function ke(){return`
struct Params {
  count: u32, _pad0: u32,
  dt: f32, rMax: f32, beta: f32, forceFactor: f32, friction: f32,
  worldHalf: f32, wrapEdge: f32,
  gridSize: u32, cells: u32, maxCand: u32,
};
@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> posIn: array<vec2f>;
@group(0) @binding(2) var<storage, read> species: array<u32>;
@group(0) @binding(3) var<storage, read_write> cellFill: array<atomic<u32>>;
@group(0) @binding(4) var<storage, read_write> order: array<u32>;
@group(0) @binding(5) var<storage, read_write> sortedPos: array<vec2f>;
@group(0) @binding(6) var<storage, read_write> sortedSp: array<u32>;
${pe}
@compute @workgroup_size(${de})
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= params.count) { return; }
  let slot = atomicAdd(&cellFill[cellOf(posIn[i])], 1u);
  order[slot] = i;
  sortedPos[slot] = posIn[i];
  sortedSp[slot] = species[i];
}
`}function Ce(p){return`
struct Params {
  count: u32, _pad0: u32,
  dt: f32, rMax: f32, beta: f32, forceFactor: f32, friction: f32,
  worldHalf: f32, wrapEdge: f32,
  gridSize: u32, cells: u32, maxCand: u32,
};
@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> matrix: array<f32>;
@group(0) @binding(2) var<storage, read> species: array<u32>;
@group(0) @binding(3) var<storage, read> posIn: array<vec2f>;
@group(0) @binding(4) var<storage, read> sortedPos: array<vec2f>;
@group(0) @binding(5) var<storage, read> sortedSp: array<u32>;
@group(0) @binding(6) var<storage, read> cellStart: array<u32>;
@group(0) @binding(7) var<storage, read> cellFill: array<u32>;
@group(0) @binding(8) var<storage, read> order: array<u32>;
@group(0) @binding(9) var<storage, read_write> partial: array<vec2f>;

fn force(r: f32, a: f32) -> f32 {
  if (r < params.beta) { return a / params.beta - 1.0; }
  if (r < 1.0) { return a * (1.0 - abs(2.0 * r - 1.0 - params.beta) / (1.0 - params.beta)); }
  return 0.0;
}

@compute @workgroup_size(64)
fn main_force_cell(@builtin(global_invocation_id) gid: vec3u) {
  let tid = gid.x;
  let i = tid / 9u;
  if (i >= params.count) { return; }
  let c = tid % 9u;
  let g = i32(params.gridSize);
  // 与 CELL_OF 完全相同的浮点序列(除以 span 再乘 g)——路径不一致会让贴格粒子查询错位一格
  let span = params.worldHalf * 2.0;
  var cx = clamp(i32(floor((posIn[i].x + params.worldHalf) / span * f32(g))), 0, g - 1);
  var cy = clamp(i32(floor((posIn[i].y + params.worldHalf) / span * f32(g))), 0, g - 1);
  let dx = i32(c % 3u) - 1;
  let dy = i32(c / 3u) - 1;
  let nx = cx + dx;
  let ny = cy + dy;
  let out = i * 9u + c;
  if (nx < 0 || ny < 0 || nx >= g || ny >= g) { partial[out] = vec2f(0.0); return; }
  let cc = u32(ny) * u32(g) + u32(nx);
  let s = cellStart[cc];
  let e = cellFill[cc];
  let myPos = posIn[i];
  let mySp = species[i];
  let rMax2 = params.rMax * params.rMax;
  var accel = vec2f(0.0, 0.0);
  var checked = 0u;
  for (var k = s; k < e; k++) {
    checked = checked + 1u;
    if (checked > params.maxCand) { break; }
    if (order[k] == i) { continue; }
    let rel = sortedPos[k] - myPos;
    let d2 = dot(rel, rel);
    if (d2 > rMax2) { continue; }
    let d = sqrt(d2);
    let r = d / params.rMax;
    if (r > 0.0 && r < 1.0) {
      let f = force(r, matrix[mySp * ${p}u + sortedSp[k]]);
      accel = accel + rel / d * f;
    }
  }
  partial[out] = accel;
}

@group(0) @binding(0) var<uniform> params2: Params;
@group(0) @binding(1) var<storage, read> velIn: array<vec2f>;
@group(0) @binding(2) var<storage, read> posIn2: array<vec2f>;
@group(0) @binding(3) var<storage, read> partialR: array<vec2f>;
@group(0) @binding(4) var<storage, read_write> posOut: array<vec2f>;
@group(0) @binding(5) var<storage, read_write> velOut: array<vec2f>;

@compute @workgroup_size(64)
fn main_force_integrate(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= params2.count) { return; }
  var accel = vec2f(0.0, 0.0);
  for (var c = 0u; c < 9u; c++) {
    accel = accel + partialR[i * 9u + c];
  }
  accel = accel * params2.forceFactor * params2.rMax;
  var vel = (velIn[i] + accel * params2.dt) * params2.friction;
  var pos = posIn2[i] + vel * params2.dt;
  let span = params2.worldHalf * 2.0;
  if (params2.wrapEdge > 0.5) {
    pos = ((pos + params2.worldHalf) % span + span) % span - params2.worldHalf;
  } else {
    pos = clamp(pos, vec2f(-params2.worldHalf), vec2f(params2.worldHalf));
  }
  posOut[i] = pos;
  velOut[i] = vel;
}
`}let Me=0;const ne=new WeakMap,se=p=>{let e=ne.get(p);return e===void 0&&(e=++Me,ne.set(p,e)),e};class q{#e;#n;#f;#r;#t;#a;#s;#c;#o;#u;#i=new Map;#l;constructor(e,c,t,l,s,u,f,y,w,d,g){this.#e=e,this.#n=c,this.#f=t,this.#r=l,this.#t=s,this.#a=u,this.#s=f,this.#l=y,this.#u=w,this.#c=d,this.#o=g}static async create(e,c){const t=await le.get(),l=e.getContext("webgpu");if(!l)throw new Error('canvas.getContext("webgpu") 返回空:该 canvas 已被其他后端占用?');const s=navigator.gpu.getPreferredCanvasFormat();l.configure({device:t.device,format:s,alphaMode:"opaque"});const u=t.device.createShaderModule({code:Se(4,c.color,c.pointSize),label:"particles-render"}),f=t.device.createBuffer({size:16,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});t.device.queue.writeBuffer(f,0,new Float32Array([1/c.worldHalf,0,0,0]));const w=(await u.getCompilationInfo()).messages.filter(b=>b.type==="error");if(w.length>0)throw new fe("particles-render",w.map(b=>({line:b.lineNum+1,msg:b.message})),0);const d=t.device.createRenderPipeline({layout:"auto",vertex:{module:u,entryPoint:"vs",buffers:[{arrayStride:8,attributes:[{shaderLocation:0,offset:0,format:"float32x2"}]}]},fragment:{module:u,entryPoint:"fs",targets:[{format:s,blend:{color:{srcFactor:"one",dstFactor:"one-minus-src-alpha"},alpha:{srcFactor:"one",dstFactor:"one-minus-src-alpha"}}}]},primitive:{topology:"triangle-list"}}),g=t.device.createBuffer({size:32,usage:GPUBufferUsage.VERTEX|GPUBufferUsage.COPY_DST});t.device.queue.writeBuffer(g,0,new Float32Array([-1,-1,1,-1,-1,1,1,1]));const S=t.device.createBuffer({size:12,usage:GPUBufferUsage.INDEX|GPUBufferUsage.COPY_DST});return t.device.queue.writeBuffer(S,0,new Uint16Array([0,1,2,2,1,3])),new q(t,l,s,d,g,S,c.species,c.count,f,c.vel??null,c.color)}render(e,c=null,t=this.#l){const l=`${se(e.gpuBuffer)}:${c?se(c.gpuBuffer):0}`;let s=this.#i.get(l);s||(s=this.#e.device.createBindGroup({layout:this.#r.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:e.gpuBuffer}},...this.#o==="species"?[{binding:1,resource:{buffer:this.#s.gpuBuffer}}]:[],...this.#o==="velocity"&&this.#c&&c?[{binding:2,resource:{buffer:c.gpuBuffer}}]:[],{binding:3,resource:{buffer:this.#u}}]}),this.#i.set(l,s));const u=this.#e.device.createCommandEncoder(),f=u.beginRenderPass({colorAttachments:[{view:this.#n.getCurrentTexture().createView(),clearValue:{r:.012,g:.014,b:.024,a:1},loadOp:"clear",storeOp:"store"}]});f.setPipeline(this.#r),f.setBindGroup(0,s),f.setVertexBuffer(0,this.#t),f.setIndexBuffer(this.#a,"uint16"),f.drawIndexed(6,t),f.end(),this.#e.device.queue.submit([u.finish()])}destroy(){this.#t.destroy(),this.#a.destroy(),this.#i.clear()}}const ce=48;async function Ie(p={}){const e=ye(p),t=(await le.get()).device,l=1*Math.sqrt(e.count/16e3),s=await me.create({pos:"vec2f",vel:"vec2f"},e.count),u={pos:s.current.pos,vel:s.current.vel},f={pos:s.other.pos,vel:s.other.vel},y=await h.create("u32",e.count),w=await h.create("f32",16);{const a=be(e.seedHash),o=new Float32Array(e.count*2);for(let i=0;i<o.length;i++)o[i]=(a()*1.6-.8)*l;const r=new Float32Array(e.count*2),v=new Uint32Array(e.count);for(let i=0;i<e.count;i++)v[i]=Math.floor(a()*4);u.pos.write(o),u.vel.write(r),y.write(v),w.write(new Float32Array(e.forces))}const d={rMax:e.rMax,beta:e.beta,forceFactor:e.forceFactor,frictionHalfLife:.04,dt:e.dt},g=t.createBuffer({size:ce,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST,label:"particles-params"}),S=(a,o=l)=>Math.max(4,Math.ceil(2*o/Math.max(a,.001)));let b=S(d.rMax,l);const k=a=>{const o=new ArrayBuffer(ce),r=new DataView(o);r.setUint32(0,e.count,!0),r.setUint32(4,0,!0),r.setFloat32(8,a,!0),r.setFloat32(12,d.rMax,!0),r.setFloat32(16,d.beta,!0),r.setFloat32(20,d.forceFactor,!0),r.setFloat32(24,Math.exp(-a/d.frictionHalfLife),!0),r.setFloat32(28,l,!0),r.setFloat32(32,e.bounds==="wrap"?1:0,!0),r.setUint32(36,b,!0),r.setUint32(40,b*b,!0),r.setUint32(44,Math.ceil(e.maxNeighbors/9),!0),t.queue.writeBuffer(g,0,o)};k(e.dt);const F=async(a,o)=>{const r=t.createShaderModule({code:a,label:o}),i=(await r.getCompilationInfo()).messages.filter(x=>x.type==="error");if(i.length>0)throw new fe(o,i.map(x=>({line:x.lineNum,msg:x.message})),0);return r},C=async(a,o,r)=>ve(t,a,`${r}(${o})`,o);let O=null,R=null,N=null,n=null;const T=async a=>{const o=a*a,r=await h.create("u32",o),v=await h.create("u32",o),i=await h.create("u32",o),x=await h.create("u32",e.count);r.write(new Uint32Array(o));const $=await F(Pe(),"grid-counts"),M=await F(_e(),"grid-scan"),G=await F(ke(),"grid-scatter"),P=await F(Ce(4),"grid-force"),Y=await C($,"main","grid-counts"),X=await C(M,"main","grid-scan"),J=await C(G,"main","grid-scatter"),Z=await C(P,"main_force_cell","grid-force-cell"),Q=await C(P,"main_force_integrate","grid-force-integrate"),E=await h.create("vec2f",e.count*9),H=await h.create("vec2f",e.count),L=await h.create("u32",e.count),ee=B=>t.createBindGroup({layout:Y.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:g}},{binding:1,resource:{buffer:B.gpuBuffer}},{binding:2,resource:{buffer:r.gpuBuffer}}]}),ge=t.createBindGroup({layout:X.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:g}},{binding:1,resource:{buffer:r.gpuBuffer}},{binding:2,resource:{buffer:v.gpuBuffer}},{binding:3,resource:{buffer:i.gpuBuffer}}]}),re=B=>t.createBindGroup({layout:J.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:g}},{binding:1,resource:{buffer:B.gpuBuffer}},{binding:2,resource:{buffer:y.gpuBuffer}},{binding:3,resource:{buffer:i.gpuBuffer}},{binding:4,resource:{buffer:x.gpuBuffer}},{binding:5,resource:{buffer:H.gpuBuffer}},{binding:6,resource:{buffer:L.gpuBuffer}}]}),te=B=>t.createBindGroup({layout:Z.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:g}},{binding:1,resource:{buffer:w.gpuBuffer}},{binding:2,resource:{buffer:y.gpuBuffer}},{binding:3,resource:{buffer:B.gpuBuffer}},{binding:4,resource:{buffer:H.gpuBuffer}},{binding:5,resource:{buffer:L.gpuBuffer}},{binding:6,resource:{buffer:v.gpuBuffer}},{binding:7,resource:{buffer:i.gpuBuffer}},{binding:8,resource:{buffer:x.gpuBuffer}},{binding:9,resource:{buffer:E.gpuBuffer}}]}),ae=(B,oe)=>t.createBindGroup({layout:Q.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:g}},{binding:1,resource:{buffer:B.vel.gpuBuffer}},{binding:2,resource:{buffer:B.pos.gpuBuffer}},{binding:3,resource:{buffer:E.gpuBuffer}},{binding:4,resource:{buffer:oe.pos.gpuBuffer}},{binding:5,resource:{buffer:oe.vel.gpuBuffer}}]});return{size:a,count:r,start:v,fill:i,order:x,partial:E,sortedPos:H,sortedSp:L,pCounts:Y,pScan:X,pScatter:J,pForceCell:Z,pForceInt:Q,bgCountsA:ee(u.pos),bgCountsB:ee(f.pos),bgScan:ge,bgScatterA:re(u.pos),bgScatterB:re(f.pos),bgForceCellAB:te(u.pos),bgForceCellBA:te(f.pos),bgIntegrateAB:ae(u,f),bgIntegrateBA:ae(f,u)}};if(e.mode==="grid")n=await T(b);else{const a=await F(we(e.mode,4),`particles-sim(${e.mode})`);O=await C(a,"main",`particles-sim(${e.mode})`);const o=(r,v)=>t.createBindGroup({layout:O.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:g}},{binding:1,resource:{buffer:w.gpuBuffer}},{binding:2,resource:{buffer:y.gpuBuffer}},{binding:3,resource:{buffer:r.pos.gpuBuffer}},{binding:4,resource:{buffer:r.vel.gpuBuffer}},{binding:5,resource:{buffer:v.pos.gpuBuffer}},{binding:6,resource:{buffer:v.vel.gpuBuffer}}]});R=o(u,f),N=o(f,u)}let U=null,j=0,D=0,A=0,I=0,V=performance.now(),K=0;return t.addEventListener?.("uncapturederror",a=>{K++;const o=a.error?.message??String(a),r=globalThis;r.__firstGpuError??=o.slice(0,400),r.__lastGpuError=o.slice(0,300),console.error("[wgpu-kit particles] GPU 错误:",o)}),{config:e,async attach(a){const o=Math.min(window.devicePixelRatio||1,2);a.width=Math.max(1,Math.floor(a.clientWidth*o)),a.height=Math.max(1,Math.floor(a.clientHeight*o)),U=await q.create(a,{count:e.count,species:y,vel:u.vel,color:e.color,pointSize:e.pointSize*l,worldHalf:l})},tick(a=1){const o=e.dt*a;k(o);const r=j%2===0,v=t.createCommandEncoder(),i=v.beginComputePass();if(n){i.setPipeline(n.pCounts),i.setBindGroup(0,r?n.bgCountsA:n.bgCountsB),i.dispatchWorkgroups(Math.ceil(e.count/m)),i.setPipeline(n.pScan),i.setBindGroup(0,n.bgScan),i.dispatchWorkgroups(1),i.setPipeline(n.pScatter),i.setBindGroup(0,r?n.bgScatterA:n.bgScatterB),i.dispatchWorkgroups(Math.ceil(e.count/m)),i.end(),t.queue.submit([v.finish()]);const $=t.createCommandEncoder(),M=$.beginComputePass();M.setPipeline(n.pForceCell),M.setBindGroup(0,r?n.bgForceCellAB:n.bgForceCellBA),M.dispatchWorkgroups(Math.ceil(e.count*9/m)),M.end(),t.queue.submit([$.finish()]);const G=t.createCommandEncoder(),P=G.beginComputePass();P.setPipeline(n.pForceInt),P.setBindGroup(0,r?n.bgIntegrateAB:n.bgIntegrateBA),P.dispatchWorkgroups(Math.ceil(e.count/m)),P.end(),t.queue.submit([G.finish()])}else i.setPipeline(O),i.setBindGroup(0,r?R:N),i.dispatchWorkgroups(Math.ceil(e.count/m)),i.end(),t.queue.submit([v.finish()]);U?.render((r?s.other:s.current).pos,(r?s.other:s.current).vel),s.swap(),j++,A++;const x=performance.now();I+=x-V,V=x,I>=500&&(D=A/(I/1e3),A=0,I=0)},setForces(a){const o=ue(a,W(e.seed));w.write(new Float32Array(o)),e.forces=o,e.forcesName=typeof a=="string"?a:"custom"},setParams(a){if(Object.assign(d,a),n&&a.rMax!==void 0){const o=S(d.rMax);o!==b&&(b=o,(async()=>{const r=n;n=await T(b),r.count.destroy(),r.start.destroy(),r.fill.destroy(),r.order.destroy()})())}},snapshot(){return JSON.stringify({count:e.count,forces:e.forcesName,mode:e.mode,color:e.color,bounds:e.bounds,seed:e.seed,rMax:d.rMax,beta:d.beta,forceFactor:d.forceFactor,frictionHalfLife:d.frictionHalfLife,dt:d.dt,pointSize:e.pointSize})},stats(){return{fps:D,gpuErrors:K}},debugGrid:n?()=>{const a=n;return{partial:a.partial,start:a.start,fill:a.fill,sortedPos:a.sortedPos,sortedSp:a.sortedSp,order:a.order}}:void 0,buffers(){return{pos:s.current.pos,vel:s.current.vel,species:y}},destroy(){U?.destroy(),s.destroy(),y.destroy(),w.destroy(),g.destroy(),n&&(n.count.destroy(),n.start.destroy(),n.fill.destroy(),n.order.destroy(),n.partial.destroy(),n.sortedPos.destroy(),n.sortedSp.destroy())}}}export{Ie as p};
