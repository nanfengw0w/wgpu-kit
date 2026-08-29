import { GpuContext } from '../../core/context.ts';
import { Buffer } from '../../core/buffer.ts';
import { PingPong } from '../../core/pingpong.ts';
import { CompileError } from '../../core/errors.ts';

/**
 * 软体触手:Verlet 链。锚点沿利萨茹轨迹游动,链身靠"跟随约束"松弛,
 * 重力 + 阻尼让触手甩出水母般的漂移感。
 * 约束求解必须 ping-pong(读一侧写另一侧):原地读写会让相邻节点的
 * 数据竞争沿链传播,实测残差放大 10 倍以上——这是本模拟的核心教训。
 */
export interface TentaclesConfig {
  chains?: number;      // 触手数,默认 48
  segments?: number;    // 每条节数,默认 64
  segLen?: number;      // 节间距,默认 0.018
  gravity?: number;     // 默认 0.00035
  damping?: number;     // 速度保留率,默认 0.985
  iterations?: number;  // 每帧约束松弛次数(偶数效果稳),默认 10
  thickness?: number;   // 点尺寸基数,默认 0.006
  colorCycle?: number;  // 色相循环速度,默认 0.35
}

export interface TentaclesSim {
  attach(canvas: HTMLCanvasElement): Promise<void>;
  tick(): void;
  stats(): { fps: number };
  buffers(): { pos: Buffer };
  destroy(): void;
}

const USIZE = 32;

export async function tentacles(config: TentaclesConfig = {}): Promise<TentaclesSim> {
  const {
    chains = 48, segments = 64, segLen = 0.018, gravity = 0.00035,
    damping = 0.985, iterations = 10, thickness = 0.006, colorCycle = 0.35,
  } = config;
  const N = chains * segments;

  const ctx = await GpuContext.get();
  const device = ctx.device;

  const pp = await PingPong.create({ pos: 'vec2f' } as const, N);
  const prev = await Buffer.create('vec2f', N);
  {
    const p = new Float32Array(N * 2);
    pp.current.pos.write(p);
    prev.write(p);
  }

  const uniform = device.createBuffer({ size: USIZE, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  let time = 0;
  const writeUniform = () => {
    const b = new ArrayBuffer(USIZE);
    const v = new DataView(b);
    v.setUint32(0, N, true);
    v.setUint32(4, segments, true);
    v.setFloat32(8, segLen, true);
    v.setFloat32(12, gravity, true);
    v.setFloat32(16, damping, true);
    v.setFloat32(20, time, true);
    v.setFloat32(24, 0.45, true); // anchorR
    v.setUint32(28, iterations, true);
    device.queue.writeBuffer(uniform, 0, b);
  };

  const module = device.createShaderModule({ code: tentaclesWgsl(thickness, colorCycle), label: 'tentacles' });
  const info = await module.getCompilationInfo();
  const errors = info.messages.filter((m) => m.type === 'error');
  if (errors.length > 0) throw new CompileError('tentacles', errors.map((m) => ({ line: m.lineNum, msg: m.message })), 0);

  const pIntegrate = device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: 'main_integrate' } });
  const pConstraint = device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: 'main_constraint' } });
  const pRender = device.createRenderPipeline({
    layout: 'auto',
    vertex: { module, entryPoint: 'vs' },
    fragment: { module, entryPoint: 'fs', targets: [{ format: navigator.gpu.getPreferredCanvasFormat() }] },
    primitive: { topology: 'triangle-list' },
  });

  const bgIntegrate = (read: Buffer, write: Buffer) => device.createBindGroup({
    layout: pIntegrate.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: uniform } },
      { binding: 1, resource: { buffer: read.gpuBuffer } },
      { binding: 2, resource: { buffer: prev.gpuBuffer } },
      { binding: 3, resource: { buffer: write.gpuBuffer } },
    ],
  });
  const bgConstraint = (read: Buffer, write: Buffer) => device.createBindGroup({
    layout: pConstraint.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: uniform } },
      { binding: 1, resource: { buffer: read.gpuBuffer } },
      { binding: 2, resource: { buffer: write.gpuBuffer } },
    ],
  });
  const bgRenderCache = new Map<number, GPUBindGroup>();
  const ids = new WeakMap<GPUBuffer, number>();
  const bgRender = (pos: Buffer) => {
    let id = ids.get(pos.gpuBuffer);
    if (id === undefined) { id = bgRenderCache.size + 1; ids.set(pos.gpuBuffer, id); }
    let bg = bgRenderCache.get(id);
    if (!bg) {
      bg = device.createBindGroup({
        layout: pRender.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: uniform } },
          { binding: 1, resource: { buffer: pos.gpuBuffer } },
        ],
      });
      bgRenderCache.set(id, bg);
    }
    return bg;
  };

  let gpuCtx: GPUCanvasContext | null = null;
  let frame = 0;
  let lastFps = 0; let fFrames = 0; let fAcc = 0; let fLast = performance.now();

  return {
    async attach(canvas) {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.max(1, Math.floor(canvas.clientWidth * dpr));
      canvas.height = Math.max(1, Math.floor(canvas.clientHeight * dpr));
      const c = canvas.getContext('webgpu');
      if (!c) throw new Error('canvas.getContext("webgpu") 返回空');
      c.configure({ device, format: navigator.gpu.getPreferredCanvasFormat(), alphaMode: 'opaque' });
      gpuCtx = c;
    },

    tick() {
      time += 1 / 60;
      writeUniform();
      // 积分:读 current 写 other,swap 后 current = 最新
      const enc = device.createCommandEncoder();
      const pass = enc.beginComputePass();
      pass.setPipeline(pIntegrate);
      pass.setBindGroup(0, bgIntegrate(pp.current.pos, pp.other.pos));
      pass.dispatchWorkgroups(Math.ceil(N / 64));
      pass.end();
      device.queue.submit([enc.finish()]);
      pp.swap();

      // 约束:每轮 ping-pong,杜绝同 dispatch 内相邻节点竞态
      const enc2 = device.createCommandEncoder();
      const pass2 = enc2.beginComputePass();
      pass2.setPipeline(pConstraint);
      for (let r = 0; r < iterations; r++) {
        pass2.setBindGroup(0, bgConstraint(pp.current.pos, pp.other.pos));
        pass2.dispatchWorkgroups(Math.ceil(N / 64));
        pp.swap();
      }
      pass2.end();
      device.queue.submit([enc2.finish()]);

      if (gpuCtx) {
        const re = device.createCommandEncoder();
        const rp = re.beginRenderPass({
          colorAttachments: [{
            view: gpuCtx.getCurrentTexture().createView(),
            clearValue: { r: 0.012, g: 0.016, b: 0.03, a: 1 },
            loadOp: 'clear', storeOp: 'store',
          }],
        });
        rp.setPipeline(pRender);
        rp.setBindGroup(0, bgRender(pp.current.pos));
        rp.draw(6, N);
        rp.end();
        device.queue.submit([re.finish()]);
      }
      frame++;
      fFrames++;
      const now = performance.now();
      fAcc += now - fLast; fLast = now;
      if (fAcc >= 500) { lastFps = fFrames / (fAcc / 1000); fFrames = 0; fAcc = 0; }
    },

    stats() { return { fps: lastFps }; },
    buffers() { return { pos: pp.current.pos }; },

    destroy() {
      pp.destroy(); prev.destroy(); uniform.destroy();
    },
  };
}

