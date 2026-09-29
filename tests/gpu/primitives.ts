/**
 * core 原语层验证页:scan / reduce。
 * 所有断言对 CPU 参考做 u32 位一致比较(回绕算术)。
 * 覆盖历史返工点:空输入、非 2 幂、单 workgroup 容量边界(65536±1)、
 * 多档路径(70000)、重复执行残留、全零/全一模式。
 */
import { createScan, createReduce, Buffer } from '../../src/index.ts';

const results: Array<{ name: string; pass: boolean; detail?: string }> = [];
(window as unknown as { __results: unknown }).__results = results;
const report = (name: string, pass: boolean, detail = '') => {
  results.push({ name, pass, detail });
  document.getElementById('out')!.textContent = results.map((r) => `${r.pass ? 'PASS' : 'FAIL'} ${r.name}: ${r.detail}`).join('\n');
};

/** 可复现伪随机(u32) */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s;
  };
}

function cpuScan(src: Uint32Array, exclusive: boolean): Uint32Array<ArrayBuffer> {
  const out = new Uint32Array(src.length);
  let run = 0;
  for (let i = 0; i < src.length; i++) {
    out[i] = exclusive ? run : (run + src[i]!) >>> 0;
    run = (run + src[i]!) >>> 0;
  }
  return out;
}

function bitwiseEq(a: Uint32Array, b: Uint32Array): number {
  if (a.length !== b.length) return -1;
  let diff = -1;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) { diff = i; break; }
  }
  return diff;
}

function makeSrc(n: number, mode: 'random' | 'zeros' | 'ones'): Uint32Array<ArrayBuffer> {
  const a = new Uint32Array(n);
  if (mode === 'random') {
    const r = lcg(0x9e3779b9 ^ n);
    for (let i = 0; i < n; i++) a[i] = r() % 1000;
  } else if (mode === 'ones') {
    a.fill(1);
  }
  return a;
}

async function main() {
  const scan = createScan();
  const reduce = createReduce();
  await scan.prepare();
  await reduce.prepare();

  // —— scan:排他 + 含前缀,随机输入,跨单/多档边界 ——
  const COUNTS = [1, 255, 256, 257, 1000, 65535, 65536, 65537, 70000];
  for (const n of COUNTS) {
    const src = makeSrc(n, 'random');
    const srcBuf = await Buffer.create('u32', Math.max(n, 1));
    const dstBuf = await Buffer.create('u32', Math.max(n, 1));
    if (n > 0) srcBuf.write(src);
    for (const exclusive of [true, false]) {
      await scan.run(srcBuf, dstBuf, n, exclusive);
      const got = (await dstBuf.read()) as Uint32Array;
      const want = cpuScan(src.subarray(0, n), exclusive);
      const diff = n === 0 ? -1 : bitwiseEq(got.subarray(0, n), want);
      const tier = n <= 65536 ? '单档' : '多档';
      report(
        `scan N=${n} ${exclusive ? 'exclusive' : 'inclusive'}(${tier})`,
        diff === -1,
        diff === -1 ? '位一致 ✓' : `首个差异位 ${diff}: got ${got[diff]} want ${want[diff]}`,
      );
    }
    srcBuf.destroy();
    dstBuf.destroy();
  }

  // —— scan:全零 / 全一 模式(多档) ——
  for (const mode of ['zeros', 'ones'] as const) {
    const n = 70000;
    const src = makeSrc(n, mode);
    const srcBuf = await Buffer.create('u32', n);
    const dstBuf = await Buffer.create('u32', n);
    srcBuf.write(src);
    await scan.run(srcBuf, dstBuf, n, true);
    const got = (await dstBuf.read()) as Uint32Array;
    const want = cpuScan(src, true);
    const diff = bitwiseEq(got, want);
    report(`scan ${mode} N=${n}(多档)`, diff === -1, diff === -1 ? '位一致 ✓' : `首个差异位 ${diff}`);
    srcBuf.destroy();
    dstBuf.destroy();
  }

  // —— scan:重复执行必须一致(专杀残留状态类 bug) ——
  {
    const n = 1000;
    const src = makeSrc(n, 'random');
    const srcBuf = await Buffer.create('u32', n);
    const dstBuf = await Buffer.create('u32', n);
    srcBuf.write(src);
    await scan.run(srcBuf, dstBuf, n, true);
    const first = (await dstBuf.read()) as Uint32Array;
    await scan.run(srcBuf, dstBuf, n, true);
    const second = (await dstBuf.read()) as Uint32Array;
    let same = true;
    for (let i = 0; i < n; i++) if (first[i] !== second[i]) { same = false; break; }
    report('scan 重复执行一致', same, same ? '两次位一致 ✓' : '两次结果不同 ← 残留状态 bug');
    srcBuf.destroy();
    dstBuf.destroy();
  }

  // —— scan:count=0 no-op ——
  {
    const srcBuf = await Buffer.create('u32', 1);
    const dstBuf = await Buffer.create('u32', 1);
    await scan.run(srcBuf, dstBuf, 0, true);
    const got = (await dstBuf.read()) as Uint32Array;
    report('scan count=0 no-op', got[0] === 0, `dst[0]=${got[0]}(期 0,不写不炸)`);
    srcBuf.destroy();
    dstBuf.destroy();
  }

  // —— reduce:随机输入各规模 ——
  for (const n of [0, 1, 257, 70000]) {
    const src = makeSrc(n, 'random');
    const srcBuf = await Buffer.create('u32', Math.max(n, 1));
    if (n > 0) srcBuf.write(src);
    let want = 0;
    for (let i = 0; i < n; i++) want = (want + src[i]!) >>> 0;
    const got = await reduce.sum(srcBuf, n);
    report(`reduce sum N=${n}`, got === want, `got ${got} want ${want}`);
    srcBuf.destroy();
  }

  scan.destroy();
  reduce.destroy();
}

main()
  .then(() => report('summary-done', results.every((r) => r.pass), `${results.filter((r) => r.pass).length}/${results.length}`))
  .catch((e) => report('fatal', false, String((e as Error).message ?? e).slice(0, 300)))
  .finally(() => {
    (window as unknown as { __done: boolean }).__done = true;
    console.log('[RESULT]', JSON.stringify(results));
  });
