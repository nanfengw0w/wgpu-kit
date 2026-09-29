import { GpuContext } from './core/context.ts';
import { Buffer } from './core/buffer.ts';
import { elementKernel, type ElementKernel, type ElementKernelSpec } from './core/kernel.ts';
import { PingPong } from './core/pingpong.ts';
import { rawKernel } from './core/raw.ts';
import { UsageError } from './core/errors.ts';
import { getUserPack, listUserPacks, type PackSim, type WgpuKitPack } from './core/pack.ts';

export { GpuContext, Buffer, elementKernel, PingPong, rawKernel };
export { defineSchema, TypedBuffer, type Schema, type SchemaBuffers, type SchemaInfer, type KindOf, type Vec2, type Vec3, type Vec4 } from './core/schema.ts';
export { definePack, registerPack, type PackSim, type WgpuKitPack } from './core/pack.ts';
export { createScan, type Scan } from './primitives/scan.ts';
export { createReduce, type Reduce } from './primitives/reduce.ts';
// 主入口直达旗舰包:import { particles } from 'wgpu-kit' 开箱即用
export { particles, type ParticlesSim } from './packs/particles/index.ts';
export type { ElementKernel, ElementKernelSpec };
export { TYPES, planUniform, packUniform, packUniformInto, type ScalarKind, type UniformValue } from './core/layout.ts';
export { WgpuKitError, WebGPUUnavailableError, CompileError, UsageError } from './core/errors.ts';

// 内置包以纯数据形态静态合成(不再有顶层 registerPack 副作用)——
// v1.x 的写法与 package.json "sideEffects: false" 冲突:打包器可合法 shake
// 掉注册调用,listPacks() 随之返回空。现在 listPacks/getPack 是纯函数,
// 内置包是数据,tree-shake 无论怎么摇语义都不变。
import { particles as _particles, type ParticlesConfig } from './packs/particles/index.ts';

const BUILT_IN_PACKS: ReadonlyArray<WgpuKitPack<ParticlesConfig | undefined, PackSim>> = [
  {
    name: 'particles',
    description: 'Particle-life physics (n2 / tiled / grid up to 200k+)',
    create: (config) => _particles(config ?? {}),
  },
];

/** 内置包 + 用户注册包,合并枚举 */
export function listPacks(): Array<{ name: string; description: string }> {
  return [
    ...BUILT_IN_PACKS.map((p) => ({ name: p.name, description: p.description ?? '' })),
    ...listUserPacks(),
  ];
}

/** 按名取包:内置优先,未命中回落用户注册表 */
export function getPack(name: string): WgpuKitPack<never, PackSim> | undefined {
  const builtin = BUILT_IN_PACKS.find((p) => p.name === name);
  if (builtin) return builtin as unknown as WgpuKitPack<never, PackSim>;
  return getUserPack(name) as WgpuKitPack<never, PackSim> | undefined;
}
