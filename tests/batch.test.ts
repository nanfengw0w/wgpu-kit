import { afterEach, describe, expect, it, vi } from 'vitest';
import { Buffer, GpuContext, PingPong, UsageError, createBatch, elementKernel } from '../src/index.ts';

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

describe('PingPong.encodeWith', () => {
  it('同步映射读写侧并自动交换,成功提交后可在下一批继续', async () => {
    const gpu = fakeGpu();
    const pp = await PingPong.create({ value: 'f32' }, 1);
    const first = pp.current.value, second = pp.other.value;
    const batch = await createBatch();
    const reads: Buffer[] = [], writes: Buffer[] = [];
    for (let i = 0; i < 3; i++) {
      pp.encodeWith(batch, (write, read) => { writes.push(write.value); reads.push(read.value); });
    }
    expect(reads).toEqual([first, second, first]);
    expect(writes).toEqual([second, first, second]);
    expect(pp.current.value).toBe(second);
    batch.submit();
    expect(gpu.submit).toHaveBeenCalledOnce();
    expect(pp.current.value).toBe(second);
    const next = await createBatch();
    pp.encodeWith(next, () => {});
    expect(pp.current.value).toBe(first);
    next.cancel();
    expect(pp.current.value).toBe(second);
    pp.swap();
    expect(pp.current.value).toBe(first);
    pp.destroy();
  });

  it('取消恢复各 PingPong 入批时的方向,重复取消不再交换', async () => {
    const gpu = fakeGpu();
    const a = await PingPong.create({ value: 'u32' }, 1);
    const b = await PingPong.create({ value: 'u32' }, 1);
    b.swap();
    const initialA = a.current.value, initialB = b.current.value;
    const batch = await createBatch();
    for (let i = 0; i < 3; i++) a.encodeWith(batch, () => {});
    for (let i = 0; i < 2; i++) b.encodeWith(batch, () => {});
    batch.cancel();
    batch.cancel();
    expect(a.current.value).toBe(initialA);
    expect(b.current.value).toBe(initialB);
    expect(gpu.submit).not.toHaveBeenCalled();
    a.swap(); b.swap();
    a.destroy(); b.destroy();
  });

  it('回调异常取消整批,恢复此前已交换的其他 PingPong', async () => {
    const gpu = fakeGpu();
    const a = await PingPong.create({ value: 'u32' }, 1);
    const b = await PingPong.create({ value: 'u32' }, 1);
    const firstA = a.current.value, firstB = b.current.value;
    const batch = await createBatch();
    a.encodeWith(batch, () => {});
    const failure = new Error('render setup failed');
    expect(() => b.encodeWith(batch, () => { throw failure; })).toThrow(failure);
    expect(batch.status).toBe('cancelled');
    expect(a.current.value).toBe(firstA);
    expect(b.current.value).toBe(firstB);
    expect(gpu.submit).not.toHaveBeenCalled();
    a.destroy(); b.destroy();
  });

  it.each(['finish', 'submit'] as const)('%s 同步失败恢复方向并解锁', async (failure) => {
    const gpu = fakeGpu();
    const pp = await PingPong.create({ value: 'u32' }, 1);
    const initial = pp.current.value;
    const batch = await createBatch();
    pp.encodeWith(batch, () => {});
    const fail = () => { throw new Error('submission failed'); };
    if (failure === 'finish') vi.spyOn(batch.encoder, 'finish').mockImplementation(fail);
    else gpu.submit.mockImplementation(fail);
    expect(() => batch.submit()).toThrow('submission failed');
    expect(batch.status).toBe('cancelled');
    expect(pp.current.value).toBe(initial);
    pp.swap();
    pp.destroy();
  });

  it('已提交后的 GPU 失败不回滚已发布方向', async () => {
    const gpu = fakeGpu();
    const pp = await PingPong.create({ value: 'f32' }, 1);
    const out = pp.other.value;
    const k = elementKernel({ state: { out: 'f32' }, code: 'fn userFn(i:u32){out[i]=7.0;}' });
    await k.prepare();
    const batch = await createBatch();
    pp.encodeWith(batch, (write) => { k.encode(batch.encoder, { out: write.value }, undefined, { batch }); });
    batch.submit();
    gpu.failures[0]!(new Error('device lost'));
    await Promise.resolve();
    expect(batch.status).toBe('submitted');
    expect(pp.current.value).toBe(out);
    pp.swap();
    k.destroy(); pp.destroy();
  });

  it('占用期间拒绝另一批次、手动交换和 runWith,不误取消原批次', async () => {
    fakeGpu();
    const pp = await PingPong.create({ value: 'u32' }, 1);
    const batch = await createBatch(), other = await createBatch();
    pp.encodeWith(batch, () => {});
    const callback = vi.fn(() => undefined);
    expect(() => pp.encodeWith(other, callback)).toThrow(UsageError);
    expect(() => pp.swap()).toThrow(UsageError);
    await expect(pp.runWith(async () => { callback(); })).rejects.toThrow(UsageError);
    expect(callback).not.toHaveBeenCalled();
    expect(batch.status).toBe('open');
    expect(other.status).toBe('open');
    batch.cancel(); other.cancel(); pp.destroy();
  });

  it('拒绝同一 PingPong 回调重入并取消部分编码', async () => {
    fakeGpu();
    const pp = await PingPong.create({ value: 'u32' }, 1);
    const initial = pp.current.value;
    const batch = await createBatch();
    expect(() => pp.encodeWith(batch, () => { pp.encodeWith(batch, () => {}); })).toThrow(UsageError);
    expect(batch.status).toBe('cancelled');
    expect(pp.current.value).toBe(initial);
    pp.destroy();
  });

  it('回调中取消不会再次换边,取消后回调仍不能手动交换', async () => {
    fakeGpu();
    const pp = await PingPong.create({ value: 'u32' }, 1);
    const initial = pp.current.value;
    const batch = await createBatch();
    pp.encodeWith(batch, () => {});
    expect(() => pp.encodeWith(batch, () => {
      batch.cancel();
      expect(() => pp.swap()).toThrow(UsageError);
    })).toThrow(UsageError);
    expect(pp.current.value).toBe(initial);
    expect(batch.status).toBe('cancelled');
    pp.swap(); pp.destroy();
  });

  it('回调中提交在 GPU 提交前被拒绝', async () => {
    const gpu = fakeGpu();
    const pp = await PingPong.create({ value: 'u32' }, 1);
    const initial = pp.current.value;
    const batch = await createBatch();
    expect(() => pp.encodeWith(batch, () => { batch.submit(); })).toThrow(UsageError);
    expect(gpu.submit).not.toHaveBeenCalled();
    expect(batch.status).toBe('cancelled');
    expect(pp.current.value).toBe(initial);
    pp.destroy();
  });

  it('运行时拒绝 thenable 回调并处理其后续拒绝', async () => {
    fakeGpu();
    const pp = await PingPong.create({ value: 'u32' }, 1);
    const initial = pp.current.value;
    const batch = await createBatch();
    const asyncCallback = async () => { await Promise.resolve(); throw new Error('late callback rejection'); };
    expect(() => pp.encodeWith(batch, asyncCallback as unknown as () => undefined)).toThrow('synchronous');
    expect(batch.status).toBe('cancelled');
    expect(pp.current.value).toBe(initial);
    await Promise.resolve(); await Promise.resolve();
    pp.destroy();
  });

  it('旧 runWith 等待期间拒绝 encodeWith,旧成功与失败行为保持', async () => {
    fakeGpu();
    const pp = await PingPong.create({ value: 'u32' }, 1);
    const initial = pp.current.value;
    let complete!: () => void;
    const pending = pp.runWith(() => new Promise<void>((resolve) => { complete = resolve; }));
    const batch = await createBatch();
    const callback = vi.fn(() => undefined);
    expect(() => pp.encodeWith(batch, callback)).toThrow(UsageError);
    expect(callback).not.toHaveBeenCalled();
    expect(batch.status).toBe('open');
    complete(); await pending;
    expect(pp.current.value).not.toBe(initial);
    const after = pp.current.value;
    await expect(pp.runWith(async () => { throw new Error('legacy failure'); })).rejects.toThrow('legacy failure');
    expect(pp.current.value).toBe(after);
    pp.encodeWith(batch, () => {});
    batch.cancel();
    expect(pp.current.value).toBe(after);
    pp.destroy();
  });

  it('关闭或伪造的 batch 不执行回调或占用 PingPong', async () => {
    fakeGpu();
    const pp = await PingPong.create({ value: 'u32' }, 1);
    const batch = await createBatch();
    batch.cancel();
    const callback = vi.fn(() => undefined);
    expect(() => pp.encodeWith(batch, callback)).toThrow(UsageError);
    expect(() => pp.encodeWith({ ...batch }, callback)).toThrow(UsageError);
    expect(callback).not.toHaveBeenCalled();
    pp.swap(); pp.destroy();
  });
});
