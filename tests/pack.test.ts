import { describe, expect, it } from 'vitest';
import { definePack, registerPack, getPack, listPacks } from '../src/core/pack.ts';
import { UsageError } from '../src/core/errors.ts';

const fakeSim = () => ({ tick() {}, destroy() {} });

describe('pack 平台契约', () => {
  it('definePack 校验 name 与 create', () => {
    expect(() => definePack({ name: 'UPPER', create: async () => fakeSim() })).toThrow(UsageError);
    expect(() => definePack({ name: 'ok-name' } as never)).toThrow(UsageError);
    const p = definePack({ name: 'ok-name', description: 'd', create: async () => fakeSim() });
    expect(p.name).toBe('ok-name');
  });

  it('注册表:注册/枚举/防重复/防覆盖', () => {
    const p = definePack({ name: 'test-pack-a', create: async () => fakeSim() });
    registerPack(p);
    expect(getPack('test-pack-a')?.name).toBe('test-pack-a');
    expect(listPacks().some((x) => x.name === 'test-pack-a')).toBe(true);
    expect(() => registerPack(p)).toThrow(UsageError);
  });

  it('内置包已注册(particles/fields)', async () => {
    // 根入口 import 时注册;这里直接验证注册表可见
    const { listPacks } = await import('../src/index.ts');
    const names = listPacks().map((x) => x.name);
    expect(names).toContain('particles');
    expect(names).toContain('fields');
  });
});
