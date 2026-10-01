# wgpu-kit showcase · 展示站

This showcase was imported from the user-provided `wgpu-kit-showcase-source.zip` and integrated into the wgpu-kit repository. It preserves the bilingual star-field homepage, live studies, twenty examples, API reference, reading preferences and original static design.

本展示站来自用户提供的 `wgpu-kit-showcase-source.zip`，现已集成到 wgpu-kit 仓库。保留双语星空首页、交互实验、二十个示例、API 参考、阅读偏好和原有静态设计。

Run from the repository root / 从仓库根目录运行：

```sh
npm ci
npm run build
npm run build:playground
npm run check:playground
npm run dev
# http://127.0.0.1:5178/wgpu-kit/
```

`dev` builds the showcase and serves it only on localhost. To serve an existing build, use `npm run dev -- --no-build`; `--port=5179` selects another port. Building is independent of the current working directory. Build the library first: the showcase imports this repository's own `wgpu-kit` package exports.

`dev` 会构建展示站并仅在本机提供预览。已有构建可用 `npm run dev -- --no-build` 启动；`--port=5179` 可选择其他端口。构建不依赖当前工作目录。请先构建库：展示站直接引用本仓库的 `wgpu-kit` 包导出。

Source lives in `src/`, structured documentation and example metadata in `content/`, and styles, fonts, previews and licenses in `public/`. `scripts/build.mjs` generates the site in the repository's ignored `dist-playground/` directory. Routes, search URLs, downloads and navigation use the GitHub Pages project base `/wgpu-kit/`. The Source link downloads the official GitHub source archive; the supplied ZIP is not copied into the repository.

源码位于 `src/`，结构化文档和示例元数据位于 `content/`，样式、字体、预览图和许可证位于 `public/`。`scripts/build.mjs` 将完整站点生成到仓库已忽略的 `dist-playground/`。路由、搜索、下载和导航统一使用 GitHub Pages 项目基路径 `/wgpu-kit/`。Source 入口下载官方 GitHub 源码归档，不在仓库中复制用户 ZIP。

The imported API documentation was audited against published 2.0.0 declarations and implementation. The runtime and visible current version come from the local repository package. Fixed 2.0.0 source/package links retain the original audit provenance. Preview assets and third-party licenses are retained. The archive's generated site and historical QA results are not included as source or claimed as validation of this integration.

导入的 API 文档原先依据已发布的 2.0.0 声明和实现核对。运行库和当前可见版本来自本仓库；固定的 2.0.0 源码、npm 链接保留原审计依据。预览素材和第三方许可证已保留。ZIP 中的生成站点和历史 QA 结果未作为源码纳入，也不作为本次接入的验证结论。

Live studies require WebGPU over localhost or HTTPS and keep the original unavailable-device states. These studies are application/example code; they do not add library packs or exports.

交互实验需要在 localhost 或 HTTPS 中使用 WebGPU，并保留原有设备不可用提示。这些实验属于应用示例，不增加库的领域包或导出。

`.github/workflows/showcase.yml` provides manual GitHub Pages deployment through `workflow_dispatch` only. Building or previewing locally does not publish the site.

`.github/workflows/showcase.yml` 仅通过 `workflow_dispatch` 提供手动 GitHub Pages 部署；本地构建和预览不会发布网站。
