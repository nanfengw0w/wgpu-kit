import { GpuContext } from './core/context.ts';
import { Buffer } from './core/buffer.ts';
import { elementKernel, type ElementKernel, type ElementKernelSpec } from './core/kernel.ts';
import { PingPong } from './core/pingpong.ts';
import { rawKernel } from './core/raw.ts';
import { UsageError } from './core/errors.ts';

export { GpuContext, Buffer, elementKernel, PingPong, rawKernel };
export { defineSchema, TypedBuffer, type Schema, type SchemaBuffers, type SchemaInfer, type KindOf, type Vec2, type Vec3, type Vec4 } from './core/schema.ts';
export { definePack, registerPack, getPack, listPacks, type PackSim, type WgpuKitPack } from './core/pack.ts';
export { createScan, type Scan } from './primitives/scan.ts';
export { createReduce, type Reduce } from './primitives/reduce.ts';
// 主入口直达旗舰包:import { particles } from 'wgpu-kit' 开箱即用
export { particles, type ParticlesSim } from './packs/particles/index.ts';
export type { ElementKernel, ElementKernelSpec };
export { TYPES, planUniform, packUniform, packUniformInto, type ScalarKind } from './core/layout.ts';
export { WgpuKitError, WebGPUUnavailableError, CompileError, UsageError } from './core/errors.ts';

// 内置包进入注册表(第三方包用 registerPack 注册后同样可被 listPacks 枚举)
import { registerPack } from './core/pack.ts';
import { particles as _particles } from './packs/particles/index.ts';
registerPack({
  name: 'particles',
  description: 'Particle-life physics (n2 / tiled / grid up to 200k+)',
  create: (config) => _particles(config ?? {}),
});
