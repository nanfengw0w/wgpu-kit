/**
 * grid 模式(spatial hash / counting sort)的四个 kernel。
 * 每帧在同一个 command encoder 里跑四遍:
 *   ① counts  原子计数每格粒子数
 *   ② scan    单 workgroup 分块前缀和(cellStart/cellFill),顺带把 cellCount 归零给下一帧
 *   ③ scatter 按格散射出有序索引表 order
 *   ④ force   与 tiled 相同的力计算,但邻域遍历改为 3×3 个 cell 的有序区间
 * 相比 O(N²),复杂度 ≈ O(N · 邻域密度)——10 万粒子的大门。
 */

export const GRID_WORKGROUP = 64;
export const SCAN_WORKGROUP = 256;

/** cellOf:世界坐标 → 格子索引(世界固定 [-worldHalf, worldHalf],格宽 = 2*worldHalf/gridSize) */
export const CELL_OF = /* wgsl */ `
fn cellOf(p: vec2f) -> u32 {
  let g = i32(params.gridSize);
  let span = params.worldHalf * 2.0;
  let cx = clamp(i32(floor((p.x + params.worldHalf) / span * f32(g))), 0, g - 1);
  let cy = clamp(i32(floor((p.y + params.worldHalf) / span * f32(g))), 0, g - 1);
  return u32(cy) * params.gridSize + u32(cx);
}
`;

export function gridCountsWgsl(): string {
  return /* wgsl */ `
struct Params {
  count: u32, _pad0: u32,
  dt: f32, rMax: f32, beta: f32, forceFactor: f32, friction: f32,
  worldHalf: f32, wrapEdge: f32,
  gridSize: u32, cells: u32, maxCand: u32,
};
@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> posIn: array<vec2f>;
@group(0) @binding(2) var<storage, read_write> cellCount: array<atomic<u32>>;
${CELL_OF}
@compute @workgroup_size(${GRID_WORKGROUP})
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= params.count) { return; }
  atomicAdd(&cellCount[cellOf(posIn[i])], 1u);
}
`;
}

export function gridScanWgsl(): string {
  // 两级扫描:① 各 workgroup 扫自己的 256-cell 块,块总和写入 blockSums;
  // ② 单 workgroup 扫 blockSums(最多 SCAN_WORKGROUP 个块 = 65536 cell);
  // ③ 各 workgroup 加上本块基址。256×256=65536 cell 内 O(1) 轮次,不再随规模线性退化。
  return /* wgsl */ `
struct Params {
  count: u32, _pad0: u32,
  dt: f32, rMax: f32, beta: f32, forceFactor: f32, friction: f32,
  worldHalf: f32, wrapEdge: f32,
  gridSize: u32, cells: u32, maxCand: u32,
};
@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read_write> cellCount: array<atomic<u32>>;
@group(0) @binding(2) var<storage, read_write> cellStart: array<u32>;
@group(0) @binding(3) var<storage, read_write> cellFill: array<u32>;
@group(0) @binding(4) var<storage, read_write> blockSums: array<u32>;

var<workgroup> partial: array<u32, ${SCAN_WORKGROUP}>;

@compute @workgroup_size(${SCAN_WORKGROUP})
fn main(@builtin(local_invocation_id) lid: vec3u, @builtin(workgroup_id) wid: vec3u) {
  let tid = lid.x;
  let wg = ${SCAN_WORKGROUP}u;
  let base = wid.x * wg;
  let cells = params.cells;

  // ① 块内 Hillis-Steele(块不足时以 0 填充)
  let v0 = select(0u, atomicLoad(&cellCount[base + tid]), base + tid < cells);
  partial[tid] = v0;
  workgroupBarrier();
  var offset = 1u;
  loop {
    if (offset >= wg) { break; }
    var v = 0u;
    if (tid >= offset) { v = partial[tid - offset]; }
    workgroupBarrier();
    if (tid >= offset) { partial[tid] = partial[tid] + v; }
    workgroupBarrier();
    offset = offset << 1u;
  }
  // 含前缀 → 排他:start = 块内前缀(不含自身),fill = start + count
  let myCount = v0;
  let myPrefix = select(partial[tid - 1u], 0u, tid == 0u);
  if (base + tid < cells) {
    cellStart[base + tid] = myPrefix;
    cellFill[base + tid] = myPrefix + myCount;
  }
  // 块总和 → blockSums(含)
  if (tid == 0u) { blockSums[wid.x] = partial[wg - 1u]; }
  workgroupBarrier();

  // ② 块间扫描(单 workgroup;块数 = ceil(cells/wg) ≤ SCAN_WORKGROUP)
  if (wid.x == 0u) {
    var off = 1u;
    loop {
      if (off >= wg) { break; }
      var v = 0u;
      if (tid >= off) { v = blockSums[tid - off]; }
      workgroupBarrier();
      if (tid >= off) { blockSums[tid] = blockSums[tid] + v; }
      workgroupBarrier();
      off = off << 1u;
    }
  }
  workgroupBarrier();

  // ③ 加块基址;cellCount 归零供下一帧
  let blockBase = select(0u, blockSums[wid.x - 1u], wid.x > 0u);
  if (base + tid < cells) {
    cellStart[base + tid] = cellStart[base + tid] + blockBase;
    cellFill[base + tid] = cellFill[base + tid] + blockBase;
    atomicStore(&cellCount[base + tid], 0u);
  }
}
`;
}

