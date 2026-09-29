import { planUniform, packUniformInto, TYPES, type ScalarKind, type UniformLayout, type UniformValue } from './layout.ts';
import { GpuContext } from './context.ts';
import { Buffer } from './buffer.ts';
import { CompileError, ERR, UsageError } from './errors.ts';
import { createShaderModuleChecked } from './shader.ts';

/**
 * elementKernel —— wgpu-kit 的心脏。
 *
 * 用户只写"单个元素怎么变"的 WGSL 函数(第一个参数固定为 idx: u32,
 * 之后按 uniforms 声明顺序接收 uniform 标量),库生成全部仪式:
 * uniform struct + 对齐打包、storage 绑定、count 越界保护、
 * workgroup/dispatch、bind group 缓存、编译错误行号映射回用户代码。
 */
export interface ElementKernelSpec {
  /** 调试名,错误信息里出现 */
  name?: string;
  /** 读写字段(就地修改),如 { pos: 'vec2f' } */
  state?: Record<string, ScalarKind>;
  /** 只读字段,如 { vel: 'vec2f' } */
  inputs?: Record<string, ScalarKind>;
  /** uniform 标量(不允许叫 count,count 由库自动注入) */
  uniforms?: Record<string, ScalarKind>;
  /** workgroup 大小,默认 64 */
  workgroupSize?: number;
  /** 用户函数,如 `fn step(idx: u32, dt: f32) { ... }`(引用字段名直接访问数组) */
  code: string;
}

export interface ElementKernel {
  readonly name: string;
  /** 生成的完整 WGSL(调试/单测用) */
  readonly source: string;
  readonly uniformLayout: UniformLayout;
  readonly workgroupSize: number;
  run(resources: Record<string, Buffer>, uniforms?: Record<string, UniformValue>): Promise<void>;
  /** [v2.0] 异步准备:解析上下文、编译管线、分配内部资源。幂等;encode 前必须完成 */
  prepare(): Promise<void>;
  /** [v2.0] 同步编码:dispatch 写入调用方 encoder(不提交);须先 prepare()。
   *  同一实例在一次提交前只能 encode 一次(共享 uniform 快照语义);
   *  自定义 submit 流程须在提交后调用 endSubmit() 重置检测。 */
  encode(encoder: GPUCommandEncoder, resources: Record<string, Buffer>, uniforms?: Record<string, UniformValue>): void;
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
  const uniforms = Object.entries(spec.uniforms ?? {});
  if (state.length + inputs.length === 0) {
    throw new UsageError(ERR.RESOURCE_MISSING, `elementKernel "${name}" requires at least one state or inputs field`);
  }
  for (const [uName] of uniforms) {
    if (RESERVED.has(uName)) throw new UsageError(ERR.USAGE, `uniform name "${uName}" is reserved (count is auto-injected by the library)`);
  }
  const seen = new Set([...state, ...inputs, ...uniforms].map(([n]) => n));
  if (seen.size !== state.length + inputs.length + uniforms.length) {
    throw new UsageError(ERR.USAGE, `elementKernel "${name}" has duplicate field names across state/inputs/uniforms`);
  }
  if (typeof spec.code !== 'string' || spec.code.trim().length === 0) {
    throw new UsageError(ERR.USAGE, `elementKernel "${name}" is missing code (user WGSL function)`);
  }

  const uniformEntries: Array<readonly [string, ScalarKind]> = [...uniforms, ['count', 'u32']];
  const uniformLayout = planUniform(uniformEntries);

