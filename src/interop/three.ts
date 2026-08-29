import type { ParticlesSim } from '../packs/particles/index.ts';

/**
 * three.js 互通(interop)—— 快照模式,零依赖、通用任何渲染器(WebGL/WebGPU)。
 *
 * const { points, update } = threePoints(sim, THREE, { size: 0.02 });
 * scene.add(points);
 * // 每帧渲染前:
 * await update();
 *
 * 原理:从 GPU 读回位置快照填进 BufferAttribute(每帧一次 readback)。
 * 零拷贝的 TSL storage 直通路径在路线图上(对渲染器有强绑定,不在 MVP 承诺内)。
 */

/** three.js 最小表面(按需注入,避免硬依赖) */
export interface ThreeAPI {
  Points: new (geometry: unknown, material: unknown) => unknown;
  BufferGeometry: new () => unknown;
  BufferAttribute: new (array: Float32Array, itemSize: number) => {
    set: (arr: ArrayLike<number>) => void;
    needsUpdate: boolean;
  };
  PointsMaterial: new (params: { size?: number; color?: number; sizeAttenuation?: boolean }) => unknown;
}

export interface ThreePointsHandle {
  /** 加进场景的 THREE.Points 实例 */
  points: unknown;
  /** 同步一帧位置快照(await;每帧调用) */
  update(): Promise<void>;
  dispose(): void;
}

export function threePoints(
  sim: ParticlesSim,
  THREE: ThreeAPI,
  opts: { size?: number; color?: number } = {},
): ThreePointsHandle {
  const { pos } = sim.buffers();
  const count = pos.length;
  const positions = new Float32Array(count * 3); // three 需要 vec3,z=0

  const geometry = new THREE.BufferGeometry();
  const attr = new THREE.BufferAttribute(positions, 3);
  (geometry as { setAttribute: (name: string, a: unknown) => void }).setAttribute('position', attr);

  const material = new THREE.PointsMaterial({
    size: opts.size ?? 0.015,
    color: opts.color ?? 0x8fb4ff,
    sizeAttenuation: true,
  });
  const points = new THREE.Points(geometry, material);

  return {
    points,
    async update() {
      const data = (await pos.read()) as Float32Array;
      for (let i = 0; i < count; i++) {
        positions[i * 3] = data[i * 2] ?? 0;
        positions[i * 3 + 1] = data[i * 2 + 1] ?? 0;
        positions[i * 3 + 2] = 0;
      }
      attr.needsUpdate = true;
    },
    dispose() {
      sim.destroy();
    },
  };
}
