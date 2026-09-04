import { resolveMatrix, hashSeed, type ForceMatrix, type ForcePresetName } from './presets.ts';
import { UsageError } from '../../core/errors.ts';

/** 粒子模拟的邻域算法路径(基准对比见 validation/05) */
export type SimMode = 'n2' | 'tiled' | 'grid';

export interface ParticlesConfig {
  /** 粒子数(默认 8192;n2 模式建议 ≤ 20000) */
  count?: number;
  /** 力矩阵:预设名('cells'|'snakes'|'orbitals'|'viruses'|'random')或自定义 16 元数组 */
  forces?: ForcePresetName | 'random' | ForceMatrix;
  /** 邻域算法:'n2' | 'tiled'(默认)| 'grid' */
  mode?: SimMode;
  /** 着色:'species'(默认)| 'velocity' */
  color?: 'species' | 'velocity';
  /** 边界:'wrap'(默认)| 'clamp' */
  bounds?: 'wrap' | 'clamp';
  /** 种子(字符串或数字),决定初始分布与 random 矩阵 */
  seed?: string | number;
  /** 物理参数(全部可选,有默认值) */
  rMax?: number;
  beta?: number;
  forceFactor?: number;
  frictionHalfLife?: number;
  dt?: number;
  /** 点大小(canvas 像素单位的比例,默认 0.004;大规模下自动缩小) */
  pointSize?: number;
  /** 每粒子邻域候选上限(grid 模式;仅作极端抱团的保险丝,默认 32768 在支持密度内不触发——按格子顺序截断会引入方向偏差伪影) */
  maxNeighbors?: number;
}

export interface ResolvedConfig {
  count: number;
  forces: ForceMatrix;
  forcesName: string;
  mode: SimMode;
  color: 'species' | 'velocity';
  bounds: 'wrap' | 'clamp';
  seed: string;
  seedHash: number;
  rMax: number;
  beta: number;
  forceFactor: number;
  friction: number;
  frictionHalfLife: number;
  dt: number;
  pointSize: number;
  maxNeighbors: number;
}

const MODES: readonly SimMode[] = ['n2', 'tiled', 'grid'];

export function resolveConfig(config: ParticlesConfig = {}): ResolvedConfig {
  const {
    count = 8192,
    forces = 'cells',
    mode = 'grid', // 基准数据驱动:v0.4 起 grid 全面优于 tiled(0.54ms vs 3.62ms @16k),见 benchmarks.md
    color = 'species',
    bounds = 'wrap',
    seed = 'wgpu-kit',
    rMax = 0.12,
    beta = 0.3,
    forceFactor = 10,
    frictionHalfLife = 0.04,
    dt = 0.02,
    pointSize = 0.004,
    maxNeighbors = 32768,
  } = config;

  if (!Number.isInteger(count) || count <= 0 || count > 1_000_000) {
    throw new UsageError(`count 必须是 1..1_000_000 的整数,收到: ${String(count)}`);
  }
  if (!MODES.includes(mode)) {
    throw new UsageError(`mode 必须是 ${MODES.join(' | ')},收到: "${String(mode)}"`);
  }
  if (mode === 'n2' && count > 32_000) {
    throw new UsageError(`mode='n2' 建议 count ≤ 20000(当前 ${count});大规模请用 mode='tiled' 或 'grid'`);
  }
  const seedStr = String(seed);

  return {
    count,
    forces: resolveMatrix(forces, hashSeed(seedStr)),
    forcesName: typeof forces === 'string' ? forces : 'custom',
    mode,
    color,
    bounds,
    seed: seedStr,
    seedHash: hashSeed(seedStr),
    rMax,
    beta,
    forceFactor,
    friction: Math.exp(-dt / frictionHalfLife),
    frictionHalfLife,
    dt,
    pointSize,
    maxNeighbors,
  };
}

export type { ForceMatrix, ForcePresetName };
export { FORCE_PRESETS, mulberry32, hashSeed, randomMatrix, resolveMatrix } from './presets.ts';
