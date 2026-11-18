import { GpuContext } from './context.ts';
import { ERR, UsageError } from './errors.ts';

/** Owns an encoder; append compute or render passes before submit(). */
export interface ComputeBatch {
  readonly encoder: GPUCommandEncoder;
  readonly status: 'open' | 'submitted' | 'cancelled';
  /** Submit without waiting for GPU completion. */
  submit(): void;
  /** Discard an open batch; idempotent. */
  cancel(): void;
}

interface Allocation { buffer: GPUBuffer; size: number; usage: number }
interface BatchState {
  device: GPUDevice;
  encoder: GPUCommandEncoder;
  status: ComputeBatch['status'];
  owned: Allocation[];
  page: Allocation | null;
  cursor: number;
  steps: Array<(cancelled: boolean) => void>;
  encoding: number;
}

const states = new WeakMap<ComputeBatch, BatchState>();
const pools = new WeakMap<GPUDevice, Allocation[]>();
const PAGE_SIZE = 65536;
const POOL_BYTES = 1024 * 1024;

function take(state: BatchState, size: number, usage: number): Allocation {
  const pool = pools.get(state.device) ?? [];
  pools.set(state.device, pool);
  const bytes = Math.ceil(size / 256) * 256;
  const index = pool.findIndex((entry) => entry.usage === usage && entry.size >= bytes);
  const entry = index < 0
    ? { buffer: state.device.createBuffer({ size: bytes, usage, label: 'wgpu-kit batch' }), size: bytes, usage }
    : pool.splice(index, 1)[0]!;
  state.owned.push(entry);
  return entry;
}

function retire(state: BatchState, reuse: boolean): void {
  const pool = pools.get(state.device) ?? [];
  let bytes = pool.reduce((sum, entry) => sum + entry.size, 0);
  for (const entry of state.owned) {
    if (reuse && pool.length < 16 && bytes + entry.size <= POOL_BYTES) {
      pool.push(entry);
      bytes += entry.size;
    } else entry.buffer.destroy();
  }
  pools.set(state.device, pool);
  state.owned = [];
  state.page = null;
}

function stateFor(batch: ComputeBatch, encoder: GPUCommandEncoder, device: GPUDevice): BatchState {
  const state = states.get(batch);
  if (!state || state.status !== 'open' || state.encoder !== encoder || state.device !== device) {
    throw new UsageError(ERR.USAGE, 'Batch requires its own open encoder/device');
  }
  return state;
}

export function validateBatch(batch: ComputeBatch, encoder: GPUCommandEncoder, device: GPUDevice): void {
  stateFor(batch, encoder, device);
}

function settleSteps(state: BatchState, cancelled: boolean): void {
  for (const settle of state.steps) settle(cancelled);
  state.steps = [];
}

export function withBatchStep(batch: ComputeBatch, settle: ((cancelled: boolean) => void) | undefined, encode: () => void): void {
  const state = states.get(batch);
  if (!state || state.status !== 'open') throw new UsageError(ERR.USAGE, 'Batch is closed');
  if (settle) state.steps.push(settle);
  state.encoding++;
  try {
    encode();
    if (state.status !== 'open') throw new UsageError(ERR.USAGE, 'Batch is closed');
  } catch (error) {
    if (state.status === 'open') batch.cancel();
    throw error;
  } finally {
    state.encoding--;
  }
}

export function batchUniform(batch: ComputeBatch, encoder: GPUCommandEncoder, device: GPUDevice, data: ArrayBuffer): GPUBufferBinding {
  const state = stateFor(batch, encoder, device);
  const align = device.limits.minUniformBufferOffsetAlignment;
  let offset = Math.ceil(state.cursor / align) * align;
  if (!state.page || offset + data.byteLength > state.page.size) {
    state.page = take(state, Math.max(PAGE_SIZE, data.byteLength), GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
    offset = 0;
  }
  state.cursor = offset + data.byteLength;
  device.queue.writeBuffer(state.page.buffer, offset, data);
  return { buffer: state.page.buffer, offset, size: data.byteLength };
}

export function batchStorage(batch: ComputeBatch, encoder: GPUCommandEncoder, device: GPUDevice, size: number): GPUBuffer {
  return take(stateFor(batch, encoder, device), size, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST).buffer;
}

export async function createBatch(): Promise<ComputeBatch> {
  const { device } = await GpuContext.get();
  const state: BatchState = { device, encoder: device.createCommandEncoder(), status: 'open', owned: [], page: null, cursor: 0, steps: [], encoding: 0 };
  const batch: ComputeBatch = {
    get encoder() { return state.encoder; },
    get status() { return state.status; },
    submit() {
      stateFor(batch, state.encoder, device);
      if (state.encoding) throw new UsageError(ERR.USAGE, 'encodeWith is active');
      try {
        device.queue.submit([state.encoder.finish()]);
      } catch (error) {
        state.status = 'cancelled';
        retire(state, false);
        settleSteps(state, true);
        throw error;
      }
      state.status = 'submitted';
      settleSteps(state, false);
      if (state.owned.length) {
        void device.queue.onSubmittedWorkDone().then(() => retire(state, true), () => retire(state, false));
      }
    },
    cancel() {
      if (state.status === 'cancelled') return;
      stateFor(batch, state.encoder, device);
      state.status = 'cancelled';
      retire(state, true);
      settleSteps(state, true);
    },
  };
  states.set(batch, state);
  return batch;
}
