import { planUniform, packUniformInto, TYPES, type ScalarKind, type UniformLayout, type UniformValue } from './layout.ts';
import { GpuContext } from './context.ts';
import { Buffer } from './buffer.ts';
import { CompileError, ERR, UsageError } from './errors.ts';
import { createShaderModuleChecked } from './shader.ts';
import { batchUniform, validateBatch, type ComputeBatch } from './batch.ts';

/** Per-element WGSL with generated bindings, uniforms, bounds checks and diagnostics. */
export interface ElementKernelSpec {
  /** 调试名,错误信息里出现 */
  name?: string;
  /** 读写逐元素字段(就地修改),如 { pos: 'vec2f' } */
  state?: Record<string, ScalarKind>;
  /** 只读逐元素字段,如 { vel: 'vec2f' } */
  inputs?: Record<string, ScalarKind>;
  /** 任意长度的只读辅助缓冲,不参与执行数量推导;索引边界由用户 WGSL 负责 */
  auxInputs?: Record<string, ScalarKind>;
  /** uniform 标量(不允许叫 count,count 由库自动注入) */
  uniforms?: Record<string, ScalarKind>;
  /** workgroup 大小,默认 64 */
  workgroupSize?: number;
  /** 用户函数,如 `fn step(idx: u32, dt: f32) { ... }`(引用字段名直接访问数组) */
  code: string;
}

export interface ElementKernelDispatchOptions {
  /** 执行前 count 个元素;省略时保持 state/inputs 等长并自动推导数量 */
  count?: number;
}

export interface ElementKernelEncodeOptions extends ElementKernelDispatchOptions {
  /** 独立参数快照和临时资源由此提交作用域管理;encoder 必须为 batch.encoder */
  batch?: ComputeBatch;
}

export interface ElementKernel {
  readonly name: string;
  /** 生成的完整 WGSL(调试/单测用) */
  readonly source: string;
  readonly uniformLayout: UniformLayout;
  readonly workgroupSize: number;
  run(resources: Record<string, Buffer>, uniforms?: Record<string, UniformValue>, options?: ElementKernelDispatchOptions): Promise<void>;
  /** [v2.0] 异步准备:解析上下文、编译管线、分配内部资源。幂等;encode 前必须完成 */
  prepare(): Promise<void>;
  /** 同步编码;须先 prepare()。batch 支持重复调用,原生路径仍须提交后 endSubmit()。 */
  encode(encoder: GPUCommandEncoder, resources: Record<string, Buffer>, uniforms?: Record<string, UniformValue>, options?: ElementKernelEncodeOptions): void;
  /** [v2.0] 自定义 submit 流程完成后调用:重置 encode-once-per-submit 检测 */
  endSubmit(): void;
  /** 高级:解除 encode-once-per-submit 检测(自行承担 uniform 覆盖语义) */
  resetEncodeGuard(): void;
  /** 热重载:替换用户函数并重建管线;编译失败时抛错且内核保持旧版 */
  replace(code: string): Promise<void>;
  destroy(): void;
}

interface NormalizedSpec {
  name: string;
  workgroupSize: number;
  state: Array<readonly [string, ScalarKind]>;
  inputs: Array<readonly [string, ScalarKind]>;
  auxInputs: Array<readonly [string, ScalarKind]>;
  uniforms: Array<readonly [string, ScalarKind]>;
  code: string;
  /** 入口点静态使用的 binding 号('auto' 布局语义,见生成处的注释) */
  usedBindings: Set<number>;
}

const RESERVED = new Set(['count']);

/** GPUBuffer 的稳定数字身份(WeakMap 分配,用于 bind group 缓存键) */
let nextBufferId = 0;
const bufferIds = new WeakMap<GPUBuffer, number>();
function bufId(b: GPUBuffer): number {
  let id = bufferIds.get(b);
  if (id === undefined) { id = ++nextBufferId; bufferIds.set(b, id); }
  return id;
}

