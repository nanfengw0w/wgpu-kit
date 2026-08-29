/**
 * 粒子模拟 WGSL 生成器。
 * mode 是"路径对比驱动设计"的落点:
 *  - n2    每线程全量扫一遍:最简单,≤2 万粒子
 *  - tiled workgroup 共享内存分块加载:全局读取减少 64×,数万粒子(S3 基准)
 *  - grid  spatial hash 两遍:10 万+(S4)
 */
export const WORKGROUP = 64;

export function simWgsl(mode: 'n2' | 'tiled', speciesCount: number): string {
  const tiled = mode === 'tiled';

  const common = /* wgsl */ `
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
`;

  // interact:lid 仅 tiled 模式需要(workgroup 内分块加载坐标)
  const interactSig = tiled
    ? 'fn interact(myIdx: u32, mySp: u32, myPos: vec2f, lid: u32) -> vec2f {'
    : 'fn interact(myIdx: u32, mySp: u32, myPos: vec2f) -> vec2f {';
  const body = tiled ? tiledBody(speciesCount) : n2Body(speciesCount);

  const main = /* wgsl */ `
@compute @workgroup_size(${WORKGROUP})
fn main(@builtin(global_invocation_id) gid: vec3u${tiled ? ', @builtin(local_invocation_id) lid: vec3u' : ''}) {
  let i = gid.x;
  // 注意:workgroupBarrier 要求 uniform control flow——
  // 越界线程也必须参与 barrier 循环,只能在最终写入处 guard(tiled 尾部 workgroup 的经典坑)
  let ok = i < params.count;
  let myIdx = min(i, params.count - 1u);
  let mySp = species[myIdx];
  let myPos = posIn[myIdx];
  var accel = interact(myIdx, mySp, myPos${tiled ? ', lid.x' : ''});
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
`;

  return `${common}${tiled ? TILE_DECLS : ''}\n${interactSig}${body}\n}\n${main}`;
}

function n2Body(speciesCount: number): string {
  return /* wgsl */ `
  var accel = vec2f(0.0, 0.0);
  let rMax2 = params.rMax * params.rMax;
  for (var j = 0u; j < params.count; j++) {
    if (j == myIdx) { continue; }
    let rel = posIn[j] - myPos;
    let d2 = dot(rel, rel);
    if (d2 > rMax2) { continue; }   // 距离平方 early-out:绝大多数对免开方
    let d = sqrt(d2);
    let r = d / params.rMax;
    if (r > 0.0 && r < 1.0) {
      let f = force(r, matrix[mySp * ${speciesCount}u + species[j]]);
      accel = accel + rel / d * f;
    }
  }
  return accel;
  `;
}

function tiledBody(speciesCount: number): string {
  return /* wgsl */ `
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
      if (d2 > rMax2) { continue; } // 距离平方 early-out
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
  `;
}

/** tiled 模式的 workgroup 共享内存声明 */
export const TILE_DECLS = /* wgsl */ `
var<workgroup> tilePos: array<vec2f, ${WORKGROUP}>;
var<workgroup> tileSp: array<u32, ${WORKGROUP}>;
`;

/** 渲染着色器:instanced quad + storage 只读直通(spike 验证的形态) */
export function renderWgsl(speciesCount: number, colorMode: 'species' | 'velocity', pointSize: number): string {
  const palette = colorMode === 'species'
    ? `const PALETTE = array<vec3f, ${speciesCount}>(
  vec3f(1.00, 0.42, 0.24),
  vec3f(0.36, 0.86, 0.56),
  vec3f(0.36, 0.58, 1.00),
  vec3f(0.98, 0.80, 0.30),
);`
    : '';

  const colorExpr = colorMode === 'velocity'
    ? /* wgsl */ `
  let speed = length(vel[inst]);
  let t = 1.0 - exp(-speed * 40.0);
  out.color = mix(vec3f(0.20, 0.32, 0.55), vec3f(1.0, 0.85, 0.45), t);
  out.color = mix(out.color, vec3f(1.0, 0.95, 0.9), smoothstep(0.6, 1.0, t));`
    : /* wgsl */ `
  let sp = min(species[inst], ${speciesCount - 1}u);
  out.color = PALETTE[sp];`;

  const velBinding = colorMode === 'velocity' ? '\n@group(0) @binding(2) var<storage, read> vel: array<vec2f>;' : '';

  return /* wgsl */ `
struct VsOut {
  @builtin(position) clip: vec4f,
  @location(0) uv: vec2f,
  @location(1) color: vec3f,
};
${palette}
@group(0) @binding(0) var<storage, read> pos: array<vec2f>;
@group(0) @binding(1) var<storage, read> species: array<u32>;${velBinding}
@group(0) @binding(3) var<uniform> rs: vec4f; // x = 1/worldHalf(相机缩放;binding 2 留给 velocity 模式的 vel)

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
`;
}
