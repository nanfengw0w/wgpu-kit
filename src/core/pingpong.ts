import { Buffer } from './buffer.ts';
import { type ScalarKind } from './layout.ts';
import { type ComputeBatch, withBatchStep } from './batch.ts';
import { ERR, UsageError } from './errors.ts';

type Side<K extends string, F extends Record<K, ScalarKind>> = { [P in K]: Buffer<F[P]> };
type CreateResult<F extends string | Record<string, ScalarKind>> = Exclude<F, string> extends infer Fields extends Record<string, ScalarKind>
  ? keyof Fields extends string ? PingPong<keyof Fields, Fields> : PingPong<string>
  : never;

export class PingPong<K extends string, F extends Record<K, ScalarKind> = Record<K, ScalarKind>> {
  #sides: [Side<K, F>, Side<K, F>];
  #names: readonly K[];
  #length: number;
  #kinds: F;
  #index = 0;
  #batch: ComputeBatch | null = null;
  #encoding = false;
  #running = 0;

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

  get current(): Side<K, F> {
    return this.#sides[this.#index]!;
  }

  get other(): Side<K, F> {
    return this.#sides[1 - this.#index]!;
  }

  swap(): void {
    if (this.#batch || this.#encoding) throw new UsageError(ERR.USAGE, 'PingPong is busy');
    this.#index = 1 - this.#index;
  }

  async runWith(fn: (write: Side<K, F>, read: Side<K, F>) => Promise<void>): Promise<void> {
    if (this.#batch || this.#encoding) throw new UsageError(ERR.USAGE, 'PingPong is busy');
    this.#running++;
    try {
      await fn(this.other, this.current);
      this.swap();
    } finally {
      this.#running--;
    }
  }

  /** Encode and swap; cancellation restores the initial side. */
  encodeWith(batch: ComputeBatch, fn: (write: Side<K, F>, read: Side<K, F>) => undefined): void {
    if (this.#encoding || this.#running || (this.#batch && this.#batch !== batch)) {
      throw new UsageError(ERR.USAGE, 'PingPong is busy');
    }
    const initial = this.#index;
    withBatchStep(batch, this.#batch ? undefined : (cancelled) => {
      if (cancelled) this.#index = initial;
      this.#batch = null;
    }, () => {
      this.#batch = batch;
      this.#encoding = true;
      try {
        const result: unknown = fn(this.other, this.current);
        if (result && typeof (result as PromiseLike<unknown>).then === 'function') {
          void Promise.resolve(result).catch(() => {});
          throw new UsageError(ERR.USAGE, 'encodeWith must be synchronous');
        }
      } finally {
        this.#encoding = false;
      }
    });
    this.#index = 1 - this.#index;
  }

  destroy(): void {
    for (const side of this.#sides) for (const b of Object.values(side) as Buffer[]) b.destroy();
  }

  async clone(): Promise<PingPong<K, F>> {
    return PingPong.create<Record<string, ScalarKind>>(this.#kinds, this.#length) as unknown as Promise<PingPong<K, F>>;
  }

  get names(): readonly K[] {
    return this.#names;
  }
}
