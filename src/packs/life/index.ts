/**
 * life 包 —— 人工生命合集。每个模拟都是"简单规则 → 涌现复杂",
 * 引擎与渲染管线与 particles 包同源,每个模拟都是一条可发布的视频素材。
 */
export { turing, type TuringSim, type TuringConfig, type TuringPreset } from './turing.ts';
export { physarum, type PhysarumSim, type PhysarumConfig } from './physarum.ts';
export { boids, type BoidsSim, type BoidsConfig } from './boids.ts';
export { tentacles, type TentaclesSim, type TentaclesConfig } from './tentacles.ts';
export type { Colormap } from './map.ts';
