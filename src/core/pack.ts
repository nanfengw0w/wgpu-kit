/**
 * Pack 平台契约:第三方在 core 之上写自己的模拟包,与内置包(particles/life/
 * fields)平级注册、平级验证。这是"功能集 → 平台"的那一步。
 *
 * 契约只有三条(章程原则 2:错误说人话;原则 3:可验证):
 *   ① create(config) → PackSim:统一的生命周期(attach/tick/stats/destroy);
 *   ② 可选 probe():自报物理不变量 —— verify harness 会收集并展示,
 *      第三方包从第一天就拥有与内置包相同的验证故事;
 *   ③ registerPack():进入运行时注册表,工具链(playground/gallery)可枚举启动。
 */

import { UsageError, ERR } from './errors.ts';

/** 所有 pack 模拟实例的统一生命周期。tick/destroy 必须;其余可选。 */
export interface PackSim {
  /** 需要 canvas 的包在此建渲染器(可选) */
  attach?(canvas: HTMLCanvasElement): Promise<void>;
  /** 推进一帧(计算 + 可选渲染) */
  tick(): void;
  /** 轻量运行统计(fps 等),工具链直接读 */
  stats?(): Record<string, number | string>;
  /** 自检:返回物理不变量(如 totalMass / meanSpeed / gpuErrors),verify 页收集展示 */
  probe?(): Promise<Record<string, number | string | boolean>>;
  destroy(): void;
}

export interface WgpuKitPack<TConfig, TSim extends PackSim = PackSim> {
  /** 注册表命名空间名(如 'fields');重复注册同名包报 UsageError */
  readonly name: string;
  readonly description?: string;
  create(config?: TConfig): Promise<TSim>;
}

/** 声明一个 pack。运行时只做契约校验;泛型把 TConfig 的类型检查交给编辑器。 */
export function definePack<TConfig, TSim extends PackSim>(pack: WgpuKitPack<TConfig, TSim>): WgpuKitPack<TConfig, TSim> {
  if (!pack || typeof pack.name !== 'string' || !/^[a-z][a-z0-9-]*$/.test(pack.name)) {
    throw new UsageError(ERR.USAGE, `definePack: name must be a lowercase identifier, got: ${String((pack as { name?: unknown })?.name)}`);
  }
  if (typeof pack.create !== 'function') {
    throw new UsageError(ERR.USAGE, `definePack("${pack.name}"): create(config) is required`);
  }
  return pack;
}

const REGISTRY = new Map<string, WgpuKitPack<unknown, PackSim>>();

/** 注册进全局注册表(同名重复注册报错,防止第三方覆盖内置包) */
export function registerPack<TConfig, TSim extends PackSim>(pack: WgpuKitPack<TConfig, TSim>): void {
  if (REGISTRY.has(pack.name)) {
    throw new UsageError(ERR.USAGE, `registerPack("${pack.name}"): already registered`);
  }
  REGISTRY.set(pack.name, pack as unknown as WgpuKitPack<unknown, PackSim>);
}

export function getPack(name: string): WgpuKitPack<unknown, PackSim> | undefined {
  return REGISTRY.get(name);
}

export function listPacks(): Array<{ name: string; description: string }> {
  return [...REGISTRY.values()].map((p) => ({ name: p.name, description: p.description ?? '' }));
}
