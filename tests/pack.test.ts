import { describe, expect, it } from 'vitest';
import { definePack, registerPack, getUserPack, listUserPacks } from '../src/core/pack.ts';
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
    expect(getUserPack('test-pack-a')?.name).toBe('test-pack-a');
    expect(listUserPacks().some((x) => x.name === 'test-pack-a')).toBe(true);
    expect(() => registerPack(p)).toThrow(UsageError);
  });

  it('内置包已注册(particles;fields/image 已于 v2.0 删除)', async () => {
    // 根入口 import 时注册;这里直接验证注册表可见
    const { listPacks } = await import('../src/index.ts');
    const names = listPacks().map((x) => x.name);
    expect(names).toContain('particles');
    expect(names).not.toContain('fields');
  });

  it('内置名不可被用户注册覆盖(外部审查 P1-5)', async () => {
    const { registerPack, listPacks, getPack } = await import('../src/index.ts');
    expect(() =>
      registerPack({ name: 'particles', description: 'imposter', create: async () => fakeSim() }),
    ).toThrow(UsageError);
    // 枚举仍只有一份,查找返回内置实现
    const names = listPacks().map((x) => x.name);
    expect(names.filter((n) => n === 'particles')).toHaveLength(1);
    expect(getPack('particles')?.description).not.toBe('imposter');
  });

  it('getPack 携带 config 泛型(外部审查 P2-1)', async () => {
    const { getPack } = await import('../src/index.ts');
    const p = getPack<{ count?: number }>('particles');
    expect(p).toBeDefined();
    // create 接受声明的 config 类型(编译期检查;此处验证运行时可调用)
    expect(typeof p!.create).toBe('function');
  });
});
