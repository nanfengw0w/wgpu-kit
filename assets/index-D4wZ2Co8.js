import{U as q,E as N,h as j,r as pe,G as ge,C as me,P as xe,B as S,m as he,c as Be,a as Se}from"./presets-CDncw6LK.js";const ue=["n2","tiled","grid"];function Pe(g={}){const{count:e=8192,forces:n="cells",mode:t="grid",color:f="species",bounds:s="wrap",seed:c="wgpu-kit",rMax:l=.12,beta:y=.3,forceFactor:w=10,frictionHalfLife:p=.04,dt:m=.02,pointSize:P=.004,maxNeighbors:v=8100}=g;if(!Number.isInteger(e)||e<=0||e>1e6)throw new q(N.USAGE,`count must be an integer in 1..1_000_000, got: ${String(e)}`);if(!ue.includes(t))throw new q(N.USAGE,`mode must be one of ${ue.join(" | ")}, got: "${String(t)}"`);if(t==="n2"&&e>32e3)throw new q(N.USAGE,`mode='n2' is recommended for count <= 20000 (got ${e}); use 'tiled' or 'grid' for larger counts`);const _=String(c);return{count:e,forces:pe(n,j(_)),forcesName:typeof n=="string"?n:"custom",mode:t,color:f,bounds:s,seed:_,seedHash:j(_),rMax:l,beta:y,forceFactor:w,friction:Math.exp(-m/p),frictionHalfLife:p,dt:m,pointSize:P,maxNeighbors:v}}const b=64;function Ce(g,e){const n=g==="tiled",t=`
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
`,f=n?"fn interact(myIdx: u32, mySp: u32, myPos: vec2f, lid: u32) -> vec2f {":"fn interact(myIdx: u32, mySp: u32, myPos: vec2f) -> vec2f {",s=n?_e(e):Fe(e),c=`
@compute @workgroup_size(${b})
fn main(@builtin(global_invocation_id) gid: vec3u${n?", @builtin(local_invocation_id) lid: vec3u":""}) {
  let i = gid.x;
  // 注意:workgroupBarrier 要求 uniform control flow——
  // 越界线程也必须参与 barrier 循环,只能在最终写入处 guard(tiled 尾部 workgroup 的经典坑)
  let ok = i < params.count;
  let myIdx = min(i, params.count - 1u);
  let mySp = species[myIdx];
  let myPos = posIn[myIdx];
  var accel = interact(myIdx, mySp, myPos${n?", lid.x":""});
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
`;return`${t}${n?ke:""}
${f}${s}
}
${c}`}function Fe(g){return`
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
      let f = force(r, matrix[mySp * ${g}u + species[j]]);
      accel = accel + rel / d * f;
    }
  }
  return accel;
  `}function _e(g){return`
  var accel = vec2f(0.0, 0.0);
  let rMax2 = params.rMax * params.rMax;
  let tiles = (params.count + ${b}u - 1u) / ${b}u;
  for (var t = 0u; t < tiles; t++) {
    let loadIdx = t * ${b}u + lid;
    tilePos[lid] = posIn[min(loadIdx, params.count - 1u)];
    tileSp[lid] = species[min(loadIdx, params.count - 1u)];
    workgroupBarrier();
    let tileLen = min(${b}u, params.count - t * ${b}u);
    for (var k = 0u; k < ${b}u; k++) {
      if (k >= tileLen) { break; }
      let j = t * ${b}u + k;
      if (j == myIdx) { continue; }
      let rel = tilePos[k] - myPos;
      let d2 = dot(rel, rel);
      if (d2 > rMax2) { continue; } // 距离平方 early-out
      let d = sqrt(d2);
      let r = d / params.rMax;
      if (r > 0.0 && r < 1.0) {
        let f = force(r, matrix[mySp * ${g}u + tileSp[k]]);
        accel = accel + rel / d * f;
      }
    }
    workgroupBarrier();
  }
  return accel;
  `}const ke=`
var<workgroup> tilePos: array<vec2f, ${b}>;
var<workgroup> tileSp: array<u32, ${b}>;
`;function Me(g,e,n){const t=e==="species"?`const PALETTE = array<vec3f, ${g}>(
  vec3f(1.00, 0.42, 0.24),
  vec3f(0.36, 0.86, 0.56),
  vec3f(0.36, 0.58, 1.00),
  vec3f(0.98, 0.80, 0.30),
);`:"",f=e==="velocity"?`
  let speed = length(vel[inst]);
  let t = 1.0 - exp(-speed * 40.0);
  out.color = mix(vec3f(0.20, 0.32, 0.55), vec3f(1.0, 0.85, 0.45), t);
  out.color = mix(out.color, vec3f(1.0, 0.95, 0.9), smoothstep(0.6, 1.0, t));`:`
  let sp = min(species[inst], ${g-1}u);
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
  out.clip = vec4f((pos[inst] + corner * ${n.toFixed(4)}) * rs.x, 0.0, 1.0);
  out.uv = corner;
  ${f}
  return out;
}

@fragment
fn fs(in: VsOut) -> @location(0) vec4f {
  let d = length(in.uv);
  if (d > 1.0) { discard; }
  let alpha = smoothstep(1.0, 0.35, d);
  return vec4f(in.color * alpha, alpha);
}
`}const be=64,T=256,ve=`
fn cellOf(p: vec2f) -> u32 {
  let g = i32(params.gridSize);
  let span = params.worldHalf * 2.0;
  let cx = clamp(i32(floor((p.x + params.worldHalf) / span * f32(g))), 0, g - 1);
  let cy = clamp(i32(floor((p.y + params.worldHalf) / span * f32(g))), 0, g - 1);
  return u32(cy) * params.gridSize + u32(cx);
}
`;function Ie(){return`
struct Params {
  count: u32, _pad0: u32,
  dt: f32, rMax: f32, beta: f32, forceFactor: f32, friction: f32,
  worldHalf: f32, wrapEdge: f32,
  gridSize: u32, cells: u32, maxCand: u32,
};
@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> posIn: array<vec2f>;
@group(0) @binding(2) var<storage, read_write> cellCount: array<atomic<u32>>;
${ve}
@compute @workgroup_size(${be})
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= params.count) { return; }
  atomicAdd(&cellCount[cellOf(posIn[i])], 1u);
}
`}function Ge(){return`
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

var<workgroup> partial: array<u32, ${T}>;
var<workgroup> carry: u32;

@compute @workgroup_size(${T})
fn main(@builtin(local_invocation_id) lid: vec3u) {
  let tid = lid.x;
  let wg = ${T}u;
  let cells = params.cells;
  let numChunks = (cells + wg - 1u) / wg;
  if (tid == 0u) { carry = 0u; }
  workgroupBarrier();
  for (var ch = 0u; ch < numChunks; ch++) {
    let idx = ch * wg + tid;
    let inRange = idx < cells;
    let v0 = select(0u, atomicLoad(&cellCount[idx]), inRange);
    partial[tid] = v0;
    workgroupBarrier();
    // 块内含前缀(Hillis-Steele)
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
    // 排他:start = carry + 块内前缀(不含自身);fill 是 scatter 的原子填充
    // 游标,初始化为段起点(与通用包 NeighborGrid 同语义)——scatter 填完一格
    // 后 fill 恰好 = start + count,力核读 [start, fill) 才不会多扫下一格的粒子。
    if (inRange) {
      let excl = partial[tid] - v0;
      cellStart[idx] = carry + excl;
      cellFill[idx] = carry + excl;
      atomicStore(&cellCount[idx], 0u);
    }
    // 所有线程读完 partial/写完 carry 后才能进入下一块
    workgroupBarrier();
    if (tid == wg - 1u) { carry = carry + partial[wg - 1u]; }
    workgroupBarrier();
  }
}
`}function $e(){return`
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
${ve}
@compute @workgroup_size(${be})
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= params.count) { return; }
  let slot = atomicAdd(&cellFill[cellOf(posIn[i])], 1u);
  order[slot] = i;
  sortedPos[slot] = posIn[i];
  sortedSp[slot] = species[i];
}
`}function Ae(g){return`
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
      let f = force(r, matrix[mySp * ${g}u + sortedSp[k]]);
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
`}let Ue=0;const le=new WeakMap,fe=g=>{let e=le.get(g);return e===void 0&&(e=++Ue,le.set(g,e)),e};class D{#e;#n;#f;#r;#t;#a;#s;#c;#o;#u;#i=new Map;#l;constructor(e,n,t,f,s,c,l,y,w,p,m){this.#e=e,this.#n=n,this.#f=t,this.#r=f,this.#t=s,this.#a=c,this.#s=l,this.#l=y,this.#u=w,this.#c=p,this.#o=m}static async create(e,n){const t=await ge.get(),f=e.getContext("webgpu");if(!f)throw new Error('canvas.getContext("webgpu") 返回空:该 canvas 已被其他后端占用?');const s=navigator.gpu.getPreferredCanvasFormat();f.configure({device:t.device,format:s,alphaMode:"opaque"});const c=t.device.createShaderModule({code:Me(4,n.color,n.pointSize),label:"particles-render"}),l=t.device.createBuffer({size:16,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});t.device.queue.writeBuffer(l,0,new Float32Array([1/n.worldHalf,0,0,0]));const w=(await c.getCompilationInfo()).messages.filter(v=>v.type==="error");if(w.length>0)throw new me("particles-render",w.map(v=>({line:v.lineNum+1,msg:v.message})),0);const p=t.device.createRenderPipeline({layout:"auto",vertex:{module:c,entryPoint:"vs",buffers:[{arrayStride:8,attributes:[{shaderLocation:0,offset:0,format:"float32x2"}]}]},fragment:{module:c,entryPoint:"fs",targets:[{format:s,blend:{color:{srcFactor:"one",dstFactor:"one-minus-src-alpha"},alpha:{srcFactor:"one",dstFactor:"one-minus-src-alpha"}}}]},primitive:{topology:"triangle-list"}}),m=t.device.createBuffer({size:32,usage:GPUBufferUsage.VERTEX|GPUBufferUsage.COPY_DST});t.device.queue.writeBuffer(m,0,new Float32Array([-1,-1,1,-1,-1,1,1,1]));const P=t.device.createBuffer({size:12,usage:GPUBufferUsage.INDEX|GPUBufferUsage.COPY_DST});return t.device.queue.writeBuffer(P,0,new Uint16Array([0,1,2,2,1,3])),new D(t,f,s,p,m,P,n.species,n.count,l,n.vel??null,n.color)}render(e,n=null,t=this.#l){const f=`${fe(e.gpuBuffer)}:${n?fe(n.gpuBuffer):0}`;let s=this.#i.get(f);s||(s=this.#e.device.createBindGroup({layout:this.#r.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:e.gpuBuffer}},...this.#o==="species"?[{binding:1,resource:{buffer:this.#s.gpuBuffer}}]:[],...this.#o==="velocity"&&this.#c&&n?[{binding:2,resource:{buffer:n.gpuBuffer}}]:[],{binding:3,resource:{buffer:this.#u}}]}),this.#i.set(f,s));const c=this.#e.device.createCommandEncoder(),l=c.beginRenderPass({colorAttachments:[{view:this.#n.getCurrentTexture().createView(),clearValue:{r:.012,g:.014,b:.024,a:1},loadOp:"clear",storeOp:"store"}]});l.setPipeline(this.#r),l.setBindGroup(0,s),l.setVertexBuffer(0,this.#t),l.setIndexBuffer(this.#a,"uint16"),l.drawIndexed(6,t),l.end(),this.#e.device.queue.submit([c.finish()])}destroy(){this.#t.destroy(),this.#a.destroy(),this.#i.clear()}}const de=48;async function Oe(g={}){const e=Pe(g),t=(await ge.get()).device,f=1*Math.sqrt(e.count/16e3),s=await xe.create({pos:"vec2f",vel:"vec2f"},e.count),c={pos:s.current.pos,vel:s.current.vel},l={pos:s.other.pos,vel:s.other.vel},y=await S.create("u32",e.count),w=await S.create("f32",16);{const r=he(e.seedHash),o=new Float32Array(e.count*2);for(let d=0;d<o.length;d++)o[d]=(r()*1.6-.8)*f;const a=new Float32Array(e.count*2),u=new Uint32Array(e.count);for(let d=0;d<e.count;d++)u[d]=Math.floor(r()*4);c.pos.write(o),c.vel.write(a),y.write(u),w.write(new Float32Array(e.forces))}const p={rMax:e.rMax,beta:e.beta,forceFactor:e.forceFactor,frictionHalfLife:e.frictionHalfLife,dt:e.dt},m=t.createBuffer({size:de,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST,label:"particles-params"}),P=(r,o=f)=>Math.max(4,Math.floor(2*o/Math.max(r,.001)));let v=P(p.rMax,f);const _=r=>{const o=new ArrayBuffer(de),a=new DataView(o);a.setUint32(0,e.count,!0),a.setUint32(4,0,!0),a.setFloat32(8,r,!0),a.setFloat32(12,p.rMax,!0),a.setFloat32(16,p.beta,!0),a.setFloat32(20,p.forceFactor,!0),a.setFloat32(24,Math.exp(-r/p.frictionHalfLife),!0),a.setFloat32(28,f,!0),a.setFloat32(32,e.bounds==="wrap"?1:0,!0),a.setUint32(36,v,!0),a.setUint32(40,v*v,!0),a.setUint32(44,Math.ceil(e.maxNeighbors/9),!0),t.queue.writeBuffer(m,0,o)};_(e.dt);const G=async(r,o)=>{const{module:a,messages:u}=await Be(t,r,o),d=u.filter(x=>x.type==="error");if(d.length>0)throw new me(o,d.map(x=>({line:x.lineNum,msg:x.message})),0);return a},k=async(r,o,a)=>Se(t,r,`${a}(${o})`,o);let E=null,V=null,K=null,i=null,Y=0;const X=r=>{r.count.destroy(),r.start.destroy(),r.fill.destroy(),r.order.destroy(),r.partial.destroy(),r.sortedPos.destroy(),r.sortedSp.destroy()},J=async r=>{const o=r*r,a=await S.create("u32",o),u=await S.create("u32",o),d=await S.create("u32",o),x=await S.create("u32",e.count);a.write(new Uint32Array(o));const h=await G(Ie(),"grid-counts"),M=await G(Ge(),"grid-scan"),I=await G($e(),"grid-scatter"),C=await G(Ae(4),"grid-force"),F=await k(h,"main","grid-counts"),te=await k(M,"main","grid-scan"),ae=await k(I,"main","grid-scatter"),oe=await k(C,"main_force_cell","grid-force-cell"),ie=await k(C,"main_force_integrate","grid-force-integrate"),L=await S.create("vec2f",e.count*9),z=await S.create("vec2f",e.count),R=await S.create("u32",e.count),ne=B=>t.createBindGroup({layout:F.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:m}},{binding:1,resource:{buffer:B.gpuBuffer}},{binding:2,resource:{buffer:a.gpuBuffer}}]}),ye=t.createBindGroup({layout:te.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:m}},{binding:1,resource:{buffer:a.gpuBuffer}},{binding:2,resource:{buffer:u.gpuBuffer}},{binding:3,resource:{buffer:d.gpuBuffer}}]}),se=B=>t.createBindGroup({layout:ae.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:m}},{binding:1,resource:{buffer:B.gpuBuffer}},{binding:2,resource:{buffer:y.gpuBuffer}},{binding:3,resource:{buffer:d.gpuBuffer}},{binding:4,resource:{buffer:x.gpuBuffer}},{binding:5,resource:{buffer:z.gpuBuffer}},{binding:6,resource:{buffer:R.gpuBuffer}}]}),A=B=>t.createBindGroup({layout:oe.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:m}},{binding:1,resource:{buffer:w.gpuBuffer}},{binding:2,resource:{buffer:y.gpuBuffer}},{binding:3,resource:{buffer:B.gpuBuffer}},{binding:4,resource:{buffer:z.gpuBuffer}},{binding:5,resource:{buffer:R.gpuBuffer}},{binding:6,resource:{buffer:u.gpuBuffer}},{binding:7,resource:{buffer:d.gpuBuffer}},{binding:8,resource:{buffer:x.gpuBuffer}},{binding:9,resource:{buffer:L.gpuBuffer}}]}),ce=(B,U)=>t.createBindGroup({layout:ie.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:m}},{binding:1,resource:{buffer:B.vel.gpuBuffer}},{binding:2,resource:{buffer:B.pos.gpuBuffer}},{binding:3,resource:{buffer:L.gpuBuffer}},{binding:4,resource:{buffer:U.pos.gpuBuffer}},{binding:5,resource:{buffer:U.vel.gpuBuffer}}]}),we=B=>{const U=B===c.pos?l.pos:c.pos;W.bgForceCellAB=A(B),W.bgForceCellBA=A(U)},W={size:r,count:a,start:u,fill:d,order:x,partial:L,sortedPos:z,sortedSp:R,pCounts:F,pScan:te,pScatter:ae,pForceCell:oe,pForceInt:ie,bgCountsA:ne(c.pos),bgCountsB:ne(l.pos),bgScan:ye,bgScatterA:se(c.pos),bgScatterB:se(l.pos),bgForceCellAB:A(c.pos),bgForceCellBA:A(l.pos),bgIntegrateAB:ce(c,l),bgIntegrateBA:ce(l,c),bgForceCellRebuild:we};return W};if(e.mode==="grid")i=await J(v);else{const r=await G(Ce(e.mode,4),`particles-sim(${e.mode})`);E=await k(r,"main",`particles-sim(${e.mode})`);const o=(a,u)=>t.createBindGroup({layout:E.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:m}},{binding:1,resource:{buffer:w.gpuBuffer}},{binding:2,resource:{buffer:y.gpuBuffer}},{binding:3,resource:{buffer:a.pos.gpuBuffer}},{binding:4,resource:{buffer:a.vel.gpuBuffer}},{binding:5,resource:{buffer:u.pos.gpuBuffer}},{binding:6,resource:{buffer:u.vel.gpuBuffer}}]});V=o(c,l),K=o(l,c)}let O=null,Z=0,Q=0,H=0,$=0,ee=performance.now(),re=0;return t.addEventListener?.("uncapturederror",r=>{re++;const o=r.error?.message??String(r),a=globalThis;a.__firstGpuError??=o.slice(0,400),a.__lastGpuError=o.slice(0,300),console.error("[wgpu-kit particles] GPU 错误:",o)}),{config:e,async attach(r){const o=Math.min(window.devicePixelRatio||1,2);r.width=Math.max(1,Math.floor(r.clientWidth*o)),r.height=Math.max(1,Math.floor(r.clientHeight*o)),O=await D.create(r,{count:e.count,species:y,vel:c.vel,color:e.color,pointSize:e.pointSize*f,worldHalf:f})},tick(r=1){const o=e.dt*r;_(o);const a=Z%2===0,u=t.createCommandEncoder();if(i){const h=u.beginComputePass();h.setPipeline(i.pCounts),h.setBindGroup(0,a?i.bgCountsA:i.bgCountsB),h.dispatchWorkgroups(Math.ceil(e.count/b)),h.end();const M=u.beginComputePass();M.setPipeline(i.pScan),M.setBindGroup(0,i.bgScan),M.dispatchWorkgroups(1),M.end();const I=u.beginComputePass();I.setPipeline(i.pScatter),I.setBindGroup(0,a?i.bgScatterA:i.bgScatterB),I.dispatchWorkgroups(Math.ceil(e.count/b)),I.end();const C=u.beginComputePass();C.setPipeline(i.pForceCell),C.setBindGroup(0,a?i.bgForceCellAB:i.bgForceCellBA),C.dispatchWorkgroups(Math.ceil(e.count*9/b)),C.end();const F=u.beginComputePass();F.setPipeline(i.pForceInt),F.setBindGroup(0,a?i.bgIntegrateAB:i.bgIntegrateBA),F.dispatchWorkgroups(Math.ceil(e.count/b)),F.end(),t.queue.submit([u.finish()])}else{const h=u.beginComputePass();h.setPipeline(E),h.setBindGroup(0,a?V:K),h.dispatchWorkgroups(Math.ceil(e.count/b)),h.end(),t.queue.submit([u.finish()])}const d=a?s.other:s.current;O?.render(d.pos,d.vel),s.swap(),Z++,H++;const x=performance.now();$+=x-ee,ee=x,$>=500&&(Q=H/($/1e3),H=0,$=0)},setForces(r){const o=pe(r,j(e.seed));w.write(new Float32Array(o)),e.forces=o,e.forcesName=typeof r=="string"?r:"custom"},setParams(r){if(Object.assign(p,r),i&&r.rMax!==void 0){const o=P(p.rMax);if(o!==v){v=o;const a=++Y;(async()=>{const u=await J(v);if(a!==Y){X(u);return}const d=i;i=u,u.bgForceCellRebuild(c.pos),d&&X(d)})()}}},snapshot(){return JSON.stringify({count:e.count,forces:e.forcesName,mode:e.mode,color:e.color,bounds:e.bounds,seed:e.seed,rMax:p.rMax,beta:p.beta,forceFactor:p.forceFactor,frictionHalfLife:p.frictionHalfLife,dt:p.dt,pointSize:e.pointSize})},stats(){return{fps:Q,gpuErrors:re}},debugGrid:i?()=>{const r=i;return{partial:r.partial,start:r.start,fill:r.fill,sortedPos:r.sortedPos,sortedSp:r.sortedSp,order:r.order}}:void 0,buffers(){return{pos:s.current.pos,vel:s.current.vel,species:y}},destroy(){O?.destroy(),s.destroy(),y.destroy(),w.destroy(),m.destroy(),i&&(i.count.destroy(),i.start.destroy(),i.fill.destroy(),i.order.destroy(),i.partial.destroy(),i.sortedPos.destroy(),i.sortedSp.destroy())}}}export{Oe as p};
