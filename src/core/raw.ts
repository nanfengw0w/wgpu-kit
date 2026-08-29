import { GpuContext } from './context.ts';
import { CompileError, UsageError } from './errors.ts';

/**
 * rawKernel —— 逃生舱(章程原则 1)。
 * 用户给完整 WGSL(自己写 binding 声明),库只负责管线与提交,不做任何加工。
 */
export interface RawKernel {
  run(entries: GPUBindGroupEntry[], workgroups: number): Promise<void>;
  destroy(): void;
}

export function rawKernel(code: string, entryPoint = 'main', label = 'rawKernel'): RawKernel {
  if (typeof code !== 'string' || code.trim().length === 0) throw new UsageError('rawKernel 需要 WGSL 代码');
  let pipelinePromise: Promise<GPUComputePipeline> | null = null;

  return {
    async run(entries: GPUBindGroupEntry[], workgroups: number): Promise<void> {
      if (!Number.isInteger(workgroups) || workgroups < 1) {
        throw new UsageError(`rawKernel.run 的 workgroups 必须是正整数,收到 ${String(workgroups)}`);
      }
      const ctx = await GpuContext.get();
      if (!pipelinePromise) {
        pipelinePromise = (async () => {
          const module = ctx.device.createShaderModule({ code, label });
          const info = await module.getCompilationInfo();
          const errors = info.messages.filter((m) => m.type === 'error');
          if (errors.length > 0) {
            pipelinePromise = null;
            // 实测(Dawn/Edge 151):lineNum 已是 1-based
            throw new CompileError(label, errors.map((m) => ({ line: m.lineNum, msg: m.message })), 0);
          }
          return ctx.device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint } });
        })();
      }
      const pipeline = await pipelinePromise;
      const bg = ctx.device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries });
      const enc = ctx.device.createCommandEncoder();
      const pass = enc.beginComputePass();
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, bg);
      pass.dispatchWorkgroups(workgroups);
      pass.end();
      ctx.device.queue.submit([enc.finish()]);
    },
    destroy() { pipelinePromise = null; },
  };
}
