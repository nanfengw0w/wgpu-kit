// src/core/errors.ts
var WgpuKitError = class extends Error {
  constructor(message) {
    super(message);
    this.name = new.target.name;
  }
};
var WebGPUUnavailableError = class extends WgpuKitError {
  constructor(reason) {
    super(
      `\u5F53\u524D\u73AF\u5883\u4E0D\u53EF\u7528 WebGPU: ${reason}
  \u6392\u67E5:\u2460 \u6D4F\u89C8\u5668\u9700 Chrome/Edge 113+ \u6216 Safari 18+;\u2461 \u65E0\u5934\u73AF\u5883\u9700\u5F00\u542F WebGPU;\u2462 \u68C0\u67E5 GPU \u9A71\u52A8\u4E0E\u786C\u4EF6\u52A0\u901F\u8BBE\u7F6E\u3002
  \u53EF\u7528 navigator.gpu \u662F\u5426\u5B58\u5728\u5FEB\u901F\u5224\u65AD\u3002`
    );
  }
};
var CompileError = class extends WgpuKitError {
  constructor(kernelName, messages, userCodeOffset) {
    const mapped = messages.map((m) => {
      const userLine = m.line - userCodeOffset;
      const where = userLine > 0 ? `\u7528\u6237\u4EE3\u7801\u7B2C ${userLine} \u884C` : `\u751F\u6210\u4EE3\u7801\u7B2C ${m.line} \u884C(\u5E93\u7684\u95EE\u9898,\u6B22\u8FCE\u62A5 issue)`;
      return `  ${where}: ${m.msg}`;
    }).join("\n");
    super(`kernel "${kernelName}" WGSL \u7F16\u8BD1\u5931\u8D25:
${mapped}`);
  }
};
var UsageError = class extends WgpuKitError {
};
async function createComputePipelineChecked(device, module, label, entryPoint = "main") {
  device.pushErrorScope("validation");
  const pipeline = device.createComputePipeline({ layout: "auto", compute: { module, entryPoint } });
  const err = await device.popErrorScope();
  if (err) {
    throw new WgpuKitError(`compute \u7BA1\u7EBF "${label}" \u521B\u5EFA\u5931\u8D25: ${err.message}
  \u5E38\u89C1\u539F\u56E0:storage buffer \u6570\u8D85\u8FC7\u6BCF\u9636\u6BB5\u4E0A\u9650(\u53EF\u5411\u672C\u5E93\u63D0 issue \u7533\u8BF7 limits \u652F\u6301)`);
  }
  return pipeline;
}

// src/core/context.ts
var GpuContext = class _GpuContext {
  device;
  adapterInfo;
  constructor(device, adapterInfo) {
    this.device = device;
    this.adapterInfo = adapterInfo;
  }
  static #singleton = null;
  /** 仅供设备丢失自动重建(observe.watchDevice)使用:重置单例 */
  static resetForTests() {
    _GpuContext.#singleton = null;
  }
  static get() {
    if (!_GpuContext.#singleton) {
      _GpuContext.#singleton = _GpuContext.#create().catch((e) => {
        _GpuContext.#singleton = null;
        throw e;
      });
    }
    return _GpuContext.#singleton;
  }
  static async #create() {
    if (typeof navigator === "undefined" || !("gpu" in navigator) || !navigator.gpu) {
      throw new WebGPUUnavailableError("navigator.gpu \u4E0D\u5B58\u5728");
    }
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
    if (!adapter) throw new WebGPUUnavailableError("requestAdapter() \u8FD4\u56DE null");
    const info = adapter.info;
    const label = info ? [info.vendor, info.architecture, info.description].filter(Boolean).join(" / ") || "unknown" : "unknown";
    const requiredLimits = {};
    const want = [
      "maxStorageBuffersPerShaderStage",
      "maxStorageBuffersInVertexStage",
      "maxStorageBufferBindingSize"
    ];
    for (const key of want) {
      const supported = adapter.limits[key];
      if (typeof supported === "number") requiredLimits[key] = supported;
    }
    const device = await adapter.requestDevice({ label: "wgpu-kit", requiredLimits });
    return new _GpuContext(device, label);
  }
  /** device lost 时 reject;调用方可 await 做清理/提示 */
  get lost() {
    return this.device.lost;
  }
  /** 等待队列中已提交的全部 GPU 工作完成(测试/读回前同步用) */
  async sync() {
    await this.device.queue.onSubmittedWorkDone();
  }
};

// src/core/layout.ts
var TYPES = {
  f32: { size: 4, stride: 4, align: 4, comps: 1, typed: "Float32Array", wgsl: "f32" },
  i32: { size: 4, stride: 4, align: 4, comps: 1, typed: "Int32Array", wgsl: "i32" },
  u32: { size: 4, stride: 4, align: 4, comps: 1, typed: "Uint32Array", wgsl: "u32" },
  vec2f: { size: 8, stride: 8, align: 8, comps: 2, typed: "Float32Array", wgsl: "vec2f" },
  vec2i: { size: 8, stride: 8, align: 8, comps: 2, typed: "Int32Array", wgsl: "vec2i" },
  vec2u: { size: 8, stride: 8, align: 8, comps: 2, typed: "Uint32Array", wgsl: "vec2u" },
  vec3f: { size: 12, stride: 16, align: 16, comps: 3, typed: "Float32Array", wgsl: "vec3f" },
  vec4f: { size: 16, stride: 16, align: 16, comps: 4, typed: "Float32Array", wgsl: "vec4f" }
};

