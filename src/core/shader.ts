/**
 * 带去重与缓存绕行的 shader 编译。
 *
 * ① 去重:同一 device 上相同 code 的模块直接复用(GPUShaderModule 创建后
 *    不可变,跨管线共享安全)——本就该做的工程优化,同时物理上消灭了
 *    "相同代码二次编译"这一触发点。
 *
 * ② 绕行:CI 的 SwiftShader 上,Dawn 对相同代码的模块走缓存命中路径,该
 *    路径的 getCompilationInfo 会抛 "Instance dropped"(部分环境确定性
 *    复现)。若首查失败:先试唯一 alias 副本(真实类型声明,改变缓存键 ——
 *    注释会被 Tint 归一化,改注释没用),仍失败则直接抛给上层。
 */
const MODULE_CACHE = new WeakMap<GPUDevice, Map<string, { module: GPUShaderModule; messages: readonly GPUCompilationMessage[] }>>();
let bypassCounter = 0;

export async function createShaderModuleChecked(
  device: GPUDevice,
  code: string,
  label: string,
): Promise<{ module: GPUShaderModule; messages: readonly GPUCompilationMessage[] }> {
  let cache = MODULE_CACHE.get(device);
  if (!cache) {
    cache = new Map();
    MODULE_CACHE.set(device, cache);
  }
  const hit = cache.get(code);
  if (hit) return hit;

  const module = device.createShaderModule({ code, label });
  let messages: readonly GPUCompilationMessage[];
  try {
    messages = (await module.getCompilationInfo()).messages;
  } catch {
    bypassCounter += 1;
    const retryModule = device.createShaderModule({
      code: `${code}\nalias _wgpuKitBypass${bypassCounter} = u32;`,
      label,
    });
    messages = (await retryModule.getCompilationInfo()).messages;
    cache.set(code, { module: retryModule, messages });
    return { module: retryModule, messages };
  }
  const result = { module, messages };
  cache.set(code, result);
  return result;
}
