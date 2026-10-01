# wgpu-kit working notes / 工作说明

## Current scope / 当前范围

Version 2.0.1 updates the showcase, bilingual documentation and package hygiene. The core API is unchanged. The user reviewed the draft and approved GitHub submission and npm publication. Future releases still require user authorization.

2.0.1 仅整理展示站、中英文文档和发布内容，核心 API 不变。用户已审查草稿并批准提交 GitHub 和发布 npm。后续发布仍需用户授权。

## Source map / 源码结构

- `src/core/`: context, buffers, kernels, layouts, schema and pack registry. / 设备、缓冲、内核、布局、schema 和注册表。
- `src/primitives/`: scan and reduce with GPU-resident outputs. / 输出常驻 GPU 的扫描与归约。
- `src/packs/`: particles and the reusable neighbor grid. / 粒子与通用邻域网格。
- `playground/`: imported showcase source, content and static assets; output goes to `dist-playground/`. / 新展示站源码、内容和静态资源，生成物位于 `dist-playground/`。
- `tests/`: required unit, type and GPU regression sources. Bundles are generated locally and ignored. / 必要单元、类型和 GPU 回归源码，bundle 本地生成并忽略。

## Validation / 验证

Use `npm run typecheck`, `npm test`, `npm run build`, `npm run check:playground`, `npm run build:playground` and `npm run audit:package`. GPU probes use `npm run bundle:tests` followed by `scripts/verify.mjs`. Keep review outputs outside tracked source.

依次检查库类型、单元测试、库构建、站点类型、站点构建和 npm 包内容。GPU 探针需先生成测试 bundle，再运行验证器。审查输出不得混入跟踪源码。

## Constraints / 约束

Preserve the existing compute API and numerical behavior. Do not add effect packs or rewrite core as part of this release cleanup. Explicit user instructions take precedence over these notes.

此次收尾保持计算 API 和数值行为，不新增特效包，不重写 core。用户明确要求优先于本文说明。
