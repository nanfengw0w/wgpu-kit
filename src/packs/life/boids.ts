import { GpuContext } from '../../core/context.ts';
import { Buffer } from '../../core/buffer.ts';
import { PingPong } from '../../core/pingpong.ts';
import { CompileError } from '../../core/errors.ts';
import { mulberry32 } from '../particles/presets.ts';

/**
 * Boids 鸟群:分离/对齐/聚集三条规则(Reynolds 1986),十万级个体靠 grid 邻域加速。
 * 渲染为按速度方向旋转的三角,速度映射颜色。
 */
export interface BoidsConfig {
  count?: number;          // 默认 8,192
  perception?: number;     // 感知半径(世界单位),默认 0.05
  maxSpeed?: number;       // 默认 0.03
  wSep?: number;           // 分离权重,默认 1.6
  wAli?: number;           // 对齐权重,默认 1.0
  wCoh?: number;           // 聚集权重,默认 0.8
  size?: number;           // 三角尺寸,默认 0.016
  seed?: string | number;
}

export interface BoidsSim {
  attach(canvas: HTMLCanvasElement): Promise<void>;
  tick(): void;
  stats(): { fps: number };
  buffers(): { pos: Buffer; vel: Buffer };
  destroy(): void;
}

const WG = 64;

export async function boids(config: BoidsConfig = {}): Promise<BoidsSim> {
  const {
    count: N = 3000, perception = 0.05, maxSpeed = 0.012,
    wSep = 1.6, wAli = 1.0, wCoh = 0.8, size = 0.009,
    seed = 'boids',
  } = config;
  const seedHash = typeof seed === 'string' ? hashStr(seed) : (seed ?? 3);
  const gridSize = Math.max(4, Math.ceil(2 / perception));

  const ctx = await GpuContext.get();
  const device = ctx.device;

  const pp = await PingPong.create({ pos: 'vec2f', vel: 'vec2f' } as const, N);
  const sideA = { pos: pp.current.pos, vel: pp.current.vel };
  const sideB = { pos: pp.other.pos, vel: pp.other.vel };
  {
    const rand = mulberry32(seedHash);
    const p = new Float32Array(N * 2);
    const v = new Float32Array(N * 2);
    for (let i = 0; i < N; i++) {
      const t = rand() * Math.PI * 2;
      const r = Math.sqrt(rand()) * 0.6;
      p[i * 2] = Math.cos(t) * r; p[i * 2 + 1] = Math.sin(t) * r;
      const va = rand() * Math.PI * 2;
      v[i * 2] = Math.cos(va) * maxSpeed * 0.6; v[i * 2 + 1] = Math.sin(va) * maxSpeed * 0.6;
    }
    sideA.pos.write(p); sideA.vel.write(v);
  }

  const USIZE = 48;
  const uniform = device.createBuffer({ size: USIZE, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const writeUniform = () => {
    const b = new ArrayBuffer(USIZE);
    const v = new DataView(b);
    v.setUint32(0, N, true);
    v.setUint32(4, gridSize, true);
    v.setFloat32(8, perception, true);
    v.setFloat32(12, maxSpeed, true);
    v.setFloat32(16, wSep, true);
    v.setFloat32(20, wAli, true);
    v.setFloat32(24, wCoh, true);
    v.setFloat32(28, 1 / 60, true); // dt
    v.setFloat32(32, 1.0, true);    // worldHalf
    device.queue.writeBuffer(uniform, 0, b);
  };
  writeUniform();

  const cells = gridSize * gridSize;
  const cellCount = await Buffer.create('u32', cells);
  const cellStart = await Buffer.create('u32', cells);
  const cellFill = await Buffer.create('u32', cells);
  const order = await Buffer.create('u32', N);
  cellCount.write(new Uint32Array(cells));

  const module = device.createShaderModule({ code: boidsWgsl(size), label: 'boids' });
  const info = await module.getCompilationInfo();
  const errors = info.messages.filter((m) => m.type === 'error');
  if (errors.length > 0) throw new CompileError('boids', errors.map((m) => ({ line: m.lineNum, msg: m.message })), 0);

  const pCounts = device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: 'main_counts' } });
  const pScan = device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: 'main_scan' } });
  const pScatter = device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: 'main_scatter' } });
  const pForce = device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: 'main_force' } });
  const pRender = device.createRenderPipeline({
    layout: 'auto',
    vertex: { module, entryPoint: 'vs' },
    fragment: { module, entryPoint: 'fs', targets: [{ format: navigator.gpu.getPreferredCanvasFormat() }] },
    primitive: { topology: 'triangle-list' },
  });

  const bgCounts = (read: { pos: Buffer }) => device.createBindGroup({
    layout: pCounts.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: uniform } },
      { binding: 1, resource: { buffer: read.pos.gpuBuffer } },
      { binding: 2, resource: { buffer: cellCount.gpuBuffer } },
    ],
  });
  const bgScan = device.createBindGroup({
    layout: pScan.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: uniform } },
      { binding: 2, resource: { buffer: cellCount.gpuBuffer } },
      { binding: 3, resource: { buffer: cellStart.gpuBuffer } },
      { binding: 4, resource: { buffer: cellFill.gpuBuffer } },
    ],
  });
  const bgScatter = (read: { pos: Buffer }) => device.createBindGroup({
    layout: pScatter.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: uniform } },
      { binding: 1, resource: { buffer: read.pos.gpuBuffer } },
      { binding: 4, resource: { buffer: cellFill.gpuBuffer } },
      { binding: 5, resource: { buffer: order.gpuBuffer } },
    ],
  });
  const bgForce = (read: { pos: Buffer; vel: Buffer }, write: { pos: Buffer; vel: Buffer }) => device.createBindGroup({
    layout: pForce.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: uniform } },
      { binding: 1, resource: { buffer: read.pos.gpuBuffer } },
      { binding: 6, resource: { buffer: read.vel.gpuBuffer } },
      { binding: 7, resource: { buffer: write.pos.gpuBuffer } },
      { binding: 8, resource: { buffer: write.vel.gpuBuffer } },
      { binding: 3, resource: { buffer: cellStart.gpuBuffer } },
      { binding: 4, resource: { buffer: cellFill.gpuBuffer } },
      { binding: 5, resource: { buffer: order.gpuBuffer } },
    ],
  });
  const bgRender = (read: { pos: Buffer; vel: Buffer }) => device.createBindGroup({
    layout: pRender.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: uniform } },
      { binding: 1, resource: { buffer: read.pos.gpuBuffer } },
      { binding: 6, resource: { buffer: read.vel.gpuBuffer } },
    ],
  });

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
      const useAB = frame % 2 === 0;
      const read = useAB ? sideA : sideB;
      const write = useAB ? sideB : sideA;
      const enc = device.createCommandEncoder();
      const pass = enc.beginComputePass();
      pass.setPipeline(pCounts);
      pass.setBindGroup(0, bgCounts(read));
      pass.dispatchWorkgroups(Math.ceil(N / WG));
      pass.setPipeline(pScan);
      pass.setBindGroup(0, bgScan);
      pass.dispatchWorkgroups(1);
      pass.setPipeline(pScatter);
      pass.setBindGroup(0, bgScatter(read));
      pass.dispatchWorkgroups(Math.ceil(N / WG));
      pass.setPipeline(pForce);
      pass.setBindGroup(0, bgForce(read, write));
      pass.dispatchWorkgroups(Math.ceil(N / WG));
      pass.end();
      device.queue.submit([enc.finish()]);

      if (gpuCtx) {
        const bg = bgRender(write);
        const re = enc2(device, gpuCtx, pRender, bg, N);
        device.queue.submit([re]);
      }
      pp.swap();
      frame++;
      fFrames++;
      const now = performance.now();
      fAcc += now - fLast; fLast = now;
      if (fAcc >= 500) { lastFps = fFrames / (fAcc / 1000); fFrames = 0; fAcc = 0; }
    },

    stats() { return { fps: lastFps }; },
    buffers() { return { pos: pp.current.pos, vel: pp.current.vel }; },

    destroy() {
      pp.destroy(); cellCount.destroy(); cellStart.destroy(); cellFill.destroy(); order.destroy(); uniform.destroy();
    },
  };
}

