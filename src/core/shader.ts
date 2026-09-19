/**
 * 带一次重试的 shader 编译:CI 的 SwiftShader 上 Dawn 偶发抛
 * "Instance dropped error in getCompilationInfo"(基础设施级抖动,与代码
 * 无关)。Instance 掉了之后同一个 module 再查也会失败,所以重试 = 重建模块。
 */
const COMPILATION_RETRY_DELAY_MS = 150;

export async function createShaderModuleChecked(
  device: GPUDevice,
  code: string,
  label: string,
): Promise<{ module: GPUShaderModule; messages: readonly GPUCompilationMessage[] }> {
  for (let attempt = 0; ; attempt++) {
    const module = device.createShaderModule({ code, label });
    try {
      const info = await module.getCompilationInfo();
      return { module, messages: info.messages };
    } catch (e) {
      if (attempt >= 1) throw e;
      await new Promise((r) => setTimeout(r, COMPILATION_RETRY_DELAY_MS));
    }
  }
}
