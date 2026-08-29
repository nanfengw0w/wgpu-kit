import { GpuContext } from '../../core/context.ts';
import { Buffer } from '../../core/buffer.ts';
import { PingPong } from '../../core/pingpong.ts';
import { CompileError } from '../../core/errors.ts';
import { MapRenderer, type Colormap } from '../life/map.ts';
import { mulberry32 } from '../particles/presets.ts';

/**
 * fields 包:向量场平迹(flow)。粒子被解析向量场平流,沉积到带衰减的信息素图上,
 * 流线自会浮现——数据可视化里"风场/流场"的标准画法。
 * 复用 life/physarum 的沉积-扩散-上屏管线,把"三触须感知"换成"场采样"。
 */
export type FieldKind = 'vortex' | 'curl' | 'twin';

export interface FlowConfig {
  count?: number;          // 平流粒子,默认 131,072
  mapSize?: number;        // 信息素图边长,默认 1024
  field?: FieldKind;
  speed?: number;          // 每帧移动距离,默认 0.004
  decay?: number;          // 每帧衰减 0..1,默认 0.045
  deposit?: number;        // 默认 1.0
  seed?: string | number;
  colormap?: Colormap;
}

export interface FlowSim {
  attach(canvas: HTMLCanvasElement): Promise<void>;
  tick(): void;
  stats(): { fps: number };
  sampleTrail(): Promise<Float32Array>;
  destroy(): void;
}

const FIELD_FNS: Record<FieldKind, string> = {
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
}`,
};

const AWG = 32;

export async function flow(config: FlowConfig = {}): Promise<FlowSim> {
  const {
    count: N = 131_072, mapSize = 1024, field = 'curl',
    speed = 0.004, decay = 0.045, deposit = 1.0,
    seed = 'flow', colormap = 'ice',
  } = config;
  const seedHash = typeof seed === 'string' ? hashStr(seed) : (seed ?? 11);

  const ctx = await GpuContext.get();
  const device = ctx.device;

  const posBuf = await Buffer.create('vec2f', N);
  {
    const rand = mulberry32(seedHash);
    const p = new Float32Array(N * 2);
    for (let i = 0; i < N; i++) { p[i * 2] = rand() * 1.8 - 0.9; p[i * 2 + 1] = rand() * 1.8 - 0.9; }
    posBuf.write(p);
  }

  const trail = await PingPong.create({ t: 'f32' } as const, mapSize * mapSize);
  const trailA = trail.current.t;
  const trailB = trail.other.t;

  const uniform = device.createBuffer({ size: AWG, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  // 持久参数对象:每次全量写入(首版只写部分字段,未写字段被清零 → deposit=0 的教训)
  const u = { count: N, pad: 0, speed, worldHalf: 1.0, deposit, time: 0, p0: 0, p1: 0 };
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

  const compile = async (code: string, label: string) => {
    const m = device.createShaderModule({ code, label });
    const info = await m.getCompilationInfo();
    const errors = info.messages.filter((x) => x.type === 'error');
    if (errors.length > 0) throw new CompileError(label, errors.map((x) => ({ line: x.lineNum, msg: x.message })), 0);
    return m;
  };

  const mAdvect = await compile(advectWgsl(FIELD_FNS[field], mapSize), `fields-advect(${field})`);
  const mDiffuse = await compile(diffuseWgsl(), 'fields-diffuse');
  const pAdvect = device.createComputePipeline({ layout: 'auto', compute: { module: mAdvect, entryPoint: 'main' } });
  const pDiffuse = device.createComputePipeline({ layout: 'auto', compute: { module: mDiffuse, entryPoint: 'main' } });

  const bgAdvect = (t: Buffer) => device.createBindGroup({
    layout: pAdvect.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: uniform } },
      { binding: 1, resource: { buffer: posBuf.gpuBuffer } },
      { binding: 2, resource: { buffer: t.gpuBuffer } },
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
  let time = 0;
  let lastFps = 0; let fFrames = 0; let fAcc = 0; let fLast = performance.now();

  return {
    async attach(canvas) {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.max(1, Math.floor(canvas.clientWidth * dpr));
      canvas.height = Math.max(1, Math.floor(canvas.clientHeight * dpr));
      renderer = await MapRenderer.create(canvas, { width: mapSize, height: mapSize, maxV: 5.0, gamma: 0.65, colormap });
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
    async sampleTrail() { return (await trail.current.t.read()) as Float32Array; },

    destroy() {
      posBuf.destroy(); trail.destroy(); uniform.destroy(); diffuseUniform.destroy();
    },
  };
}

function advectWgsl(fieldFn: string, mapSize: number): string {
  return /* wgsl */ `
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
    // 出界重生:随机撒回(确定性 hash,免额外随机源)
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
`;
}

function diffuseWgsl(): string {
  return /* wgsl */ `
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
`;
}

function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
