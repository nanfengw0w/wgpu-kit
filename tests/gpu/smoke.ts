/**
 * src/core 的 GPU 冒烟测试(替代原计划的卷积 spike):
 * 用真实 GPU 验证 elementKernel 的通用性——向量加、uniform、就地更新、
 * PingPong、rawKernel 逃生舱、CompileError 行号映射、Usage 校验。
 * 由 harness(scripts/verify.mjs)无头运行;页面契约同 spike。
 */
import { GpuContext, Buffer, elementKernel, rawKernel, PingPong, CompileError, UsageError } from '../../src/index.ts';

const results: Array<{ name: string; pass: boolean; detail?: string }> = [];
const report = (name: string, pass: boolean, detail = '') => {
  results.push({ name, pass, detail });
  (window as any).__results = results;
};
(window as any).__results = results;

const near = (a: number, b: number, eps = 1e-4) => Math.abs(a - b) <= eps;

async function main() {
  const ctx = await GpuContext.get();
  (window as any).__adapter = ctx.adapterInfo;
  report('context-adapter', true, ctx.adapterInfo);

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
      const mapped = msg.includes('用户代码第 2 行');
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
