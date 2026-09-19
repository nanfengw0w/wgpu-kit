import { describe, expect, it } from 'vitest';
import { defineSchema } from '../src/core/schema.ts';
import { UsageError } from '../src/core/errors.ts';

describe('defineSchema.wgslStruct', () => {
  const S = defineSchema({ pos: 'vec2f', species: 'u32', home: 'vec3f' });

  it('按声明顺序生成 struct,成员与 fields 同源', () => {
    expect(S.wgslStruct('Particle')).toBe(
      'struct Particle {\n  pos: vec2f,\n  species: u32,\n  home: @size(16) vec3f,\n}',
    );
  });

  it('storage 语义下 vec3f 补 @size(16) 对齐步长,uniform 语义用自然布局', () => {
    expect(S.wgslStruct('P', 'uniform')).not.toContain('@size');
    expect(S.wgslStruct('P', 'storage')).toContain('@size(16)');
  });

  it('非法 struct 名拒绝', () => {
    expect(() => S.wgslStruct('0bad name')).toThrow(UsageError);
  });

  it('空 schema 拒绝', () => {
    expect(() => defineSchema({})).toThrow(UsageError);
  });
});
