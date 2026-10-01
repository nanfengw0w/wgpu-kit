# Measuring compute / 计算测量

This document describes the local benchmark procedure. It does not promise a frame rate, speedup or bundle size across devices. The README focuses on the public API and capabilities.

本文说明本地基准测量方法，不承诺跨设备帧率、加速比或包体积。README 聚焦公开 API 和实际能力。

## Run / 运行

```sh
npm run bundle:tests
npm run bench
```

Use a WebGPU-capable local Chrome or Edge browser. `tests/gpu/bench.ts` and `scripts/bench.mjs` are the implementation. Record device, browser, algorithm, input size and warm-up conditions with any result.

使用支持 WebGPU 的本地 Chrome 或 Edge。测量实现位于 `tests/gpu/bench.ts` 和 `scripts/bench.mjs`。记录设备、浏览器、算法、输入规模及预热条件。

## Interpret results / 理解结果

- Synchronous latency waits for submitted GPU work after each step and includes host/GPU round-trip costs. / 同步延迟逐步等待 GPU 完成，包含主机与 GPU 往返开销。
- The bounded in-flight pump measures completion over a sequence of submissions; it also includes host scheduling. / 有界在途测量统计一组提交的完成时间，也包含主机调度开销。
- `ParticlesSim.stats().fps` counts `tick()` calls over elapsed host time. It does not establish completed or presented GPU frames. / `ParticlesSim.stats().fps` 统计主机时间内的 `tick()` 次数，不能等同于 GPU 完成或实际呈现帧率。
- `timeGpu()` measures a queue interval and may include gaps and unrelated queued work. / `timeGpu()` 测量队列区间，可能包含提交间隔和其他排队工作。

Compare algorithms in the same session with the same inputs. Do not copy one device's measurements into general performance claims.

算法比较应在同一会话、相同输入下进行。单设备测量不能直接作为通用性能承诺。