  // —— 静态使用分析:layout:'auto' 的绑定组布局只含入口点**实际引用**的绑定。
  // 声明了但 userFn 没用到的字段若塞进 bind group → 校验错误且被异步吞掉
  // (表现为核不生效)。
  // 提取管线(外部审查两轮修订):
  //   ① 剥注释 —— 注释里提及字段名不构成使用;
  //   ② 剥 struct 声明体 + 成员访问(复审 P1-2)—— `struct Item { ghost: f32 }`
  //      的成员声明和 `item.ghost` 的成员访问都不构成对全局资源 ghost 的使用;
  //   ③ 可达性闭包 —— 定义了但 userFn 不可达的 helper 不算使用;
  //   ④ 词法 token 匹配只在可达体内进行。
  // 诚实边界:函数内 let 局部变量与全局资源同名的遮蔽场景无法词法判定,
  // 需要真 WGSL 解析器(见 schema.ts 的边界声明);此前已知并文档化。
  // params(binding 0)因 params.count 恒被使用。
  const codeNoComments = spec.code
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/.*$/gm, ' ')
    .replace(/struct\s+[A-Za-z_][A-Za-z0-9_]*\s*\{[^}]*\}/g, ' ')
    .replace(/\.\s*[A-Za-z_][A-Za-z0-9_]*/g, ' ');
  // 收集 userFn 可达的函数体(text);无 userFn(坏输入)时退化为全文匹配,
  // 让后续编译错误正常浮出而不是静默误判
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
    normalized: { name, workgroupSize, state, inputs, uniforms, code: spec.code, usedBindings },
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

  // 构造期预展开:稳态 run() 每帧零分配(评审:两次展开 + O(字段²) find + 字符串 key)
  const orderedFields: Array<{ key: string; kind: ScalarKind }> = [
    ...normalized.state.map(([k, t]) => ({ key: k, kind: t })),
    ...normalized.inputs.map(([k, t]) => ({ key: k, kind: t })),
  ];
  const expectedKinds = new Map(orderedFields.map((f) => [f.key, f.kind] as const));
  const sharedPack = new ArrayBuffer(uniformLayout.size); // 复用打包缓冲(writeBuffer 会拷贝)

  let pipelinePromise: Promise<GPUComputePipeline> | null = null;
  let pipeline: GPUComputePipeline | null = null; // resolve 后的同步引用(encode 用)
  let cachedCtx: GpuContext | null = null; // 首帧后缓存为普通引用
  const bindGroupCache = new Map<number, { bg: GPUBindGroup; ids: readonly number[] }>();
  let uniformBuffer: GPUBuffer | null = null;
  // encode-once-per-submit 合同的运行时检测(外部审查 P1-2):默认开启,
  // encode 打开闸、submit 关闭;生产高级用法可 resetEncodeGuard() 解除
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
     * [v2.0] 同步编码:把 dispatch 命令写入调用方的 encoder,不提交。
     * 多个 kernel 可写入同一 encoder 组成计算链,由调用方决定提交时机。
     * 前置条件:prepare() 已完成(否则内部管线/uniform 资源尚未就绪)。
     *
     * 参数快照语义:encode 把 uniform **立即**写入内部 uniform buffer(队列
     * 顺序=调用顺序),本 dispatch 绑定的就是这份快照。因此同一实例在**一次
     * 提交前**只能 encode 一次——连续两次 encode 会把共享 uniform 覆盖成
     * 第二份参数(两个 dispatch 都读到它,外部审查 P1-2)。需要同 kernel 多组
     * 参数时:每组一次 encode+submit,或用多个 elementKernel 实例。
     * 运行时检测:提交间隔内重复 encode 抛 UsageError(生产环境可用
     * resetEncodeGuard() 解除,见下)。
     */
    encode(encoder: GPUCommandEncoder, resources: Record<string, Buffer>, uniforms: Record<string, UniformValue> = {}): void {
      if (!cachedCtx || !pipeline || !uniformBuffer) {
        throw new UsageError(ERR.USAGE, `kernel "${normalized.name}".encode called before prepare() — await kernel.prepare() first`);
      }
      if (encodeGuardArmed && encodeGuardOpen) {
        throw new UsageError(ERR.USAGE, `kernel "${normalized.name}".encode called twice before submit — the shared uniform would be overwritten (encode-once-per-submit contract; see docs). Call submit between encodes, or create one kernel instance per concurrent encode.`);
      }
      const device = cachedCtx.device;

      // —— 资源校验 + 有序收集(预展开清单,稳态零分配) ——
      // 注意顺序(外部审查 P2-1):guard 在校验**之后**才打开——校验抛错时
      // 不锁闸,同一 encoder 上用正确资源重试必须可行
      const ordered: Buffer[] = [];
      let count = -1;
      let firstKey = '';
      for (let i = 0; i < orderedFields.length; i++) {
        const f = orderedFields[i]!;
        const buf = resources[f.key];
        if (!buf) throw new UsageError(ERR.RESOURCE_MISSING, `kernel "${normalized.name}".run is missing resource "${f.key}"`);
        const want = expectedKinds.get(f.key);
        if (buf.kind !== want) {
          throw new UsageError(ERR.RESOURCE_TYPE, `Resource "${f.key}" type mismatch: expected ${want}, got ${buf.kind}`);
        }
        if (count === -1) { count = buf.length; firstKey = f.key; }
        else if (buf.length !== count) {
          throw new UsageError(ERR.RESOURCE_LENGTH, `Resource "${f.key}" length ${buf.length} does not match "${firstKey}" length ${count}`);
        }
        ordered.push(buf);
      }
      if (encodeGuardArmed) encodeGuardOpen = true;

      // —— uniform 打包上传 ——
      packUniformInto(sharedPack, uniformLayout, { ...uniforms, count });
      if (!uniformBuffer) {
        uniformBuffer = device.createBuffer({
          size: uniformLayout.size,
          usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
          label: uniformBufferName,
        });
      }
      device.queue.writeBuffer(uniformBuffer, 0, sharedPack);

      // —— bind group(按 buffer 身份缓存) ——
      let cacheKey = 0;
      for (let i = 0; i < ordered.length; i++) cacheKey = (cacheKey * 31 + bufId(ordered[i]!.gpuBuffer)) | 0;
      const ids = ordered.map((b) => bufId(b.gpuBuffer));
      const cached = bindGroupCache.get(cacheKey);
      const identityMatch = cached && cached.ids.length === ids.length && cached.ids.every((id, idx) => id === ids[idx]);
      let bg = identityMatch ? cached!.bg : undefined;
      if (!bg) {
        // 只绑定入口点静态使用的绑定(layout:'auto' 语义,见生成处的注释)
        const entries: GPUBindGroupEntry[] = [];
        if (normalized.usedBindings.has(0)) entries.push({ binding: 0, resource: { buffer: uniformBuffer } });
        ordered.forEach((buffer, i) => {
          if (normalized.usedBindings.has(i + 1)) entries.push({ binding: i + 1, resource: { buffer: buffer.gpuBuffer } });
        });
        bg = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries });
        bindGroupCache.set(cacheKey, { bg, ids });
      }

      // —— 写入调用方 encoder(不提交) ——
      const pass = encoder.beginComputePass();
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, bg);
      pass.dispatchWorkgroups(Math.ceil(count / normalized.workgroupSize));
      pass.end();
    },

    async run(resources: Record<string, Buffer>, uniforms: Record<string, UniformValue> = {}): Promise<void> {
      await this.prepare();
      const enc = cachedCtx!.device.createCommandEncoder();
      this.encode(enc, resources, uniforms);
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
