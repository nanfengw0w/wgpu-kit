/**
 * 类型化 schema 层:字段名与类型用 const 对象声明一次,三处受益——
 *   ① TS 类型:SchemaInfer 给出精确的行类型,字段拼错/类型不匹配在编辑器就报红;
 *   ② WGSL:wgslStruct() 由同一份声明生成 struct 代码,消灭"TS 字段表和
 *      WGSL struct 各写一份"的漂移(名称/顺序由库保证一致);
 *   ③ 缓冲:buffers() 生成与 elementKernel 绑定模型一致的逐字段 TypedBuffer。
 * 诚实边界:用户 WGSL 函数体内部的拼写错误仍由 WGSL 编译期报错(带用户行号
 * 映射)——完整 WGSL 类型检查是一个编译器工程,不在本层承诺范围内。
 */
import type { ScalarKind } from './layout.ts';
import { TYPES } from './layout.ts';
import { Buffer, type NumArray } from './buffer.ts';
import { ERR, UsageError } from './errors.ts';

export interface Vec2 { x: number; y: number }
export interface Vec3 { x: number; y: number; z: number }
export interface Vec4 { x: number; y: number; z: number; w: number }

/** ScalarKind → TS 行类型(编译期映射,本层类型安全的根基) */
export type KindOf<S extends ScalarKind> =
  S extends 'f32' | 'i32' | 'u32' ? number :
  S extends 'vec2f' | 'vec2i' | 'vec2u' ? Vec2 :
  S extends 'vec3f' ? Vec3 :
  S extends 'vec4f' ? Vec4 :
  never;

/** schema 声明 → TS 行类型。字段名逐字保留,拼错即编译错误。 */
export type SchemaInfer<F extends Record<string, ScalarKind>> = {
  readonly [K in keyof F]: KindOf<F[K]>;
};

const COMPS: Record<ScalarKind, number> = {
  f32: 1, i32: 1, u32: 1, vec2f: 2, vec2i: 2, vec2u: 2, vec3f: 3, vec4f: 4,
};
const COMP_NAMES = ['x', 'y', 'z', 'w'] as const;

function rowToFlat(kind: ScalarKind, row: unknown, index: number, out: NumArray, base: number): void {
  const comps = COMPS[kind];
  if (comps === 1) {
    if (typeof row !== 'number' || !Number.isFinite(row)) {
      throw new UsageError(ERR.BUFFER_WRITE, `schema row ${index} expects a finite number, got: ${typeof row}`);
    }
    out[base] = row;
    return;
  }
  if (typeof row !== 'object' || row === null) {
    throw new UsageError(ERR.BUFFER_WRITE, `schema row ${index} expects an object with ${comps} components, got: ${typeof row}`);
  }
  const rec = row as Record<string, unknown>;
  for (let c = 0; c < comps; c++) {
    const v = rec[COMP_NAMES[c]!];
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      throw new UsageError(ERR.BUFFER_WRITE, `schema row ${index} component "${COMP_NAMES[c]}" must be a finite number, got: ${String(v)}`);
    }
    out[base + c] = v;
  }
}

function flatToRow(kind: ScalarKind, flat: NumArray, i: number): number | Vec2 | Vec3 | Vec4 {
  const comps = COMPS[kind];
  const base = i * comps;
  if (comps === 1) return flat[base]!;
  if (comps === 2) return { x: flat[base]!, y: flat[base + 1]! };
  if (comps === 3) return { x: flat[base]!, y: flat[base + 1]!, z: flat[base + 2]! };
  return { x: flat[base]!, y: flat[base + 1]!, z: flat[base + 2]!, w: flat[base + 3]! };
}

/**
 * 单字段类型化缓冲:write/read 收发**行对象**(如 {x, y});原始 flat TypedArray
 * 走 raw.write/raw.read(章程原则 1:逃生舱常开)。
 */
export class TypedBuffer<K extends ScalarKind> {
  readonly raw: Buffer<K>;
  readonly kind: K;
  readonly length: number;

  private constructor(raw: Buffer<K>, kind: K) {
    this.raw = raw;
    this.kind = kind;
    this.length = raw.length;
  }

