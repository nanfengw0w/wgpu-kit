import{U as R,h as q,r as pe,G as ge,C as me,P as xe,B as h,m as Be,c as he}from"./presets-DEcsTrp7.js";const ue=["n2","tiled","grid"];function Se(g={}){const{count:e=8192,forces:n="cells",mode:a="grid",color:f="species",bounds:c="wrap",seed:u="wgpu-kit",rMax:l=.12,beta:w=.3,forceFactor:y=10,frictionHalfLife:p=.04,dt:m=.02,pointSize:S=.004,maxNeighbors:v=32768}=g;if(!Number.isInteger(e)||e<=0||e>1e6)throw new R(`count 必须是 1..1_000_000 的整数,收到: ${String(e)}`);if(!ue.includes(a))throw new R(`mode 必须是 ${ue.join(" | ")},收到: "${String(a)}"`);if(a==="n2"&&e>32e3)throw new R(`mode='n2' 建议 count ≤ 20000(当前 ${e});大规模请用 mode='tiled' 或 'grid'`);const P=String(u);return{count:e,forces:pe(n,q(P)),forcesName:typeof n=="string"?n:"custom",mode:a,color:f,bounds:c,seed:P,seedHash:q(P),rMax:l,beta:w,forceFactor:y,friction:Math.exp(-m/p),frictionHalfLife:p,dt:m,pointSize:S,maxNeighbors:v}}const b=64;function Pe(g,e){const n=g==="tiled",a=`
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
`,f=n?"fn interact(myIdx: u32, mySp: u32, myPos: vec2f, lid: u32) -> vec2f {":"fn interact(myIdx: u32, mySp: u32, myPos: vec2f) -> vec2f {",c=n?Ce(e):ke(e),u=`
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
`;return`${a}${n?_e:""}
${f}${c}
}
${u}`}function ke(g){return`
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
  `}function Ce(g){return`
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
  `}const _e=`
var<workgroup> tilePos: array<vec2f, ${b}>;
var<workgroup> tileSp: array<u32, ${b}>;
`;function Fe(g,e,n){const a=e==="species"?`const PALETTE = array<vec3f, ${g}>(
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
${a}
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
`}const be=64,W=256,ve=`
fn cellOf(p: vec2f) -> u32 {
  let g = i32(params.gridSize);
  let span = params.worldHalf * 2.0;
  let cx = clamp(i32(floor((p.x + params.worldHalf) / span * f32(g))), 0, g - 1);
  let cy = clamp(i32(floor((p.y + params.worldHalf) / span * f32(g))), 0, g - 1);
  return u32(cy) * params.gridSize + u32(cx);
}
`;function Me(){return`
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
`}function Ie(){return`
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
@group(0) @binding(4) var<storage, read_write> blockSums: array<u32>;

var<workgroup> partial: array<u32, ${W}>;

@compute @workgroup_size(${W})
fn main(@builtin(local_invocation_id) lid: vec3u, @builtin(workgroup_id) wid: vec3u) {
  let tid = lid.x;
  let wg = ${W}u;
  let base = wid.x * wg;
  let cells = params.cells;

  // ① 块内 Hillis-Steele(块不足时以 0 填充)
  let v0 = select(0u, atomicLoad(&cellCount[base + tid]), base + tid < cells);
  partial[tid] = v0;
  workgroupBarrier();
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
  // 含前缀 → 排他:start = 块内前缀(不含自身),fill = start + count
  let myCount = v0;
  let myPrefix = select(partial[tid - 1u], 0u, tid == 0u);
  if (base + tid < cells) {
    cellStart[base + tid] = myPrefix;
    cellFill[base + tid] = myPrefix + myCount;
  }
  // 块总和 → blockSums(含)
  if (tid == 0u) { blockSums[wid.x] = partial[wg - 1u]; }
  workgroupBarrier();

  // ② 块间扫描(单 workgroup;块数 = ceil(cells/wg) ≤ SCAN_WORKGROUP)
  if (wid.x == 0u) {
    var off = 1u;
    loop {
      if (off >= wg) { break; }
      var v = 0u;
      if (tid >= off) { v = blockSums[tid - off]; }
      workgroupBarrier();
      if (tid >= off) { blockSums[tid] = blockSums[tid] + v; }
      workgroupBarrier();
      off = off << 1u;
    }
  }
  workgroupBarrier();

  // ③ 加块基址;cellCount 归零供下一帧
  let blockBase = select(0u, blockSums[wid.x - 1u], wid.x > 0u);
  if (base + tid < cells) {
    cellStart[base + tid] = cellStart[base + tid] + blockBase;
    cellFill[base + tid] = cellFill[base + tid] + blockBase;
    atomicStore(&cellCount[base + tid], 0u);
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
`}function Ge(g){return`
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
`}let Oe=0;const le=new WeakMap,fe=g=>{let e=le.get(g);return e===void 0&&(e=++Oe,le.set(g,e)),e};class N{#e;#s;#f;#r;#t;#a;#n;#c;#o;#u;#i=new Map;#l;constructor(e,n,a,f,c,u,l,w,y,p,m){this.#e=e,this.#s=n,this.#f=a,this.#r=f,this.#t=c,this.#a=u,this.#n=l,this.#l=w,this.#u=y,this.#c=p,this.#o=m}static async create(e,n){const a=await ge.get(),f=e.getContext("webgpu");if(!f)throw new Error('canvas.getContext("webgpu") 返回空:该 canvas 已被其他后端占用?');const c=navigator.gpu.getPreferredCanvasFormat();f.configure({device:a.device,format:c,alphaMode:"opaque"});const u=a.device.createShaderModule({code:Fe(4,n.color,n.pointSize),label:"particles-render"}),l=a.device.createBuffer({size:16,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});a.device.queue.writeBuffer(l,0,new Float32Array([1/n.worldHalf,0,0,0]));const y=(await u.getCompilationInfo()).messages.filter(v=>v.type==="error");if(y.length>0)throw new me("particles-render",y.map(v=>({line:v.lineNum+1,msg:v.message})),0);const p=a.device.createRenderPipeline({layout:"auto",vertex:{module:u,entryPoint:"vs",buffers:[{arrayStride:8,attributes:[{shaderLocation:0,offset:0,format:"float32x2"}]}]},fragment:{module:u,entryPoint:"fs",targets:[{format:c,blend:{color:{srcFactor:"one",dstFactor:"one-minus-src-alpha"},alpha:{srcFactor:"one",dstFactor:"one-minus-src-alpha"}}}]},primitive:{topology:"triangle-list"}}),m=a.device.createBuffer({size:32,usage:GPUBufferUsage.VERTEX|GPUBufferUsage.COPY_DST});a.device.queue.writeBuffer(m,0,new Float32Array([-1,-1,1,-1,-1,1,1,1]));const S=a.device.createBuffer({size:12,usage:GPUBufferUsage.INDEX|GPUBufferUsage.COPY_DST});return a.device.queue.writeBuffer(S,0,new Uint16Array([0,1,2,2,1,3])),new N(a,f,c,p,m,S,n.species,n.count,l,n.vel??null,n.color)}render(e,n=null,a=this.#l){const f=`${fe(e.gpuBuffer)}:${n?fe(n.gpuBuffer):0}`;let c=this.#i.get(f);c||(c=this.#e.device.createBindGroup({layout:this.#r.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:e.gpuBuffer}},...this.#o==="species"?[{binding:1,resource:{buffer:this.#n.gpuBuffer}}]:[],...this.#o==="velocity"&&this.#c&&n?[{binding:2,resource:{buffer:n.gpuBuffer}}]:[],{binding:3,resource:{buffer:this.#u}}]}),this.#i.set(f,c));const u=this.#e.device.createCommandEncoder(),l=u.beginRenderPass({colorAttachments:[{view:this.#s.getCurrentTexture().createView(),clearValue:{r:.012,g:.014,b:.024,a:1},loadOp:"clear",storeOp:"store"}]});l.setPipeline(this.#r),l.setBindGroup(0,c),l.setVertexBuffer(0,this.#t),l.setIndexBuffer(this.#a,"uint16"),l.drawIndexed(6,a),l.end(),this.#e.device.queue.submit([u.finish()])}destroy(){this.#t.destroy(),this.#a.destroy(),this.#i.clear()}}const de=48;async function Ue(g={}){const e=Se(g),a=(await ge.get()).device,f=1*Math.sqrt(e.count/16e3),c=await xe.create({pos:"vec2f",vel:"vec2f"},e.count),u={pos:c.current.pos,vel:c.current.vel},l={pos:c.other.pos,vel:c.other.vel},w=await h.create("u32",e.count),y=await h.create("f32",16);{const r=Be(e.seedHash),o=new Float32Array(e.count*2);for(let i=0;i<o.length;i++)o[i]=(r()*1.6-.8)*f;const t=new Float32Array(e.count*2),d=new Uint32Array(e.count);for(let i=0;i<e.count;i++)d[i]=Math.floor(r()*4);u.pos.write(o),u.vel.write(t),w.write(d),y.write(new Float32Array(e.forces))}const p={rMax:e.rMax,beta:e.beta,forceFactor:e.forceFactor,frictionHalfLife:e.frictionHalfLife,dt:e.dt},m=a.createBuffer({size:de,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST,label:"particles-params"}),S=(r,o=f)=>Math.max(4,Math.ceil(2*o/Math.max(r,.001)));let v=S(p.rMax,f);const P=r=>{const o=new ArrayBuffer(de),t=new DataView(o);t.setUint32(0,e.count,!0),t.setUint32(4,0,!0),t.setFloat32(8,r,!0),t.setFloat32(12,p.rMax,!0),t.setFloat32(16,p.beta,!0),t.setFloat32(20,p.forceFactor,!0),t.setFloat32(24,Math.exp(-r/p.frictionHalfLife),!0),t.setFloat32(28,f,!0),t.setFloat32(32,e.bounds==="wrap"?1:0,!0),t.setUint32(36,v,!0),t.setUint32(40,v*v,!0),t.setUint32(44,Math.ceil(e.maxNeighbors/9),!0),a.queue.writeBuffer(m,0,o)};P(e.dt);const F=async(r,o)=>{const t=a.createShaderModule({code:r,label:o}),i=(await t.getCompilationInfo()).messages.filter(x=>x.type==="error");if(i.length>0)throw new me(o,i.map(x=>({line:x.lineNum,msg:x.message})),0);return t},k=async(r,o,t)=>he(a,r,`${t}(${o})`,o);let O=null,T=null,j=null,s=null,D=0;const V=r=>{r.count.destroy(),r.start.destroy(),r.fill.destroy(),r.order.destroy(),r.partial.destroy(),r.sortedPos.destroy(),r.sortedSp.destroy(),r.blockSums.destroy()},K=async r=>{const o=r*r,t=await h.create("u32",o),d=await h.create("u32",o),i=await h.create("u32",o),x=await h.create("u32",e.count);t.write(new Uint32Array(o));const I=await F(Me(),"grid-counts"),C=await F(Ie(),"grid-scan"),_=await F($e(),"grid-scatter"),Q=await F(Ge(4),"grid-force"),ee=await k(I,"main","grid-counts"),re=await k(C,"main","grid-scan"),te=await k(_,"main","grid-scatter"),ae=await k(Q,"main_force_cell","grid-force-cell"),oe=await k(Q,"main_force_integrate","grid-force-integrate"),H=await h.create("vec2f",e.count*9),ie=await h.create("u32",Math.ceil(o/256)),E=await h.create("vec2f",e.count),L=await h.create("u32",e.count),se=B=>a.createBindGroup({layout:ee.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:m}},{binding:1,resource:{buffer:B.gpuBuffer}},{binding:2,resource:{buffer:t.gpuBuffer}}]}),we=a.createBindGroup({layout:re.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:m}},{binding:1,resource:{buffer:t.gpuBuffer}},{binding:2,resource:{buffer:d.gpuBuffer}},{binding:3,resource:{buffer:i.gpuBuffer}},{binding:4,resource:{buffer:ie.gpuBuffer}}]}),ne=B=>a.createBindGroup({layout:te.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:m}},{binding:1,resource:{buffer:B.gpuBuffer}},{binding:2,resource:{buffer:w.gpuBuffer}},{binding:3,resource:{buffer:i.gpuBuffer}},{binding:4,resource:{buffer:x.gpuBuffer}},{binding:5,resource:{buffer:E.gpuBuffer}},{binding:6,resource:{buffer:L.gpuBuffer}}]}),$=B=>a.createBindGroup({layout:ae.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:m}},{binding:1,resource:{buffer:y.gpuBuffer}},{binding:2,resource:{buffer:w.gpuBuffer}},{binding:3,resource:{buffer:B.gpuBuffer}},{binding:4,resource:{buffer:E.gpuBuffer}},{binding:5,resource:{buffer:L.gpuBuffer}},{binding:6,resource:{buffer:d.gpuBuffer}},{binding:7,resource:{buffer:i.gpuBuffer}},{binding:8,resource:{buffer:x.gpuBuffer}},{binding:9,resource:{buffer:H.gpuBuffer}}]}),ce=(B,G)=>a.createBindGroup({layout:oe.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:m}},{binding:1,resource:{buffer:B.vel.gpuBuffer}},{binding:2,resource:{buffer:B.pos.gpuBuffer}},{binding:3,resource:{buffer:H.gpuBuffer}},{binding:4,resource:{buffer:G.pos.gpuBuffer}},{binding:5,resource:{buffer:G.vel.gpuBuffer}}]}),ye=B=>{const G=B===u.pos?l.pos:u.pos;z.bgForceCellAB=$(B),z.bgForceCellBA=$(G)},z={size:r,count:t,start:d,fill:i,order:x,partial:H,sortedPos:E,sortedSp:L,blockSums:ie,pCounts:ee,pScan:re,pScatter:te,pForceCell:ae,pForceInt:oe,bgCountsA:se(u.pos),bgCountsB:se(l.pos),bgScan:we,bgScatterA:ne(u.pos),bgScatterB:ne(l.pos),bgForceCellAB:$(u.pos),bgForceCellBA:$(l.pos),bgIntegrateAB:ce(u,l),bgIntegrateBA:ce(l,u),bgForceCellRebuild:ye};return z};if(e.mode==="grid")s=await K(v);else{const r=await F(Pe(e.mode,4),`particles-sim(${e.mode})`);O=await k(r,"main",`particles-sim(${e.mode})`);const o=(t,d)=>a.createBindGroup({layout:O.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:m}},{binding:1,resource:{buffer:y.gpuBuffer}},{binding:2,resource:{buffer:w.gpuBuffer}},{binding:3,resource:{buffer:t.pos.gpuBuffer}},{binding:4,resource:{buffer:t.vel.gpuBuffer}},{binding:5,resource:{buffer:d.pos.gpuBuffer}},{binding:6,resource:{buffer:d.vel.gpuBuffer}}]});T=o(u,l),j=o(l,u)}let A=null,Y=0,X=0,U=0,M=0,J=performance.now(),Z=0;return a.addEventListener?.("uncapturederror",r=>{Z++;const o=r.error?.message??String(r),t=globalThis;t.__firstGpuError??=o.slice(0,400),t.__lastGpuError=o.slice(0,300),console.error("[wgpu-kit particles] GPU 错误:",o)}),{config:e,async attach(r){const o=Math.min(window.devicePixelRatio||1,2);r.width=Math.max(1,Math.floor(r.clientWidth*o)),r.height=Math.max(1,Math.floor(r.clientHeight*o)),A=await N.create(r,{count:e.count,species:w,vel:u.vel,color:e.color,pointSize:e.pointSize*f,worldHalf:f})},tick(r=1){const o=e.dt*r;P(o);const t=Y%2===0,d=a.createCommandEncoder(),i=d.beginComputePass();if(s){i.setPipeline(s.pCounts),i.setBindGroup(0,t?s.bgCountsA:s.bgCountsB),i.dispatchWorkgroups(Math.ceil(e.count/b)),i.setPipeline(s.pScan),i.setBindGroup(0,s.bgScan),i.dispatchWorkgroups(1),i.setPipeline(s.pScatter),i.setBindGroup(0,t?s.bgScatterA:s.bgScatterB),i.dispatchWorkgroups(Math.ceil(e.count/b)),i.end();const C=d.beginComputePass();C.setPipeline(s.pForceCell),C.setBindGroup(0,t?s.bgForceCellAB:s.bgForceCellBA),C.dispatchWorkgroups(Math.ceil(e.count*9/b)),C.end();const _=d.beginComputePass();_.setPipeline(s.pForceInt),_.setBindGroup(0,t?s.bgIntegrateAB:s.bgIntegrateBA),_.dispatchWorkgroups(Math.ceil(e.count/b)),_.end(),a.queue.submit([d.finish()])}else i.setPipeline(O),i.setBindGroup(0,t?T:j),i.dispatchWorkgroups(Math.ceil(e.count/b)),i.end(),a.queue.submit([d.finish()]);const x=t?c.other:c.current;A?.render(x.pos,x.vel),c.swap(),Y++,U++;const I=performance.now();M+=I-J,J=I,M>=500&&(X=U/(M/1e3),U=0,M=0)},setForces(r){const o=pe(r,q(e.seed));y.write(new Float32Array(o)),e.forces=o,e.forcesName=typeof r=="string"?r:"custom"},setParams(r){if(Object.assign(p,r),s&&r.rMax!==void 0){const o=S(p.rMax);if(o!==v){v=o;const t=++D;(async()=>{const d=await K(v);if(t!==D){V(d);return}const i=s;s=d,d.bgForceCellRebuild(u.pos),i&&V(i)})()}}},snapshot(){return JSON.stringify({count:e.count,forces:e.forcesName,mode:e.mode,color:e.color,bounds:e.bounds,seed:e.seed,rMax:p.rMax,beta:p.beta,forceFactor:p.forceFactor,frictionHalfLife:p.frictionHalfLife,dt:p.dt,pointSize:e.pointSize})},stats(){return{fps:X,gpuErrors:Z}},debugGrid:s?()=>{const r=s;return{partial:r.partial,start:r.start,fill:r.fill,sortedPos:r.sortedPos,sortedSp:r.sortedSp,order:r.order}}:void 0,buffers(){return{pos:c.current.pos,vel:c.current.vel,species:w}},destroy(){A?.destroy(),c.destroy(),w.destroy(),y.destroy(),m.destroy(),s&&(s.count.destroy(),s.start.destroy(),s.fill.destroy(),s.order.destroy(),s.partial.destroy(),s.sortedPos.destroy(),s.sortedSp.destroy())}}}export{Ue as p};
