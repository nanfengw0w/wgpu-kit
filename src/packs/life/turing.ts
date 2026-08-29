import { GpuContext } from '../../core/context.ts';
import { Buffer } from '../../core/buffer.ts';
import { PingPong } from '../../core/pingpong.ts';
import { CompileError } from '../../core/errors.ts';
import { MapRenderer } from './map.ts';
import { mulberry32 } from '../particles/presets.ts';

/**
 * 图灵斑图(Gray-Scott 反应扩散):两种化学物质的反应 + 扩散,
 * 自发长出珊瑚/细胞/斑纹——"复杂来自简单规则"的教科书案例。
 * state 每纹素 vec2f(A, B);每帧多个迭代步让花纹快速演化。
 */
export interface TuringConfig {
  /** 网格宽高(正方形),默认 512 */
  size?: number;
  /** 预设参数:coral 珊瑚 / mitosis 分裂 / spots 斑点 / waves 波纹 / custom */
  preset?: TuringPreset;
  /** 自定义 feed(0.01..0.08),preset 为 custom 时生效 */
  feed?: number;
  /** 自定义 kill(0.03..0.07) */
  kill?: number;
  /** 每帧迭代步数,默认 12 */
  steps?: number;
  seed?: string | number;
  colormap?: 'duotone' | 'amber' | 'ice' | 'mono';
}

export type TuringPreset = 'coral' | 'mitosis' | 'spots' | 'waves' | 'custom';

const PRESETS: Record<Exclude<TuringPreset, 'custom'>, { f: number; k: number }> = {
  coral: { f: 0.0545, k: 0.062 },
  mitosis: { f: 0.0367, k: 0.0649 },
  spots: { f: 0.03, k: 0.062 },
  waves: { f: 0.014, k: 0.045 },
};

export interface TuringSim {
  readonly config: { size: number; preset: TuringPreset; feed: number; kill: number; steps: number };
  attach(canvas: HTMLCanvasElement): Promise<void>;
  tick(): void;
  /** 喂入扰动:在随机位置撒一把 B(交互/救场用) */
  sprinkle(count?: number): void;
  stats(): { fps: number };
  /** 读回 B 通道缩略采样(验证/分析用) */
  sampleB(): Promise<Float32Array>;
  destroy(): void;
}

const USIZE = 32; // w,h (u32×2) + f,k,dA,dB,dt (f32×5) = 28 → 32