/** 纯函数:规范校验 + WGSL 代码生成。单测直接覆盖,不碰 GPU。 */
export function generateElementKernel(spec: ElementKernelSpec): {
  normalized: NormalizedSpec;
  source: string;
  uniformLayout: UniformLayout;
  userCodeLineOffset: number;
} {
  const name = spec.name ?? 'kernel';
  const workgroupSize = spec.workgroupSize ?? 64;
  if (!Number.isInteger(workgroupSize) || workgroupSize < 1 || workgroupSize > 512) {
    throw new UsageError(ERR.WORKGROUP_SIZE, `workgroupSize must be in 1..512, got: ${String(workgroupSize)}`);
  }
  const state = Object.entries(spec.state ?? {});
  const inputs = Object.entries(spec.inputs ?? {});
  const auxInputs = Object.entries(spec.auxInputs ?? {});
  const uniforms = Object.entries(spec.uniforms ?? {});
  if (state.length + inputs.length === 0) {
    throw new UsageError(ERR.RESOURCE_MISSING, `elementKernel "${name}" requires at least one state or inputs field`);
  }
  for (const [uName] of uniforms) {
    if (RESERVED.has(uName)) throw new UsageError(ERR.USAGE, `uniform name "${uName}" is reserved (count is auto-injected by the library)`);
  }
  const seen = new Set([...state, ...inputs, ...auxInputs, ...uniforms].map(([n]) => n));
  if (seen.size !== state.length + inputs.length + auxInputs.length + uniforms.length) {
    throw new UsageError(ERR.USAGE, `elementKernel "${name}" has duplicate field names across state/inputs/auxInputs/uniforms`);
  }
  if (typeof spec.code !== 'string' || spec.code.trim().length === 0) {
    throw new UsageError(ERR.USAGE, `elementKernel "${name}" is missing code (user WGSL function)`);
  }

  const uniformEntries: Array<readonly [string, ScalarKind]> = [...uniforms, ['count', 'u32']];
  const uniformLayout = planUniform(uniformEntries);

  // Auto layouts contain only reachable bindings. Exclude comments, struct members
  // and dead helpers. Lexical matching cannot resolve local-variable shadowing.
  // Binding 0 is always used by the generated count guard.
  const codeNoComments = spec.code
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/.*$/gm, ' ')
    .replace(/struct\s+[A-Za-z_][A-Za-z0-9_]*\s*\{[^}]*\}/g, ' ')
    .replace(/\.\s*[A-Za-z_][A-Za-z0-9_]*/g, ' ');
  // Without userFn, leave validation to the shader compiler.
  const reachableBodies = (): string[] => {
    const fnHeader = /fn\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;
    const bodies = new Map<string, string>();
    let m: RegExpExecArray | null;
    while ((m = fnHeader.exec(codeNoComments)) !== null) {
      const name = m[1]!;
      const braceStart = codeNoComments.indexOf('{', m.index + m[0].length - 1);
      if (braceStart === -1) continue;
      let depth = 0;
      let end = -1;
      for (let i = braceStart; i < codeNoComments.length; i++) {
        if (codeNoComments[i] === '{') depth++;
        else if (codeNoComments[i] === '}') {
          depth--;
          if (depth === 0) { end = i; break; }
        }
      }
      if (end !== -1) bodies.set(name, codeNoComments.slice(braceStart, end + 1));
    }
    const reachable: string[] = [];
    const seen = new Set<string>();
    const visit = (body: string) => {
      reachable.push(body);
      for (const [name, text] of bodies) {
        if (!seen.has(name) && new RegExp(`\\b${name}\\b`).test(body)) {
          seen.add(name);
          visit(text);
        }
      }
    };
    const userFnBody = bodies.get('userFn');
    if (userFnBody) { seen.add('userFn'); visit(userFnBody); return reachable; }
    return [codeNoComments];
  };
  const wordInReachable = (n: string) => {
    const re = new RegExp(`\\b${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
    return reachableBodies().some((body) => re.test(body));
  };
  const usedBindings = new Set<number>([0]);
  {
    let b = 1;
    for (const [n] of state) { if (wordInReachable(n)) usedBindings.add(b); b++; }
    for (const [n] of inputs) { if (wordInReachable(n)) usedBindings.add(b); b++; }
    for (const [n] of auxInputs) { if (wordInReachable(n)) usedBindings.add(b); b++; }
  }

  // —— 生成 WGSL:头部(声明) + main + 用户代码 ——
  const header: string[] = [];
  header.push('// 由 wgpu-kit elementKernel 生成');
  header.push('struct Params {');
  for (const [n, k] of uniformEntries) header.push(`  ${n}: ${TYPES[k].wgsl},`);
  header.push('};');
  header.push('@group(0) @binding(0) var<uniform> params: Params;');
  let binding = 1;
  for (const [n, k] of state) header.push(`@group(0) @binding(${binding++}) var<storage, read_write> ${n}: array<${TYPES[k].wgsl}>;`);
  for (const [n, k] of inputs) header.push(`@group(0) @binding(${binding++}) var<storage, read> ${n}: array<${TYPES[k].wgsl}>;`);
  for (const [n, k] of auxInputs) header.push(`@group(0) @binding(${binding++}) var<storage, read> ${n}: array<${TYPES[k].wgsl}>;`);
  header.push('');
  header.push(`@compute @workgroup_size(${workgroupSize})`);
  header.push('fn main(@builtin(global_invocation_id) gid: vec3u) {');
  header.push('  let idx = gid.x;');
  header.push('  if (idx >= params.count) { return; }');
  const uniformArgs = uniforms.map(([n]) => `params.${n}`).join(', ');
  // 用户函数固定命名 userFn —— 唯一约定,杜绝调用名对不上的脆弱性
  header.push(`  userFn(idx${uniformArgs ? ', ' + uniformArgs : ''});`);
  header.push('}');
  const userCodeLineOffset = header.length; // 1-based 行号:用户代码从 offset+1 行开始
  const source = [...header, spec.code].join('\n');

  return {
    normalized: { name, workgroupSize, state, inputs, auxInputs, uniforms, code: spec.code, usedBindings },
    source,
    uniformLayout,
    userCodeLineOffset,
  };
}

export function elementKernel(spec: ElementKernelSpec): ElementKernel {
  const first = generateElementKernel(spec);
  const uniformLayout = first.uniformLayout;
  let normalized = first.normalized;
  let source = first.source;
  let userCodeLineOffset = first.userCodeLineOffset;
  const uniformBufferName = `${normalized.name}:uniform`;

  // 构造期预展开字段与类型,避免每帧重新解析声明。
  const orderedFields: Array<{ key: string; kind: ScalarKind }> = [
    ...normalized.state.map(([k, t]) => ({ key: k, kind: t })),
    ...normalized.inputs.map(([k, t]) => ({ key: k, kind: t })),
    ...normalized.auxInputs.map(([k, t]) => ({ key: k, kind: t })),
  ];
  const elementFieldCount = normalized.state.length + normalized.inputs.length;
  const expectedKinds = new Map(orderedFields.map((f) => [f.key, f.kind] as const));
  const sharedPack = new ArrayBuffer(uniformLayout.size); // 复用打包缓冲(writeBuffer 会拷贝)

  let pipelinePromise: Promise<GPUComputePipeline> | null = null;
  let pipeline: GPUComputePipeline | null = null; // resolve 后的同步引用(encode 用)
  let cachedCtx: GpuContext | null = null; // 首帧后缓存为普通引用
  const bindGroupCache = new Map<number, { bg: GPUBindGroup; ids: readonly number[] }>();
  let uniformBuffer: GPUBuffer | null = null;
  // Only the native encoder path shares the instance uniform buffer.
  let encodeGuardArmed = true;
  let encodeGuardOpen = false;

  const compilePipeline = async (): Promise<GPUComputePipeline> => {
    const ctx = await GpuContext.get();
    const device = ctx.device;
    const { module, messages } = await createShaderModuleChecked(device, source, normalized.name);
    // 捕获编译错误并映射行号
    const errors = messages.filter((m) => m.type === 'error');
    if (errors.length > 0) {
      throw new CompileError(
        normalized.name,
        errors.map((m) => ({ line: m.lineNum, msg: m.message })),
        userCodeLineOffset,
      );
    }
    return device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: 'main' } });
  };

  const ensureUniformBuffer = (device: GPUDevice): GPUBuffer => {
    if (!uniformBuffer) {
      uniformBuffer = device.createBuffer({
        size: uniformLayout.size,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        label: uniformBufferName,
      });
    }
    return uniformBuffer;
  };

  async function getPipeline(): Promise<GPUComputePipeline> {
    if (pipeline) return pipeline;
    if (!pipelinePromise) {
      pipelinePromise = compilePipeline().catch((e) => { pipelinePromise = null; throw e; });
    }
    pipeline = await pipelinePromise;
    return pipeline;
  }

  return {
    get name() { return normalized.name; },
    get source() { return source; },
    get uniformLayout() { return first.uniformLayout; },
    get workgroupSize() { return normalized.workgroupSize; },

    async replace(code: string): Promise<void> {
      const regen = generateElementKernel({ ...spec, code });
      // 先编译后切换:新代码编译失败则保持旧版不动
      const savedSource = source;
      const savedOffset = userCodeLineOffset;
      const savedNormalized = normalized;
      source = regen.source;
      userCodeLineOffset = regen.userCodeLineOffset;
      normalized = regen.normalized; // usedBindings 随新代码重算
      try {
        const p = await compilePipeline();
        pipelinePromise = Promise.resolve(p);
        pipeline = p;
        bindGroupCache.clear();
      } catch (e) {
        source = savedSource;
        userCodeLineOffset = savedOffset;
        normalized = savedNormalized;
        throw e;
      }
    },

    async prepare(): Promise<void> {
      cachedCtx ??= await GpuContext.get();
      await getPipeline();
      ensureUniformBuffer(cachedCtx.device);
    },

    /**
     * prepare 后同步编码到调用方 encoder,不提交。
     * 省略 count 时 state/inputs 必须等长;显式指定时容量须覆盖 count。
     * auxInputs 的长度和索引由用户 WGSL 处理。
     * 共享 uniform 在编码时上传,因此每次提交前只允许一次非零编码。
     * 提交后调用 endSubmit();解除检测时自行承担参数覆盖风险。
     */
    encode(encoder: GPUCommandEncoder, resources: Record<string, Buffer>, uniforms: Record<string, UniformValue> = {}, options: ElementKernelEncodeOptions = {}): void {
      if (!cachedCtx || !pipeline || !uniformBuffer) {
        throw new UsageError(ERR.USAGE, `kernel "${normalized.name}".encode called before prepare() — await kernel.prepare() first`);
      }
      const device = cachedCtx.device;
      const batch = options.batch;
      if (batch) validateBatch(batch, encoder, device);

      const explicitCount = options.count;
      if (explicitCount !== undefined && (!Number.isInteger(explicitCount) || explicitCount < 0 || explicitCount > 0xffffffff)) {
        throw new UsageError(ERR.USAGE, `kernel "${normalized.name}" count must be an integer in 0..4294967295, got: ${String(explicitCount)}`);
      }

      // Validate before arming the guard, so failed calls can be retried.
      const ordered: Buffer[] = [];
      let count = explicitCount ?? -1;
      let firstKey = '';
      for (let i = 0; i < orderedFields.length; i++) {
        const f = orderedFields[i]!;
        const buf = resources[f.key];
        if (!buf) throw new UsageError(ERR.RESOURCE_MISSING, `kernel "${normalized.name}".run is missing resource "${f.key}"`);
        const want = expectedKinds.get(f.key);
        if (buf.kind !== want) {
          throw new UsageError(ERR.RESOURCE_TYPE, `Resource "${f.key}" type mismatch: expected ${want}, got ${buf.kind}`);
        }
        if (i < elementFieldCount) {
          if (explicitCount !== undefined) {
            if (buf.length < count) {
              throw new UsageError(ERR.RESOURCE_LENGTH, `Resource "${f.key}" length ${buf.length} is smaller than dispatch count ${count}`);
            }
          } else if (count === -1) { count = buf.length; firstKey = f.key; }
          else if (buf.length !== count) {
            throw new UsageError(ERR.RESOURCE_LENGTH, `Resource "${f.key}" length ${buf.length} does not match "${firstKey}" length ${count}`);
          }
        }
        ordered.push(buf);
      }
      const workgroups = Math.ceil(count / normalized.workgroupSize);
      if (workgroups > device.limits.maxComputeWorkgroupsPerDimension) {
        throw new UsageError(ERR.USAGE, `kernel "${normalized.name}" dispatch needs ${workgroups} workgroups, exceeding device limit ${device.limits.maxComputeWorkgroupsPerDimension}`);
      }
      // Uniform validation must also complete before changing submission state.
      packUniformInto(sharedPack, uniformLayout, { ...uniforms, count });
      // 零次执行也校验资源和参数,但不得上传、打开或清除已有的提交闸。
      if (count === 0) return;
      if (!batch && encodeGuardArmed && encodeGuardOpen) {
        throw new UsageError(ERR.USAGE, `kernel "${normalized.name}".encode called twice before submit — the shared uniform would be overwritten (encode-once-per-submit contract; see docs). Call submit between encodes, or create one kernel instance per concurrent encode.`);
      }
      if (!batch && encodeGuardArmed) encodeGuardOpen = true;
      const uniformBinding = batch
        ? batchUniform(batch, encoder, device, sharedPack)
        : { buffer: uniformBuffer };
      if (!batch) device.queue.writeBuffer(uniformBuffer, 0, sharedPack);

      // —— bind group(按 buffer 身份缓存) ——
      let cacheKey = 0;
      for (let i = 0; i < ordered.length; i++) cacheKey = (cacheKey * 31 + bufId(ordered[i]!.gpuBuffer)) | 0;
      const ids = ordered.map((b) => bufId(b.gpuBuffer));
      const cached = batch ? undefined : bindGroupCache.get(cacheKey);
      const identityMatch = cached && cached.ids.length === ids.length && cached.ids.every((id, idx) => id === ids[idx]);
      let bg = identityMatch ? cached!.bg : undefined;
      if (!bg) {
        // 只绑定入口点静态使用的绑定(layout:'auto' 语义,见生成处的注释)
        const entries: GPUBindGroupEntry[] = [];
        if (normalized.usedBindings.has(0)) entries.push({ binding: 0, resource: uniformBinding });
        ordered.forEach((buffer, i) => {
          if (normalized.usedBindings.has(i + 1)) entries.push({ binding: i + 1, resource: { buffer: buffer.gpuBuffer } });
        });
        bg = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries });
        if (!batch) bindGroupCache.set(cacheKey, { bg, ids });
      }

      // —— 写入调用方 encoder(不提交) ——
      const pass = encoder.beginComputePass();
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, bg);
      pass.dispatchWorkgroups(workgroups);
      pass.end();
    },

    async run(resources: Record<string, Buffer>, uniforms: Record<string, UniformValue> = {}, options: ElementKernelDispatchOptions = {}): Promise<void> {
      await this.prepare();
      const enc = cachedCtx!.device.createCommandEncoder();
      this.encode(enc, resources, uniforms, options);
      if (options.count === 0) return;
      cachedCtx!.device.queue.submit([enc.finish()]);
      encodeGuardOpen = false;
    },

    /** [v2.0] 自定义 submit 流程完成后调用:重置 encode-once-per-submit 检测 */
    endSubmit(): void {
      encodeGuardOpen = false;
    },

    /** 高级:解除 encode-once-per-submit 检测(自行承担 uniform 覆盖语义) */
    resetEncodeGuard(): void {
      encodeGuardArmed = false;
    },

    destroy(): void {
      pipelinePromise = null;
      bindGroupCache.clear();
      uniformBuffer?.destroy();
      uniformBuffer = null;
      encodeGuardOpen = false;
    },
  };
}
