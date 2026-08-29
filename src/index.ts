import { GpuContext } from './core/context.ts';
import { Buffer } from './core/buffer.ts';
import { elementKernel, type ElementKernel, type ElementKernelSpec } from './core/kernel.ts';
import { PingPong } from './core/pingpong.ts';
import { rawKernel } from './core/raw.ts';
import { UsageError } from './core/errors.ts';

export { GpuContext, Buffer, elementKernel, PingPong, rawKernel };
// 主入口直达旗舰包:import { particles } from 'wgpu-kit' 开箱即用
export { particles, type ParticlesSim } from './packs/particles/index.ts';
export type { ElementKernel, ElementKernelSpec };
export { TYPES, planUniform, packUniform, type ScalarKind } from './core/layout.ts';
export { WgpuKitError, WebGPUUnavailableError, CompileError, UsageError } from './core/errors.ts';