function tentaclesWgsl(thickness: number, colorCycle: number): string {
  return /* wgsl */ `
struct Params {
  count: u32, segments: u32,
  segLen: f32, gravity: f32, damping: f32, time: f32,
  anchorR: f32, iterations: u32,
};
@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> posIn: array<vec2f>;
@group(0) @binding(2) var<storage, read_write> posOut: array<vec2f>;
@group(0) @binding(3) var<storage, read_write> prev: array<vec2f>;

fn anchorPos(chain: u32, t: f32) -> vec2f {
  let phase = f32(chain) * 2.399963; // 黄金角:链与链永不重叠排布
  let x = cos(t * 0.7 + phase) * params.anchorR;
  let y = sin(t * 1.13 + phase * 1.7) * params.anchorR * 0.55;
  return vec2f(x, y);
}

@compute @workgroup_size(64)
fn main_integrate(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= params.count) { return; }
  let segs = params.segments;
  let k = i % segs;
  let chain = i / segs;
  if (k == 0u) {
    let anchor = anchorPos(chain, params.time);
    posOut[i] = anchor;
    prev[i] = anchor;
    return;
  }
  let vel = (posIn[i] - prev[i]) * params.damping;
  prev[i] = posIn[i];
  posOut[i] = posIn[i] + vel + vec2f(0.0, -params.gravity);
}

// 跟随约束:读 posIn 写 posOut(单线程单数据,零竞态)
@compute @workgroup_size(64)
fn main_constraint(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= params.count) { return; }
  let segs = params.segments;
  let k = i % segs;
  if (k == 0u) { posOut[i] = posIn[i]; return; }
  let d = posIn[i] - posIn[i - 1u];
  let l = length(d) + 1e-6;
  posOut[i] = posIn[i - 1u] + d / l * params.segLen;
}

struct VsOut {
  @builtin(position) clip: vec4f,
  @location(0) color: vec3f,
};
@group(0) @binding(0) var<uniform> vp: Params;
@group(0) @binding(1) var<storage, read> posR: array<vec2f>;

@vertex
fn vs(@builtin(vertex_index) v: u32, @builtin(instance_index) inst: u32) -> VsOut {
  let segs = vp.segments;
  let k = inst % segs;
  let chain = inst / segs;
  let taper = 1.0 - f32(k) / f32(segs);
  let r = ${(thickness * 1.1).toFixed(5)} * (0.25 + 0.75 * taper);
  var corner = array<vec2f, 6>(
    vec2f(-r, -r), vec2f(r, -r), vec2f(-r, r),
    vec2f(-r, r), vec2f(r, -r), vec2f(r, r)
  );
  var out: VsOut;
  out.clip = vec4f(posR[inst] + corner[v], 0.0, 1.0);
  out.color = 0.5 + 0.5 * cos(f32(chain) * ${colorCycle.toFixed(3)} + vec3f(0.0, 2.1, 4.2)) * (0.4 + 0.6 * taper);
  return out;
}

@fragment
fn fs(in: VsOut) -> @location(0) vec4f {
  return vec4f(in.color, 1.0);
}
`;
}
