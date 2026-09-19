/**
 * 带缓存绕行的 shader 编译。CI 的 SwiftShader 上,Dawn 对**相同代码**的模块
 * 走缓存命中路径,该路径的 getCompilationInfo 偶发(部分环境确定性)抛
 * "Instance dropped error in getCompilationInfo" —— 实测:同页第 3 次创建
 * 相同 WGSL 的模块必炸,而首建正常。
 * 绕行:失败后改用带唯一尾部注释的副本重取编译信息(绕开缓存;注释追加在
 * 末尾,不改语义、不偏移用户行号)。真有编译错误时 messages 照常返回。
 */
const CACHE_BYPASS_SUFFIX = '\n// wgpu-kit: compile-info cache bypass';

export async function createShaderModuleChecked(
  device: GPUDevice,
  code: string,
  label: string,
): Promise<{ module: GPUShaderModule; messages: readonly GPUCompilationMessage[] }> {
  const module = device.createShaderModule({ code, label });
  try {
    const info = await module.getCompilationInfo();
    return { module, messages: info.messages };
  } catch {
    // 缓存命中路径抖动:唯一副本绕行
    const retryModule = device.createShaderModule({ code: code + CACHE_BYPASS_SUFFIX, label });
    const info = await retryModule.getCompilationInfo();
    return { module: retryModule, messages: info.messages };
  }
}
