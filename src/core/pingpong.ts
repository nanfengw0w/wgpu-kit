import { Buffer } from './buffer.ts';
import { type ScalarKind } from './layout.ts';

/**
 * 双缓冲:模拟类 kernel 的绝对刚需(spike 中是 45 行仪式)。
 * A/B 两组同构缓冲,读"当前侧"、写"另一侧",swap 一次完成帧间翻转。
 * 泛型 K 保留字段名的字面量类型,Record 访问不会被 noUncheckedIndexedAccess 弄成 undefined。
 */
export class PingPong<K extends string> {
  #sides: [Record<K, Buffer>, Record<K, Buffer>];
  #names: readonly K[];
  #length: number;
  #kinds: Record<K, ScalarKind>;
  #index = 0;

  private constructor(names: readonly K[], kinds: Record<K, ScalarKind>, length: number, a: Record<K, Buffer>, b: Record<K, Buffer>) {
    this.#names = names;
    this.#kinds = kinds;
    this.#length = length;
    this.#sides = [a, b];
  }

  static async create<K extends string>(kinds: Record<K, ScalarKind>, length: number): Promise<PingPong<K>> {
    const names = Object.keys(kinds) as K[];
    if (names.length === 0) throw new Error('PingPong 至少需要一个字段');
    const make = async (): Promise<Record<K, Buffer>> => {
      const side = {} as Record<K, Buffer>;
      for (const name of names) side[name] = await Buffer.create(kinds[name], length);
      return side;
    };
    return new PingPong<K>(names, kinds, length, await make(), await make());
  }

  /** 当前帧的数据侧(渲染/读回用) */
  get current(): Record<K, Buffer> {
    return this.#sides[this.#index]!;
  }

  /** 另一侧(kernel 写入目标) */
  get other(): Record<K, Buffer> {
    return this.#sides[1 - this.#index]!;
  }

  /** 帧末翻转 */
  swap(): void {
    this.#index = 1 - this.#index;
  }

  /** 以 (写侧, 读侧) 调用 fn 后自动 swap 的语法糖 */
  async runWith(fn: (write: Record<K, Buffer>, read: Record<K, Buffer>) => Promise<void>): Promise<void> {
    await fn(this.other, this.current);
    this.swap();
  }

  destroy(): void {
    for (const side of this.#sides) for (const b of Object.values(side) as Buffer[]) b.destroy();
  }

  /** 克隆一份同构 PingPong(同字段同长度) */
  async clone(): Promise<PingPong<K>> {
    return PingPong.create(this.#kinds, this.#length);
  }

  get names(): readonly K[] {
    return this.#names;
  }
}
