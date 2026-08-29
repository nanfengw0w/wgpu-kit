/** 错误体系:所有错误说人话,给出定位与修复建议(章程原则 3)。 */

export class WgpuKitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** 环境无 WebGPU / 拿不到 adapter。 */
export class WebGPUUnavailableError extends WgpuKitError {
  constructor(reason: string) {
    super(
      `当前环境不可用 WebGPU: ${reason}\n` +
      '  排查:① 浏览器需 Chrome/Edge 113+ 或 Safari 18+;② 无头环境需开启 WebGPU;③ 检查 GPU 驱动与硬件加速设置。\n' +
      '  可用 navigator.gpu 是否存在快速判断。',
    );
  }
}

/** WGSL 编译错误,行号已映射回用户代码。 */
export class CompileError extends WgpuKitError {
  constructor(kernelName: string, messages: readonly { line: number; msg: string }[], userCodeOffset: number) {
    const mapped = messages
      .map((m) => {
        const userLine = m.line - userCodeOffset;
        const where = userLine > 0 ? `用户代码第 ${userLine} 行` : `生成代码第 ${m.line} 行(库的问题,欢迎报 issue)`;
        return `  ${where}: ${m.msg}`;
      })
      .join('\n');
    super(`kernel "${kernelName}" WGSL 编译失败:\n${mapped}`);
  }
}

/** 调用方使用不当(缺资源/类型不匹配/长度不一致等)。 */
export class UsageError extends WgpuKitError {}


/** 创建 compute 管线并用 pushErrorScope 捕获异步校验错误(超限等),把"黑屏刷屏"变成显式报错 */
export async function createComputePipelineChecked(
  device: GPUDevice,
  module: GPUShaderModule,
  label: string,
  entryPoint = 'main',
): Promise<GPUComputePipeline> {
  device.pushErrorScope('validation');
  const pipeline = device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint } });
  const err = await device.popErrorScope();
  if (err) {
    throw new WgpuKitError(`compute 管线 "${label}" 创建失败: ${err.message}
  常见原因:storage buffer 数超过每阶段上限(可向本库提 issue 申请 limits 支持)`);
  }
  return pipeline;
}
