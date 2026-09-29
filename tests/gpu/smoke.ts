/**
 * src/core 的 GPU 冒烟测试(替代原计划的卷积 spike):
 * 用真实 GPU 验证 elementKernel 的通用性——向量加、uniform、就地更新、
 * PingPong、rawKernel 逃生舱、CompileError 行号映射、Usage 校验。
 * 由 harness(scripts/verify.mjs)无头运行;页面契约同 spike。
 */
import { GpuContext, Buffer, elementKernel, rawKernel, PingPong, CompileError, UsageError, defineSchema, particles, type Vec2 } from '../../src/index.ts';
import { timeGpu } from '../../src/observe.ts';

const results: Array<{ name: string; pass: boolean; detail?: string }> = [];
const report = (name: string, pass: boolean, detail = '') => {
  results.push({ name, pass, detail });
  (window as any).__results = results;
};
(window as any).__results = results;

const near = (a: number, b: number, eps = 1e-4) => Math.abs(a - b) <= eps;

async function main() {
  // T0 adopt:接入调用方自有设备(v2.0 资源契约)——必须先于任何 get();
  // 此后全部探针都跑在接入设备上,等于整页冒烟变成 adopt 路径的常测覆盖
  let adoptInfo = 'skipped: no adapter';
  {
    const adapter = (await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' }))
      ?? (await navigator.gpu.requestAdapter({ forceFallbackAdapter: true }));
    if (adapter) {
      const device = await adapter.requestDevice({ label: 'smoke-adopted' });
      adoptInfo = GpuContext.adopt(device).adapterInfo;
      const k = elementKernel({ name: 'adopt-probe', state: { x: 'f32' }, code: 'fn userFn(idx: u32) { x[idx] = 7.0; }' });
      const buf = await Buffer.create('f32', 8);
      await k.run({ x: buf });
      const got = (await buf.read()) as Float32Array;
      report('adopt-device', got[3] === 7, `设备 ${adoptInfo} · x[3]=${got[3]}(期 7;全库运行于接入设备)`);
      buf.destroy();
    } else {
      report('adopt-device', false, 'requestAdapter null(环境无适配器)');
    }
  }

  const ctx = await GpuContext.get();
  (window as any).__adapter = ctx.adapterInfo;
  report('context-adapter', true, `${ctx.adapterInfo} · adopt=${adoptInfo}`);

  // T1b 纹理读写回裸诊断(原 packages 页迁移):writeTexture → copyTextureToBuffer → mapAsync
  {
    const t = ctx.device.createTexture({ size: [4, 4], format: 'rgba8unorm', usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC });
    ctx.device.queue.writeTexture({ texture: t }, new Uint8Array([
      255,0,0,255, 0,255,0,255, 0,0,255,255, 255,255,255,255,
      1,2,3,255, 5,6,7,255, 9,10,11,255, 13,14,15,255,
      16,17,18,255, 19,20,21,255, 22,23,24,255, 25,26,27,255,
      28,29,30,255, 31,32,33,255, 33,34,35,255, 37,38,39,255,
    ]), { bytesPerRow: 16, rowsPerImage: 4 }, [4, 4]);
    const staging = ctx.device.createBuffer({ size: 256 * 4, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const enc = ctx.device.createCommandEncoder();
    enc.copyTextureToBuffer({ texture: t }, { buffer: staging, bytesPerRow: 256, rowsPerImage: 4 }, [4, 4]);
    ctx.device.queue.submit([enc.finish()]);
    await staging.mapAsync(GPUMapMode.READ);
    const px = new Uint8Array(staging.getMappedRange().slice(0));
    staging.unmap();
    report('gpu-texture-roundtrip', px[0] === 255 && px[4] === 0 && px[256] === 1, `R=${px[0]} G=${px[1]} 第二行首=${px[256]}`);
    t.destroy();
    staging.destroy();
  }

  // T1 向量加:inputs 只读 + state 写出
  {
    const n = 4096;
    const a = await Buffer.create('f32', n);
    const b = await Buffer.create('f32', n);
    const out = await Buffer.create('f32', n);
    const ha = new Float32Array(n).map(() => Math.random() * 100);
    const hb = new Float32Array(n).map(() => Math.random() * 100);
    a.write(ha); b.write(hb);
    const add = elementKernel({
      name: 'add',
      state: { out: 'f32' },
      inputs: { a: 'f32', b: 'f32' },
      code: 'fn userFn(idx: u32) {\n  out[idx] = a[idx] + b[idx];\n}',
    });
    await add.run({ out, a, b });
    const got = (await out.read()) as Float32Array;
    let ok = true;
    for (let i = 0; i < n; i++) { if (!near(got[i]!, ha[i]! + hb[i]!)) { ok = false; break; } }
    report('kernel-vector-add', ok, `n=${n}`);
  }

  // T2 uniform + vec2f 就地更新
  {
    const n = 1024;
    const pos = await Buffer.create('vec2f', n);
    const vel = await Buffer.create('vec2f', n);
    const hp = new Float32Array(n * 2).map(() => Math.random() * 2 - 1);
    const hv = new Float32Array(n * 2).map(() => Math.random() * 0.1);
    pos.write(hp); vel.write(hv);
    const dt = 0.02, friction = 0.914;
    const integrate = elementKernel({
      name: 'integrate',
      state: { pos: 'vec2f' },
      inputs: { vel: 'vec2f' },
      uniforms: { dt: 'f32', friction: 'f32' },
      code: 'fn userFn(idx: u32, dt: f32, friction: f32) {\n  pos[idx] = (pos[idx] + vel[idx] * dt) * friction;\n}',
    });
    await integrate.run({ pos, vel }, { dt, friction });
    const got = (await pos.read()) as Float32Array;
    let ok = true;
    for (let i = 0; i < n * 2; i++) {
      if (!near(got[i]!, (hp[i]! + hv[i]! * dt) * friction, 1e-5)) { ok = false; break; }
    }
    report('kernel-uniform-inplace', ok, `n=${n}, dt=${dt}`);
  }

  // T3 PingPong 身份与翻转
  {
    const pp = await PingPong.create({ pos: 'f32' }, 16);
    const a0 = pp.current.pos;
    const b0 = pp.other.pos;
    const identityOk = a0 !== b0 && pp.current.pos === a0;
    pp.swap();
    const swapOk = pp.current.pos === b0;
    report('pingpong-swap', identityOk && swapOk);
  }

  // T4 CompileError 行号映射
  {
    const k = elementKernel({
      name: 'broken',
      state: { pos: 'f32' },
      code: 'fn userFn(idx: u32) {\n  pos[idx] = nonsense_value;\n}', // 第 2 行故意错误
    });
    const buf = await Buffer.create('f32', 64);
    try {
      await k.run({ pos: buf });
      report('compile-error-mapping', false, '未抛出 CompileError');
    } catch (e) {
      const msg = String((e as Error).message);
      const isCompile = e instanceof CompileError;
      const mapped = msg.includes('your code, line 2');
      report('compile-error-mapping', isCompile && mapped, isCompile ? (mapped ? msg.split('\n')[1] ?? '' : `未映射到用户行: ${msg}`) : `类型错误: ${String(e)}`);
    }
  }

  // T5 rawKernel 逃生舱(u32 翻倍)
  {
    const n = 128;
    const buf = await Buffer.create('u32', n);
    buf.write(new Uint32Array(n).map((_, i) => i));
    const double = rawKernel(`
@group(0) @binding(0) var<storage, read_write> data: array<u32>;
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  if (gid.x >= arrayLength(&data)) { return; }
  data[gid.x] = data[gid.x] * 2u;
}
`, 'main', 'double');
    await double.run([{ binding: 0, resource: { buffer: buf.gpuBuffer } }], Math.ceil(n / 64));
    const got = (await buf.read()) as Uint32Array;
    let ok = true;
    for (let i = 0; i < n; i++) { if (got[i] !== i * 2) { ok = false; break; } }
    report('rawkernel-escape-hatch', ok, `n=${n}`);
  }

  // T6 Usage 校验(write 类型/长度,run 长度不一致)
  {
    const f = await Buffer.create('f32', 8);
    const u = await Buffer.create('u32', 8);
    let e1 = '';
    try { f.write(new Uint32Array(8)); } catch (err) { e1 = (err as Error).name; }
    let e2 = '';
    try { f.write(new Float32Array(7)); } catch (err) { e2 = (err as Error).name; }
    let e3 = '';
    const big = await Buffer.create('f32', 16);
    const k = elementKernel({ name: 'mismatch', state: { a: 'f32' }, inputs: { b: 'f32' }, code: 'fn userFn(idx: u32) { a[idx] = b[idx]; }' });
    try { await k.run({ a: f, b: big }); } catch (err) { e3 = (err as Error).name; }
    report('usage-validation', e1 === 'UsageError' && e2 === 'UsageError' && e3 === 'UsageError', `write-type=${e1} write-len=${e2} run-len=${e3}`);
  }

  // T7 kernel 热重载:replace 后行为改变;编译失败保持旧版
  {
    const n = 64;
    const buf = await Buffer.create('f32', n);
    const inp = await Buffer.create('f32', n);
    inp.write(new Float32Array(n).map((_, i) => i));
    const k = elementKernel({
      name: 'hot',
      state: { out: 'f32' },
      inputs: { a: 'f32' },
      code: 'fn userFn(idx: u32) {\n  out[idx] = a[idx] + 1.0;\n}',
    });
    await k.run({ out: buf, a: inp });
    let got = (await buf.read()) as Float32Array;
    const pass1 = got[10] === 11;
    await k.replace('fn userFn(idx: u32) {\n  out[idx] = a[idx] * 3.0;\n}');
    await k.run({ out: buf, a: inp });
    got = (await buf.read()) as Float32Array;
    const pass2 = got[10] === 30;
    let keptOld = false;
    try {
      await k.replace('fn userFn(idx: u32) {\n  out[idx] = nonsense;\n}');
    } catch { keptOld = true; }
    await k.run({ out: buf, a: inp });
    got = (await buf.read()) as Float32Array;
    const pass3 = keptOld && got[10] === 30;
    report('kernel-hot-reload', pass1 && pass2 && pass3, `加法=${pass1} 热替换=${pass2} 坏代码保持旧版=${pass3}`);
  }

  // T8 schema 类型化层:行对象 write/read 往返 + elementKernel 以 schema.fields
  // 作 state(字段名/顺序同源,raws() 直接喂 run)
  {
    const S = defineSchema({ pos: 'vec2f', species: 'u32' });
    const bufs = await S.buffers(4);
    bufs.pos.write([{ x: 1, y: 2 }, { x: 3, y: 4 }, { x: 5, y: 6 }, { x: 7, y: 8 }]);
    bufs.species.write([0, 1, 2, 3]);
    const k = elementKernel({
      name: 'schema-double',
      state: S.fields,
      code: 'fn userFn(idx: u32) {\n  pos[idx] = pos[idx] * 2.0;\n}',
    });
    await k.run(bufs.raws());
    const rows = await bufs.pos.read();
    const sp = await bufs.species.read();
    const roundtrip = rows[1]!.x === 6 && rows[1]!.y === 8 && rows[3]!.x === 14 && rows[3]!.y === 16;
    const speciesOk = sp[2] === 2;
    const shapeOk = 'x' in rows[0]! && 'y' in rows[0]!;
    const dump = rows.map((r) => `${(r as Vec2).x},${(r as Vec2).y}`).join(' ');
    report('schema-typed-buffers', roundtrip && speciesOk && shapeOk, `往返=${roundtrip} 接入=${speciesOk} 行对象=${shapeOk} dump=[${dump}] sp=[${sp.join(',')}]`);
    bufs.destroy();
  }

  // T9 生成的 WGSL struct 经**真实编译器**验证(双地址空间)
  // 背景:wgslStruct 曾生成属性后置的非法 WGSL(home: @size(16) vec3f),
  // 单测期望串镜像了同一个错误 —— 字符串比较不等于正确性,必须过编译器。
  {
    const S = defineSchema({ home: 'vec3f', mass: 'f32' });
    let ok = true;
    let why = '';
    for (const space of ['storage', 'uniform'] as const) {
      const decl = space === 'storage'
        ? 'var<storage, read_write> data: array<S>;'
        : 'var<uniform> params: S;';
      const code = `${S.wgslStruct('S', space)}\n@group(0) @binding(0) ${decl}\n@compute @workgroup_size(1)\nfn main() {}\n`;
      const m = ctx.device.createShaderModule({ code, label: `schema-struct-${space}` });
      const info = await m.getCompilationInfo();
      const errs = info.messages.filter((x) => x.type === 'error');
      if (errs.length > 0) { ok = false; why = `${space}: ${errs[0]!.message.slice(0, 100)}`; break; }
    }
    report('schema-struct-compiles', ok, ok ? 'storage+uniform 双语义真实编译通过' : why);
  }

  // T10 setParams({dt}) 必须真实生效:与"构造参数即目标值"的实例逐位一致
  // 背景:tick 曾读 cfg.dt 而 setParams 写 phys.dt —— 快照变了行为不变(死参数)
  {
    const base = { count: 256, mode: 'n2' as const, seed: 'dt-check', forces: 'random' as const };
    const a = await particles({ ...base, dt: 0.05 });
    const b = await particles({ ...base, dt: 0.02 });
    b.setParams({ dt: 0.05 });
    a.tick();
    b.tick();
    const pa = (await a.buffers().pos.read()) as Float32Array;
    const pb = (await b.buffers().pos.read()) as Float32Array;
    let maxD = 0;
    for (let i = 0; i < pa.length; i++) maxD = Math.max(maxD, Math.abs(pa[i]! - pb[i]!));
    report('setparams-dt-effective', maxD < 1e-6, `max|Δpos|=${maxD.toExponential(2)}(阈 1e-6;死参数时为有限差)`);
    a.destroy();
    b.destroy();
  }

  // T11 注释提及未用字段不得使内核失效(此前注释里的词被当作"已使用")
  {
    const n = 32;
    const out = await Buffer.create('f32', n);
    const inp = await Buffer.create('f32', n);
    inp.write(new Float32Array(n).map((_, i) => i));
    const k = elementKernel({
      name: 'comment-mention',
      state: { out: 'f32' },
      inputs: { a: 'f32', vel: 'f32' },
      code: '// vel is intentionally unused\nfn userFn(idx: u32) {\n  out[idx] = a[idx] + 1.0;\n}',
    });
    await k.run({ out, a: inp, vel: inp });
    const got = (await out.read()) as Float32Array;
    report('comment-field-ignored', got[5] === 6, `out[5]=${got[5]}(期 6;注释提及未用字段不得使 bind group 失配)`);
    out.destroy();
    inp.destroy();
  }

  // T12 向量 uniform:setParams 式传值 {x,y},kernel 以 vec2f 形参消费
  {
    const buf = await Buffer.create('vec2f', 4);
    const k = elementKernel({
      name: 'vec-uniform',
      state: { out: 'vec2f' },
      uniforms: { origin: 'vec2f' },
      code: 'fn userFn(idx: u32, origin: vec2f) { out[idx] = origin + vec2f(f32(idx), -f32(idx)); }',
    });
    await k.run({ out: buf }, { origin: { x: 10, y: 20 } });
    const rows = (await buf.read()) as Float32Array;
    const ok = rows[4] === 12 && rows[5] === 18;
    report('vector-uniform', ok, `out[2]=[${rows[4]},${rows[5]}](期 [12,18];uniform 向量化)`);
    buf.destroy();
  }

  // T13 编码合同:两个 kernel 写进同一条计算链(一次提交),效果串联
  // 背景:encode 合同是 v2.0 的头号特性,必须有直接探针——此前只有 run() 间接覆盖
  {
    const n = 64;
    const buf = await Buffer.create('f32', n);
    const ka = elementKernel({ name: 'chain-double', state: { x: 'f32' }, code: 'fn userFn(idx: u32) { x[idx] = x[idx] * 2.0; }' });
    const kb = elementKernel({ name: 'chain-inc', state: { y: 'f32' }, inputs: { a: 'f32' }, code: 'fn userFn(idx: u32) { y[idx] = a[idx] + 1.0; }' });
    await Promise.all([ka.prepare(), kb.prepare()]);
    const a = await Buffer.create('f32', n);
    a.write(new Float32Array(n).map((_, i) => i));
    const b = await Buffer.create('f32', n);
    // 链:x=数据 → A(×2 写 a) → B(a 读入 +1 写 b) —— 一次提交
    const enc = ctx.device.createCommandEncoder();
    ka.encode(enc, { x: a });
    kb.encode(enc, { y: b, a });
    ctx.device.queue.submit([enc.finish()]);
    await ctx.sync();
    const got = (await b.read()) as Float32Array;
    const ok = got[10] === 21 && got[63] === 127;
    report('encode-contract-chain', ok, `b[10]=${got[10]} b[63]=${got[63]}(期 21/127;双 kernel 单提交串联)`);
    buf.destroy();
    a.destroy();
    b.destroy();
  }

  // T14 timeGpu 三段提交修复:必须测得非零 GPU 时间(旧实现双时间戳背靠背,Δ≈0)
  // T14 timeGpu 三段提交修复:必须测得非零 GPU 时间(旧实现双时间戳背靠背,Δ≈0)
  // timestamp-query 需要设备特性;缺失时跳过(特性探针原则),不判失败
  if (ctx.device.features.has('timestamp-query')) {
    const buf = await Buffer.create('f32', 1 << 20); // 1M 元素,保证 GPU 时间 > 0
    const k = elementKernel({ name: 'timed', state: { x: 'f32' }, code: 'fn userFn(idx: u32) { x[idx] = x[idx] * 1.0000001 + 0.5; }' });
    const ms = await timeGpu(async () => {
      for (let i = 0; i < 20; i++) await k.run({ x: buf });
    });
    const ok = Number.isFinite(ms) && ms > 0 && ms < 5000;
    report('timegpu-brackets-work', ok, `${ms.toFixed(3)} ms(20 次提交;须 > 0 且 < 5000)`);
    buf.destroy();
  } else {
    report('timegpu-brackets-work', true, 'skipped: 设备不支持 timestamp-query(特性探针原则,真机验证)');
  }

  await ctx.sync();
}

main()
  .then(() => {
    report('summary-done', results.every((r) => r.pass), `${results.filter((r) => r.pass).length}/${results.length}`);
  })
  .catch((e) => {
    report('fatal', false, String(e?.message ?? e));
  })
  .finally(() => {
    (window as any).__done = true;
    console.log('[RESULT]', JSON.stringify(results));
  });
