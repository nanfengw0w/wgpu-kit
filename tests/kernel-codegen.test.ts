import { describe, it, expect } from 'vitest';
import { generateElementKernel, type ElementKernelSpec } from '../src/core/kernel.ts';
import { UsageError } from '../src/core/errors.ts';

describe('generateElementKernel: WGSL 代码生成', () => {
  const k = generateElementKernel({
    name: 'step',
    state: { pos: 'vec2f' },
    inputs: { sp: 'u32' },
    uniforms: { dt: 'f32', friction: 'f32' },
    workgroupSize: 128,
    code: 'fn stepFn(idx: u32, dt: f32, friction: f32) {\n  pos[idx] = pos[idx] + dt;\n}',
  });

  it('uniform struct 按声明顺序 + 自动注入 count', () => {
    expect(k.source).toContain('struct Params {');
    expect(k.source).toContain('  dt: f32,');
    expect(k.source).toContain('  friction: f32,');
    expect(k.source).toContain('  count: u32,');
  });

  it('binding 顺序:uniform@0,state read_write@1,inputs read@2', () => {
    expect(k.source).toContain('@group(0) @binding(0) var<uniform> params: Params;');
    expect(k.source).toContain('@group(0) @binding(1) var<storage, read_write> pos: array<vec2f>;');
    expect(k.source).toContain('@group(0) @binding(2) var<storage, read> sp: array<u32>;');
  });

  it('count 越界保护与 workgroup 大小', () => {
    expect(k.source).toContain('@compute @workgroup_size(128)');
    expect(k.source).toContain('if (idx >= params.count) { return; }');
  });

  it('用户函数按声明顺序收到 uniform', () => {
    expect(k.source).toContain('userFn(idx, params.dt, params.friction);');
  });

  it('用户代码整体附加在生成头之后,行号偏移正确', () => {
    const idx = k.source.indexOf('fn stepFn');
    expect(idx).toBeGreaterThan(0);
    const headerLines = k.source.slice(0, idx).split('\n').length;
    expect(k.userCodeLineOffset).toBe(headerLines - 1); // 用户代码第一行 = 头部之后
  });

  it('uniform 布局与生成 struct 一致(含 count)', () => {
    expect(k.uniformLayout.fields.map((f) => f.name)).toEqual(['dt', 'friction', 'count']);
  });
});

describe('generateElementKernel: 使用校验', () => {
  it('拒绝 uniform 占用保留名 count', () => {
    expect(() => generateElementKernel({ uniforms: { count: 'f32' }, state: { a: 'f32' }, code: 'fn f(i: u32) {}' }))
      .toThrow(UsageError);
  });

  it('拒绝空 state+inputs', () => {
    expect(() => generateElementKernel({ uniforms: { dt: 'f32' }, code: 'fn f(i: u32, dt: f32) {}' }))
      .toThrow(UsageError);
  });

  it('拒绝重复字段', () => {
    expect(() => generateElementKernel({ state: { a: 'f32' }, inputs: { a: 'f32' }, code: 'fn f(i: u32) {}' }))
      .toThrow(UsageError);
  });

  it('拒绝非法 workgroupSize', () => {
    expect(() => generateElementKernel({ state: { a: 'f32' }, code: 'fn f(i: u32) {}', workgroupSize: 0 })).toThrow(UsageError);
    expect(() => generateElementKernel({ state: { a: 'f32' }, code: 'fn f(i: u32) {}', workgroupSize: 600 })).toThrow(UsageError);
  });

  it('拒绝空 code', () => {
    expect(() => generateElementKernel({ state: { a: 'f32' }, code: '  ' })).toThrow(UsageError);
  });

  it('workgroupSize 默认 64', () => {
    const k = generateElementKernel({ state: { a: 'f32' }, code: 'fn f(i: u32) {}' });
    expect(k.source).toContain('@compute @workgroup_size(64)');
  });
});

describe('generateElementKernel: auxInputs', () => {
  it('辅助只读数组排在 state/inputs 后,保持已有 binding 与 uniform 布局', () => {
    const k = generateElementKernel({
      state: { out: 'f32' },
      inputs: { ids: 'u32' },
      auxInputs: { table: 'vec2f', weights: 'f32' },
      code: 'fn userFn(idx: u32) { out[idx] = table[ids[idx]].x * weights[0]; }',
    });
    expect(k.source).toContain('@binding(1) var<storage, read_write> out: array<f32>;');
    expect(k.source).toContain('@binding(2) var<storage, read> ids: array<u32>;');
    expect(k.source).toContain('@binding(3) var<storage, read> table: array<vec2f>;');
    expect(k.source).toContain('@binding(4) var<storage, read> weights: array<f32>;');
    expect(k.uniformLayout.fields.map((field) => field.name)).toEqual(['count']);
    expect([...k.normalized.usedBindings]).toEqual([0, 1, 2, 3, 4]);
  });

  it('拒绝 aux 与其他资源或 uniform 重名,也拒绝只有 aux 的内核', () => {
    const code = 'fn userFn(idx: u32) {}';
    const invalidSpecs: ElementKernelSpec[] = [
      { state: { table: 'f32' }, auxInputs: { table: 'f32' }, code },
      { inputs: { table: 'f32' }, auxInputs: { table: 'f32' }, code },
      { state: { out: 'f32' }, uniforms: { table: 'f32' }, auxInputs: { table: 'f32' }, code },
      { auxInputs: { table: 'f32' }, code },
    ];
    for (const spec of invalidSpecs) {
      expect(() => generateElementKernel(spec)).toThrow(UsageError);
    }
  });

  it('仅绑定可达 helper 使用的 aux,注释/死代码/struct 成员不构成使用', () => {
    const k = generateElementKernel({
      state: { out: 'f32' },
      auxInputs: { live: 'f32', commented: 'f32', dead: 'f32', member: 'f32' },
      code: `struct Item { member: f32, }
fn unused(idx: u32) -> f32 { return dead[idx]; }
fn lookup(idx: u32) -> f32 { return live[idx % arrayLength(&live)]; }
fn userFn(idx: u32) {
  // commented[0] is deliberately unused.
  let item = Item(1.0);
  out[idx] = lookup(idx) + item.member;
}`,
    });
    expect([...k.normalized.usedBindings]).toEqual([0, 1, 2]);
  });

  it('替换代码时重新分析 aux 使用,绑定编号与用户行号仍然稳定', () => {
    const spec = { state: { out: 'f32' as const }, auxInputs: { table: 'f32' as const } };
    const before = generateElementKernel({ ...spec, code: 'fn userFn(idx: u32) { out[idx] = 1.0; }' });
    const after = generateElementKernel({ ...spec, code: 'fn userFn(idx: u32) { out[idx] = table[0]; }' });
    expect([...before.normalized.usedBindings]).toEqual([0, 1]);
    expect([...after.normalized.usedBindings]).toEqual([0, 1, 2]);
    expect(before.source).toContain('@binding(2) var<storage, read> table: array<f32>;');
    expect(after.userCodeLineOffset).toBe(before.userCodeLineOffset);
  });
});