function enc2(device: GPUDevice, gpuCtx: GPUCanvasContext, pipeline: GPURenderPipeline, bg: GPUBindGroup, n: number): GPUCommandBuffer {
  const enc = device.createCommandEncoder();
  const pass = enc.beginRenderPass({
    colorAttachments: [{
      view: gpuCtx.getCurrentTexture().createView(),
      clearValue: { r: 0.012, g: 0.016, b: 0.03, a: 1 },
      loadOp: 'clear', storeOp: 'store',
    }],
  });
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, bg);
  pass.draw(3, n);
  pass.end();
  return enc.finish();
}

function boidsWgsl(pointSize: number): string {
  return /* wgsl */ `
struct Params {
  count: u32, gridSize: u32,
  perception: f32, maxSpeed: f32, wSep: f32, wAli: f32, wCoh: f32,
  dt: f32, worldHalf: f32, _p: f32,
};
// 统一绑定布局(模块级唯一声明,四个入口按需引用):
// 0 uniform | 1 posIn | 2 cellCount(atomic) | 3 cellStart | 4 cellFill(atomic)
// 5 order   | 6 velIn | 7 posOut | 8 velOut
@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> posIn: array<vec2f>;
@group(0) @binding(2) var<storage, read_write> cellCount: array<atomic<u32>>;
@group(0) @binding(3) var<storage, read_write> cellStart: array<u32>;
@group(0) @binding(4) var<storage, read_write> cellFill: array<atomic<u32>>;
@group(0) @binding(5) var<storage, read_write> order: array<u32>;
@group(0) @binding(6) var<storage, read> velIn: array<vec2f>;
@group(0) @binding(7) var<storage, read_write> posOut: array<vec2f>;
@group(0) @binding(8) var<storage, read_write> velOut: array<vec2f>;

fn cellOf(p: vec2f) -> u32 {
  let g = i32(params.gridSize);
  let span = params.worldHalf * 2.0;
  let cx = clamp(i32(floor((p.x + params.worldHalf) / span * f32(g))), 0, g - 1);
  let cy = clamp(i32(floor((p.y + params.worldHalf) / span * f32(g))), 0, g - 1);
  return u32(cy) * u32(g) + u32(cx);
}

@compute @workgroup_size(${WG})
fn main_counts(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= params.count) { return; }
  atomicAdd(&cellCount[cellOf(posIn[i])], 1u);
}

var<workgroup> partial: array<u32, 256>;
@compute @workgroup_size(256)
fn main_scan(@builtin(local_invocation_id) lid: vec3u) {
  let tid = lid.x;
  let cells = params.gridSize * params.gridSize;
  let chunks = (cells + 255u) / 256u;
  var local = 0u;
  for (var c = 0u; c < chunks; c++) {
    let idx = c * 256u + tid;
    if (idx < cells) { local = local + atomicLoad(&cellCount[idx]); }
  }
  partial[tid] = local;
  workgroupBarrier();
  var offset = 1u;
  loop {
    if (offset >= 256u) { break; }
    var v = 0u;
    if (tid >= offset) { v = partial[tid - offset]; }
    workgroupBarrier();
    if (tid >= offset) { partial[tid] = partial[tid] + v; }
    workgroupBarrier();
    offset = offset << 1u;
  }
  var run = 0u;
  if (tid > 0u) { run = partial[tid - 1u]; }
  for (var c = 0u; c < chunks; c++) {
    let idx = c * 256u + tid;
    if (idx < cells) {
      cellStart[idx] = run;
      atomicStore(&cellFill[idx], run);
      run = run + atomicLoad(&cellCount[idx]);
      atomicStore(&cellCount[idx], 0u);
    }
  }
}

@compute @workgroup_size(${WG})
fn main_scatter(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= params.count) { return; }
  let slot = atomicAdd(&cellFill[cellOf(posIn[i])], 1u);
  order[slot] = i;
}

@compute @workgroup_size(${WG})
fn main_force(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= params.count) { return; }
  let myPos = posIn[i];
  let myVel = velIn[i];
  var sep = vec2f(0.0);
  var ali = vec2f(0.0);
  var coh = vec2f(0.0);
  var n = 0u;
  let g = i32(params.gridSize);
  let cellSize = params.worldHalf * 2.0 / f32(g);
  var cx = clamp(i32(floor((myPos.x + params.worldHalf) / cellSize)), 0, g - 1);
  var cy = clamp(i32(floor((myPos.y + params.worldHalf) / cellSize)), 0, g - 1);
  let p2 = params.perception * params.perception;

  for (var dy = -1; dy <= 1; dy++) {
    for (var dx = -1; dx <= 1; dx++) {
      let nx = cx + dx;
      let ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= g || ny >= g) { continue; }
      let c = u32(ny) * u32(g) + u32(nx);
      let s = cellStart[c];
      let e = atomicLoad(&cellFill[c]);
      for (var k = s; k < e; k++) {
        let j = order[k];
        if (j == i) { continue; }
        let rel = posIn[j] - myPos;
        let d2 = dot(rel, rel);
        if (d2 > p2) { continue; }
        let d = sqrt(d2) + 1e-5;
        sep = sep + (myPos - posIn[j]) / d;
        ali = ali + velIn[j];
        coh = coh + posIn[j];
        n = n + 1u;
      }
    }
  }

  var vel = myVel;
  if (n > 0u) {
    let nf = f32(n);
    ali = ali / nf;
    coh = coh / nf - myPos;
    vel = myVel + (sep * params.wSep + ali * params.wAli + coh * params.wCoh) * 0.016;
  }
  let sp = length(vel);
  if (sp > params.maxSpeed) { vel = vel / sp * params.maxSpeed; }
  if (sp < params.maxSpeed * 0.35) { vel = vel / max(sp, 1e-5) * params.maxSpeed * 0.35; }

  var pos = myPos + vel;
  let h = params.worldHalf;
  pos = ((pos + h) % (2.0 * h) + 2.0 * h) % (2.0 * h) - h;
  posOut[i] = pos;
  velOut[i] = vel;
}

// ---- 渲染:朝向速度方向的三角 ----
struct VsOut {
  @builtin(position) clip: vec4f,
  @location(0) color: vec3f,
};

@vertex
fn vs(@builtin(vertex_index) v: u32, @builtin(instance_index) inst: u32) -> VsOut {
  var shape = array<vec2f, 3>(vec2f(${(pointSize * 1.6).toFixed(4)}, 0.0), vec2f(${(-pointSize).toFixed(4)}, ${(pointSize * 0.45).toFixed(4)}), vec2f(${(-pointSize).toFixed(4)}, ${(-pointSize * 0.45).toFixed(4)}));
  let a = atan2(velIn[inst].y, velIn[inst].x);
  let c = cos(a);
  let s = sin(a);
  let l = shape[v];
  var out: VsOut;
  out.clip = vec4f(posIn[inst] + vec2f(l.x * c - l.y * s, l.x * s + l.y * c), 0.0, 1.0);
  let sp = length(velIn[inst]) / params.maxSpeed;
  out.color = mix(vec3f(0.12, 0.2, 0.45), vec3f(0.4, 0.9, 1.0), clamp(sp, 0.0, 1.0));
  return out;
}

@fragment
fn fs(in: VsOut) -> @location(0) vec4f {
  return vec4f(in.color, 1.0);
}
`;
}

function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