export async function turing(config: TuringConfig = {}): Promise<TuringSim> {
  const size = config.size ?? 512;
  const preset = config.preset ?? 'coral';
  const p = preset === 'custom' ? { f: config.feed ?? 0.037, k: config.kill ?? 0.06 } : PRESETS[preset];
  const steps = config.steps ?? 12;
  const seedHash = typeof config.seed === 'string' ? hashStr(config.seed) : (config.seed ?? 42);
  const colormap = config.colormap ?? 'duotone';

  const ctx = await GpuContext.get();
  const device = ctx.device;

  const state = await PingPong.create({ st: 'vec2f' } as const, size * size);
  const sideA = state.current.st;
  const sideB = state.other.st;

  // 初始化:A=1,B 在随机小方块里 =1
  {
    const rand = mulberry32(seedHash);
    const init = new Float32Array(size * size * 2);
    for (let i = 0; i < size * size; i++) init[i * 2] = 1;
    for (let s = 0; s < 10; s++) {
      const cx = 40 + Math.floor(rand() * (size - 80));
      const cy = 40 + Math.floor(rand() * (size - 80));
      const r = 3 + Math.floor(rand() * 6);
      for (let y = cy - r; y <= cy + r; y++) {
        for (let x = cx - r; x <= cx + r; x++) {
          const idx = ((y + size) % size) * size + ((x + size) % size);
          init[idx * 2] = 0.5; init[idx * 2 + 1] = 0.25;
        }
      }
    }
    sideA.write(init);
  }

  const uniform = device.createBuffer({ size: USIZE, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const params = { f: p.f, k: p.k, dA: 1.0, dB: 0.5, dt: 1.0 };
  const writeUniform = () => {
    const buf = new ArrayBuffer(USIZE);
    const v = new DataView(buf);
    v.setUint32(0, size, true);
    v.setUint32(4, size, true);
    v.setFloat32(8, params.f, true);
    v.setFloat32(12, params.k, true);
    v.setFloat32(16, params.dA, true);
    v.setFloat32(20, params.dB, true);
    v.setFloat32(24, params.dt, true);
    device.queue.writeBuffer(uniform, 0, buf);
  };
  writeUniform();

  const module = device.createShaderModule({ code: updateWgsl(), label: 'turing-update' });
  const info = await module.getCompilationInfo();
  const errors = info.messages.filter((m) => m.type === 'error');
  if (errors.length > 0) throw new CompileError('turing-update', errors.map((m) => ({ line: m.lineNum, msg: m.message })), 0);
  const pipeline = device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: 'main' } });

  const bg = (read: Buffer, write: Buffer) => device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: uniform } },
      { binding: 1, resource: { buffer: read.gpuBuffer } },
      { binding: 2, resource: { buffer: write.gpuBuffer } },
    ],
  });
  const bgAB = bg(sideA, sideB);
  const bgBA = bg(sideB, sideA);

  let renderer: MapRenderer | null = null;
  let frame = 0;
  let lastFps = 0; let fFrames = 0; let fAcc = 0; let fLast = performance.now();

  return {
    config: { size, preset, feed: params.f, kill: params.k, steps },

    async attach(canvas) {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.max(1, Math.floor(canvas.clientWidth * dpr));
      canvas.height = Math.max(1, Math.floor(canvas.clientHeight * dpr));
      renderer = await MapRenderer.create(canvas, { width: size, height: size, maxV: 0.9, gamma: 0.85, colormap });
    },

    tick() {
      const base = frame * steps; // 全局迭代序号决定数据在哪一侧(奇偶必须跨帧连续)
      const enc = device.createCommandEncoder();
      const pass = enc.beginComputePass();
      pass.setPipeline(pipeline);
      for (let s = 0; s < steps; s++) {
        pass.setBindGroup(0, (base + s) % 2 === 0 ? bgAB : bgBA);
        pass.dispatchWorkgroups(Math.ceil((size * size) / 64));
      }
      pass.end();
      device.queue.submit([enc.finish()]);
      // 渲染最后一步写入的一侧
      renderer?.render((base + steps - 1) % 2 === 0 ? sideB : sideA);
      for (let s = 0; s < steps; s++) state.swap();
      frame++;
      fFrames++;
      const now = performance.now();
      fAcc += now - fLast; fLast = now;
      if (fAcc >= 500) { lastFps = fFrames / (fAcc / 1000); fFrames = 0; fAcc = 0; }
    },

    sprinkle(count = 6) {
      const rand = mulberry32((seedHash + frame) >>> 0);
      const patch = new Float32Array(size * size * 2);
      for (let s = 0; s < count; s++) {
        const cx = Math.floor(rand() * size);
        const cy = Math.floor(rand() * size);
        const r = 2 + Math.floor(rand() * 5);
        for (let y = cy - r; y <= cy + r; y++) {
          for (let x = cx - r; x <= cx + r; x++) {
            const idx = ((y + size) % size) * size + ((x + size) % size);
            patch[idx * 2] = 0.5; patch[idx * 2 + 1] = 0.25;
          }
        }
      }
      device.queue.writeBuffer(state.current.st.gpuBuffer, 0, patch);
    },

    stats() { return { fps: lastFps }; },

    async sampleB() {
      const data = (await state.current.st.read()) as Float32Array;
      const out = new Float32Array(size * size);
      for (let i = 0; i < out.length; i++) out[i] = data[i * 2 + 1] ?? 0;
      return out;
    },

    destroy() {
      state.destroy();
      uniform.destroy();
    },
  };
}

function updateWgsl(): string {
  return /* wgsl */ `
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
`;
}

function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
