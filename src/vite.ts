import type { ElementKernel } from './core/kernel.ts';

/**
 * kernel 热重载(Vite 插件 + 客户端助手)。
 *
 * 服务端:`wgpuKitHotReload()` 监听 *.wgsl 文件变化,把新代码推给浏览器;
 * 客户端:`hotKernel(kernel, import.meta.hot, './sim.wgsl')` 收到推送后调 kernel.replace。
 *
 * 用法(配合 Vite 的 ?raw 导入):
 *   import simSrc from './sim.wgsl?raw';
 *   const k = elementKernel({ state: {...}, code: simSrc });
 *   hotKernel(k, import.meta.hot, './sim.wgsl');
 */

interface HotContext {
  on(event: string, cb: (data: unknown) => void): void;
  off?(event: string, cb: (data: unknown) => void): void;
}

interface ViteHotUpdateCtx {
  file: string;
  read(): string | Promise<string>;
  server: { ws: { send(payload: { type: string; event: string; data: unknown }): void } };
}

interface VitePluginLike {
  name: string;
  apply?: string;
  handleHotUpdate?(ctx: ViteHotUpdateCtx): unknown;
}

export function wgpuKitHotReload(): VitePluginLike {
  return {
    name: 'wgpu-kit:hot-reload',
    handleHotUpdate(ctx) {
      if (!ctx.file.endsWith('.wgsl')) return;
      void (async () => {
        const code = await ctx.read();
        ctx.server.ws.send({ type: 'custom', event: 'wgpu-kit:kernel', data: { file: ctx.file, code } });
      })();
      return []; // 阻止 Vite 默认整页刷新,替换由 hotKernel 接管
    },
  };
}

/** 把 kernel 注册进热重载:对应 .wgsl 文件一变,自动 kernel.replace */
export function hotKernel(kernel: ElementKernel, hot: HotContext | undefined, file: string): void {
  if (!hot) return;
  const suffix = file.slice(file.lastIndexOf('/'));
  hot.on('wgpu-kit:kernel', (data) => {
    const d = data as { file?: string; code?: string };
    if (typeof d?.code === 'string' && typeof d.file === 'string' && d.file.endsWith(suffix)) {
      void kernel.replace(d.code).catch((e: unknown) => {
        // 热更新编译失败不打断运行,保留旧版并在控制台说人话
        console.error('[wgpu-kit] 热重载失败,保留旧版 kernel:', (e as Error).message);
      });
    }
  });
}
