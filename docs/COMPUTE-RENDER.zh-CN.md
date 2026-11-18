# 在应用自有设备上组合计算与渲染

[English](COMPUTE-RENDER.md) · [完整可运行示例](examples/shared-device.html)

示例自行申请 WebGPU adapter 和 device，将该设备接入 wgpu-kit，计算动态颜色网格，
再用原生 WebGPU 绘制。计算与渲染使用同一个 storage 缓冲和 command encoder，
主渲染流程不把数据读回 JavaScript。

## 本地运行

在源码仓库中使用 Node.js 22，从仓库根目录安装依赖并构建：

```sh
npm ci
npm run build
```

以该根目录作为静态站点根目录，通过 HTTP localhost 提供文件。任何能正确返回
JavaScript MIME 类型的静态服务器都可以；例如已安装 Python 时：

```sh
python -m http.server 8000 --bind 127.0.0.1
```

在支持 WebGPU 的浏览器打开
[http://127.0.0.1:8000/docs/examples/shared-device.html](http://127.0.0.1:8000/docs/examples/shared-device.html)。
使用 HTTP localhost 或 HTTPS；直接通过 `file://` 打开 HTML 不具备所需的模块加载环境。

对于已包含此示例的安装包，可以改为在包根目录提供服务，例如 `node_modules/wgpu-kit`。
安装包中的 `dist/` 已经构建，不需要在安装包内执行源码构建。HTML 通过
`../../dist/index.js` 导入，因此仓库与安装包内的相对路径相同。示例不需要 CDN、
打包器或额外 JavaScript 依赖。若安装的是尚未收录此示例的历史包，请使用源码仓库。

## 跟随数据流阅读

1. 应用自行调用 `requestAdapter()`、`requestDevice()` 获取设备。
2. 在 `GpuBuffer.create()`、`prepare()`、`createBatch()` 等初始化操作之前调用
   `GpuContext.adopt(device)`。仅导入库不会创建 GPU 上下文；共享上下文一旦初始化，
   再接入设备会被拒绝。
3. `import { Buffer as GpuBuffer }` 为库的缓冲类型取本地别名，可与 Node 的 `Buffer`
   共存。`GpuBuffer.create('vec4f', 64 * 64)` 在接入设备上分配存储，
   `await kernel.prepare()` 完成计算管线编译。
4. 原生渲染器把 `colors.gpuBuffer` 绑定为只读 storage 数组。库缓冲具有 storage 用途，
   没有分配 `VERTEX` 用途；本示例在片元着色器中读取它。
5. 每帧创建一个 batch，先编码计算，再通过 `batch.encoder` 追加原生渲染 pass。
   同次提交中的 pass 顺序保证渲染能读取本次计算结果。`batch.submit()` 负责结束并提交
   该 encoder，不要另外手动结束或提交它。

`batch.submit()` 在完成提交后即返回，不等待 GPU 执行完成。帧循环不调用
`Buffer.read()`、`mapAsync()` 或 `GpuContext.sync()`。canvas 的 `data-frames` 属性和
`wgpu-kit-frame` 事件供浏览器检查已提交帧数，不代表 GPU 完成帧数或实际呈现帧数。

HTML 包含错误与设备丢失提示，以及停止按钮。同一时间最多存在一个待完成的异步帧。
若在等待 `createBatch()` 时停止，取得 batch 后会先取消，不继续编码。页面自行创建并
拥有设备，因此退出时会销毁设备；嵌入已有应用的组件应只清理自己的资源，保留共享设备。

## 应用已有原生 encoder 时

托管批次是可选路径。在完成相同初始化后，也可以使用应用自有 encoder 编码一帧：

```js
const encoder = device.createCommandEncoder();
kernel.encode(encoder, { colors }, { size, time });

const pass = encoder.beginRenderPass({
  colorAttachments: [{
    view: context.getCurrentTexture().createView(),
    clearValue: { r: 0, g: 0, b: 0, a: 1 },
    loadOp: 'clear', storeOp: 'store',
  }],
});
pass.setPipeline(pipeline);
pass.setBindGroup(0, bindings);
pass.draw(3);
pass.end();

device.queue.submit([encoder.finish()]);
kernel.endSubmit();
```

请在没有打开 pass 时调用 `encode()`。不传 `{ batch }` 时，每个内核实例在一次提交前
只能进行一次非零 count 的编码，因为原生路径共用一个 uniform 快照。应用提交后调用
`endSubmit()` 恢复该实例的编码检查。重复执行可使用不同实例、分次提交或托管批次。

若编码后放弃某个原生 encoder，必须保证以后不会再提交它。明确丢弃后，在重试前对
仅由该 encoder 使用的内核实例显式调用 `endSubmit()`，恢复检查状态。这只清除闸，
不会提交命令，也不会撤销资源写入或 `PingPong.swap()`。如果另一个使用同一实例的
encoder 仍待提交，就不能提前恢复检查。`resetEncodeGuard()` 会永久关闭检查，
不应作为常规错误恢复步骤。托管 batch 不需要 `endSubmit()`；取消 open batch 应调用
`batch.cancel()`，并由调用方自行恢复 CPU 状态。

这里演示的是原生 WebGPU 互通。共享设备本身不会自动实现某个上层渲染器的零拷贝接入。
`wgpu-kit/three` 仍是独立的快照适配器，会把位置读回 CPU。
