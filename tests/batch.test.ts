import { afterEach, describe, expect, it, vi } from 'vitest';
import { Buffer, GpuContext, UsageError, createBatch, elementKernel } from '../src/index.ts';

interface Snapshot {
  buffer: GPUBuffer;
  offset: number;
  bytes: ArrayBuffer;
}

function overlaps(left: Snapshot, right: Snapshot): boolean {
  return left.buffer === right.buffer && left.offset < right.offset + right.bytes.byteLength && right.offset < left.offset + left.bytes.byteLength;
}

// 不模拟 GPU 执行;观察公开 encode/submit 的参数快照、队列提交与资源生存期。
function fakeGpu() {
  vi.stubGlobal('GPUBufferUsage', { STORAGE: 1, COPY_SRC: 2, COPY_DST: 4, UNIFORM: 8 });
  const completions: Array<() => void> = [];
  const failures: Array<(reason: Error) => void> = [];
  const writes: Snapshot[] = [];
  const submit = vi.fn();
  const device = {
    limits: { maxComputeWorkgroupsPerDimension: 65535, minUniformBufferOffsetAlignment: 256 },
    queue: {
      submit,
      writeBuffer: vi.fn((buffer: GPUBuffer, offset: number, bytes: ArrayBuffer) => {
        writes.push({ buffer, offset, bytes: bytes.slice(0) });
      }),
      onSubmittedWorkDone: vi.fn(() => new Promise<void>((resolve, reject) => { completions.push(resolve); failures.push(reject); })),
    },
    createBuffer: vi.fn((descriptor: GPUBufferDescriptor) => ({ size: descriptor.size, destroy: vi.fn() })),
    createShaderModule: vi.fn(() => ({ getCompilationInfo: async () => ({ messages: [] }) })),
    createComputePipeline: vi.fn(() => ({ getBindGroupLayout: () => ({}) })),
    createBindGroup: vi.fn(() => ({})),
    createCommandEncoder: vi.fn(() => ({
      beginComputePass: vi.fn(() => ({
        setPipeline: vi.fn(), setBindGroup: vi.fn(), dispatchWorkgroups: vi.fn(), end: vi.fn(),
      })),
      finish: vi.fn(() => ({})),
    })),
  };
  vi.spyOn(GpuContext, 'get').mockResolvedValue({ device } as unknown as GpuContext);
  return { device, writes, completions, failures, submit };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('ComputeBatch', () => {
  it('参数跨 arena 页仍不重叠,GPU 完成后下一批复用已退休页面', async () => {
    const gpu = fakeGpu();
    const out = await Buffer.create('f32', 1);
    const k = elementKernel({ state: { out: 'f32' }, uniforms: { value: 'f32' }, code: 'fn userFn(i: u32, value: f32) { out[i] = value; }' });
    await k.prepare();
    const first = await createBatch();
    for (let i = 0; i < 300; i++) k.encode(first.encoder, { out }, { value: i }, { batch: first });
    for (let i = 0; i < gpu.writes.length; i++) {
      expect(gpu.writes.slice(0, i).some((write) => overlaps(write, gpu.writes[i]!))).toBe(false);
      expect(gpu.writes[i]!.offset % 256).toBe(0);
    }
    expect(new Set(gpu.writes.map((write) => write.buffer)).size).toBeGreaterThan(1);
    const allocated = gpu.device.createBuffer.mock.calls.length;
    expect(allocated).toBeLessThan(10);
    first.submit();
    gpu.completions[0]!();
    await Promise.resolve();
    const next = await createBatch();
    k.encode(next.encoder, { out }, { value: 7 }, { batch: next });
    expect(gpu.device.createBuffer.mock.calls).toHaveLength(allocated);
    next.cancel();
    k.destroy(); out.destroy();
  });

  it('提交异常和 GPU 完成失败会释放托管资源,不会回收损坏的缓冲', async () => {
    const gpu = fakeGpu();
    const out = await Buffer.create('f32', 1);
    const k = elementKernel({ state: { out: 'f32' }, code: 'fn userFn(i: u32) { out[i] = 1.0; }' });
    await k.prepare();
    const failed = await createBatch();
    k.encode(failed.encoder, { out }, {}, { batch: failed });
    vi.spyOn(failed.encoder, 'finish').mockImplementation(() => { throw new Error('finish failed'); });
    expect(() => failed.submit()).toThrow('finish failed');
    expect(failed.status).toBe('cancelled');
    expect(gpu.writes[0]!.buffer.destroy).toHaveBeenCalledOnce();
    expect(gpu.submit).not.toHaveBeenCalled();
    failed.cancel();

    const lost = await createBatch();
    k.encode(lost.encoder, { out }, {}, { batch: lost });
    lost.submit();
    gpu.failures[0]!(new Error('device lost'));
    await Promise.resolve();
    expect(gpu.writes[1]!.buffer.destroy).toHaveBeenCalledOnce();
    const next = await createBatch();
    k.encode(next.encoder, { out }, {}, { batch: next });
    expect(gpu.writes[2]!.buffer).not.toBe(gpu.writes[1]!.buffer);
    next.cancel();
    k.destroy(); out.destroy();
  });

  it('每次 encode 保留独立 uniform 快照,拒绝错 encoder 和已提交 batch', async () => {
    const gpu = fakeGpu();
    const out = await Buffer.create('f32', 4);
    const k = elementKernel({
      state: { out: 'f32' }, uniforms: { value: 'f32' },
      code: 'fn userFn(idx: u32, value: f32) { out[idx] = value; }',
    });
    await k.prepare();
    const batch = await createBatch();
    expect(batch.status).toBe('open');
    const otherEncoder = gpu.device.createCommandEncoder() as unknown as GPUCommandEncoder;
    expect(() => k.encode(otherEncoder, { out }, { value: 1 }, { batch })).toThrow(UsageError);
    expect(gpu.writes).toHaveLength(0);
    k.encode(batch.encoder, { out }, { value: 1 }, { batch });
    k.encode(batch.encoder, { out }, { value: 2 }, { batch });
    expect(gpu.writes).toHaveLength(2);
    expect(overlaps(gpu.writes[0]!, gpu.writes[1]!)).toBe(false);
    const offset = k.uniformLayout.fields.find((field) => field.name === 'value')!.offset;
    expect(gpu.writes.map((write) => new DataView(write.bytes).getFloat32(offset, true))).toEqual([1, 2]);
    expect(gpu.submit).not.toHaveBeenCalled();
    batch.submit();
    expect(batch.status).toBe('submitted');
    expect(gpu.submit).toHaveBeenCalledTimes(1);
    expect(() => k.encode(batch.encoder, { out }, { value: 3 }, { batch })).toThrow(UsageError);
    expect(() => batch.submit()).toThrow(UsageError);
    expect(() => batch.cancel()).toThrow(UsageError);
    gpu.completions[0]!();
    await Promise.resolve();
    k.destroy();
    out.destroy();
  });

  it('cancel 不提交,重复 cancel 可用于 finally,取消后拒绝编码和提交', async () => {
    const gpu = fakeGpu();
    const out = await Buffer.create('f32', 1);
    const k = elementKernel({ state: { out: 'f32' }, code: 'fn userFn(idx: u32) { out[idx] = 1.0; }' });
    await k.prepare();
    const batch = await createBatch();
    k.encode(batch.encoder, { out }, {}, { batch });
    batch.cancel();
    expect(batch.status).toBe('cancelled');
    expect(() => batch.cancel()).not.toThrow();
    expect(() => batch.submit()).toThrow(UsageError);
    expect(() => k.encode(batch.encoder, { out }, {}, { batch })).toThrow(UsageError);
    expect(gpu.submit).not.toHaveBeenCalled();
    k.destroy();
    out.destroy();
  });

  it('GPU 完成前的下一 batch 不得复用尚在执行的参数槽', async () => {
    const gpu = fakeGpu();
    const out = await Buffer.create('f32', 1);
    const k = elementKernel({
      state: { out: 'f32' }, uniforms: { value: 'f32' },
      code: 'fn userFn(idx: u32, value: f32) { out[idx] = value; }',
    });
    await k.prepare();
    const first = await createBatch();
    k.encode(first.encoder, { out }, { value: 7 }, { batch: first });
    first.submit();
    expect(gpu.device.queue.onSubmittedWorkDone).toHaveBeenCalledTimes(1);
    const second = await createBatch();
    k.encode(second.encoder, { out }, { value: 11 }, { batch: second });
    expect(overlaps(gpu.writes[0]!, gpu.writes[1]!)).toBe(false);
    expect(gpu.submit).toHaveBeenCalledTimes(1);
    second.cancel();
    gpu.completions[0]!();
    await Promise.resolve();
    k.destroy();
    out.destroy();
  });
});
