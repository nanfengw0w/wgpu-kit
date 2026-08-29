import { describe, it, expect } from 'vitest';
import { TYPES, planUniform, packUniform, alignTo } from '../src/core/layout.ts';

describe('layout: WGSL 类型表', () => {
  it('vec3f 对齐 16(WGSL 规则)', () => {
    expect(TYPES.vec3f).toMatchObject({ size: 12, align: 16 });
    expect(TYPES.vec2f).toMatchObject({ size: 8, align: 8 });
    expect(TYPES.f32).toMatchObject({ size: 4, align: 4 });
  });
});

describe('planUniform: 偏移与对齐', () => {
  it('标量顺序紧排', () => {
    const l = planUniform([['dt', 'f32'], ['count', 'u32']]);
    expect(l.fields[0]).toEqual({ name: 'dt', kind: 'f32', offset: 0 });
    expect(l.fields[1]).toEqual({ name: 'count', kind: 'u32', offset: 4 });
    expect(l.size).toBe(16); // 8B → 取整到 16
  });

  it('f32 后跟 vec2f:对齐补到 8', () => {
    const l = planUniform([['a', 'f32'], ['b', 'vec2f']]);
    expect(l.fields[1]!.offset).toBe(8);
    expect(l.size).toBe(16);
  });

  it('u32 后跟 vec3f:对齐补到 16', () => {
    const l = planUniform([['a', 'u32'], ['b', 'vec3f']]);
    expect(l.fields[1]!.offset).toBe(16);
    expect(l.size).toBe(32);
  });

  it('alignTo', () => {
    expect(alignTo(0, 16)).toBe(0);
    expect(alignTo(1, 8)).toBe(8);
    expect(alignTo(16, 16)).toBe(16);
  });
});

describe('packUniform: 小端打包与校验', () => {
  it('按布局写入小端字节', () => {
    const l = planUniform([['dt', 'f32'], ['n', 'u32']]);
    const buf = packUniform(l, { dt: 0.5, n: 7 });
    const v = new DataView(buf);
    expect(v.getFloat32(0, true)).toBe(0.5);
    expect(v.getUint32(4, true)).toBe(7);
  });

  it('缺字段/非法值报错', () => {
    const l = planUniform([['dt', 'f32']]);
    expect(() => packUniform(l, {})).toThrow(/缺少 uniform/);
    expect(() => packUniform(l, { dt: NaN })).toThrow(/有限数字/);
    expect(() => packUniform(l, { dt: Infinity })).toThrow(/有限数字/);
  });

  it('多余字段被忽略', () => {
    const l = planUniform([['dt', 'f32']]);
    expect(() => packUniform(l, { dt: 1, extra: 2 })).not.toThrow();
  });
});