export function gridScatterWgsl(): string {
  return /* wgsl */ `
struct Params {
  count: u32, _pad0: u32,
  dt: f32, rMax: f32, beta: f32, forceFactor: f32, friction: f32,
  worldHalf: f32, wrapEdge: f32,
  gridSize: u32, cells: u32, maxCand: u32,
};
@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> posIn: array<vec2f>;
@group(0) @binding(2) var<storage, read> species: array<u32>;
@group(0) @binding(3) var<storage, read_write> cellFill: array<atomic<u32>>;
@group(0) @binding(4) var<storage, read_write> order: array<u32>;
@group(0) @binding(5) var<storage, read_write> sortedPos: array<vec2f>;
@group(0) @binding(6) var<storage, read_write> sortedSp: array<u32>;
${CELL_OF}
@compute @workgroup_size(${GRID_WORKGROUP})
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= params.count) { return; }
  let slot = atomicAdd(&cellFill[cellOf(posIn[i])], 1u);
  order[slot] = i;
  sortedPos[slot] = posIn[i];
  sortedSp[slot] = species[i];
}
`;
}

/**
 * grid 力核:拆成两趟以消除负载不均(v0.9.7 黑屏级卡顿的根治)。
 * 抱团时单格可能挤几千粒子,"一个线程扫 9 格"会让重格子线程拖死整批;
 * 拆成 (粒子 × 格子) 一线程后工作量均分,物理结果与单趟完全一致(仅求和顺序不同)。
 *   ① main_force_cell:线程 = (粒子 i × 邻域格 c),把该格贡献写入 partial[i*9+c]
 *   ② main_force_integrate:线程 = 粒子,汇总 9 份贡献并积分
 * 同格候选数上限 maxCand(由 JS 侧传 maxNeighbors/9)仍是极端抱团的保险丝。
 */