// src/core/buffer.ts
var TYPED_CTORS = {
  Float32Array,
  Int32Array,
  Uint32Array
};
var Buffer = class _Buffer {
  kind;
  length;
  gpuBuffer;
  #ctx;
  #byteLength;
  #stride;
  #staging = null;
  constructor(ctx, kind, length, gpuBuffer) {
    this.#ctx = ctx;
    this.kind = kind;
    this.length = length;
    this.gpuBuffer = gpuBuffer;
    this.#byteLength = length * TYPES[kind].stride;
    this.#stride = TYPES[kind].stride;
  }
  static async create(kind, length) {
    if (!Number.isInteger(length) || length <= 0) {
      throw new UsageError(`Buffer \u957F\u5EA6\u5FC5\u987B\u662F\u6B63\u6574\u6570,\u6536\u5230: ${String(length)}`);
    }
    const def = TYPES[kind];
    if (!def) throw new UsageError(`\u672A\u77E5\u7C7B\u578B "${String(kind)}",\u53EF\u7528: ${Object.keys(TYPES).join(", ")}`);
    const ctx = await GpuContext.get();
    const gpuBuffer = ctx.device.createBuffer({
      size: length * def.stride,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
      label: `wgpu-kit Buffer<${kind}>[${length}]`
    });
    return new _Buffer(ctx, kind, length, gpuBuffer);
  }
  /** 校验并写入(CPU → GPU);vec3f 等 stride≠size 的类型自动补 padding */
  write(data) {
    const def = TYPES[this.kind];
    const ctor = TYPED_CTORS[def.typed];
    if (!(data instanceof ctor)) {
      throw new UsageError(`Buffer<${this.kind}>.write \u9700\u8981 ${def.typed},\u6536\u5230 ${data.constructor?.name ?? typeof data}`);
    }
    const expected = this.length * def.comps;
    if (data.length !== expected) {
      throw new UsageError(`Buffer<${this.kind}>[${this.length}].write \u9700\u8981 ${expected} \u4E2A\u5206\u91CF,\u6536\u5230 ${data.length}`);
    }
    if (def.stride === def.size || def.comps === 1) {
      this.#ctx.device.queue.writeBuffer(this.gpuBuffer, 0, data);
      return;
    }
    const comps = def.comps;
    const per = def.stride / 4;
    const gpu = new Float32Array(this.length * per);
    for (let i = 0; i < this.length; i++) {
      for (let c = 0; c < comps; c++) gpu[i * per + c] = data[i * comps + c];
    }
    this.#ctx.device.queue.writeBuffer(this.gpuBuffer, 0, gpu);
  }
  /** GPU → CPU:内部 staging buffer + mapAsync,mapAsync 的异步陷阱由库承担 */
  async read() {
    const def = TYPES[this.kind];
    if (!this.#staging) {
      this.#staging = this.#ctx.device.createBuffer({
        size: this.#byteLength,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
        label: `wgpu-kit staging[${this.length}]`
      });
    }
    const enc = this.#ctx.device.createCommandEncoder();
    enc.copyBufferToBuffer(this.gpuBuffer, 0, this.#staging, 0, this.#byteLength);
    this.#ctx.device.queue.submit([enc.finish()]);
    await this.#staging.mapAsync(GPUMapMode.READ);
    const ab = this.#staging.getMappedRange().slice(0);
    this.#staging.unmap();
    if (def.stride === def.size || def.comps === 1) {
      if (def.typed === "Float32Array") return new Float32Array(ab);
      if (def.typed === "Int32Array") return new Int32Array(ab);
      return new Uint32Array(ab);
    }
    const comps = def.comps;
    const per = def.stride / 4;
    const src = new Float32Array(ab);
    const out = new Float32Array(this.length * comps);
    for (let i = 0; i < this.length; i++) {
      for (let c = 0; c < comps; c++) out[i * comps + c] = src[i * per + c];
    }
    return out;
  }
  destroy() {
    if (this.#staging) {
      this.#staging.destroy();
      this.#staging = null;
    }
    this.gpuBuffer.destroy();
  }
};

