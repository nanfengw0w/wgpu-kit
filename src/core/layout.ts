/** WGSL 类型布局表:尺寸、对齐、组件数、对应的 TypedArray。库替用户算字节数的根据。 */
export type ScalarKind =
  | 'f32' | 'i32' | 'u32'
  | 'vec2f' | 'vec2i' | 'vec2u'
  | 'vec3f'
  | 'vec4f';

export interface TypeDef {
  /** 字节数(uniform/标量语义) */
  readonly size: number;
  /** **storage 数组元素步长**(WGSL 规则:array<vec3f> 步长 16,与 size 12 不同) */
  readonly stride: number;
  /** 字节对齐(WGSL 规则:vec3 对齐到 16) */
  readonly align: number;
  /** 分量数 */
  readonly comps: number;
  readonly typed: 'Float32Array' | 'Int32Array' | 'Uint32Array';
  readonly wgsl: string;
}

export const TYPES: Record<ScalarKind, TypeDef> = {
  f32:   { size: 4,  stride: 4,  align: 4,  comps: 1, typed: 'Float32Array', wgsl: 'f32' },
  i32:   { size: 4,  stride: 4,  align: 4,  comps: 1, typed: 'Int32Array',   wgsl: 'i32' },
  u32:   { size: 4,  stride: 4,  align: 4,  comps: 1, typed: 'Uint32Array',  wgsl: 'u32' },
  vec2f: { size: 8,  stride: 8,  align: 8,  comps: 2, typed: 'Float32Array', wgsl: 'vec2f' },
  vec2i: { size: 8,  stride: 8,  align: 8,  comps: 2, typed: 'Int32Array',   wgsl: 'vec2i' },
  vec2u: { size: 8,  stride: 8,  align: 8,  comps: 2, typed: 'Uint32Array',  wgsl: 'vec2u' },
  vec3f: { size: 12, stride: 16, align: 16, comps: 3, typed: 'Float32Array', wgsl: 'vec3f' },
  vec4f: { size: 16, stride: 16, align: 16, comps: 4, typed: 'Float32Array', wgsl: 'vec4f' },
};

export function alignTo(offset: number, align: number): number {
  return Math.ceil(offset / align) * align;
}

export interface UniformField {
  readonly name: string;
  readonly kind: ScalarKind;
  /** 在 uniform struct 中的字节偏移(与 WGSL 自然对齐规则一致) */
  readonly offset: number;
}

export interface UniformLayout {
  readonly fields: readonly UniformField[];
  /** 总字节数,向上取整到 16 的倍数(uniform 绑定安全尺寸) */
  readonly size: number;
}

/**
 * 按声明顺序规划 uniform 布局。声明顺序 = WGSL struct 成员顺序 = 用户函数参数顺序,
 * 三者由库保证一致,不给用户对齐自由(对齐是库的事)。
 */
export function planUniform(entries: ReadonlyArray<readonly [string, ScalarKind]>): UniformLayout {
  const fields: UniformField[] = [];
  let cursor = 0;
  for (const [name, kind] of entries) {
    const def = TYPES[kind];
    cursor = alignTo(cursor, def.align);
    fields.push({ name, kind, offset: cursor });
    cursor += def.size;
  }
  return { fields, size: alignTo(Math.max(cursor, 1), 16) };
}

const PACKERS: Record<string, (v: DataView, o: number, x: number) => void> = {
  f32: (v, o, x) => v.setFloat32(o, x, true),
  i32: (v, o, x) => v.setInt32(o, x, true),
  u32: (v, o, x) => v.setUint32(o, x, true),
};

/** 把标量值按布局写进 ArrayBuffer;缺失字段报错,多余字段忽略前给出字段清单便于排错 */
export function packUniform(layout: UniformLayout, values: Readonly<Record<string, number>>): ArrayBuffer {
  const buf = new ArrayBuffer(layout.size);
  const view = new DataView(buf);
  for (const f of layout.fields) {
    const pack = PACKERS[f.kind];
    if (!pack) {
      throw new Error(`uniform 字段 ${f.name} 的类型 ${f.kind} 暂不支持(当前仅支持标量)`);
    }
    const v = values[f.name];
    if (v === undefined) throw new Error(`缺少 uniform 值: ${f.name}`);
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      throw new Error(`uniform 值 ${f.name} 必须是有限数字,收到: ${String(v)}`);
    }
    pack(view, f.offset, v);
  }
  return buf;
}

/** packUniform 的零分配变体:写入调用方提供的缓冲(每帧路径用,避免 new ArrayBuffer) */
export function packUniformInto(target: ArrayBuffer, layout: UniformLayout, values: Readonly<Record<string, number>>): void {
  const view = new DataView(target);
  for (const f of layout.fields) {
    const pack = PACKERS[f.kind];
    if (!pack) {
      throw new Error(`uniform 字段 ${f.name} 的类型 ${f.kind} 暂不支持(当前仅支持标量)`);
    }
    const v = values[f.name];
    if (v === undefined) throw new Error(`缺少 uniform 值: ${f.name}`);
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      throw new Error(`uniform 值 ${f.name} 必须是有限数字,收到: ${String(v)}`);
    }
    pack(view, f.offset, v);
  }
}
