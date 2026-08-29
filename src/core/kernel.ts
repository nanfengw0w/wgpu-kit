import { planUniform, packUniform, TYPES, type ScalarKind, type UniformLayout } from './layout.ts';
import { GpuContext } from './context.ts';
import { Buffer } from './buffer.ts';
import { CompileError, UsageError } from './errors.ts';

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
  run(resources: Record<string, Buffer>, uniforms?: Record<string, number>): Promise<void>;
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
    throw new UsageError(`workgroupSize 必须在 1..512,收到: ${String(workgroupSize)}`);
  }
  const state = Object.entries(spec.state ?? {});
  const inputs = Object.entries(spec.inputs ?? {});
  const uniforms = Object.entries(spec.uniforms ?? {});
  if (state.length + inputs.length === 0) {
    throw new UsageError(`elementKernel "${name}" 至少需要一个 state 或 inputs 字段`);
  }
  for (const [uName] of uniforms) {
    if (RESERVED.has(uName)) throw new UsageError(`uniform 名 "${uName}" 是保留名(count 由库自动注入)`);
  }
  const seen = new Set([...state, ...inputs, ...uniforms].map(([n]) => n));
  if (seen.size !== state.length + inputs.length + uniforms.length) {
    throw new UsageError(`elementKernel "${name}" 的 state/inputs/uniforms 存在重名字段`);
  }
  if (typeof spec.code !== 'string' || spec.code.trim().length === 0) {
    throw new UsageError(`elementKernel "${name}" 缺少 code(用户 WGSL 函数)`);
  }

  const uniformEntries: Array<readonly [string, ScalarKind]> = [...uniforms, ['count', 'u32']];
  const uniformLayout = planUniform(uniformEntries);

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
    normalized: { name, workgroupSize, state, inputs, uniforms, code: spec.code },
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

  let pipelinePromise: Promise<GPUComputePipeline> | null = null;
  const bindGroupCache = new Map<string, GPUBindGroup>();
  let uniformBuffer: GPUBuffer | null = null;

  const compilePipeline = async (): Promise<GPUComputePipeline> => {
    const ctx = await GpuContext.get();
    const device = ctx.device;
    const module = device.createShaderModule({ code: source, label: normalized.name });
    // 捕获编译错误并映射行号
    const info = await module.getCompilationInfo();
    const errors = info.messages.filter((m) => m.type === 'error');
    if (errors.length > 0) {
      throw new CompileError(
        normalized.name,
        errors.map((m) => ({ line: m.lineNum, msg: m.message })),
        userCodeLineOffset,
      );
    }
    return device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: 'main' } });
  };

  async function getPipeline(): Promise<GPUComputePipeline> {
    if (!pipelinePromise) {
      pipelinePromise = compilePipeline().catch((e) => { pipelinePromise = null; throw e; });
    }
    return pipelinePromise;
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
      source = regen.source;
      userCodeLineOffset = regen.userCodeLineOffset;
      try {
        const p = await compilePipeline();
        pipelinePromise = Promise.resolve(p);
        bindGroupCache.clear();
      } catch (e) {
        source = savedSource;
        userCodeLineOffset = savedOffset;
        throw e;
      }
    },

    async run(resources: Record<string, Buffer>, uniforms: Record<string, number> = {}): Promise<void> {
      const ctx = await GpuContext.get();
      const device = ctx.device;
      const pipeline = await getPipeline();

      // —— 资源校验 ——
      const ordered: Array<{ key: string; buffer: Buffer }> = [];
      for (const [key] of [...normalized.state, ...normalized.inputs]) {
        const buf = resources[key];
        if (!buf) throw new UsageError(`kernel "${normalized.name}".run 缺少资源 "${key}"`);
        const want = [...normalized.state, ...normalized.inputs].find(([n]) => n === key)?.[1];
        if (buf.kind !== want) {
          throw new UsageError(`资源 "${key}" 类型不匹配: 需要 ${want},收到 ${buf.kind}`);
        }
        ordered.push({ key, buffer: buf });
      }
      const count = ordered[0]?.buffer.length ?? 0;
      for (const { key, buffer } of ordered) {
        if (buffer.length !== count) {
          throw new UsageError(`资源 "${key}" 长度 ${buffer.length} 与 "${ordered[0]!.key}" 的 ${count} 不一致`);
        }
      }

      // —— uniform 打包上传 ——
      const uBytes = packUniform(uniformLayout, { ...uniforms, count });
      if (!uniformBuffer) {
        uniformBuffer = device.createBuffer({
          size: uniformLayout.size,
          usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
          label: uniformBufferName,
        });
      }
      device.queue.writeBuffer(uniformBuffer, 0, uBytes);

      // —— bind group(按 buffer 身份缓存) ——
      const cacheKey = ordered.map(({ key, buffer }) => `${key}:${bufId(buffer.gpuBuffer)}`).join('|');
      let bg = bindGroupCache.get(cacheKey);
      if (!bg) {
        const entries: GPUBindGroupEntry[] = [{ binding: 0, resource: { buffer: uniformBuffer } }];
        ordered.forEach(({ buffer }, i) => entries.push({ binding: i + 1, resource: { buffer: buffer.gpuBuffer } }));
        bg = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries });
        bindGroupCache.set(cacheKey, bg);
      }

      // —— 编码提交 ——
      const enc = device.createCommandEncoder();
      const pass = enc.beginComputePass();
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, bg);
      pass.dispatchWorkgroups(Math.ceil(count / normalized.workgroupSize));
      pass.end();
      device.queue.submit([enc.finish()]);
    },

    destroy(): void {
      pipelinePromise = null;
      bindGroupCache.clear();
      uniformBuffer?.destroy();
      uniformBuffer = null;
    },
  };
}