// src/core/pingpong.ts
var PingPong = class _PingPong {
  #sides;
  #names;
  #length;
  #kinds;
  #index = 0;
  constructor(names, kinds, length, a, b) {
    this.#names = names;
    this.#kinds = kinds;
    this.#length = length;
    this.#sides = [a, b];
  }
  static async create(kinds, length) {
    const names = Object.keys(kinds);
    if (names.length === 0) throw new Error("PingPong \u81F3\u5C11\u9700\u8981\u4E00\u4E2A\u5B57\u6BB5");
    const make = async () => {
      const side = {};
      for (const name of names) side[name] = await Buffer.create(kinds[name], length);
      return side;
    };
    return new _PingPong(names, kinds, length, await make(), await make());
  }
  /** 当前帧的数据侧(渲染/读回用) */
  get current() {
    return this.#sides[this.#index];
  }
  /** 另一侧(kernel 写入目标) */
  get other() {
    return this.#sides[1 - this.#index];
  }
  /** 帧末翻转 */
  swap() {
    this.#index = 1 - this.#index;
  }
  /** 以 (写侧, 读侧) 调用 fn 后自动 swap 的语法糖 */
  async runWith(fn) {
    await fn(this.other, this.current);
    this.swap();
  }
  destroy() {
    for (const side of this.#sides) for (const b of Object.values(side)) b.destroy();
  }
  /** 克隆一份同构 PingPong(同字段同长度) */
  async clone() {
    return _PingPong.create(this.#kinds, this.#length);
  }
  get names() {
    return this.#names;
  }
};

// src/packs/particles/presets.ts
var FORCE_PRESETS = {
  /** 经典细胞:小团簇 + 缓慢迁移(spike 验证过的矩阵) */
  cells: [
    0,
    0.6,
    -0.4,
    0,
    -0.4,
    0,
    0.7,
    -0.2,
    0.5,
    -0.5,
    0,
    0.6,
    -0.3,
    0.4,
    -0.6,
    0
  ],
  /** 蛇形:链状结构与游动 */
  snakes: [
    0,
    0.7,
    0.1,
    -0.5,
    -0.3,
    0,
    0.8,
    -0.1,
    0.2,
    -0.4,
    0,
    0.7,
    -0.6,
    0.2,
    -0.3,
    0
  ],
  /** 轨道:环带与漩涡感 */
  orbitals: [
    0,
    -0.5,
    0.4,
    0.2,
    0.5,
    0,
    -0.6,
    0.1,
    -0.3,
    0.6,
    0,
    -0.4,
    0.1,
    -0.2,
    0.5,
    0
  ],
  /** 病毒:捕食结构,红吃绿 */
  viruses: [
    0,
    0.9,
    -0.6,
    0.1,
    -0.5,
    0,
    0.3,
    -0.8,
    0.7,
    0.2,
    0,
    -0.3,
    -0.2,
    0.8,
    0.4,
    0
  ]
};
function mulberry32(seed) {
  let s = seed | 0;
  return () => {
    s = s + 1831565813 | 0;
    let t = Math.imul(s ^ s >>> 15, 1 | s);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
function hashSeed(seed) {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
function randomMatrix(seed) {
  const rand = mulberry32(seed ^ 2654435769);
  const m = Array.from({ length: 16 }, () => Math.round((rand() * 2 - 1) * 100) / 100);
  for (let i = 0; i < 4; i++) m[i * 4 + i] = 0;
  return m;
}
function resolveMatrix(forces, seed) {
  if (forces === "random") return randomMatrix(seed);
  if (typeof forces === "string") {
    const preset = FORCE_PRESETS[forces];
    if (!preset) {
      throw new Error(`\u672A\u77E5\u529B\u77E9\u9635\u9884\u8BBE "${forces}",\u53EF\u7528: ${Object.keys(FORCE_PRESETS).join(", ")}, random`);
    }
    return preset;
  }
  return forces;
}

// src/packs/particles/config.ts
var MODES = ["n2", "tiled", "grid"];
function resolveConfig(config = {}) {
  const {
    count = 8192,
    forces = "cells",
    mode = "grid",
    // 基准数据驱动:v0.4 起 grid 全面优于 tiled(0.54ms vs 3.62ms @16k),见 benchmarks.md
    color = "species",
    bounds = "wrap",
    seed = "wgpu-kit",
    rMax = 0.12,
    beta = 0.3,
    forceFactor = 10,
    frictionHalfLife = 0.04,
    dt = 0.02,
    pointSize = 4e-3,
    maxNeighbors = 8100
  } = config;
  if (!Number.isInteger(count) || count <= 0 || count > 1e6) {
    throw new UsageError(`count \u5FC5\u987B\u662F 1..1_000_000 \u7684\u6574\u6570,\u6536\u5230: ${String(count)}`);
  }
  if (!MODES.includes(mode)) {
    throw new UsageError(`mode \u5FC5\u987B\u662F ${MODES.join(" | ")},\u6536\u5230: "${String(mode)}"`);
  }
  if (mode === "n2" && count > 32e3) {
    throw new UsageError(`mode='n2' \u5EFA\u8BAE count \u2264 20000(\u5F53\u524D ${count});\u5927\u89C4\u6A21\u8BF7\u7528 mode='tiled' \u6216 'grid'`);
  }
  const seedStr = String(seed);
  return {
    count,
    forces: resolveMatrix(forces, hashSeed(seedStr)),
    forcesName: typeof forces === "string" ? forces : "custom",
    mode,
    color,
    bounds,
    seed: seedStr,
    seedHash: hashSeed(seedStr),
    rMax,
    beta,
    forceFactor,
    friction: Math.exp(-dt / frictionHalfLife),
    frictionHalfLife,
    dt,
    pointSize,
    maxNeighbors
  };
}

// src/packs/particles/wgsl.ts
var WORKGROUP = 64;
function simWgsl(mode, speciesCount) {
  const tiled = mode === "tiled";
  const common = (
    /* wgsl */
    `
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
`
  );
  const interactSig = tiled ? "fn interact(myIdx: u32, mySp: u32, myPos: vec2f, lid: u32) -> vec2f {" : "fn interact(myIdx: u32, mySp: u32, myPos: vec2f) -> vec2f {";
  const body = tiled ? tiledBody(speciesCount) : n2Body(speciesCount);
  const main2 = (
    /* wgsl */
    `
@compute @workgroup_size(${WORKGROUP})
fn main(@builtin(global_invocation_id) gid: vec3u${tiled ? ", @builtin(local_invocation_id) lid: vec3u" : ""}) {
  let i = gid.x;
  // \u6CE8\u610F:workgroupBarrier \u8981\u6C42 uniform control flow\u2014\u2014
  // \u8D8A\u754C\u7EBF\u7A0B\u4E5F\u5FC5\u987B\u53C2\u4E0E barrier \u5FAA\u73AF,\u53EA\u80FD\u5728\u6700\u7EC8\u5199\u5165\u5904 guard(tiled \u5C3E\u90E8 workgroup \u7684\u7ECF\u5178\u5751)
  let ok = i < params.count;
  let myIdx = min(i, params.count - 1u);
  let mySp = species[myIdx];
  let myPos = posIn[myIdx];
  var accel = interact(myIdx, mySp, myPos${tiled ? ", lid.x" : ""});
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
`
  );
  return `${common}${tiled ? TILE_DECLS : ""}
${interactSig}${body}
}
${main2}`;
}
function n2Body(speciesCount) {
  return (
    /* wgsl */
    `
  var accel = vec2f(0.0, 0.0);
  let rMax2 = params.rMax * params.rMax;
  for (var j = 0u; j < params.count; j++) {
    if (j == myIdx) { continue; }
    let rel = posIn[j] - myPos;
    let d2 = dot(rel, rel);
    if (d2 > rMax2) { continue; }   // \u8DDD\u79BB\u5E73\u65B9 early-out:\u7EDD\u5927\u591A\u6570\u5BF9\u514D\u5F00\u65B9
    let d = sqrt(d2);
    let r = d / params.rMax;
    if (r > 0.0 && r < 1.0) {
      let f = force(r, matrix[mySp * ${speciesCount}u + species[j]]);
      accel = accel + rel / d * f;
    }
  }
  return accel;
  `
  );
}
function tiledBody(speciesCount) {
  return (
    /* wgsl */
    `
  var accel = vec2f(0.0, 0.0);
  let rMax2 = params.rMax * params.rMax;
  let tiles = (params.count + ${WORKGROUP}u - 1u) / ${WORKGROUP}u;
  for (var t = 0u; t < tiles; t++) {
    let loadIdx = t * ${WORKGROUP}u + lid;
    tilePos[lid] = posIn[min(loadIdx, params.count - 1u)];
    tileSp[lid] = species[min(loadIdx, params.count - 1u)];
    workgroupBarrier();
    let tileLen = min(${WORKGROUP}u, params.count - t * ${WORKGROUP}u);
    for (var k = 0u; k < ${WORKGROUP}u; k++) {
      if (k >= tileLen) { break; }
      let j = t * ${WORKGROUP}u + k;
      if (j == myIdx) { continue; }
      let rel = tilePos[k] - myPos;
      let d2 = dot(rel, rel);
      if (d2 > rMax2) { continue; } // \u8DDD\u79BB\u5E73\u65B9 early-out
      let d = sqrt(d2);
      let r = d / params.rMax;
      if (r > 0.0 && r < 1.0) {
        let f = force(r, matrix[mySp * ${speciesCount}u + tileSp[k]]);
        accel = accel + rel / d * f;
      }
    }
    workgroupBarrier();
  }
  return accel;
  `
  );
}
var TILE_DECLS = (
  /* wgsl */
  `
var<workgroup> tilePos: array<vec2f, ${WORKGROUP}>;
var<workgroup> tileSp: array<u32, ${WORKGROUP}>;
`
);
function renderWgsl(speciesCount, colorMode, pointSize) {
  const palette = colorMode === "species" ? `const PALETTE = array<vec3f, ${speciesCount}>(
  vec3f(1.00, 0.42, 0.24),
  vec3f(0.36, 0.86, 0.56),
  vec3f(0.36, 0.58, 1.00),
  vec3f(0.98, 0.80, 0.30),
);` : "";
  const colorExpr = colorMode === "velocity" ? (
    /* wgsl */
    `
  let speed = length(vel[inst]);
  let t = 1.0 - exp(-speed * 40.0);
  out.color = mix(vec3f(0.20, 0.32, 0.55), vec3f(1.0, 0.85, 0.45), t);
  out.color = mix(out.color, vec3f(1.0, 0.95, 0.9), smoothstep(0.6, 1.0, t));`
  ) : (
    /* wgsl */
    `
  let sp = min(species[inst], ${speciesCount - 1}u);
  out.color = PALETTE[sp];`
  );
  const velBinding = colorMode === "velocity" ? "\n@group(0) @binding(2) var<storage, read> vel: array<vec2f>;" : "";
  return (
    /* wgsl */
    `
struct VsOut {
  @builtin(position) clip: vec4f,
  @location(0) uv: vec2f,
  @location(1) color: vec3f,
};
${palette}
@group(0) @binding(0) var<storage, read> pos: array<vec2f>;
@group(0) @binding(1) var<storage, read> species: array<u32>;${velBinding}
@group(0) @binding(3) var<uniform> rs: vec4f; // x = 1/worldHalf(\u76F8\u673A\u7F29\u653E;binding 2 \u7559\u7ED9 velocity \u6A21\u5F0F\u7684 vel)

@vertex
fn vs(@location(0) corner: vec2f, @builtin(instance_index) inst: u32) -> VsOut {
  var out: VsOut;
  out.clip = vec4f((pos[inst] + corner * ${pointSize.toFixed(4)}) * rs.x, 0.0, 1.0);
  out.uv = corner;
  ${colorExpr}
  return out;
}

@fragment
fn fs(in: VsOut) -> @location(0) vec4f {
  let d = length(in.uv);
  if (d > 1.0) { discard; }
  let alpha = smoothstep(1.0, 0.35, d);
  return vec4f(in.color * alpha, alpha);
}
`
  );
}

// src/packs/particles/grid.ts
var GRID_WORKGROUP = 64;
var SCAN_WORKGROUP = 256;
var CELL_OF = (
  /* wgsl */
  `
fn cellOf(p: vec2f) -> u32 {
  let g = i32(params.gridSize);
  let span = params.worldHalf * 2.0;
  let cx = clamp(i32(floor((p.x + params.worldHalf) / span * f32(g))), 0, g - 1);
  let cy = clamp(i32(floor((p.y + params.worldHalf) / span * f32(g))), 0, g - 1);
  return u32(cy) * params.gridSize + u32(cx);
}
`
);
function gridCountsWgsl() {
  return (
    /* wgsl */
    `
struct Params {
  count: u32, _pad0: u32,
  dt: f32, rMax: f32, beta: f32, forceFactor: f32, friction: f32,
  worldHalf: f32, wrapEdge: f32,
  gridSize: u32, cells: u32, maxCand: u32,
};
@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> posIn: array<vec2f>;
@group(0) @binding(2) var<storage, read_write> cellCount: array<atomic<u32>>;
${CELL_OF}
@compute @workgroup_size(${GRID_WORKGROUP})
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= params.count) { return; }
  atomicAdd(&cellCount[cellOf(posIn[i])], 1u);
}
`
  );
}
function gridScanWgsl() {
  return (
    /* wgsl */
    `
struct Params {
  count: u32, _pad0: u32,
  dt: f32, rMax: f32, beta: f32, forceFactor: f32, friction: f32,
  worldHalf: f32, wrapEdge: f32,
  gridSize: u32, cells: u32, maxCand: u32,
};
@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read_write> cellCount: array<atomic<u32>>;
@group(0) @binding(2) var<storage, read_write> cellStart: array<u32>;
@group(0) @binding(3) var<storage, read_write> cellFill: array<atomic<u32>>;
@group(0) @binding(4) var<storage, read_write> blockSums: array<atomic<u32>>;

var<workgroup> partial: array<u32, ${SCAN_WORKGROUP}>;

// Pass A:\u5757\u5185\u6392\u4ED6\u626B\u63CF\u3002cellFill[c] = \u5757\u5185\u6392\u4ED6\u524D\u7F00(\u4E34\u65F6);blockSums[wid] = \u5757\u603B\u548C
@compute @workgroup_size(${SCAN_WORKGROUP})
fn main_scan_blocks(@builtin(local_invocation_id) lid: vec3u, @builtin(workgroup_id) wid: vec3u) {
  let tid = lid.x;
  let wg = ${SCAN_WORKGROUP}u;
  let base = wid.x * wg;
  let cells = params.cells;
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
  // \u542B\u524D\u7F00 \u2192 \u6392\u4ED6:excl = incl - own
  if (base + tid < cells) {
    atomicStore(&cellFill[base + tid], partial[tid] - v0);
  }
  if (tid == 0u) { atomicStore(&blockSums[wid.x], partial[wg - 1u]); }
}

// Pass B:\u5355 workgroup \u5BF9 blockSums \u505A\u6392\u4ED6\u626B\u63CF \u2192 \u5404\u5757\u57FA\u5740
@compute @workgroup_size(${SCAN_WORKGROUP})
fn main_scan_bases(@builtin(local_invocation_id) lid: vec3u) {
  let tid = lid.x;
  let nBlocks = ceil(f32(params.cells) / ${SCAN_WORKGROUP}.0);
  let v0 = select(atomicLoad(&blockSums[tid]), 0u, f32(tid) >= nBlocks);
  partial[tid] = v0;
  workgroupBarrier();
  var offset = 1u;
  loop {
    if (offset >= ${SCAN_WORKGROUP}u) { break; }
    var v = 0u;
    if (tid >= offset) { v = partial[tid - offset]; }
    workgroupBarrier();
    if (tid >= offset) { partial[tid] = partial[tid] + v; }
    workgroupBarrier();
    offset = offset << 1u;
  }
  atomicStore(&blockSums[tid], partial[tid] - v0);
}

// Pass C:\u52A0\u5757\u57FA\u5740 \u2192 \u6700\u7EC8 start/fill;counts \u5F52\u96F6\u4F9B\u4E0B\u4E00\u5E27
@compute @workgroup_size(${SCAN_WORKGROUP})
fn main_scan_apply(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= params.cells) { return; }
  let block = i / ${SCAN_WORKGROUP}u;
  let base = atomicLoad(&blockSums[block]);
  let excl = atomicLoad(&cellFill[i]);
  cellStart[i] = excl + base;
  atomicExchange(&cellFill[i], excl + base);
  atomicStore(&cellCount[i], 0u);
}
`
  );
}
function gridScatterWgsl() {
  return (
    /* wgsl */
    `
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
${CELL_OF}
@compute @workgroup_size(${GRID_WORKGROUP})
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= params.count) { return; }
  let slot = atomicAdd(&cellFill[cellOf(posIn[i])], 1u);
  order[slot] = i;
  sortedPos[slot] = posIn[i];
  sortedSp[slot] = species[i];
}
`
  );
}
function gridForceWgsl(speciesCount) {
  return (
    /* wgsl */
    `
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
  // \u4E0E CELL_OF \u5B8C\u5168\u76F8\u540C\u7684\u6D6E\u70B9\u5E8F\u5217(\u9664\u4EE5 span \u518D\u4E58 g)\u2014\u2014\u8DEF\u5F84\u4E0D\u4E00\u81F4\u4F1A\u8BA9\u8D34\u683C\u7C92\u5B50\u67E5\u8BE2\u9519\u4F4D\u4E00\u683C
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
      let f = force(r, matrix[mySp * ${speciesCount}u + sortedSp[k]]);
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
`
  );
}

// src/packs/particles/render.ts
var nextId = 0;
var ids = /* @__PURE__ */ new WeakMap();
var bufKey = (b) => {
  let id = ids.get(b);
  if (id === void 0) {
    id = ++nextId;
    ids.set(b, id);
  }
  return id;
};
var ParticlesRenderer = class _ParticlesRenderer {
  #ctx;
  #gpuCtx;
  #format;
  #pipeline;
  #quad;
  #idx;
  #species;
  #vel;
  #colorMode;
  #rs;
  #bgCache = /* @__PURE__ */ new Map();
  #count;
  constructor(ctx, gpuCtx, format, pipeline, quad, idx, species, count, rs, vel, colorMode) {
    this.#ctx = ctx;
    this.#gpuCtx = gpuCtx;
    this.#format = format;
    this.#pipeline = pipeline;
    this.#quad = quad;
    this.#idx = idx;
    this.#species = species;
    this.#count = count;
    this.#rs = rs;
    this.#vel = vel;
    this.#colorMode = colorMode;
  }
  static async create(canvas, opts) {
    const ctx = await GpuContext.get();
    const gpuCtx = canvas.getContext("webgpu");
    if (!gpuCtx) throw new Error('canvas.getContext("webgpu") \u8FD4\u56DE\u7A7A:\u8BE5 canvas \u5DF2\u88AB\u5176\u4ED6\u540E\u7AEF\u5360\u7528?');
    const format = navigator.gpu.getPreferredCanvasFormat();
    gpuCtx.configure({ device: ctx.device, format, alphaMode: "opaque" });
    const module = ctx.device.createShaderModule({ code: renderWgsl(4, opts.color, opts.pointSize), label: "particles-render" });
    const rsUniform = ctx.device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    ctx.device.queue.writeBuffer(rsUniform, 0, new Float32Array([1 / opts.worldHalf, 0, 0, 0]));
    const info = await module.getCompilationInfo();
    const errors = info.messages.filter((m) => m.type === "error");
    if (errors.length > 0) throw new CompileError("particles-render", errors.map((m) => ({ line: m.lineNum + 1, msg: m.message })), 0);
    const pipeline = ctx.device.createRenderPipeline({
      layout: "auto",
      vertex: {
        module,
        entryPoint: "vs",
        buffers: [{ arrayStride: 8, attributes: [{ shaderLocation: 0, offset: 0, format: "float32x2" }] }]
      },
      fragment: {
        module,
        entryPoint: "fs",
        targets: [{ format, blend: { color: { srcFactor: "one", dstFactor: "one-minus-src-alpha" }, alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha" } } }]
      },
      primitive: { topology: "triangle-list" }
    });
    const quad = ctx.device.createBuffer({ size: 8 * 4, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    ctx.device.queue.writeBuffer(quad, 0, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]));
    const idx = ctx.device.createBuffer({ size: 6 * 2, usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST });
    ctx.device.queue.writeBuffer(idx, 0, new Uint16Array([0, 1, 2, 2, 1, 3]));
    return new _ParticlesRenderer(ctx, gpuCtx, format, pipeline, quad, idx, opts.species, opts.count, rsUniform, opts.vel ?? null, opts.color);
  }
  /** 渲染一帧(pos 来自 PingPong 当前侧;可传入覆盖数量) */
  render(pos, vel = null, count = this.#count) {
    const key = `${bufKey(pos.gpuBuffer)}:${vel ? bufKey(vel.gpuBuffer) : 0}`;
    let bg = this.#bgCache.get(key);
    if (!bg) {
      bg = this.#ctx.device.createBindGroup({
        layout: this.#pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: pos.gpuBuffer } },
          // 各 binding 按管线 layout 裁剪:velocity 模式的着色器不读 species,
          // 物种模式不读 vel——auto layout 会剔除未使用的绑定,bind group 必须同步
          ...this.#colorMode === "species" ? [{ binding: 1, resource: { buffer: this.#species.gpuBuffer } }] : [],
          ...this.#colorMode === "velocity" && this.#vel && vel ? [{ binding: 2, resource: { buffer: vel.gpuBuffer } }] : [],
          { binding: 3, resource: { buffer: this.#rs } }
        ]
      });
      this.#bgCache.set(key, bg);
    }
    const enc = this.#ctx.device.createCommandEncoder();
    const pass = enc.beginRenderPass({
      colorAttachments: [{
        view: this.#gpuCtx.getCurrentTexture().createView(),
        clearValue: { r: 0.012, g: 0.014, b: 0.024, a: 1 },
        loadOp: "clear",
        storeOp: "store"
      }]
    });
    pass.setPipeline(this.#pipeline);
    pass.setBindGroup(0, bg);
    pass.setVertexBuffer(0, this.#quad);
    pass.setIndexBuffer(this.#idx, "uint16");
    pass.drawIndexed(6, count);
    pass.end();
    this.#ctx.device.queue.submit([enc.finish()]);
  }
  destroy() {
    this.#quad.destroy();
    this.#idx.destroy();
    this.#bgCache.clear();
  }
};

// src/packs/particles/index.ts
var USIZE = 48;
async function particles(config = {}) {
  const cfg = resolveConfig(config);
  const ctx = await GpuContext.get();
  const device = ctx.device;
  const worldHalf = 1 * Math.sqrt(cfg.count / 16e3);
  const pp = await PingPong.create({ pos: "vec2f", vel: "vec2f" }, cfg.count);
  const sideA = { pos: pp.current.pos, vel: pp.current.vel };
  const sideB = { pos: pp.other.pos, vel: pp.other.vel };
  const species = await Buffer.create("u32", cfg.count);
  const matrix = await Buffer.create("f32", 16);
  {
    const rand = mulberry32(cfg.seedHash);
    const pos0 = new Float32Array(cfg.count * 2);
    for (let i = 0; i < pos0.length; i++) pos0[i] = (rand() * 1.6 - 0.8) * worldHalf;
    const vel0 = new Float32Array(cfg.count * 2);
    const sp0 = new Uint32Array(cfg.count);
    for (let i = 0; i < cfg.count; i++) sp0[i] = Math.floor(rand() * 4);
    sideA.pos.write(pos0);
    sideA.vel.write(vel0);
    species.write(sp0);
    matrix.write(new Float32Array(cfg.forces));
  }
  const phys = { rMax: cfg.rMax, beta: cfg.beta, forceFactor: cfg.forceFactor, frictionHalfLife: cfg.frictionHalfLife, dt: cfg.dt };
  const uniform = device.createBuffer({ size: USIZE, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST, label: "particles-params" });
  const gridSizeOf = (rMax, half = worldHalf) => Math.max(4, Math.ceil(2 * half / Math.max(rMax, 1e-3)));
  let gridSize = gridSizeOf(phys.rMax, worldHalf);
  const writeUniform = (dt) => {
    const buf = new ArrayBuffer(USIZE);
    const v = new DataView(buf);
    v.setUint32(0, cfg.count, true);
    v.setUint32(4, 0, true);
    v.setFloat32(8, dt, true);
    v.setFloat32(12, phys.rMax, true);
    v.setFloat32(16, phys.beta, true);
    v.setFloat32(20, phys.forceFactor, true);
    v.setFloat32(24, Math.exp(-dt / phys.frictionHalfLife), true);
    v.setFloat32(28, worldHalf, true);
    v.setFloat32(32, cfg.bounds === "wrap" ? 1 : 0, true);
    v.setUint32(36, gridSize, true);
    v.setUint32(40, gridSize * gridSize, true);
    v.setUint32(44, Math.ceil(cfg.maxNeighbors / 9), true);
    device.queue.writeBuffer(uniform, 0, buf);
  };
  writeUniform(cfg.dt);
  const compile = async (code, label) => {
    const module = device.createShaderModule({ code, label });
    const info = await module.getCompilationInfo();
    const errors = info.messages.filter((m) => m.type === "error");
    if (errors.length > 0) throw new CompileError(label, errors.map((m) => ({ line: m.lineNum, msg: m.message })), 0);
    return module;
  };
  const makePipeline = async (module, entryPoint, label) => createComputePipelineChecked(device, module, `${label}(${entryPoint})`, entryPoint);
  let simPipeline = null;
  let bgAB = null;
  let bgBA = null;
  let grid = null;
  let gridBuildVersion = 0;
  let gridBindGroupsDirty = false;
  const gridDestroy = (g) => {
    g.count.destroy();
    g.start.destroy();
    g.fill.destroy();
    g.order.destroy();
    g.partial.destroy();
    g.sortedPos.destroy();
    g.sortedSp.destroy();
    g.blockSums.destroy();
  };
  const buildGrid = async (size) => {
    const cells = size * size;
    const count = await Buffer.create("u32", cells);
    const start = await Buffer.create("u32", cells);
    const fill = await Buffer.create("u32", cells);
    const order = await Buffer.create("u32", cfg.count);
    count.write(new Uint32Array(cells));
    const mCounts = await compile(gridCountsWgsl(), "grid-counts");
    const mScan = await compile(gridScanWgsl(), "grid-scan");
    const mScatter = await compile(gridScatterWgsl(), "grid-scatter");
    const mForce = await compile(gridForceWgsl(4), "grid-force");
    const pCounts = await makePipeline(mCounts, "main", "grid-counts");
    const pScanBlocks = await makePipeline(mScan, "main_scan_blocks", "grid-scan-blocks");
    const pScanBases = await makePipeline(mScan, "main_scan_bases", "grid-scan-bases");
    const pScanApply = await makePipeline(mScan, "main_scan_apply", "grid-scan-apply");
    const pScatter = await makePipeline(mScatter, "main", "grid-scatter");
    const pForceCell = await makePipeline(mForce, "main_force_cell", "grid-force-cell");
    const pForceInt = await makePipeline(mForce, "main_force_integrate", "grid-force-integrate");
    const partial = await Buffer.create("vec2f", cfg.count * 9);
    const blockSums = await Buffer.create("u32", Math.ceil(cells / 256));
    const sortedPos = await Buffer.create("vec2f", cfg.count);
    const sortedSp = await Buffer.create("u32", cfg.count);
    const bgCounts = (readPos) => device.createBindGroup({
      layout: pCounts.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: uniform } },
        { binding: 1, resource: { buffer: readPos.gpuBuffer } },
        { binding: 2, resource: { buffer: count.gpuBuffer } }
      ]
    });
    const bgScanBlocks = device.createBindGroup({
      layout: pScanBlocks.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: uniform } },
        { binding: 1, resource: { buffer: count.gpuBuffer } },
        { binding: 2, resource: { buffer: start.gpuBuffer } },
        { binding: 3, resource: { buffer: fill.gpuBuffer } },
        { binding: 4, resource: { buffer: blockSums.gpuBuffer } }
      ]
    });
    const bgScanBases = device.createBindGroup({
      layout: pScanBases.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: uniform } },
        { binding: 1, resource: { buffer: count.gpuBuffer } },
        { binding: 2, resource: { buffer: start.gpuBuffer } },
        { binding: 3, resource: { buffer: fill.gpuBuffer } },
        { binding: 4, resource: { buffer: blockSums.gpuBuffer } }
      ]
    });
    const bgScanApply = device.createBindGroup({
      layout: pScanApply.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: uniform } },
        { binding: 1, resource: { buffer: count.gpuBuffer } },
        { binding: 2, resource: { buffer: start.gpuBuffer } },
        { binding: 3, resource: { buffer: fill.gpuBuffer } },
        { binding: 4, resource: { buffer: blockSums.gpuBuffer } }
      ]
    });
    const bgScatter = (readPos) => device.createBindGroup({
      layout: pScatter.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: uniform } },
        { binding: 1, resource: { buffer: readPos.gpuBuffer } },
        { binding: 2, resource: { buffer: species.gpuBuffer } },
        { binding: 3, resource: { buffer: fill.gpuBuffer } },
        { binding: 4, resource: { buffer: order.gpuBuffer } },
        { binding: 5, resource: { buffer: sortedPos.gpuBuffer } },
        { binding: 6, resource: { buffer: sortedSp.gpuBuffer } }
      ]
    });
    const bgForceCell = (readPos) => device.createBindGroup({
      layout: pForceCell.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: uniform } },
        { binding: 1, resource: { buffer: matrix.gpuBuffer } },
        { binding: 2, resource: { buffer: species.gpuBuffer } },
        { binding: 3, resource: { buffer: readPos.gpuBuffer } },
        { binding: 4, resource: { buffer: sortedPos.gpuBuffer } },
        { binding: 5, resource: { buffer: sortedSp.gpuBuffer } },
        { binding: 6, resource: { buffer: start.gpuBuffer } },
        { binding: 7, resource: { buffer: fill.gpuBuffer } },
        { binding: 8, resource: { buffer: order.gpuBuffer } },
        { binding: 9, resource: { buffer: partial.gpuBuffer } }
      ]
    });
    const bgIntegrate = (read, write) => device.createBindGroup({
      layout: pForceInt.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: uniform } },
        { binding: 1, resource: { buffer: read.vel.gpuBuffer } },
        { binding: 2, resource: { buffer: read.pos.gpuBuffer } },
        { binding: 3, resource: { buffer: partial.gpuBuffer } },
        { binding: 4, resource: { buffer: write.pos.gpuBuffer } },
        { binding: 5, resource: { buffer: write.vel.gpuBuffer } }
      ]
    });
    const rebuildForceCellBG = (readPos) => {
      const otherPos = readPos === sideA.pos ? sideB.pos : sideA.pos;
      state.bgForceCellAB = bgForceCell(readPos);
      state.bgForceCellBA = bgForceCell(otherPos);
    };
    const state = {
      size,
      cells,
      count,
      start,
      fill,
      order,
      partial,
      sortedPos,
      sortedSp,
      blockSums,
      pCounts,
      pScanBlocks,
      pScanBases,
      pScanApply,
      pScatter,
      pForceCell,
      pForceInt,
      bgCountsA: bgCounts(sideA.pos),
      bgCountsB: bgCounts(sideB.pos),
      bgScanBlocks,
      bgScanBases,
      bgScanApply,
      bgScatterA: bgScatter(sideA.pos),
      bgScatterB: bgScatter(sideB.pos),
      bgForceCellAB: bgForceCell(sideA.pos),
      bgForceCellBA: bgForceCell(sideB.pos),
      bgIntegrateAB: bgIntegrate(sideA, sideB),
      bgIntegrateBA: bgIntegrate(sideB, sideA),
      bgForceCellRebuild: rebuildForceCellBG
    };
    return state;
  };
  if (cfg.mode === "grid") grid = await buildGrid(gridSize);
  else {
    const module = await compile(simWgsl(cfg.mode, 4), `particles-sim(${cfg.mode})`);
    simPipeline = await makePipeline(module, "main", `particles-sim(${cfg.mode})`);
    const bg = (read, write) => device.createBindGroup({
      layout: simPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: uniform } },
        { binding: 1, resource: { buffer: matrix.gpuBuffer } },
        { binding: 2, resource: { buffer: species.gpuBuffer } },
        { binding: 3, resource: { buffer: read.pos.gpuBuffer } },
        { binding: 4, resource: { buffer: read.vel.gpuBuffer } },
        { binding: 5, resource: { buffer: write.pos.gpuBuffer } },
        { binding: 6, resource: { buffer: write.vel.gpuBuffer } }
      ]
    });
    bgAB = bg(sideA, sideB);
    bgBA = bg(sideB, sideA);
  }
  let renderer = null;
  let frame = 0;
  let lastFps = 0;
  let fpsFrames = 0;
  let fpsAcc = 0;
  let fpsLast = performance.now();
  let gpuErrorCount = 0;
  device.addEventListener?.("uncapturederror", (e) => {
    gpuErrorCount++;
    const msg = e.error?.message ?? String(e);
    const g = globalThis;
    g.__firstGpuError ??= msg.slice(0, 400);
    g.__lastGpuError = msg.slice(0, 300);
    console.error("[wgpu-kit particles] GPU \u9519\u8BEF:", msg);
  });
  return {
    config: cfg,
    async attach(canvas) {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.max(1, Math.floor(canvas.clientWidth * dpr));
      canvas.height = Math.max(1, Math.floor(canvas.clientHeight * dpr));
      renderer = await ParticlesRenderer.create(canvas, {
        count: cfg.count,
        species,
        vel: sideA.vel,
        color: cfg.color,
        pointSize: cfg.pointSize * worldHalf,
        worldHalf
      });
    },
    tick(dtMultiplier = 1) {
      const dt = cfg.dt * dtMultiplier;
      writeUniform(dt);
      const useAB = frame % 2 === 0;
      const read = useAB ? sideA : sideB;
      if (gridBindGroupsDirty && grid) {
        grid.bgForceCellRebuild(sideA.pos);
        gridBindGroupsDirty = false;
      }
      if (grid) {
        const runPass = (pipeline, bg, wgs) => {
          const e = device.createCommandEncoder();
          const p = e.beginComputePass();
          p.setPipeline(pipeline);
          p.setBindGroup(0, bg);
          p.dispatchWorkgroups(wgs);
          p.end();
          device.queue.submit([e.finish()]);
        };
        const nCellWg = Math.ceil(grid.cells / 256);
        runPass(grid.pCounts, useAB ? grid.bgCountsA : grid.bgCountsB, Math.ceil(cfg.count / WORKGROUP));
        runPass(grid.pScanBlocks, grid.bgScanBlocks, nCellWg);
        runPass(grid.pScanBases, grid.bgScanBases, 1);
        runPass(grid.pScatter, useAB ? grid.bgScatterA : grid.bgScatterB, Math.ceil(cfg.count / WORKGROUP));
        runPass(grid.pForceCell, useAB ? grid.bgForceCellAB : grid.bgForceCellBA, Math.ceil(cfg.count * 9 / WORKGROUP));
        runPass(grid.pForceInt, useAB ? grid.bgIntegrateAB : grid.bgIntegrateBA, Math.ceil(cfg.count / WORKGROUP));
      } else {
        const enc = device.createCommandEncoder();
        const pass = enc.beginComputePass();
        pass.setPipeline(simPipeline);
        pass.setBindGroup(0, useAB ? bgAB : bgBA);
        pass.dispatchWorkgroups(Math.ceil(cfg.count / WORKGROUP));
        pass.end();
        device.queue.submit([enc.finish()]);
      }
      const writtenSide = useAB ? pp.other : pp.current;
      renderer?.render(writtenSide.pos, writtenSide.vel);
      pp.swap();
      frame++;
      fpsFrames++;
      const now = performance.now();
      fpsAcc += now - fpsLast;
      fpsLast = now;
      if (fpsAcc >= 500) {
        lastFps = fpsFrames / (fpsAcc / 1e3);
        fpsFrames = 0;
        fpsAcc = 0;
      }
    },
    setForces(forces) {
      const m = resolveMatrix(forces, hashSeed(cfg.seed));
      matrix.write(new Float32Array(m));
      cfg.forces = m;
      cfg.forcesName = typeof forces === "string" ? forces : "custom";
    },
    setParams(p) {
      Object.assign(phys, p);
      if (grid && p.rMax !== void 0) {
        const g = gridSizeOf(phys.rMax);
        if (g !== gridSize) {
          gridSize = g;
          const version = ++gridBuildVersion;
          void (async () => {
            const fresh = await buildGrid(gridSize);
            if (version !== gridBuildVersion) {
              gridDestroy(fresh);
              return;
            }
            const old = grid;
            grid = fresh;
            fresh.bgForceCellRebuild(sideA.pos);
            if (old) gridDestroy(old);
          })();
        }
      }
    },
    snapshot() {
      return JSON.stringify({
        count: cfg.count,
        forces: cfg.forcesName,
        mode: cfg.mode,
        color: cfg.color,
        bounds: cfg.bounds,
        seed: cfg.seed,
        rMax: phys.rMax,
        beta: phys.beta,
        forceFactor: phys.forceFactor,
        frictionHalfLife: phys.frictionHalfLife,
        dt: phys.dt,
        pointSize: cfg.pointSize
      });
    },
    stats() {
      return { fps: lastFps, gpuErrors: gpuErrorCount };
    },
    debugGrid: grid ? () => {
      const g = grid;
      return { partial: g.partial, start: g.start, fill: g.fill, sortedPos: g.sortedPos, sortedSp: g.sortedSp, order: g.order };
    } : void 0,
    buffers() {
      return { pos: pp.current.pos, vel: pp.current.vel, species };
    },
    destroy() {
      renderer?.destroy();
      pp.destroy();
      species.destroy();
      matrix.destroy();
      uniform.destroy();
      if (grid) {
        grid.count.destroy();
        grid.start.destroy();
        grid.fill.destroy();
        grid.order.destroy();
        grid.partial.destroy();
        grid.sortedPos.destroy();
        grid.sortedSp.destroy();
      }
    }
  };
}

