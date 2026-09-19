import { WebGPUUnavailableError } from './errors.ts';

/**
 * 设备上下文:全库单例,惰性申请 adapter/device。
 * 峰值性能偏好;失败给人话报错;device lost 以 promise 形式暴露。
 */
export class GpuContext {
  readonly device: GPUDevice;
  readonly adapterInfo: string;
  /**
   * 必须持有 adapter 强引用:adapter 是 JS 侧到 Dawn Instance 的锚。若被 GC
   * 回收,设备的异步操作(mapAsync / getCompilationInfo)会随机 abort
   * "A valid external Instance reference no longer exists" —— 无头 SwiftShader
   * 上必现的重负载页面死亡根因(CI gpu-probes 第 2~7 跑的事故链)。
   */
  readonly #adapter: GPUAdapter;

  private constructor(device: GPUDevice, adapterInfo: string, adapter: GPUAdapter) {
    this.device = device;
    this.adapterInfo = adapterInfo;
    this.#adapter = adapter;
  }

  static #singleton: Promise<GpuContext> | null = null;

  /** 仅供设备丢失自动重建(observe.watchDevice)使用:重置单例 */
  static resetForTests(): void {
    GpuContext.#singleton = null;
  }

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
      throw new WebGPUUnavailableError('navigator.gpu is not available');
    }
    // 机器有真 GPU 时 high-performance 命中独显;无 GPU 的 CI/虚拟机/远程桌面
    // 场景再退到 forceFallbackAdapter(SwiftShader 软件适配器)——正确性一致,
    // 只是慢,让探针能在任何机器上跑起来而不是直接报"无 WebGPU"。
    const adapter =
      (await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' })) ??
      (await navigator.gpu.requestAdapter({ forceFallbackAdapter: true }));
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
    return new GpuContext(device, label, adapter);
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
