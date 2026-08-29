import type { ScalarKind } from '../../core/layout.ts';

/** 粒子包的字段布局(species 独立成 u32 缓冲,方便按需着色) */
export const PARTICLE_FIELDS = {
  pos: 'vec2f',
  vel: 'vec2f',
  species: 'u32',
} as const satisfies Record<string, ScalarKind>;

export type ForceMatrix = readonly [number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number];

/** 精选力矩阵(4×4,行=施加者,列=承受者;正值吸引)。调参原则:对角 0,正负平衡。 */
export const FORCE_PRESETS = {
  /** 经典细胞:小团簇 + 缓慢迁移(spike 验证过的矩阵) */
  cells: [
    0.0, 0.6, -0.4, 0.0,
    -0.4, 0.0, 0.7, -0.2,
    0.5, -0.5, 0.0, 0.6,
    -0.3, 0.4, -0.6, 0.0,
  ] as ForceMatrix,
  /** 蛇形:链状结构与游动 */
  snakes: [
    0.0, 0.7, 0.1, -0.5,
    -0.3, 0.0, 0.8, -0.1,
    0.2, -0.4, 0.0, 0.7,
    -0.6, 0.2, -0.3, 0.0,
  ] as ForceMatrix,
  /** 轨道:环带与漩涡感 */
  orbitals: [
    0.0, -0.5, 0.4, 0.2,
    0.5, 0.0, -0.6, 0.1,
    -0.3, 0.6, 0.0, -0.4,
    0.1, -0.2, 0.5, 0.0,
  ] as ForceMatrix,
  /** 病毒:捕食结构,红吃绿 */
  viruses: [
    0.0, 0.9, -0.6, 0.1,
    -0.5, 0.0, 0.3, -0.8,
    0.7, 0.2, 0.0, -0.3,
    -0.2, 0.8, 0.4, 0.0,
  ] as ForceMatrix,
} as const;

export type ForcePresetName = keyof typeof FORCE_PRESETS;

/** mulberry32:种子可复现(seed 支持字符串散列,URL 分享友好) */
export function mulberry32(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashSeed(seed: string): number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** 随机力矩阵(从种子生成,保证可复现) */
export function randomMatrix(seed: number): ForceMatrix {
  const rand = mulberry32(seed ^ 0x9E3779B9);
  const m = Array.from({ length: 16 }, () => Math.round((rand() * 2 - 1) * 100) / 100);
  for (let i = 0; i < 4; i++) m[i * 4 + i] = 0;
  return m as unknown as ForceMatrix;
}

export function resolveMatrix(forces: ForcePresetName | 'random' | ForceMatrix, seed: number): ForceMatrix {
  if (forces === 'random') return randomMatrix(seed);
  if (typeof forces === 'string') {
    const preset = FORCE_PRESETS[forces];
    if (!preset) {
      throw new Error(`未知力矩阵预设 "${forces}",可用: ${Object.keys(FORCE_PRESETS).join(', ')}, random`);
    }
    return preset;
  }
  return forces;
}
