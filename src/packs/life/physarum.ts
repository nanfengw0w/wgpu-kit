import { GpuContext } from '../../core/context.ts';
import { Buffer } from '../../core/buffer.ts';
import { PingPong } from '../../core/pingpong.ts';
import { CompileError } from '../../core/errors.ts';
import { MapRenderer } from './map.ts';
import { mulberry32 } from '../particles/presets.ts';

/**
 * 粘菌(Physarum):每个智能体三触须感知信息素、转向、前进、沉积;
 * 信息素每帧扩散+衰减。没有任何"网络"的设定,河流/菌丝网络自会长出来。
 */
export interface PhysarumConfig {
  /** 智能体数,默认 100,000 */
  agents?: number;
  /** 信息素图边长(正方形),默认 1024 */
  mapSize?: number;
  sensorAngle?: number;   // 触须张角(弧度),默认 0.5
  sensorDist?: number;    // 感知距离(世界单位),默认 0.012
  turnAngle?: number;     // 每帧最大转向,默认 0.45
  step?: number;          // 每帧移动距离,默认 0.003
  decay?: number;         // 每帧衰减比例 0..1,默认 0.06
  seed?: string | number;
  colormap?: 'amber' | 'ice' | 'duotone' | 'mono';
}

export interface PhysarumSim {
  attach(canvas: HTMLCanvasElement): Promise<void>;
  tick(): void;
  stats(): { fps: number };
  /** 读回信息素图(验证用;1M 纹素,别每帧调) */
  sampleTrail(): Promise<Float32Array>;
  destroy(): void;
}

const AWG = 32; // count(u32) pad(u32) + sensorAngle, sensorDist, turnAngle, step, deposit, worldHalf (f32×6) = 32

export async function physarum(config: PhysarumConfig = {}): Promise<PhysarumSim> {
  const {
    agents: N = 100_000,
    mapSize = 1024,
    sensorAngle = 0.5,
    sensorDist = 0.012,
    turnAngle = 0.45,
    step = 0.003,
    decay = 0.06,
    seed = 'physarum',
    colormap = 'amber',
  } = config;
  const seedHash = typeof seed === 'string' ? hashStr(seed) : (seed ?? 7);

  const ctx = await GpuContext.get();
  const device = ctx.device;

  // —— 智能体:中心圆盘出发,朝外 ——
  const posBuf = await Buffer.create('vec2f', N);
  const angBuf = await Buffer.create('f32', N);
  {
    const rand = mulberry32(seedHash);
    const p = new Float32Array(N * 2);
    const a = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      const t = rand() * Math.PI * 2;
      const r = Math.sqrt(rand()) * 0.08;
      p[i * 2] = Math.cos(t) * r;
      p[i * 2 + 1] = Math.sin(t) * r;
      a[i] = t;
    }
    posBuf.write(p);
    angBuf.write(a);
  }

  // —— 信息素图(双缓冲) ——
  const trail = await PingPong.create({ t: 'f32' } as const, mapSize * mapSize);
  const trailA = trail.current.t;
  const trailB = trail.other.t;

  const uniform = device.createBuffer({ size: AWG, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const writeUniform = () => {
    const buf = new ArrayBuffer(AWG);
    const v = new DataView(buf);
    v.setUint32(0, N, true);
    v.setUint32(4, 0, true);
    v.setFloat32(8, sensorAngle, true);
    v.setFloat32(12, sensorDist, true);
    v.setFloat32(16, turnAngle, true);
    v.setFloat32(20, step, true);
    v.setFloat32(24, 1.0, true);        // deposit
    v.setFloat32(28, 1.0, true);        // worldHalf
    device.queue.writeBuffer(uniform, 0, buf);
  };
  writeUniform();

  const diffuseUniform = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  device.queue.writeBuffer(diffuseUniform, 0, new Uint32Array([mapSize, mapSize]));
  // decay 写进 diffuse kernel 的第二个 uniform?并成 16B:w,h,decayFrac,pad
  device.queue.writeBuffer(diffuseUniform, 8, new Float32Array([1 - decay, 0]));

  const compile = async (code: string, label: string) => {
    const m = device.createShaderModule({ code, label });
    const info = await m.getCompilationInfo();
    const errors = info.messages.filter((x) => x.type === 'error');
    if (errors.length > 0) throw new CompileError(label, errors.map((x) => ({ line: x.lineNum, msg: x.message })), 0);
    return m;
  };

  const mAgent = await compile(agentWgsl(mapSize), 'physarum-agent');
  const mDiffuse = await compile(diffuseWgsl(), 'physarum-diffuse');
  const pAgent = device.createComputePipeline({ layout: 'auto', compute: { module: mAgent, entryPoint: 'main' } });
  const pDiffuse = device.createComputePipeline({ layout: 'auto', compute: { module: mDiffuse, entryPoint: 'main' } });

  const bgAgent = (t: Buffer) => device.createBindGroup({
    layout: pAgent.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: uniform } },
      { binding: 1, resource: { buffer: posBuf.gpuBuffer } },
      { binding: 2, resource: { buffer: angBuf.gpuBuffer } },
      { binding: 3, resource: { buffer: t.gpuBuffer } },
    ],
  });
  const bgDiffuse = (read: Buffer, write: Buffer) => device.createBindGroup({
    layout: pDiffuse.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: diffuseUniform } },
      { binding: 1, resource: { buffer: read.gpuBuffer } },
      { binding: 2, resource: { buffer: write.gpuBuffer } },
    ],
  });

  let renderer: MapRenderer | null = null;
  let frame = 0;
  let lastFps = 0; let fFrames = 0; let fAcc = 0; let fLast = performance.now();

  return {
    async attach(canvas) {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.max(1, Math.floor(canvas.clientWidth * dpr));
      canvas.height = Math.max(1, Math.floor(canvas.clientHeight * dpr));
      renderer = await MapRenderer.create(canvas, { width: mapSize, height: mapSize, maxV: 6.0, gamma: 0.6, colormap });
    },

    tick() {
      const readT = trail.current.t;
      const writeT = trail.other.t;
      const enc = device.createCommandEncoder();
      const pass = enc.beginComputePass();
      // 智能体:感知/转向/移动/沉积(在当前 trail 上就地沉积)
      pass.setPipeline(pAgent);
      pass.setBindGroup(0, bgAgent(readT));
      pass.dispatchWorkgroups(Math.ceil(N / 64));
      // 扩散 + 衰减 → 另一侧
      pass.setPipeline(pDiffuse);
      pass.setBindGroup(0, bgDiffuse(readT, writeT));
      pass.dispatchWorkgroups(Math.ceil((mapSize * mapSize) / 64));
      pass.end();
      device.queue.submit([enc.finish()]);
      renderer?.render(writeT);
      trail.swap();
      frame++;
      fFrames++;
      const now = performance.now();
      fAcc += now - fLast; fLast = now;
      if (fAcc >= 500) { lastFps = fFrames / (fAcc / 1000); fFrames = 0; fAcc = 0; }
    },

    stats() { return { fps: lastFps }; },

    async sampleTrail() {
      return (await trail.current.t.read()) as Float32Array;
    },

    destroy() {
      posBuf.destroy(); angBuf.destroy(); trail.destroy();
      uniform.destroy(); diffuseUniform.destroy();
    },
  };
}

function agentWgsl(trailW: number): string {
  return /* wgsl */ `
const TRAIL_W: u32 = ${trailW}u;
const TRAIL_MASK: u32 = ${trailW - 1}u;
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
`;
}

function diffuseWgsl(): string {
  return /* wgsl */ `
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
`;
}

function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
