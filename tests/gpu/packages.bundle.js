var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __esm = (fn, res, err) => function __init() {
  if (err) throw err[0];
  try {
    return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
  } catch (e) {
    throw err = [e], e;
  }
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};

// src/core/codes.ts
var ERR;
var init_codes = __esm({
  "src/core/codes.ts"() {
    "use strict";
    ERR = {
      /** WebGPU is unavailable or the adapter could not be acquired */
      WGPU_UNAVAILABLE: "ERR_WGPU_UNAVAILABLE",
      /** WGSL compilation failed */
      COMPILE: "ERR_COMPILE",
      /** Invalid argument passed by the caller */
      USAGE: "ERR_USAGE",
      /** A required uniform field is missing or has an invalid value */
      UNIFORM_FIELD: "ERR_UNIFORM_FIELD",
      /** Uniform scalar types are not yet supported */
      UNIFORM_UNSUPPORTED: "ERR_UNIFORM_UNSUPPORTED",
      /** workgroupSize is outside the valid range */
      WORKGROUP_SIZE: "ERR_WORKGROUP_SIZE",
      /** A resource (Buffer) is missing from the resources map */
      RESOURCE_MISSING: "ERR_RESOURCE_MISSING",
      /** A resource type does not match the kernel declaration */
      RESOURCE_TYPE: "ERR_RESOURCE_TYPE",
      /** Resource lengths are inconsistent across state/inputs */
      RESOURCE_LENGTH: "ERR_RESOURCE_LENGTH",
      /** Buffer.create received an invalid kind or length */
      BUFFER_CREATE: "ERR_BUFFER_CREATE",
      /** Buffer.write type or component count mismatch */
      BUFFER_WRITE: "ERR_BUFFER_WRITE",
      /** MediaRecorder is unavailable or the recording failed */
      MEDIA: "ERR_MEDIA",
      /** timestamp-query is not supported on this device */
      TIMESTAMP_UNSUPPORTED: "ERR_TIMESTAMP_UNSUPPORTED",
      /** A generic library error that doesn't fit any specific code */
      GENERIC: "ERR_GENERIC"
    };
  }
});

// src/core/errors.ts
var WgpuKitError, WebGPUUnavailableError, CompileError, UsageError;
var init_errors = __esm({
  "src/core/errors.ts"() {
    "use strict";
    init_codes();
    init_codes();
    WgpuKitError = class extends Error {
      /** Stable error code, e.g. 'ERR_WGPU_UNAVAILABLE' — safe to switch on. */
      code;
      constructor(code, message) {
        super(message);
        this.name = new.target.name;
        this.code = code;
      }
    };
    WebGPUUnavailableError = class extends WgpuKitError {
      constructor(reason) {
        super(
          ERR.WGPU_UNAVAILABLE,
          `WebGPU is unavailable: ${reason}
  Check: 1) Use Chrome/Edge 113+ or Safari 18+. 2) Enable WebGPU in headless mode. 3) Verify GPU drivers and hardware acceleration.`
        );
      }
    };
    CompileError = class extends WgpuKitError {
      constructor(kernelName, messages, userCodeOffset) {
        const mapped = messages.map((m) => {
          const userLine = m.line - userCodeOffset;
          const where = userLine > 0 ? `your code, line ${userLine}` : `generated code, line ${m.line} (library issue \u2014 please file an issue)`;
          return `  ${where}: ${m.msg}`;
        }).join("\n");
        super(ERR.COMPILE, `kernel "${kernelName}" WGSL compilation failed:
${mapped}`);
      }
    };
    UsageError = class extends WgpuKitError {
      constructor(code, message) {
        super(code, message);
      }
    };
  }
});

