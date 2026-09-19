/**
 * 带去重与降级的 shader 编译检查。
 *
 * ① 去重:同一 device 上相同 code 的模块直接复用(GPUShaderModule 创建后
 *    不可变,跨管线共享安全)。
 *
 * ② 降级:CI 的 SwiftShader 在页面 GPU 负载累积后,getCompilationInfo 会
 *    对一切新模块抛 "Instance dropped"(OperationError,连唯一代码的首查
 *    都失败)。此时返回 messages: [] 继续编译 —— 编译错误并不会被掩盖:
 *    管线创建/首.dispatch 会触发 uncapturederror,各验证页都有监听。
 *    健康环境(真 GPU / smoke 页)下查询照常工作,CompileError 行号映射
 *    不受影响。
 */
const MODULE_CACHE = new WeakMap<GPUDevice, Map<string, { module: GPUShaderModule; messages: readonly GPUCompilationMessage[] }>>();

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
  } catch (e) {
    console.warn(`[wgpu-kit] getCompilationInfo unavailable (${String((e as Error)?.message ?? e).slice(0, 60)}); skipping compile-info check for "${label}"`);
    const result = { module, messages: [] as readonly GPUCompilationMessage[] };
    cache.set(code, result);
    return result;
  }
  const result = { module, messages };
  cache.set(code, result);
  return result;
}
