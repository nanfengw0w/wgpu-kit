import type { Buffer } from './buffer.ts';
import { elementKernel, type ElementKernel, type ElementKernelDispatchOptions, type ElementKernelEncodeOptions, type ElementKernelSpec } from './kernel.ts';
import type { ScalarKind } from './layout.ts';
import type { KindOf } from './schema.ts';

type Fields<S, K extends keyof ElementKernelSpec> = K extends keyof S ? NonNullable<S[K]> : {};
type ResourceFields<S> = Fields<S, 'state'> & Fields<S, 'inputs'> & Fields<S, 'auxInputs'>;

/** 从逐元素与辅助字段声明推导资源名和 Buffer 的元素类型。 */
export type TypedElementKernelResources<S extends ElementKernelSpec> = {
  readonly [K in keyof ResourceFields<S>]: Buffer<ResourceFields<S>[K] & ScalarKind>;
};

/** uniform 的标量或向量值;WGSL 函数体仍由着色器编译器检查。 */
export type TypedElementKernelUniforms<S extends ElementKernelSpec> = {
  readonly [K in keyof Fields<S, 'uniforms'>]: KindOf<Fields<S, 'uniforms'>[K] & ScalarKind>;
};

type DispatchArguments<S extends ElementKernelSpec, Options> = keyof Fields<S, 'uniforms'> extends never
  ? [resources: TypedElementKernelResources<S>, uniforms?: Record<string, never>, options?: Options]
  : [resources: TypedElementKernelResources<S>, uniforms: TypedElementKernelUniforms<S>, options?: Options];

/** 可选的严格调用入口;保留 ElementKernel 的全部生命周期方法。 */
export type TypedElementKernel<S extends ElementKernelSpec> = Omit<ElementKernel, 'run' | 'encode'> & {
  run(...args: DispatchArguments<S, ElementKernelDispatchOptions>): Promise<void>;
  encode(encoder: GPUCommandEncoder, ...args: DispatchArguments<S, ElementKernelEncodeOptions>): void;
};

/** 只收紧 TypeScript 调用签名,执行与资源校验沿用 elementKernel。 */
export function typedElementKernel<const S extends ElementKernelSpec>(spec: S): TypedElementKernel<S> {
  return elementKernel(spec) as TypedElementKernel<S>;
}