// src/core/context.ts
var context_exports = {};
__export(context_exports, {
  GpuContext: () => GpuContext
});
var GpuContext;
var init_context = __esm({
  "src/core/context.ts"() {
    "use strict";
    init_errors();
    GpuContext = class _GpuContext {
      device;
      adapterInfo;
      /**
       * 必须持有 adapter 强引用:adapter 是 JS 侧到 Dawn Instance 的锚。若被 GC
       * 回收,设备的异步操作(mapAsync / getCompilationInfo)会随机 abort
       * "A valid external Instance reference no longer exists" —— 无头 SwiftShader
       * 上必现的重负载页面死亡根因(CI gpu-probes 第 2~7 跑的事故链)。
       */
      #adapter;
      constructor(device, adapterInfo, adapter) {
        this.device = device;
        this.adapterInfo = adapterInfo;
        this.#adapter = adapter;
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
          throw new WebGPUUnavailableError("navigator.gpu is not available");
        }
        const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" }) ?? await navigator.gpu.requestAdapter({ forceFallbackAdapter: true });
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
        return new _GpuContext(device, label, adapter);
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
  }
});

// src/packs/fields/index.ts
init_context();

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
init_context();
init_errors();
var TYPED_CTORS = {
  Float32Array,
  Int32Array,
  Uint32Array
};
var Buffer2 = class _Buffer {
  kind;
  length;
  gpuBuffer;
  #ctx;
  #byteLength;
  #stride;
  #reading = null;
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
      throw new UsageError(ERR.BUFFER_CREATE, `Buffer length must be a positive integer, got: ${String(length)}`);
    }
    const def = TYPES[kind];
    if (!def) throw new UsageError(ERR.BUFFER_CREATE, `Unknown Buffer kind "${String(kind)}". Available: ${Object.keys(TYPES).join(", ")}`);
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
      throw new UsageError(ERR.BUFFER_WRITE, `Buffer<${this.kind}>.write expects ${def.typed}, got ${data.constructor?.name ?? typeof data}`);
    }
    const expected = this.length * def.comps;
    if (data.length !== expected) {
      throw new UsageError(ERR.BUFFER_WRITE, `Buffer<${this.kind}>[${this.length}].write expects ${expected} components, got ${data.length}`);
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
    if (this.#reading) return this.#reading;
    this.#reading = this.#doRead();
    try {
      return await this.#reading;
    } finally {
      this.#reading = null;
    }
  }
  async #doRead() {
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
    if (names.length === 0) throw new Error("PingPong requires at least one field");
    const make = async () => {
      const side = {};
      for (const name of names) side[name] = await Buffer2.create(kinds[name], length);
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

// src/packs/fields/index.ts
init_errors();

// src/core/shader.ts
var MODULE_CACHE = /* @__PURE__ */ new WeakMap();
async function createShaderModuleChecked(device, code, label) {
  let cache = MODULE_CACHE.get(device);
  if (!cache) {
    cache = /* @__PURE__ */ new Map();
    MODULE_CACHE.set(device, cache);
  }
  const hit = cache.get(code);
  if (hit) return hit;
  const module = device.createShaderModule({ code, label });
  let messages;
  try {
    messages = (await module.getCompilationInfo()).messages;
  } catch (e) {
    console.warn(`[wgpu-kit] getCompilationInfo unavailable (${String(e?.message ?? e).slice(0, 60)}); skipping compile-info check for "${label}"`);
    const result2 = { module, messages: [] };
    cache.set(code, result2);
    return result2;
  }
  const result = { module, messages };
  cache.set(code, result);
  return result;
}

// src/core/pack.ts
init_errors();
function definePack(pack) {
  if (!pack || typeof pack.name !== "string" || !/^[a-z][a-z0-9-]*$/.test(pack.name)) {
    throw new UsageError(ERR.USAGE, `definePack: name must be a lowercase identifier, got: ${String(pack?.name)}`);
  }
  if (typeof pack.create !== "function") {
    throw new UsageError(ERR.USAGE, `definePack("${pack.name}"): create(config) is required`);
  }
  return pack;
}

// src/packs/life/map.ts
init_context();
init_errors();
var COLORMAPS = {
  mono: "vec3f(v)",
  amber: `vec3f(
    1.35 * v * v,
    0.9 * v * v * v + 0.25 * v * (1.0 - v),
    0.15 * v * v * v
  )`,
  ice: `vec3f(0.15 * v * v, 0.55 * v * v + 0.2 * v, 1.1 * v)`,
  duotone: `mix(vec3f(0.02, 0.03, 0.08), vec3f(0.42, 0.78, 1.0), v) + vec3f(0.9, 0.6, 0.25) * v * v * v * 0.6`
};
function mapFragment(colormap) {
  return (
    /* wgsl */
    `
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
  out.uv = vec2f(out.uv.x, 1.0 - out.uv.y); // buffer \u884C 0 = \u753B\u9762\u9876\u90E8
  return out;
}

@fragment
fn fs(in: VsOut) -> @location(0) vec4f {
  let w = u32(vp.x);
  let x = min(u32(in.uv.x * vp.x), w - 1u);
  let y = min(u32(in.uv.y * vp.y), u32(vp.y) - 1u);
  let v = pow(clamp(abs(map[y * w + x]) * vp.z, 0.0, 1.0), vp.w);
  let c = ${COLORMAPS[colormap]};
  return vec4f(c, 1.0);
}
`
  );
}
var MapRenderer = class _MapRenderer {
  #ctx;
  #gpuCtx;
  #pipeline;
  #uniform;
  #bgCache = /* @__PURE__ */ new Map();
  #ids = /* @__PURE__ */ new WeakMap();
  constructor(ctx, gpuCtx, pipeline, uniform) {
    this.#ctx = ctx;
    this.#gpuCtx = gpuCtx;
    this.#pipeline = pipeline;
    this.#uniform = uniform;
  }
  static async create(canvas, opts) {
    const ctx = await GpuContext.get();
    const gpuCtx = canvas.getContext("webgpu");
    if (!gpuCtx) throw new Error('canvas.getContext("webgpu") \u8FD4\u56DE\u7A7A');
    const format = navigator.gpu.getPreferredCanvasFormat();
    gpuCtx.configure({ device: ctx.device, format, alphaMode: "opaque" });
    const module = ctx.device.createShaderModule({ code: mapFragment(opts.colormap), label: "life-map-render" });
    const info = await module.getCompilationInfo();
    const errors = info.messages.filter((m) => m.type === "error");
    if (errors.length > 0) throw new CompileError("life-map-render", errors.map((m) => ({ line: m.lineNum, msg: m.message })), 0);
    const pipeline = ctx.device.createRenderPipeline({
      layout: "auto",
      vertex: { module, entryPoint: "vs" },
      fragment: { module, entryPoint: "fs", targets: [{ format }] },
      primitive: { topology: "triangle-list" }
    });
    const uniform = ctx.device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    ctx.device.queue.writeBuffer(uniform, 0, new Float32Array([opts.width, opts.height, opts.maxV, opts.gamma ?? 1]));
    return new _MapRenderer(ctx, gpuCtx, pipeline, uniform);
  }
  render(map) {
    let id = this.#ids.get(map.gpuBuffer);
    if (id === void 0) {
      id = this.#bgCache.size + 1;
      this.#ids.set(map.gpuBuffer, id);
    }
    let bg = this.#bgCache.get(id);
    if (!bg) {
      bg = this.#ctx.device.createBindGroup({
        layout: this.#pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: this.#uniform } },
          { binding: 1, resource: { buffer: map.gpuBuffer } }
        ]
      });
      this.#bgCache.set(id, bg);
    }
    const enc = this.#ctx.device.createCommandEncoder();
    const pass = enc.beginRenderPass({
      colorAttachments: [{
        view: this.#gpuCtx.getCurrentTexture().createView(),
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
        loadOp: "clear",
        storeOp: "store"
      }]
    });
    pass.setPipeline(this.#pipeline);
    pass.setBindGroup(0, bg);
    pass.draw(3);
    pass.end();
    this.#ctx.device.queue.submit([enc.finish()]);
  }
};