export function gridForceWgsl(speciesCount: number): string {
  return /* wgsl */ `
struct Params {
  count: u32, _pad0: u32,
  dt: f32, rMax: f32, beta: f32, forceFactor: f32, friction: f32,
  worldHalf: f32, wrapEdge: f32,
  gridSize: u32, cells: u32, maxCand: u32,
};
@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> matrix: array<f32>;
@group(0) @binding(2) var<storage, read> species: array<u32>;
@group(0) @binding(3) var<storage, read> posIn: array<vec2f>;
@group(0) @binding(4) var<storage, read> sortedPos: array<vec2f>;
@group(0) @binding(5) var<storage, read> sortedSp: array<u32>;
@group(0) @binding(6) var<storage, read> cellStart: array<u32>;
@group(0) @binding(7) var<storage, read> cellFill: array<u32>;
@group(0) @binding(8) var<storage, read> order: array<u32>;
@group(0) @binding(9) var<storage, read_write> partial: array<vec2f>;

fn force(r: f32, a: f32) -> f32 {
  if (r < params.beta) { return a / params.beta - 1.0; }
  if (r < 1.0) { return a * (1.0 - abs(2.0 * r - 1.0 - params.beta) / (1.0 - params.beta)); }
  return 0.0;
}

@compute @workgroup_size(64)
fn main_force_cell(@builtin(global_invocation_id) gid: vec3u) {
  let tid = gid.x;
  let i = tid / 9u;
  if (i >= params.count) { return; }
  let c = tid % 9u;
  let g = i32(params.gridSize);
  // 与 CELL_OF 完全相同的浮点序列(除以 span 再乘 g)——路径不一致会让贴格粒子查询错位一格
  let span = params.worldHalf * 2.0;
  var cx = clamp(i32(floor((posIn[i].x + params.worldHalf) / span * f32(g))), 0, g - 1);
  var cy = clamp(i32(floor((posIn[i].y + params.worldHalf) / span * f32(g))), 0, g - 1);
  let dx = i32(c % 3u) - 1;
  let dy = i32(c / 3u) - 1;
  let nx = cx + dx;
  let ny = cy + dy;
  let out = i * 9u + c;
  if (nx < 0 || ny < 0 || nx >= g || ny >= g) { partial[out] = vec2f(0.0); return; }
  let cc = u32(ny) * u32(g) + u32(nx);
  let s = cellStart[cc];
  let e = cellFill[cc];
  let myPos = posIn[i];
  let mySp = species[i];
  let rMax2 = params.rMax * params.rMax;
  var accel = vec2f(0.0, 0.0);
  var checked = 0u;
  for (var k = s; k < e; k++) {
    checked = checked + 1u;
    if (checked > params.maxCand) { break; }
    if (order[k] == i) { continue; }
    let rel = sortedPos[k] - myPos;
    let d2 = dot(rel, rel);
    if (d2 > rMax2) { continue; }
    let d = sqrt(d2);
    let r = d / params.rMax;
    if (r > 0.0 && r < 1.0) {
      let f = force(r, matrix[mySp * ${speciesCount}u + sortedSp[k]]);
      accel = accel + rel / d * f;
    }
  }
  partial[out] = accel;
}

@group(0) @binding(0) var<uniform> params2: Params;
@group(0) @binding(1) var<storage, read> velIn: array<vec2f>;
@group(0) @binding(2) var<storage, read> posIn2: array<vec2f>;
@group(0) @binding(3) var<storage, read> partialR: array<vec2f>;
@group(0) @binding(4) var<storage, read_write> posOut: array<vec2f>;
@group(0) @binding(5) var<storage, read_write> velOut: array<vec2f>;

@compute @workgroup_size(64)
fn main_force_integrate(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= params2.count) { return; }
  var accel = vec2f(0.0, 0.0);
  for (var c = 0u; c < 9u; c++) {
    accel = accel + partialR[i * 9u + c];
  }
  accel = accel * params2.forceFactor * params2.rMax;
  var vel = (velIn[i] + accel * params2.dt) * params2.friction;
  var pos = posIn2[i] + vel * params2.dt;
  let span = params2.worldHalf * 2.0;
  if (params2.wrapEdge > 0.5) {
    pos = ((pos + params2.worldHalf) % span + span) % span - params2.worldHalf;
  } else {
    pos = clamp(pos, vec2f(-params2.worldHalf), vec2f(params2.worldHalf));
  }
  posOut[i] = pos;
  velOut[i] = vel;
}
`;
}
