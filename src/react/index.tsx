import { useEffect, useRef, type CSSProperties } from 'react';
import { particles } from '../packs/particles/index.ts';
import type { ParticlesSim } from '../packs/particles/index.ts';
import type { ParticlesConfig } from '../packs/particles/config.ts';

/**
 * <ParticleCanvas /> —— particles 包的 React 绑定。
 *
 * <ParticleCanvas count={100_000} forces="cells" style={{ height: 400 }} />
 *
 * 设计约定:config 变化请通过 key 重建(声明式世界,整体替换);
 * 需要命令式操作时用 onReady 拿到 sim 实例(setForces/setParams/录制)。
 */
export interface ParticleCanvasProps extends ParticlesConfig {
  className?: string;
  style?: CSSProperties;
  /** sim 就绪(异步初始化完成)后回调;组件卸载后实例已销毁 */
  onReady?: (sim: ParticlesSim) => void;
}

export function ParticleCanvas(props: ParticleCanvasProps): JSX.Element {
  const { className, style, onReady, ...config } = props;
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    let raf = 0;
    let disposed = false;
    let sim: ParticlesSim | null = null;
    void (async () => {
      sim = await particles(config);
      if (disposed || !canvasRef.current) { sim.destroy(); return; }
      await sim.attach(canvasRef.current);
      onReady?.(sim);
      const loop = () => {
        if (disposed) return;
        sim?.tick();
        raf = requestAnimationFrame(loop);
      };
      raf = requestAnimationFrame(loop);
    })();
    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      sim?.destroy();
      sim = null;
    };
    // 刻意只在挂载时启动一次;config 变化请用 key 重建(声明式约定)
  }, []);

  return (
    <canvas
      ref={canvasRef}
      className={className}
      style={{ width: '100%', height: '100%', display: 'block', background: '#05070c', ...style }}
    />
  );
}