  static async create<K extends ScalarKind>(kind: K, length: number): Promise<TypedBuffer<K>> {
    return new TypedBuffer(await Buffer.create(kind, length), kind);
  }

  /** 行对象数组 → GPU */
  write(rows: ReadonlyArray<KindOf<K>>): void {
    const comps = COMPS[this.kind];
    const def = TYPES[this.kind];
    const flat = (def.typed === 'Float32Array' ? new Float32Array(rows.length * comps)
      : def.typed === 'Int32Array' ? new Int32Array(rows.length * comps)
      : new Uint32Array(rows.length * comps)) as NumArray;
    for (let i = 0; i < rows.length; i++) rowToFlat(this.kind, rows[i], i, flat, i * comps);
    this.raw.write(flat);
  }

  /** GPU → 行对象数组 */
  async read(): Promise<Array<KindOf<K>>> {
    const flat = await this.raw.read();
    const rows: Array<KindOf<K>> = new Array(this.length);
    for (let i = 0; i < this.length; i++) rows[i] = flatToRow(this.kind, flat, i) as KindOf<K>;
    return rows;
  }

  destroy(): void {
    this.raw.destroy();
  }
}

/** 逐字段缓冲集合:key 逐字保留 schema 字段名;raws() 直接喂 elementKernel.run() */
export type SchemaBuffers<F extends Record<string, ScalarKind>> = {
  readonly [K in keyof F]: TypedBuffer<F[K]>;
} & {
  /** 传给 elementKernel 的 run()/初始绑定:字段名 → 底层缓冲 */
  raws(): { readonly [K in keyof F]: Buffer<F[K]> };
  destroy(): void;
};

/** defineSchema 的返回值:同一份声明,喂类型、喂 WGSL、喂缓冲 */
export interface Schema<F extends Record<string, ScalarKind>> {
  /** 声明顺序即 WGSL struct 成员顺序;直接作 elementKernel 的 state */
  readonly fields: F;
  /**
   * 生成 `struct <name> { ... }`。storage 语义下 vec3f 成员补 @size(16)
   * (WGSL array 元素步长规则),与 CPU 侧 TYPES 步长一一对应,永不漂移。
   */
  wgslStruct(name: string, addressSpace?: 'storage' | 'uniform'): string;
  /** 逐字段缓冲(与 elementKernel 的绑定模型一致) */
  buffers(count: number): Promise<SchemaBuffers<F>>;
}

export function defineSchema<const F extends Record<string, ScalarKind>>(fields: F): Schema<F> {
  const keys = Object.keys(fields) as Array<keyof F & string>;
  if (keys.length === 0) {
    throw new UsageError(ERR.USAGE, 'defineSchema requires at least one field');
  }

  return {
    fields,

    wgslStruct(name: string, addressSpace = 'storage'): string {
      if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(name)) {
        throw new UsageError(ERR.USAGE, `wgslStruct name must be a valid WGSL identifier, got: "${name}"`);
      }
      const lines = keys.map((k) => {
        const def = TYPES[fields[k]!];
        // vec3f 在数组元素语义下步长 16 —— 显式 @size 让 GPU/CPU 永不漂移
        const pad = addressSpace === 'storage' && def.stride !== def.size ? ` @size(${def.stride})` : '';
        return `  ${k}:${pad} ${def.wgsl},`;
      });
      return `struct ${name} {\n${lines.join('\n')}\n}`;
    },

    async buffers(count: number): Promise<SchemaBuffers<F>> {
      const store = {} as Record<string, TypedBuffer<ScalarKind>>;
      for (const k of keys) {
        store[k] = await TypedBuffer.create(fields[k]!, count);
      }
      const raws = () => {
        const r = {} as Record<string, Buffer<ScalarKind>>;
        for (const k of keys) r[k] = store[k]!.raw;
        return r as { readonly [K in keyof F]: Buffer<F[K]> };
      };
      return Object.assign(store, {
        raws,
        destroy() {
          for (const k of keys) store[k]!.destroy();
        },
      }) as SchemaBuffers<F>;
    },
  };
}
