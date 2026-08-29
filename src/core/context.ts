import { WebGPUUnavailableError } from './errors.ts';

/**
 * 设备上下文:全库单例,惰性申请 adapter/device。
 * 峰值性能偏好;失败给人话报错;device lost 以 promise 形式暴露。
 */
export class GpuContext {
  readonly device: GPUDevice;
  readonly adapterInfo: string;

  private constructor(device: GPUDevice, adapterInfo: string) {
    this.device = device;
    this.adapterInfo = adapterInfo;
  }

  static #singleton: Promise<GpuContext> | null = null;

  static get(): Promise<GpuContext> {
    if (!GpuContext.#singleton) {
      GpuContext.#singleton = GpuContext.#create().catch((e) => {
        GpuContext.#singleton = null; // 允许环境修复后重试
        throw e;
      });
    }
    return GpuContext.#singleton;
  }

  static async #create(): Promise<GpuContext> {
    if (typeof navigator === 'undefined' || !('gpu' in navigator) || !navigator.gpu) {
      throw new WebGPUUnavailableError('navigator.gpu 不存在');
    }
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) throw new WebGPUUnavailableError('requestAdapter() 返回 null');
    const info = adapter.info;
    const label = info
      ? [info.vendor, info.architecture, info.description].filter(Boolean).join(' / ') || 'unknown'
      : 'unknown';
    // 按适配器能力申请存储缓冲上限:grid 力核等大 binding 数内核需要 >8,
    // 而默认上限是 8(有头真机会直接判管线无效——v0.9.5 黑屏事故的根因)
    const requiredLimits: Record<string, number> = {};
    const want = [
      'maxStorageBuffersPerShaderStage',
      'maxStorageBuffersInVertexStage',
      'maxStorageBufferBindingSize',
    ] as const;
    for (const key of want) {
      const supported = (adapter.limits as unknown as Record<string, number>)[key];
      if (typeof supported === 'number') requiredLimits[key] = supported;
    }
    const device = await adapter.requestDevice({ label: 'wgpu-kit', requiredLimits });
    return new GpuContext(device, label);
  }

  /** device lost 时 reject;调用方可 await 做清理/提示 */
  get lost(): Promise<GPUDeviceLostInfo> {
    return this.device.lost;
  }

  /** 等待队列中已提交的全部 GPU 工作完成(测试/读回前同步用) */
  async sync(): Promise<void> {
    await this.device.queue.onSubmittedWorkDone();
  }
}