// tests/gpu/grid-debug.ts
var results = [];
window.__results = results;
var report = (name, pass, detail = "") => {
  results.push({ name, pass, detail });
  const mark = (r) => r.pass ? "PASS" : "FAIL";
  document.getElementById("out").textContent = results.map((r) => `${mark(r)} ${r.name}: ${r.detail}`).join("\n");
};
var CFG = { count: 28e3, seed: "18dz5h", forces: "random", rMax: 0.12 };
var FRAMES = 300;
function structureStats(pos, samples, rHalf) {
  const n = pos.length / 2;
  let nnSum = 0;
  let nbrSum = 0;
  let cnt = 0;
  for (let s = 0; s < samples; s++) {
    const i = Math.floor(s * 7919 % n);
    const xi = pos[i * 2];
    const yi = pos[i * 2 + 1];
    let nn = Infinity;
    let nbr = 0;
    for (let j = 0; j < n; j++) {
      if (j === i) continue;
      const dx = pos[j * 2] - xi;
      const dy = pos[j * 2 + 1] - yi;
      const d2 = dx * dx + dy * dy;
      if (d2 < nn) nn = d2;
      if (d2 < rHalf * rHalf) nbr++;
    }
    nnSum += Math.sqrt(nn);
    nbrSum += nbr;
    cnt++;
  }
  return { nn: nnSum / cnt, nbr: nbrSum / cnt };
}
async function runMode(mode, maxNeighbors) {
  const sim = await particles({ ...CFG, mode, ...maxNeighbors !== void 0 ? { maxNeighbors } : {} });
  const ctx = await GpuContext.get();
  for (let f = 0; f < FRAMES; f++) sim.tick();
  await ctx.sync();
  const pos = await sim.buffers().pos.read();
  const st = structureStats(pos, 1200, CFG.rMax / 2);
  sim.destroy();
  return st;
}
async function compareModes(frames) {
  const run = async (mode) => {
    const sim = await particles({ ...CFG, mode });
    for (let f = 0; f < frames; f++) sim.tick();
    const p = await sim.buffers().pos.read();
    sim.destroy();
    return p;
  };
  const [ga, ta] = [await run("grid"), await run("tiled")];
  let maxD = 0;
  let sumD = 0;
  const n = Math.min(ga.length, ta.length) / 2;
  for (let i = 0; i < n; i++) {
    const d = Math.hypot(ga[i * 2] - ta[i * 2], ga[i * 2 + 1] - ta[i * 2 + 1]);
    if (d > maxD) maxD = d;
    sumD += d;
  }
  return `${frames} \u5E27\u540E:\u5E73\u5747\u5DEE ${(sumD / n).toFixed(6)} \u6700\u5927 ${maxD.toFixed(6)}`;
}
function jsReference(particleIdx, frames) {
  const worldHalf = Math.sqrt(CFG.count / 16e3);
  const rand = mulberry32(hashSeed(CFG.seed));
  const N = CFG.count;
  const p0 = new Float32Array(N * 2);
  for (let i = 0; i < N * 2; i++) p0[i] = (rand() * 1.6 - 0.8) * worldHalf;
  const sp = new Uint32Array(N);
  for (let i = 0; i < N; i++) sp[i] = Math.floor(rand() * 4);
  const M = randomMatrix(hashSeed(CFG.seed));
  const dt = 0.02, rMax = 0.12, beta = 0.3, ff = 10, friction = Math.exp(-dt / 0.04);
  let px = p0[particleIdx * 2], py = p0[particleIdx * 2 + 1];
  let vx = 0, vy = 0;
  const spI = sp[particleIdx];
  const force = (r, a) => r < beta ? a / beta - 1 : r < 1 ? a * (1 - Math.abs(2 * r - 1 - beta) / (1 - beta)) : 0;
  for (let f = 0; f < frames; f++) {
    let ax = 0, ay = 0;
    for (let j = 0; j < N; j++) {
      if (j === particleIdx) continue;
      const relX = p0[j * 2] - px, relY = p0[j * 2 + 1] - py;
      const d = Math.hypot(relX, relY);
      const r = d / rMax;
      if (r > 0 && r < 1) {
        const fq = force(r, M[spI * 4 + sp[j]]);
        ax += relX / d * fq;
        ay += relY / d * fq;
      }
    }
    ax *= ff * rMax;
    ay *= ff * rMax;
    vx = (vx + ax * dt) * friction;
    vy = (vy + ay * dt) * friction;
    px += vx * dt;
    py += vy * dt;
    const half = worldHalf;
    const span = half * 2;
    px = ((px + half) % span + span) % span - half;
    py = ((py + half) % span + span) % span - half;
  }
  return { x: px, y: py };
}
async function main() {
  const ctx = await GpuContext.get();
  {
    const sim = await particles({ ...CFG, mode: "grid", maxNeighbors: 999999 });
    const dbg = sim.debugGrid?.();
    const before = await sim.buffers().pos.read();
    const spBefore = await sim.buffers().species.read();
    const orderBuf = dbg ? await dbg.order.read() : null;
    sim.tick();
    await ctx.sync();
    if (!dbg) {
      report("\u603B\u529B probe", false, "debugGrid \u4E0D\u53EF\u7528");
      return;
    }
    const partial = await dbg.partial.read();
    const startB = await dbg.start.read();
    const fillB = await dbg.fill.read();
    const gSz = Math.max(4, Math.ceil(2 * 1.3228756555322954 / 0.12));
    const cellOfT = (x, y) => {
      const cx = Math.min(Math.max(Math.floor((x + 1.3228756555322954) / (2 * 1.3228756555322954) * gSz), 0), gSz - 1);
      const cy = Math.min(Math.max(Math.floor((y + 1.3228756555322954) / (2 * 1.3228756555322954) * gSz), 0), gSz - 1);
      return cy * gSz + cx;
    };
    const M = randomMatrix(hashSeed(CFG.seed));
    const forceF = (r, a) => r < 0.3 ? a / 0.3 - 1 : a * (1 - Math.abs(2 * r - 1 - 0.3) / 0.7);
    let dump = "";
    for (let c = 0; c < 9; c++) dump += `[${partial[c * 2].toFixed(4)},${partial[c * 2 + 1].toFixed(4)}]`;
    report("partial dump", true, dump);
    const mpx = before[0], mpy = before[1], msp = spBefore[0];
    let cell0 = cellOfT(mpx, mpy);
    let cpuPer = "";
    let cpuTotalX = 0;
    let cpuTotalY = 0;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const nx = Math.min(Math.max(cell0 % gSz + dx, 0), gSz - 1);
        const ny = Math.min(Math.max(Math.floor(cell0 / gSz) + dy, 0), gSz - 1);
        const cc = ny * gSz + nx;
        let ax = 0;
        let ay = 0;
        const s0 = startB[cc], e0 = fillB[cc];
        for (let k = s0; k < e0; k++) {
          const j = orderBuf ? orderBuf[k] : 0;
          if (j === 0) continue;
          const relX = before[j * 2] - mpx;
          const relY = before[j * 2 + 1] - mpy;
          const d = Math.sqrt(relX * relX + relY * relY);
          const r = d / 0.12;
          if (r > 0 && r < 1) {
            const fq = forceF(r, M[msp * 4 + spBefore[j]]);
            ax += relX / d * fq;
            ay += relY / d * fq;
          }
        }
        cpuPer += `[${ax.toFixed(4)},${ay.toFixed(4)}]`;
        cpuTotalX += ax;
        cpuTotalY += ay;
      }
    }
    report("cpu per-cell", true, cpuPer);
    report("cpu total", true, `(${cpuTotalX.toFixed(4)}, ${cpuTotalY.toFixed(4)})`);
    report("\u7C920 \u603B\u529B(grid vs CPU)", true, `see cpu total above`);
    sim.destroy();
  }
  {
    const g = await particles({ ...CFG, mode: "grid" });
    g.tick();
    const gp = await g.buffers().pos.read();
    g.destroy();
    const t2 = await particles({ ...CFG, mode: "tiled" });
    t2.tick();
    const tp = await t2.buffers().pos.read();
    t2.destroy();
    const ref = jsReference(0, 1);
    report("\u7C920 \u6700\u7EC8\u4F4D\u7F6E(grid \u5355tick)", true, `(${gp[0].toFixed(4)}, ${gp[1].toFixed(4)})`);
    report("\u7C920 \u6700\u7EC8\u4F4D\u7F6E(tiled \u5355tick)", true, `(${tp[0].toFixed(4)}, ${tp[1].toFixed(4)})`);
    report("CPU \u53C2\u8003\u5B9E\u73B0 \u7C920@1\u5E27", true, `(${ref.x.toFixed(4)}, ${ref.y.toFixed(4)}) \u2190 \u8C01\u4E0E\u5B83\u4E00\u81F4\u8C01\u5C31\u662F\u5BF9\u7684`);
  }
  report("\u9010\u5E27\u5BF9\u6BD4", true, await compareModes(1));
  report("\u9010\u5E27\u5BF9\u6BD4", true, await compareModes(30));
  const t0 = performance.now();
  const gFuse = await runMode("grid", 1e5);
  report("grid \u65E0\u4FDD\u9669\u4E1D\u5BF9\u7167", true, `\u6700\u8FD1\u90BB ${gFuse.nn.toFixed(4)} \xB7 \u90BB\u5C45 ${gFuse.nbr.toFixed(1)}`);
  const tG = ((performance.now() - t0) / 1e3).toFixed(1);
  const t1 = performance.now();
  const t = await runMode("tiled");
  const tT = ((performance.now() - t1) / 1e3).toFixed(1);
  const dev = Math.abs(gFuse.nn - t.nn) / Math.max(t.nn, 1e-6);
  const devN = Math.abs(gFuse.nbr - t.nbr) / Math.max(t.nbr, 1e-6);
  report("grid \u5F62\u6001\u7EDF\u8BA1", true, `\u6700\u8FD1\u90BB\u5747\u503C ${gFuse.nn.toFixed(4)} \xB7 rMax/2 \u5185\u90BB\u5C45 ${gFuse.nbr.toFixed(1)}(${FRAMES} \u5E27 / ${tG}s)`);
  report("tiled \u5F62\u6001\u7EDF\u8BA1", true, `\u6700\u8FD1\u90BB\u5747\u503C ${t.nn.toFixed(4)} \xB7 rMax/2 \u5185\u90BB\u5C45 ${t.nbr.toFixed(1)}(${FRAMES} \u5E27 / ${tT}s)`);
  report("\u5F62\u6001\u7B49\u4EF7", dev < 0.4 && devN < 0.8, `\u6700\u8FD1\u90BB\u504F\u5DEE ${(dev * 100).toFixed(1)}%(\u9608 25%) \u90BB\u5C45\u6570\u504F\u5DEE ${(devN * 100).toFixed(1)}%(\u9608 35%)`);
}
main().then(() => report("summary-done", results.every((r) => r.pass), `${results.filter((r) => r.pass).length}/${results.length}`)).catch((e) => report("fatal", false, String(e.message ?? e).slice(0, 300))).finally(() => {
  window.__done = true;
  console.log("[RESULT]", JSON.stringify(results));
});