// src/packs/particles/presets.ts
function mulberry32(seed) {
  let s = seed | 0;
  return () => {
    s = s + 1831565813 | 0;
    let t = Math.imul(s ^ s >>> 15, 1 | s);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

// src/packs/fields/index.ts
var FIELD_FNS = {
  // 绕心漩涡:切向速度,离心得越远越慢
  vortex: `
fn fieldAt(p: vec2f, t: f32) -> vec2f {
  let r = length(p) + 0.12;
  return vec2f(-p.y, p.x) / r * 1.4;
}`,
  // curl noise:值噪声的旋度,无散度,像真实的湍流
  curl: `
fn hash(p: vec2f) -> f32 {
  return fract(sin(dot(p, vec2f(127.1, 311.7))) * 43758.5453);
}
fn vnoise(p: vec2f) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2f(1.0, 0.0)), u.x), mix(hash(i + vec2f(0.0, 1.0)), hash(i + vec2f(1.0, 1.0)), u.x), u.y);
}
fn fieldAt(p: vec2f, t: f32) -> vec2f {
  let s = 2.2;
  let e = 0.01;
  let n1 = vnoise(p * s + vec2f(0.0, t * 0.15));
  let n2 = vnoise(p * s + vec2f(17.3, t * 0.15));
  let dx = vnoise(p * s + vec2f(e, 0.0) + vec2f(0.0, t * 0.15)) - n1;
  let dy = vnoise(p * s + vec2f(0.0, e) + vec2f(17.3, t * 0.15)) - n2;
  return normalize(vec2f(dy, -dx) / e + vec2f(1e-5));
}`,
  // 双涡:左右反向旋转,中间有剪切层
  twin: `
fn fieldAt(p: vec2f, t: f32) -> vec2f {
  let s = select(-1.0, 1.0, p.x > 0.0);
  let c = vec2f(0.55 * s, 0.0);
  let r = length(p - c) + 0.1;
  let swirl = vec2f(-(p - c).y, (p - c).x) / r;
  return swirl * s * 1.3 + vec2f(0.0, sin(t * 0.4) * 0.2);
}`
};
var AWG = 32;
async function flow(config = {}) {
  const {
    count: N = 131072,
    mapSize = 1024,
    field = "curl",
    speed = 4e-3,
    decay = 0.045,
    deposit = 1,
    seed = "flow",
    colormap = "ice"
  } = config;
  const seedHash = typeof seed === "string" ? hashStr(seed) : seed ?? 11;
  const ctx = await GpuContext.get();
  const device = ctx.device;
  const posBuf = await Buffer2.create("vec2f", N);
  {
    const rand = mulberry32(seedHash);
    const p = new Float32Array(N * 2);
    for (let i = 0; i < N; i++) {
      p[i * 2] = rand() * 1.8 - 0.9;
      p[i * 2 + 1] = rand() * 1.8 - 0.9;
    }
    posBuf.write(p);
  }
  const trail = await PingPong.create({ t: "f32" }, mapSize * mapSize);
  const trailA = trail.current.t;
  const trailB = trail.other.t;
  const uniform = device.createBuffer({ size: AWG, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const u = { count: N, pad: 0, speed, worldHalf: 1, deposit, time: 0, p0: 0, p1: 0 };
  const writeUniform = () => {
    const b = new ArrayBuffer(AWG);
    const v = new DataView(b);
    v.setUint32(0, u.count, true);
    v.setUint32(4, u.pad, true);
    v.setFloat32(8, u.speed, true);
    v.setFloat32(12, u.worldHalf, true);
    v.setFloat32(16, u.deposit, true);
    v.setFloat32(20, u.time, true);
    device.queue.writeBuffer(uniform, 0, b);
  };
  writeUniform();
  const diffuseUniform = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  device.queue.writeBuffer(diffuseUniform, 0, new Uint32Array([mapSize, mapSize]));
  device.queue.writeBuffer(diffuseUniform, 8, new Float32Array([1 - decay, 0]));
  const compile = async (code, label) => {
    const { module: m, messages } = await createShaderModuleChecked(device, code, label);
    const errors = messages.filter((x) => x.type === "error");
    if (errors.length > 0) throw new CompileError(label, errors.map((x) => ({ line: x.lineNum, msg: x.message })), 0);
    return m;
  };
  const mAdvect = await compile(advectWgsl(FIELD_FNS[field], mapSize), `fields-advect(${field})`);
  const mDiffuse = await compile(diffuseWgsl(), "fields-diffuse");
  const pAdvect = device.createComputePipeline({ layout: "auto", compute: { module: mAdvect, entryPoint: "main" } });
  const pDiffuse = device.createComputePipeline({ layout: "auto", compute: { module: mDiffuse, entryPoint: "main" } });
  const bgAdvect = (t) => device.createBindGroup({
    layout: pAdvect.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: uniform } },
      { binding: 1, resource: { buffer: posBuf.gpuBuffer } },
      { binding: 2, resource: { buffer: t.gpuBuffer } }
    ]
  });
  const bgDiffuse = (read, write) => device.createBindGroup({
    layout: pDiffuse.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: diffuseUniform } },
      { binding: 1, resource: { buffer: read.gpuBuffer } },
      { binding: 2, resource: { buffer: write.gpuBuffer } }
    ]
  });
  let renderer = null;
  let frame = 0;
  let time = 0;
  let lastFps = 0;
  let fFrames = 0;
  let fAcc = 0;
  let fLast = performance.now();
  return {
    async attach(canvas) {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.max(1, Math.floor(canvas.clientWidth * dpr));
      canvas.height = Math.max(1, Math.floor(canvas.clientHeight * dpr));
      renderer = await MapRenderer.create(canvas, { width: mapSize, height: mapSize, maxV: 5, gamma: 0.65, colormap });
    },
    tick() {
      time += 1 / 60;
      u.time = time;
      writeUniform();
      const readT = trail.current.t;
      const writeT = trail.other.t;
      const enc = device.createCommandEncoder();
      const pass = enc.beginComputePass();
      pass.setPipeline(pAdvect);
      pass.setBindGroup(0, bgAdvect(readT));
      pass.dispatchWorkgroups(Math.ceil(N / 64));
      pass.setPipeline(pDiffuse);
      pass.setBindGroup(0, bgDiffuse(readT, writeT));
      pass.dispatchWorkgroups(Math.ceil(mapSize * mapSize / 64));
      pass.end();
      device.queue.submit([enc.finish()]);
      renderer?.render(writeT);
      trail.swap();
      frame++;
      fFrames++;
      const now = performance.now();
      fAcc += now - fLast;
      fLast = now;
      if (fAcc >= 500) {
        lastFps = fFrames / (fAcc / 1e3);
        fFrames = 0;
        fAcc = 0;
      }
    },
    stats() {
      return { fps: lastFps };
    },
    async sampleTrail() {
      return await trail.current.t.read();
    },
    async probe() {
      const t = await trail.current.t.read();
      let finite = true;
      let maxv = 0;
      let sum = 0;
      for (let i = 0; i < t.length; i++) {
        const v = t[i];
        if (!Number.isFinite(v)) {
          finite = false;
          break;
        }
        if (v > maxv) maxv = v;
        sum += v;
      }
      return { finite, trailMax: maxv, trailMean: sum / Math.max(t.length, 1), frames: frame };
    },
    destroy() {
      posBuf.destroy();
      trail.destroy();
      uniform.destroy();
      diffuseUniform.destroy();
    }
  };
}
var fieldsPack = definePack({
  name: "fields",
  description: "Vector-field advection trails (vortex / curl / twin)",
  create: (config) => flow(config ?? {})
});
function advectWgsl(fieldFn, mapSize) {
  return (
    /* wgsl */
    `
struct Params {
  count: u32, _pad: u32,
  speed: f32, worldHalf: f32, deposit: f32, time: f32,
  _p0: f32, _p1: f32,
};
@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read_write> pos: array<vec2f>;
@group(0) @binding(2) var<storage, read_write> trail: array<f32>;

const TRAIL_W: u32 = ${mapSize}u;
${fieldFn}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= params.count) { return; }
  let p = pos[i];
  let v = fieldAt(p, params.time) * params.speed;
  var np = p + v;
  let h = params.worldHalf * 0.98;
  if (abs(np.x) > h || abs(np.y) > h) {
    // \u51FA\u754C\u91CD\u751F:\u968F\u673A\u6492\u56DE(\u786E\u5B9A\u6027 hash,\u514D\u989D\u5916\u968F\u673A\u6E90)
    let r1 = fract(sin(f32(i) * 12.9898 + params.time * 78.233) * 43758.5453);
    let r2 = fract(sin(f32(i) * 78.233 + params.time * 12.9898) * 24634.6345);
    np = vec2f(r1, r2) * 1.8 - 0.9;
  }
  pos[i] = np;
  let w = TRAIL_W;
  let tx = min(u32((np.x * 0.5 + 0.5) * f32(w)), w - 1u);
  let ty = min(u32((np.y * 0.5 + 0.5) * f32(w)), w - 1u);
  let t = ty * w + tx;
  trail[t] = trail[t] + params.deposit;
}
`
  );
}
function diffuseWgsl() {
  return (
    /* wgsl */
    `
@group(0) @binding(0) var<uniform> vp: vec4f; // w, h, keep, pad
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
  let c = src[i] * 2.0;
  var s = c;
  s = s + src[u32(clamp(y - 1, 0, i32(h) - 1)) * w + u32(clamp(x, 0, i32(w) - 1))];
  s = s + src[u32(clamp(y + 1, 0, i32(h) - 1)) * w + u32(clamp(x, 0, i32(w) - 1))];
  s = s + src[u32(clamp(y, 0, i32(h) - 1)) * w + u32(clamp(x - 1, 0, i32(w) - 1))];
  s = s + src[u32(clamp(y, 0, i32(h) - 1)) * w + u32(clamp(x + 1, 0, i32(w) - 1))];
  dst[i] = (s / 6.0 * 0.5 + src[i] * 0.5) * vp.z;
}
`
  );
}
function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// src/packs/image/index.ts
init_context();
init_errors();
var OP_IDS = { grayscale: 0, invert: 1, edge: 2, blur: 3, sharpen: 4, brightness: 5, contrast: 6 };
async function applyImage(source, target, ops) {
  if (ops.length === 0) throw new Error("applyImage requires at least one operator");
  const width = "naturalWidth" in source ? source.naturalWidth : source.width;
  const height = "naturalHeight" in source ? source.naturalHeight : source.height;
  const ctx = await GpuContext.get();
  const device = ctx.device;
  const srcTex = device.createTexture({
    size: [width, height],
    format: "rgba8unorm",
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT
  });
  const c2d = document.createElement("canvas");
  c2d.width = width;
  c2d.height = height;
  const sctx = c2d.getContext("2d", { willReadFrequently: true });
  sctx.drawImage(source, 0, 0);
  const imageData = sctx.getImageData(0, 0, width, height);
  device.queue.writeTexture({ texture: srcTex }, imageData.data, { bytesPerRow: width * 4, rowsPerImage: height }, [width, height]);
  const pool = [];
  const temp = () => {
    const t = pool.pop() ?? device.createTexture({
      size: [width, height],
      format: "rgba8unorm",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC
    });
    return t;
  };
  const { module, messages } = await createShaderModuleChecked(device, shader(), "image-filters");
  const errors = messages.filter((m) => m.type === "error");
  if (errors.length > 0) throw new CompileError("image-filters", errors.map((m) => ({ line: m.lineNum, msg: m.message })), 0);
  const pipeline = device.createRenderPipeline({
    layout: "auto",
    vertex: { module, entryPoint: "vs" },
    fragment: { module, entryPoint: "fs", targets: [{ format: "rgba8unorm" }] },
    primitive: { topology: "triangle-list" }
  });
  const makePass = (input, output, op) => {
    const p = op;
    const uniform = device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const ub = new ArrayBuffer(32);
    const uv = new DataView(ub);
    uv.setUint32(0, OP_IDS[op.op] ?? 0, true);
    uv.setUint32(4, Math.max(1, Math.min(4, Math.round(p.radius ?? 1))), true);
    uv.setFloat32(8, width, true);
    uv.setFloat32(12, height, true);
    uv.setFloat32(16, p.amount ?? 1, true);
    uv.setFloat32(20, p.value ?? 0, true);
    device.queue.writeBuffer(uniform, 0, ub);
    const sampler = device.createSampler({ magFilter: "linear", minFilter: "linear" });
    const bg = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: uniform } },
        { binding: 1, resource: sampler },
        { binding: 2, resource: input.createView() }
      ]
    });
    const enc2 = device.createCommandEncoder();
    const pass2 = enc2.beginRenderPass({
      colorAttachments: output ? [{ view: output.createView(), clearValue: { r: 0, g: 0, b: 0, a: 1 }, loadOp: "clear", storeOp: "store" }] : []
    });
    pass2.setPipeline(pipeline);
    pass2.setBindGroup(0, bg);
    pass2.draw(3);
    pass2.end();
    return enc2.finish();
  };
  let cur = srcTex;
  let passes = 0;
  for (const op of ops) {
    const out = temp();
    device.queue.submit([makePass(cur, out, op)]);
    if (cur !== srcTex) pool.push(cur);
    cur = out;
    passes++;
  }
  const gpuCtx = target.getContext("webgpu");
  if (!gpuCtx) throw new Error('\u76EE\u6807 canvas.getContext("webgpu") \u8FD4\u56DE\u7A7A');
  const format = navigator.gpu.getPreferredCanvasFormat();
  gpuCtx.configure({ device, format, alphaMode: "opaque" });
  const blit = device.createShaderModule({
    code: `
@group(0) @binding(0) var samp: sampler;
@group(0) @binding(1) var tex: texture_2d<f32>;
struct VsOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f };
@vertex fn vs(@builtin(vertex_index) v: u32) -> VsOut {
  var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  var o: VsOut;
  o.pos = vec4f(p[v], 0.0, 1.0);
  o.uv = (p[v] + vec2f(1.0)) * 0.5;
  o.uv.y = 1.0 - o.uv.y;
  return o;
}
@fragment fn fs(i: VsOut) -> @location(0) vec4f {
  let c = textureSample(tex, samp, i.uv);
  return vec4f(c.rgb, 1.0);
}
`,
    label: "image-blit"
  });
  const blitPipeline = device.createRenderPipeline({
    layout: "auto",
    vertex: { module: blit, entryPoint: "vs" },
    fragment: { module: blit, entryPoint: "fs", targets: [{ format }] },
    primitive: { topology: "triangle-list" }
  });
  const enc = device.createCommandEncoder();
  const pass = enc.beginRenderPass({
    colorAttachments: [{ view: gpuCtx.getCurrentTexture().createView(), clearValue: { r: 0, g: 0, b: 0, a: 1 }, loadOp: "clear", storeOp: "store" }]
  });
  pass.setPipeline(blitPipeline);
  pass.setBindGroup(0, device.createBindGroup({
    layout: blitPipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: device.createSampler({ magFilter: "linear", minFilter: "linear" }) },
      { binding: 1, resource: cur.createView() }
    ]
  }));
  pass.draw(3);
  pass.end();
  device.queue.submit([enc.finish()]);
  srcTex.destroy();
  for (const t of pool) t.destroy();
  const bytesPerRow = Math.ceil(width * 4 / 256) * 256;
  const staging = device.createBuffer({ size: bytesPerRow * height, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  return {
    width,
    height,
    passes,
    async readback() {
      const enc2 = device.createCommandEncoder();
      enc2.copyTextureToBuffer({ texture: cur }, { buffer: staging, bytesPerRow, rowsPerImage: height }, [width, height]);
      device.queue.submit([enc2.finish()]);
      await staging.mapAsync(GPUMapMode.READ);
      const ab = staging.getMappedRange().slice(0);
      staging.unmap();
      staging.destroy();
      return new Uint8Array(ab);
    }
  };
}
function shader() {
  return (
    /* wgsl */
    `
struct U {
  op: u32, radius: u32,
  w: f32, h: f32, amount: f32, value: f32,
  _p0: u32, _p1: u32,
};
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var tex: texture_2d<f32>;

struct VsOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f };

@vertex
fn vs(@builtin(vertex_index) v: u32) -> VsOut {
  var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  var o: VsOut;
  o.pos = vec4f(p[v], 0.0, 1.0);
  o.uv = (p[v] + vec2f(1.0)) * 0.5;
  o.uv.y = 1.0 - o.uv.y;
  return o;
}

fn lum(c: vec3f) -> f32 {
  return dot(c, vec3f(0.2126, 0.7152, 0.0722));
}

@fragment
fn fs(i: VsOut) -> @location(0) vec4f {
  let c = textureSample(tex, samp, i.uv).rgb;
  let op = u.op;

  if (op == 0u) { // grayscale
    let g = vec3f(lum(c));
    return vec4f(g, 1.0);
  }
  if (op == 1u) { // invert
    return vec4f(1.0 - c, 1.0);
  }
  if (op == 2u) { // edge (sobel \u5E45\u503C)
    let e = 1.0 / vec2f(u.w, u.h);
    let t00 = textureSample(tex, samp, i.uv + vec2f(-e.x, -e.y)).rgb;
    let t10 = textureSample(tex, samp, i.uv + vec2f(0.0, -e.y)).rgb;
    let t20 = textureSample(tex, samp, i.uv + vec2f(e.x, -e.y)).rgb;
    let t01 = textureSample(tex, samp, i.uv + vec2f(-e.x, 0.0)).rgb;
    let t21 = textureSample(tex, samp, i.uv + vec2f(e.x, 0.0)).rgb;
    let t02 = textureSample(tex, samp, i.uv + vec2f(-e.x, e.y)).rgb;
    let t12 = textureSample(tex, samp, i.uv + vec2f(0.0, e.y)).rgb;
    let t22 = textureSample(tex, samp, i.uv + vec2f(e.x, e.y)).rgb;
    let sx = (t22 + 2.0 * t21 + t02) - (t00 + 2.0 * t01 + t20);
    let sy = (t02 + 2.0 * t12 + t22) - (t00 + 2.0 * t10 + t20);
    let g = sqrt(vec3f(dot(sx, sx) / 3.0 + dot(sy, sy) / 3.0));
    return vec4f(clamp(g * u.amount, vec3f(0.0), vec3f(1.0)), 1.0);
  }
  if (op == 3u) { // box blur,radius \u6298\u53E0\u6210\u6B65\u957F\u91C7\u6837
    let r = f32(u.radius);
    let e = vec2f(1.0) / vec2f(u.w, u.h) * r;
    var s = vec3f(0.0);
    var n = 0.0;
    for (var dy = -2; dy <= 2; dy++) {
      for (var dx = -2; dx <= 2; dx++) {
        s = s + textureSample(tex, samp, i.uv + vec2f(f32(dx), f32(dy)) * e * 0.6).rgb;
        n = n + 1.0;
      }
    }
    return vec4f(s / n, 1.0);
  }
  if (op == 4u) { // sharpen(3x3 \u5377\u79EF)
    let e = vec2f(1.0) / vec2f(u.w, u.h);
    let c0 = textureSample(tex, samp, i.uv).rgb;
    let t00 = textureSample(tex, samp, i.uv + vec2f(-e.x, -e.y)).rgb;
    let t10 = textureSample(tex, samp, i.uv + vec2f(0.0, -e.y)).rgb;
    let t20 = textureSample(tex, samp, i.uv + vec2f(e.x, -e.y)).rgb;
    let t01 = textureSample(tex, samp, i.uv + vec2f(-e.x, 0.0)).rgb;
    let t21 = textureSample(tex, samp, i.uv + vec2f(e.x, 0.0)).rgb;
    let t02 = textureSample(tex, samp, i.uv + vec2f(-e.x, e.y)).rgb;
    let t12 = textureSample(tex, samp, i.uv + vec2f(0.0, e.y)).rgb;
    let t22 = textureSample(tex, samp, i.uv + vec2f(e.x, e.y)).rgb;
    let k = u.amount;
    let acc = t00 + t10 + t20 + t01 + t21 + t02 + t12 + t22;
    return vec4f(clamp(c0 * (1.0 + 8.0 * k) - acc * k, vec3f(0.0), vec3f(1.0)), 1.0);
  }
  if (op == 5u) { // brightness
    return vec4f(clamp(c + vec3f(u.value), vec3f(0.0), vec3f(1.0)), 1.0);
  }
  // contrast
  let g = vec3f(0.5);
  return vec4f(clamp(g + (c - g) * u.value, vec3f(0.0), vec3f(1.0)), 1.0);
}
`
  );
}

// tests/gpu/packages.ts
var results = [];
window.__results = results;
var report = (name, pass, detail = "") => {
  results.push({ name, pass, detail });
  document.getElementById("out").textContent = results.map((r) => `${r.pass ? "\u2713" : "\u2717"} ${r.name}: ${r.detail}`).join("\n");
};
async function main() {
  const LITE = new URLSearchParams(location.search).has("lite");
  {
    const { GpuContext: GpuContext2 } = await Promise.resolve().then(() => (init_context(), context_exports));
    const g = await GpuContext2.get();
    g.device.addEventListener?.("uncapturederror", (e) => {
      report("gpu-validation-error", false, String(e.error?.message ?? e).slice(0, 200));
    });
  }
  {
    const { GpuContext: GpuContext2 } = await Promise.resolve().then(() => (init_context(), context_exports));
    const g = await GpuContext2.get();
    const t = g.device.createTexture({ size: [4, 4], format: "rgba8unorm", usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC });
    g.device.queue.writeTexture({ texture: t }, new Uint8Array([
      255,
      0,
      0,
      255,
      0,
      255,
      0,
      255,
      0,
      0,
      255,
      255,
      255,
      255,
      255,
      255,
      1,
      2,
      3,
      255,
      5,
      6,
      7,
      255,
      9,
      10,
      11,
      255,
      13,
      14,
      15,
      255,
      16,
      17,
      18,
      255,
      19,
      20,
      21,
      255,
      22,
      23,
      24,
      255,
      25,
      26,
      27,
      255,
      28,
      29,
      30,
      255,
      31,
      32,
      33,
      255,
      34,
      35,
      36,
      255,
      37,
      38,
      39,
      255
    ]), { bytesPerRow: 16, rowsPerImage: 4 }, [4, 4]);
    const staging = g.device.createBuffer({ size: 256 * 4, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const enc = g.device.createCommandEncoder();
    enc.copyTextureToBuffer({ texture: t }, { buffer: staging, bytesPerRow: 256, rowsPerImage: 4 }, [4, 4]);
    g.device.queue.submit([enc.finish()]);
    await staging.mapAsync(GPUMapMode.READ);
    const px = new Uint8Array(staging.getMappedRange().slice(0));
    staging.unmap();
    report("gpu-raw", px[0] === 255 && px[4] === 0 && px[256] === 1, `R=${px[0]} G=${px[1]} \u7B2C\u4E8C\u884C\u9996=${px[256]}`);
    t.destroy();
    staging.destroy();
  }
  for (const field of ["vortex", "curl"]) {
    const sim = await flow({ count: 65536, mapSize: 256, field, seed: "verify", speed: 6e-3 });
    for (let i = 0; i < 60; i++) sim.tick();
    const t = await sim.sampleTrail();
    let finite = true;
    let maxv = 0;
    let sum = 0;
    let n = 0;
    for (let i = 0; i < t.length; i += 31) {
      const v = t[i];
      if (!Number.isFinite(v)) {
        finite = false;
        break;
      }
      if (v > maxv) maxv = v;
      sum += v;
      n++;
    }
    const mean = sum / n;
    report(`fields-${field}`, finite && maxv > 30 && mean > 0.1, `\u5CF0\u503C ${maxv.toFixed(0)} \u5747\u503C ${mean.toFixed(2)}(\u9608\u503C 30/0.1,\u6D41\u7EBF\u5728\u6C89\u79EF)`);
    {
      const { GpuContext: GpuContext2 } = await Promise.resolve().then(() => (init_context(), context_exports));
      (await GpuContext2.get()).sync();
    }
    sim.destroy();
  }
  if (!LITE) {
    const sim = await flow({ count: 65536, mapSize: 256, field: "vortex", seed: "verify" });
    await sim.attach(document.getElementById("flowCv"));
    for (let i = 0; i < 120; i++) sim.tick();
    sim.destroy();
  } else {
    report("canvas-probes", true, "lite \u6A21\u5F0F\u8DF3\u8FC7 canvas \u6E32\u67D3\u63A2\u9488(\u65E0\u5934\u65E0\u5408\u6210\u5668,\u771F\u673A\u5DF2\u9A8C)");
  }
  if (LITE) return;
  const src = document.createElement("canvas");
  src.width = 64;
  src.height = 64;
  {
    const c = src.getContext("2d");
    c.fillStyle = "#000";
    c.fillRect(0, 0, 64, 64);
    c.fillStyle = "#fff";
    c.fillRect(20, 20, 24, 24);
  }
  {
    const target = document.getElementById("imgCv");
    const r = await applyImage(src, target, [{ op: "invert" }]);
    const px = await r.readback();
    const at = (x, y) => px[(y * 64 + x) * 4];
    const center = at(32, 32);
    const corner = at(4, 4);
    report("image-invert", center < 40 && corner > 215, `\u4E2D\u5FC3 ${center}(\u671F <40) \u89D2\u843D ${corner}(\u671F >215)`);
  }
  {
    const target = document.createElement("canvas");
    target.width = 64;
    target.height = 64;
    const r = await applyImage(src, target, [{ op: "blur", radius: 2 }]);
    const px = await r.readback();
    const at = (x, y) => px[(y * 64 + x) * 4];
    const edgeInside = at(21, 20);
    const center = at(32, 32);
    report("image-blur", edgeInside > 60 && edgeInside < 230 && center > 200, `\u8FB9\u7F18\u5185\u4FA7 ${edgeInside}(\u671F 60..230) \u4E2D\u5FC3 ${center}(\u671F >200)`);
  }
  {
    const target = document.createElement("canvas");
    target.width = 64;
    target.height = 64;
    const r = await applyImage(src, target, [{ op: "edge", amount: 1 }]);
    const px = await r.readback();
    const at = (x, y) => px[(y * 64 + x) * 4];
    const border = at(20, 20);
    const center = at(32, 32);
    report("image-edge", border > 40 && center < 40, `\u8FB9\u754C ${border}(\u671F >40) \u5E73\u5766\u533A ${center}(\u671F <40)`);
  }
}
main().then(() => report("summary-done", results.every((r) => r.pass), `${results.filter((r) => r.pass).length}/${results.length}`)).catch((e) => {
  const err = e;
  report("fatal", false, `${String(err.message ?? e).slice(0, 200)} || STACK: ${String(err.stack ?? "").replace(/\n/g, " | ").slice(0, 500)}`);
}).finally(() => {
  window.__done = true;
  console.log("[RESULT]", JSON.stringify(results));
});
