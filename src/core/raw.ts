import { GpuContext } from './context.ts';
import { CompileError, ERR, UsageError } from './errors.ts';
import { createShaderModuleChecked } from './shader.ts';

/**
 * rawKernel —— 逃生舱(章程原则 1)。
 * 用户给完整 WGSL(自己写 binding 声明),库只负责管线与提交,不做任何加工。
 * [v2.0] 拆分 prepare/encode/run:encode 把 dispatch 写入调用方 encoder,
 * 多个 rawKernel 可与其他 kernel 组成同一计算链。
 */
export interface RawKernel {
  /** 异步准备:解析上下文、编译管线。幂等;encode 前必须完成 */
  prepare(): Promise<void>;
  /** 同步编码:写入调用方 encoder(不提交);须先 prepare() */
  encode(encoder: GPUCommandEncoder, entries: GPUBindGroupEntry[], workgroups: number): void;
  /** 便捷路径 = prepare + encode + 内部提交 */
  run(entries: GPUBindGroupEntry[], workgroups: number): Promise<void>;
  destroy(): void;
}

export function rawKernel(code: string, entryPoint = 'main', label = 'rawKernel'): RawKernel {
  if (typeof code !== 'string' || code.trim().length === 0) throw new UsageError(ERR.USAGE, 'rawKernel requires WGSL code');
  let pipeline: GPUComputePipeline | null = null;
  let cachedCtx: GpuContext | null = null;

  return {
    async prepare(): Promise<void> {
      if (pipeline) return;
      const ctx = await GpuContext.get();
      cachedCtx = ctx;
      const { module, messages } = await createShaderModuleChecked(ctx.device, code, label);
      const errors = messages.filter((m) => m.type === 'error');
      if (errors.length > 0) {
        // 实测(Dawn/Edge 151):lineNum 已是 1-based
        throw new CompileError(label, errors.map((m) => ({ line: m.lineNum, msg: m.message })), 0);
      }
      pipeline = ctx.device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint } });
    },

    encode(encoder: GPUCommandEncoder, entries: GPUBindGroupEntry[], workgroups: number): void {
      if (!Number.isInteger(workgroups) || workgroups < 1) {
        throw new UsageError(ERR.USAGE, `rawKernel.encode workgroups must be a positive integer, got ${String(workgroups)}`);
      }
      if (!pipeline || !cachedCtx) {
        throw new UsageError(ERR.USAGE, `rawKernel "${label}".encode called before prepare() — await kernel.prepare() first`);
      }
      const bg = cachedCtx.device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries });
      const pass = encoder.beginComputePass();
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, bg);
      pass.dispatchWorkgroups(workgroups);
      pass.end();
    },

    async run(entries: GPUBindGroupEntry[], workgroups: number): Promise<void> {
      await this.prepare();
      const device = cachedCtx!.device;
      const enc = device.createCommandEncoder();
      this.encode(enc, entries, workgroups);
      device.queue.submit([enc.finish()]);
    },

    destroy() { pipeline = null; },
  };
}
