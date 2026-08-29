/**
 * fields + image 包的 GPU 验证页。
 * fields:vortex/curl 流场跑 N 帧后信息素图应有结构(标准差/峰值);
 * image:合成测试图(黑底白块)过 invert/blur/edge,读回像素断言。
 */
import { flow } from '../../src/packs/fields/index.ts';
import { applyImage } from '../../src/packs/image/index.ts';

const results: Array<{ name: string; pass: boolean; detail?: string }> = [];
(window as unknown as { __results: unknown }).__results = results;
const report = (name: string, pass: boolean, detail = '') => {
  results.push({ name, pass, detail });
  document.getElementById('out')!.textContent = results.map((r) => `${r.pass ? '✓' : '✗'} ${r.name}: ${r.detail}`).join('\n');
};

async function main() {
  {
    const { GpuContext } = await import('../../src/core/context.ts');
    const g = await GpuContext.get();
    g.device.addEventListener?.('uncapturederror', (e: Event) => {
      report('gpu-validation-error', false, String((e as GPUUncapturedErrorEvent).error?.message ?? e).slice(0, 200));
    });
  }

  // —— 诊断:裸 writeTexture → copyTextureToBuffer → readback ——
  {
    const { GpuContext } = await import('../../src/core/context.ts');
    const g = await GpuContext.get();
    const t = g.device.createTexture({ size: [4, 4], format: 'rgba8unorm', usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC });
    g.device.queue.writeTexture({ texture: t }, new Uint8Array([
      255,0,0,255, 0,255,0,255, 0,0,255,255, 255,255,255,255,
      1,2,3,255, 5,6,7,255, 9,10,11,255, 13,14,15,255,
      16,17,18,255, 19,20,21,255, 22,23,24,255, 25,26,27,255,
      28,29,30,255, 31,32,33,255, 34,35,36,255, 37,38,39,255,
    ]), { bytesPerRow: 16, rowsPerImage: 4 }, [4, 4]);
    const staging = g.device.createBuffer({ size: 256 * 4, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const enc = g.device.createCommandEncoder();
    enc.copyTextureToBuffer({ texture: t }, { buffer: staging, bytesPerRow: 256, rowsPerImage: 4 }, [4, 4]);
    g.device.queue.submit([enc.finish()]);
    await staging.mapAsync(GPUMapMode.READ);
    const px = new Uint8Array(staging.getMappedRange().slice(0));
    staging.unmap();
    report('gpu-raw', px[0] === 255 && px[4] === 0 && px[256] === 1, `R=${px[0]} G=${px[1]} 第二行首=${px[256]}`);
    t.destroy(); staging.destroy();
  }

  // —— fields:vortex + curl ——
  for (const field of ['vortex', 'curl'] as const) {
    const sim = await flow({ count: 65_536, mapSize: 256, field, seed: 'verify', speed: 0.006 });
    for (let i = 0; i < 60; i++) sim.tick();
    const t = await sim.sampleTrail();
    let finite = true; let maxv = 0; let sum = 0; let n = 0;
    for (let i = 0; i < t.length; i += 31) {
      const v = t[i]!;
      if (!Number.isFinite(v)) { finite = false; break; }
      if (v > maxv) maxv = v;
      sum += v; n++;
    }
    const mean = sum / n;
    report(`fields-${field}`, finite && maxv > 30 && mean > 0.1, `峰值 ${maxv.toFixed(0)} 均值 ${mean.toFixed(2)}(阈值 30/0.1,流线在沉积)`);
    {
      const { GpuContext } = await import('../../src/core/context.ts');
      (await GpuContext.get()).sync();
    }
    sim.destroy();
  }

  // 把 vortex 画到页面 canvas 供肉眼复核
  {
    const sim = await flow({ count: 65_536, mapSize: 256, field: 'vortex', seed: 'verify' });
    await sim.attach(document.getElementById('flowCv') as HTMLCanvasElement);
    for (let i = 0; i < 120; i++) sim.tick();
    sim.destroy();
  }

  // —— image:合成测试图 + 读回断言 ——
  const src = document.createElement('canvas');
  src.width = 64; src.height = 64;
  {
    const c = src.getContext('2d')!;
    c.fillStyle = '#000';
    c.fillRect(0, 0, 64, 64);
    c.fillStyle = '#fff';
    c.fillRect(20, 20, 24, 24); // 中心白块
  }

  // invert:白块变黑,背景变白(GPU readback 直读,headless 的 drawImage 会拿空帧)
  {
    const target = document.getElementById('imgCv') as HTMLCanvasElement;
    const r = await applyImage(src, target, [{ op: 'invert' }]);
    const px = await r.readback();
    const at = (x: number, y: number) => px[(y * 64 + x) * 4]!;
    const center = at(32, 32); // 原 255 → 0
    const corner = at(4, 4);   // 原 0 → 255
    report('image-invert', center < 40 && corner > 215, `中心 ${center}(期 <40) 角落 ${corner}(期 >215)`);
  }

  // blur:锐利边缘变中灰
  {
    const target = document.createElement('canvas');
    target.width = 64; target.height = 64;
    const r = await applyImage(src, target, [{ op: 'blur', radius: 2 }]);
    const px = await r.readback();
    const at = (x: number, y: number) => px[(y * 64 + x) * 4]!;
    const edgeInside = at(21, 20); // 白块边缘内侧,应被模糊到中灰
    const center = at(32, 32);     // 白块中心,应保持亮
    report('image-blur', edgeInside > 60 && edgeInside < 230 && center > 200, `边缘内侧 ${edgeInside}(期 60..230) 中心 ${center}(期 >200)`);
  }

  // edge:白块边界亮,块内/块外暗
  {
    const target = document.createElement('canvas');
    target.width = 64; target.height = 64;
    const r = await applyImage(src, target, [{ op: 'edge', amount: 1 }]);
    const px = await r.readback();
    const at = (x: number, y: number) => px[(y * 64 + x) * 4]!;
    const border = at(20, 20); // 白块角上,sobel 强响应
    const center = at(32, 32); // 平坦区,应接近 0
    report('image-edge', border > 40 && center < 40, `边界 ${border}(期 >40) 平坦区 ${center}(期 <40)`);
  }
}

main()
  .then(() => report('summary-done', results.every((r) => r.pass), `${results.filter((r) => r.pass).length}/${results.length}`))
  .catch((e) => report('fatal', false, String((e as Error).message ?? e).slice(0, 300)))
  .finally(() => {
    (window as unknown as { __done: boolean }).__done = true;
    console.log('[RESULT]', JSON.stringify(results));
  });
