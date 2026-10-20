import { afterEach, describe, expect, it, vi } from 'vitest';
import { Buffer } from '../src/core/buffer.ts';
import { GpuContext } from '../src/core/context.ts';
import { UsageError } from '../src/core/errors.ts';
import { elementKernel } from '../src/core/kernel.ts';

// GPU 执行结果由 smoke 页验证;这里只观察校验阶段的队列/encoder 副作用。
function fakeGpu(maxComputeWorkgroupsPerDimension = 2) {
  vi.stubGlobal('GPUBufferUsage', { STORAGE: 1, COPY_SRC: 2, COPY_DST: 4, UNIFORM: 8 });
  const dispatch = vi.fn();
  const writeBuffer = vi.fn();
  const submit = vi.fn();
  const encoder = () => ({
    beginComputePass: vi.fn(() => ({
      setPipeline: vi.fn(), setBindGroup: vi.fn(), dispatchWorkgroups: dispatch, end: vi.fn(),
    })),
    finish: vi.fn(() => ({})),
  });
  const createCommandEncoder = vi.fn(encoder);
  const device = {
    limits: { maxComputeWorkgroupsPerDimension },
    queue: { writeBuffer, submit },
    createBuffer: vi.fn(() => ({ destroy: vi.fn() })),
    createShaderModule: vi.fn(() => ({ getCompilationInfo: async () => ({ messages: [] }) })),
    createComputePipeline: vi.fn(() => ({ getBindGroupLayout: () => ({}) })),
    createBindGroup: vi.fn(() => ({})),
    createCommandEncoder,
  };
  vi.spyOn(GpuContext, 'get').mockResolvedValue({ device } as unknown as GpuContext);
  return { device, dispatch, writeBuffer, submit, createCommandEncoder };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('elementKernel: dispatch count 与资源校验', () => {
  it('默认仍要求逐元素资源等长,显式 count 允许不同容量且不受 aux 长度限制', async () => {
    const gpu = fakeGpu();
    const out = await Buffer.create('f32', 12);
    const input = await Buffer.create('f32', 8);
    const table = await Buffer.create('f32', 1);
    const k = elementKernel({
      state: { out: 'f32' }, inputs: { input: 'f32' }, auxInputs: { table: 'f32' },
      code: 'fn userFn(idx: u32) { out[idx] = input[idx] + table[0]; }',
    });
    await expect(k.run({ out, input, table })).rejects.toThrow(UsageError);
    expect(gpu.submit).not.toHaveBeenCalled();
    await k.run({ out, input, table }, {}, { count: 8 });
    expect(gpu.dispatch).toHaveBeenLastCalledWith(1);
    expect(gpu.submit).toHaveBeenCalledTimes(1);
    await expect(k.run({ out, input, table }, {}, { count: 9 })).rejects.toThrow(UsageError);
    expect(gpu.submit).toHaveBeenCalledTimes(1);
    k.destroy();
  });

  it('count 值与设备 dispatch 上限在提交前校验,失败后仍能重试', async () => {
    const gpu = fakeGpu();
    const out = await Buffer.create('f32', 129);
    const k = elementKernel({ state: { out: 'f32' }, code: 'fn userFn(idx: u32) { out[idx] = 1.0; }' });
    await k.prepare();
    const enc = gpu.device.createCommandEncoder() as unknown as GPUCommandEncoder;
    for (const count of [-1, 0.5, NaN, Infinity, 0x1_0000_0000, 130, 129]) {
      expect(() => k.encode(enc, { out }, {}, { count })).toThrow(UsageError);
    }
    // 默认推导也必须检查 device 限制:129 个元素需要 3 个 workgroup,设备只允许 2。
    expect(() => k.encode(enc, { out })).toThrow(UsageError);
    expect(gpu.writeBuffer).not.toHaveBeenCalled();
    expect(gpu.dispatch).not.toHaveBeenCalled();
    k.encode(enc, { out }, {}, { count: 128 });
    expect(gpu.dispatch).toHaveBeenLastCalledWith(2);
    k.endSubmit();
    k.destroy();
  });

  it('count=0 仍校验 aux 存在/类型与 uniforms,失败后可在同一 encoder 重试', async () => {
    const gpu = fakeGpu();
    const out = await Buffer.create('f32', 4);
    const table = await Buffer.create('f32', 1);
    const wrong = await Buffer.create('u32', 1);
    const k = elementKernel({
      state: { out: 'f32' }, auxInputs: { table: 'f32' }, uniforms: { scale: 'f32' },
      code: 'fn userFn(idx: u32, scale: f32) { out[idx] = table[0] * scale; }',
    });
    await k.prepare();
    const enc = gpu.device.createCommandEncoder() as unknown as GPUCommandEncoder;
    expect(() => k.encode(enc, { out }, { scale: 2 }, { count: 0 })).toThrow(UsageError);
    expect(() => k.encode(enc, { out, table: wrong }, { scale: 2 }, { count: 0 })).toThrow(UsageError);
    expect(() => k.encode(enc, { out, table }, {}, { count: 0 })).toThrow(UsageError);
    expect(() => k.encode(enc, { out, table }, { scale: NaN }, { count: 0 })).toThrow(UsageError);
    await k.run({ out, table }, { scale: 2 }, { count: 0 });
    expect(gpu.writeBuffer).not.toHaveBeenCalled();
    expect(gpu.submit).not.toHaveBeenCalled();
    k.encode(enc, { out, table }, { scale: 2 }, { count: 4 });
    expect(gpu.dispatch).toHaveBeenLastCalledWith(1);
    k.endSubmit();
    k.destroy();
  });

  it('零 count 不上传/编码/提交,既不开 guard 也不解除已打开的 guard', async () => {
    const gpu = fakeGpu();
    const out = await Buffer.create('f32', 4);
    const k = elementKernel({
      state: { out: 'f32' }, uniforms: { value: 'f32' },
      code: 'fn userFn(idx: u32, value: f32) { out[idx] = value; }',
    });
    await k.prepare();
    const enc = gpu.device.createCommandEncoder() as unknown as GPUCommandEncoder;
    k.encode(enc, { out }, { value: 99 }, { count: 0 });
    await k.run({ out }, { value: 99 }, { count: 0 });
    expect(gpu.writeBuffer).not.toHaveBeenCalled();
    expect(gpu.dispatch).not.toHaveBeenCalled();
    expect(gpu.submit).not.toHaveBeenCalled();

    k.encode(enc, { out }, { value: 7 });
    k.encode(enc, { out }, { value: 99 }, { count: 0 });
    await k.run({ out }, { value: 99 }, { count: 0 });
    expect(gpu.writeBuffer).toHaveBeenCalledTimes(1);
    expect(gpu.dispatch).toHaveBeenCalledTimes(1);
    expect(gpu.submit).not.toHaveBeenCalled();
    expect(() => k.encode(enc, { out }, { value: 8 })).toThrow(UsageError);
    k.endSubmit();
    k.encode(enc, { out }, { value: 8 });
    expect(gpu.dispatch).toHaveBeenCalledTimes(2);
    k.endSubmit();
    k.destroy();
  });
});
