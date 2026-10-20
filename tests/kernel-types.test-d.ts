import { elementKernel, type Buffer, type ElementKernelDispatchOptions } from '../src/index.ts';

// 对外入口保留旧调用方式,新 options 位于原 uniforms 参数之后。
declare const resources: Record<string, Buffer>;
declare const encoder: GPUCommandEncoder;
const kernel = elementKernel({
  state: { out: 'f32' },
  auxInputs: { table: 'f32' },
  code: 'fn userFn(idx: u32) { out[idx] = table[0]; }',
});
const options: ElementKernelDispatchOptions = { count: 4 };
const legacyRun: Promise<void> = kernel.run(resources);
const prefixRun: Promise<void> = kernel.run(resources, undefined, options);
kernel.encode(encoder, resources);
kernel.encode(encoder, resources, undefined, options);
void legacyRun;
void prefixRun;
