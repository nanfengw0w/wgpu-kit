import { Buffer } from './buffer.ts';
import { type ScalarKind } from './layout.ts';

type Side<K extends string, F extends Record<K, ScalarKind>> = { [P in K]: Buffer<F[P]> };
type CreateResult<F extends string | Record<string, ScalarKind>> = Exclude<F, string> extends infer Fields extends Record<string, ScalarKind>
  ? keyof Fields extends string ? PingPong<keyof Fields, Fields> : PingPong<string>
  : never;

/** Two buffer sides: read current, write other, then swap. Field names and kinds are preserved. */
export class PingPong<K extends string, F extends Record<K, ScalarKind> = Record<K, ScalarKind>> {
  #sides: [Side<K, F>, Side<K, F>];
  #names: readonly K[];
  #length: number;
  #kinds: F;
  #index = 0;

  private constructor(names: readonly K[], kinds: F, length: number, a: Side<K, F>, b: Side<K, F>) {
    this.#names = names;
    this.#kinds = kinds;
    this.#length = length;
    this.#sides = [a, b];
  }

  static create<const F extends string | Record<string, ScalarKind>>(kinds: Exclude<F, string>, length: number): Promise<CreateResult<F>>;
  static create<K extends string>(kinds: Record<K, ScalarKind>, length: number): Promise<PingPong<K>>;
  static async create(kinds: Record<string, ScalarKind>, length: number): Promise<PingPong<string>> {
    type K = string;
    const names = Object.keys(kinds) as K[];
    if (names.length === 0) throw new Error('PingPong requires at least one field');
    const make = async (): Promise<Record<K, Buffer>> => {
      const side = {} as Record<K, Buffer>;
      for (const name of names) side[name] = await Buffer.create(kinds[name]!, length);
      return side;
    };
    return new PingPong<K>(names, kinds, length, await make(), await make());
  }

  /** 当前帧的数据侧(渲染/读回用) */
  get current(): Side<K, F> {
    return this.#sides[this.#index]!;
  }

  /** 另一侧(kernel 写入目标) */
  get other(): Side<K, F> {
    return this.#sides[1 - this.#index]!;
  }

  /** 帧末翻转 */
  swap(): void {
    this.#index = 1 - this.#index;
  }

  /** 以 (写侧, 读侧) 调用 fn 后自动 swap 的语法糖 */
  async runWith(fn: (write: Side<K, F>, read: Side<K, F>) => Promise<void>): Promise<void> {
    await fn(this.other, this.current);
    this.swap();
  }

  destroy(): void {
    for (const side of this.#sides) for (const b of Object.values(side) as Buffer[]) b.destroy();
  }

  /** 克隆一份同构 PingPong(同字段同长度) */
  async clone(): Promise<PingPong<K, F>> {
    // The saved declaration keeps field kinds unchanged.
    return PingPong.create<Record<string, ScalarKind>>(this.#kinds, this.#length) as unknown as Promise<PingPong<K, F>>;
  }

  get names(): readonly K[] {
    return this.#names;
  }
}
