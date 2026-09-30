/**
 * 可观测性与健壮性助手(批次 2)。
 * —— 评审指出的"最大产品级缺口":GPGPU 库却看不到"这帧 GPU 花了多少"。
 */

import { GpuContext } from './core/context.ts';
import { ERR, UsageError } from './core/errors.ts';

/** 时间戳查询封装:测量一段 GPU 工作的真实耗时(毫秒)。
 *  Chrome/Edge 支持 timestamp-query;不支持的浏览器 reject。 */
export async function timeGpu(fn: (ctx: GpuContext) => void | Promise<void>): Promise<number> {
  const ctx = await GpuContext.get();
  const device = ctx.device;
  const featureOk = device.features.has('timestamp-query');
  if (!featureOk) throw new UsageError(ERR.TIMESTAMP_UNSUPPORTED, 'timestamp-query is not supported on this device (requires Chrome/Edge + a GPU with timestamp support)');

  const QUERY_POOL = 2;
  const querySet = device.createQuerySet({ type: 'timestamp', count: QUERY_POOL });
  const resolveBuf = device.createBuffer({
    size: QUERY_POOL * 8,
    usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC,
  });
  const readBuf = device.createBuffer({ size: QUERY_POOL * 8, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });

  // 新版 WebGPU 规范:时间戳通过 pass 的 timestampWrites 写入(无 encoder.writeTimestamp)。
  // [v2.0 三段提交,外部审查 P1-1 复核修复] ts0 与 fn 的提交必须处于**不同的
  // submit**:此前单 encoder 一次提交,fn 的提交先入队、双时间戳 pass 最后
  // 背靠背执行,包围的是空隙(Δ≈0)而非被测工作。
  {
    const enc0 = device.createCommandEncoder();
    const p0 = enc0.beginComputePass({ timestampWrites: { querySet, beginningOfPassWriteIndex: 0 } });
    p0.end();
    device.queue.submit([enc0.finish()]);
  }

  await fn(ctx);

  {
    const enc1 = device.createCommandEncoder();
    const p1 = enc1.beginComputePass({ timestampWrites: { querySet, beginningOfPassWriteIndex: 1 } });
    p1.end();
    enc1.resolveQuerySet(querySet, 0, QUERY_POOL, resolveBuf, 0);
    enc1.copyBufferToBuffer(resolveBuf, 0, readBuf, 0, QUERY_POOL * 8);
    device.queue.submit([enc1.finish()]);
  }
  // 口径:ts0→ts1 的 GPU 墙钟时间,含 fn 各次提交之间的空隙与队列排队;
  // 不区分 fn 内部有多少个 dispatch(per-pass 精确计时需编排层注入 timestampWrites)

  await readBuf.mapAsync(GPUMapMode.READ);
  const times = new BigInt64Array(readBuf.getMappedRange().slice(0));
  readBuf.unmap();
  querySet.destroy();
  resolveBuf.destroy();
  readBuf.destroy();

  // period = 1ns(按规范),换算毫秒
  const deltaNs = Number(times[1]! - times[0]!);
  return deltaNs / 1e6;
}

/** 设备诊断:注册错误/丢失回调;设备丢失时自动重建上下文并调用 onRebuild。
 *  长跑页面(展览/大屏)的必需品。 */
export function watchDevice(opts: {
  onError?: (message: string, recoverable: boolean) => void;
  onRebuild?: (ctx: GpuContext) => void;
}): void {
  void GpuContext.get().then((ctx) => {
    ctx.device.addEventListener?.('uncapturederror', (e) => {
      opts.onError?.(String((e as GPUUncapturedErrorEvent).error?.message ?? e), true);
    });
    void ctx.lost.then((info) => {
      opts.onError?.(`GPU device lost: ${info.reason}`, false);
      // 丢失后重置单例,下一次 GpuContext.get() 走全新设备
      (GpuContext as unknown as { resetForTests?: () => void }).resetForTests?.();
      void GpuContext.get().then((fresh) => opts.onRebuild?.(fresh)).catch(() => undefined);
    });
  });
}

/** 推荐的画布 canvas 格式(一行助手的语义化封装)。 */
export function preferredCanvasFormat(): GPUTextureFormat {
  return navigator.gpu.getPreferredCanvasFormat();
}

/** 画布 resize(DPR 上限策略):宽高物理像素 = clientSize × min(dpr, cap)。
 *  返回是否实际改变了尺寸(没变则无需重建)。 */
export function resizeCanvas(
  canvas: HTMLCanvasElement,
  dprCap = 2,
): boolean {
  const dpr = Math.min(window.devicePixelRatio || 1, dprCap);
  const w = Math.max(1, Math.floor(canvas.clientWidth * dpr));
  const h = Math.max(1, Math.floor(canvas.clientHeight * dpr));
  if (canvas.width === w && canvas.height === h) return false;
  canvas.width = w;
  canvas.height = h;
  return true;
}
