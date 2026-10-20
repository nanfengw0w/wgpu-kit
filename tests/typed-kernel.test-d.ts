import type { Buffer } from '../src/core/buffer.ts';
import { elementKernel, type ElementKernel, type ElementKernelEncodeOptions } from '../src/core/kernel.ts';
import { PingPong } from '../src/core/pingpong.ts';
import { defineSchema } from '../src/core/schema.ts';
import { typedElementKernel, type TypedElementKernel, type TypedElementKernelResources, type TypedElementKernelUniforms } from '../src/core/typed-kernel.ts';
import type { ScalarKind } from '../src/core/layout.ts';

declare const encoder: GPUCommandEncoder;
declare const position: Buffer<'vec2f'>;
declare const velocity: Buffer<'vec2f'>;
declare const table: Buffer<'f32'>;
declare const indices: Buffer<'u32'>;
declare const batch: NonNullable<ElementKernelEncodeOptions['batch']>;

const spec = {
  state: { position: 'vec2f' },
  inputs: { velocity: 'vec2f' },
  auxInputs: { table: 'f32', indices: 'u32' },
  uniforms: { dt: 'f32', offset: 'vec2f' },
  code: 'fn userFn(i: u32, dt: f32, offset: vec2f) { position[i] += velocity[i] * dt + offset; }',
} as const;
const kernel: TypedElementKernel<typeof spec> = typedElementKernel(spec);
const resources: TypedElementKernelResources<typeof spec> = { position, velocity, table, indices };
const uniforms: TypedElementKernelUniforms<typeof spec> = { dt: 0.02, offset: { x: 1, y: 2 } };
const run: Promise<void> = kernel.run(resources, uniforms);
kernel.encode(encoder, resources, uniforms, { count: 4 });
kernel.encode(batch.encoder, resources, uniforms, { batch, count: 4 });
void run;

// @ts-expect-error 声明了 uniform 时必须提供参数。
kernel.run(resources);
// @ts-expect-error encode 同样要求 uniform。
kernel.encode(encoder, resources);
// @ts-expect-error 辅助资源也不能缺漏。
kernel.run({ position, velocity, table }, uniforms);
// @ts-expect-error 资源名拼写错误。
kernel.run({ positon: position, velocity, table, indices }, uniforms);
// @ts-expect-error Buffer kind 必须匹配资源声明。
kernel.run({ position: table, velocity, table, indices }, uniforms);
// @ts-expect-error 辅助资源的 Buffer kind 也必须匹配。
kernel.run({ position, velocity, table: indices, indices }, uniforms);
// @ts-expect-error 多余的资源键不会被严格入口接受。
kernel.run({ position, velocity, table, indices, extra: table }, uniforms);
// @ts-expect-error uniform 名拼错。
kernel.run(resources, { delta: 0.02, offset: { x: 1, y: 2 } });
// @ts-expect-error uniform 不能缺漏。
kernel.run(resources, { dt: 0.02 });
// @ts-expect-error 标量 uniform 不能传入向量。
kernel.run(resources, { dt: { x: 1, y: 2 }, offset: { x: 1, y: 2 } });
// @ts-expect-error 向量 uniform 必须具有所需分量。
kernel.run(resources, { dt: 0.02, offset: { x: 1 } });
// @ts-expect-error 向量 uniform 不能传入标量。
kernel.run(resources, { dt: 0.02, offset: 1 });
// @ts-expect-error 多余 uniform 键会被拒绝。
kernel.run(resources, { dt: 0.02, offset: { x: 1, y: 2 }, extra: 1 });
// @ts-expect-error encode 同样检查资源 kind。
kernel.encode(encoder, { position, velocity, table: indices, indices }, uniforms);
// @ts-expect-error dispatch options 沿用原始接口。
kernel.run(resources, uniforms, { count: '4' });
// @ts-expect-error 批次仅用于外部 encoder 编码,run 自行提交。
kernel.run(resources, uniforms, { batch });

const noUniform = typedElementKernel({
  state: { position: 'vec2f' },
  auxInputs: { table: 'f32' },
  code: 'fn userFn(i: u32) { position[i] *= table[0]; }',
});
noUniform.run({ position, table });
noUniform.run({ position, table }, undefined, { count: 4 });
noUniform.run({ position, table }, {}, { count: 4 });
noUniform.encode(encoder, { position, table });
noUniform.encode(encoder, { position, table }, undefined, { count: 4 });
noUniform.encode(batch.encoder, { position, table }, undefined, { batch });
// @ts-expect-error 没有声明的 uniform 不允许传入。
noUniform.run({ position, table }, { dt: 0.02 });

const emptyUniform = typedElementKernel({ state: { table: 'f32' }, uniforms: {}, code: 'fn userFn(i: u32) {}' });
emptyUniform.run({ table });

// 无 state 的只读内核同样保留输入字段。
const readOnly = typedElementKernel({ inputs: { indices: 'u32' }, code: 'fn userFn(i: u32) {}' });
readOnly.run({ indices });
// @ts-expect-error inputs 不能遗漏。
readOnly.run({});

// schema.fields 与严格内核共用同一份元素类型声明。
const Motion = defineSchema({ position: 'vec2f', velocity: 'vec2f' });
const schemaKernel = typedElementKernel({ state: Motion.fields, code: 'fn userFn(i: u32) {}' });
schemaKernel.run({ position, velocity });
// @ts-expect-error schema 中的具体 kind 不会扩大为 ScalarKind。
schemaKernel.run({ position: table, velocity });

const vectors = typedElementKernel({
  state: { table: 'f32' },
  uniforms: { axis: 'vec3f', color: 'vec4f', cell: 'vec2u', shift: 'vec2i', mode: 'u32', frame: 'i32' },
  code: 'fn userFn(i: u32, axis: vec3f, color: vec4f, cell: vec2u, shift: vec2i, mode: u32, frame: i32) {}',
});
vectors.run({ table }, { axis: { x: 1, y: 2, z: 3 }, color: { x: 1, y: 2, z: 3, w: 4 }, cell: { x: 1, y: 2 }, shift: { x: -1, y: -2 }, mode: 1, frame: -1 });
// @ts-expect-error vec3f 必须具有 z 分量。
vectors.run({ table }, { axis: { x: 1, y: 2 }, color: { x: 1, y: 2, z: 3, w: 4 }, cell: { x: 1, y: 2 }, shift: { x: -1, y: -2 }, mode: 1, frame: -1 });

// 执行对象的其余方法与属性不需要包装,沿用基础内核。
const prepared: Promise<void> = kernel.prepare();
const replaced: Promise<void> = kernel.replace(spec.code);
kernel.endSubmit();
kernel.resetEncodeGuard();
kernel.destroy();
const source: string = kernel.source;
void prepared;
void replaced;
void source;

// 现有宽松工厂及 ElementKernel 赋值不会被严格入口影响。
declare const dynamicResources: Record<string, Buffer>;
const legacy: ElementKernel = elementKernel(spec);
legacy.run(dynamicResources);
legacy.encode(encoder, dynamicResources, { arbitraryUniform: 1 });

async function pingPongTypes(): Promise<void> {
  // 单次声明中的每个字段都保留具体 kind,可直接连接严格内核。
  const state = await PingPong.create({ chem: 'vec2f', seed: 'u32' }, 16);
  const currentChem: Buffer<'vec2f'> = state.current.chem;
  const otherSeed: Buffer<'u32'> = state.other.seed;
  const step = typedElementKernel({
    state: { next: 'vec2f' }, inputs: { previous: 'vec2f' }, auxInputs: { seed: 'u32' },
    code: 'fn userFn(i: u32) { next[i] = previous[i]; }',
  });
  await step.run({ next: state.other.chem, previous: state.current.chem, seed: state.current.seed });
  step.encode(batch.encoder, { next: state.other.chem, previous: state.current.chem, seed: state.current.seed }, undefined, { batch });
  // @ts-expect-error 不同字段的 kind 不能混用。
  step.run({ next: state.other.seed, previous: state.current.chem, seed: state.current.seed });
  // @ts-expect-error 实际字段名会被保留。
  state.current.chems;
  await state.runWith(async (write, read) => {
    await step.run({ next: write.chem, previous: read.chem, seed: read.seed });
    // @ts-expect-error runWith 的两侧也保留每字段 kind。
    const wrong: Buffer<'f32'> = write.chem;
    void wrong;
  });

  const cloned = await state.clone();
  const clonedChem: Buffer<'vec2f'> = cloned.current.chem;
  const clonedSeed: Buffer<'u32'> = cloned.other.seed;
  await step.run({ next: cloned.other.chem, previous: cloned.current.chem, seed: cloned.current.seed });
  // @ts-expect-error clone 不会把不同字段的 kind 扩大成相同联合类型。
  const wrongCloneKind: Buffer<'vec2f'> = cloned.current.seed;
  // @ts-expect-error clone 也保留字段名。
  cloned.current.extra;

  // 保留旧版显式字段名泛型、类单泛型注解与泛型 ReturnType 用法。
  const explicit = await PingPong.create<'chem'>({ chem: 'vec2f' }, 16);
  const annotated: PingPong<'chem'> = explicit;
  const inferredAnnotated: PingPong<'chem'> = await PingPong.create({ chem: 'vec2f' }, 16);
  const typedReturn: Awaited<ReturnType<typeof PingPong.create<'chem'>>> = explicit;
  const legacyBuffer: Buffer = annotated.current.chem;
  const clonedLegacy: PingPong<'chem'> = await annotated.clone();
  const explicitUnion = await PingPong.create<'chem' | 'seed'>({ chem: 'vec2f', seed: 'u32' }, 16);
  const unionReturn: Awaited<ReturnType<typeof PingPong.create<'chem' | 'seed'>>> = explicitUnion;
  const unionChem: Buffer = explicitUnion.current.chem;
  const unionSeed: Buffer = explicitUnion.current.seed;
  // @ts-expect-error 显式字段名联合中的字段也不能缺漏。
  PingPong.create<'chem' | 'seed'>({ chem: 'vec2f' }, 16);
  // 数字键继续允许输入;这类非字符串声明保留宽泛的旧访问类型。
  const numeric = await PingPong.create({ 0: 'f32' }, 16);
  const numericField: Buffer | undefined = numeric.current[0];
  // @ts-expect-error 显式旧泛型保持只按字段名约束,不会虚构精确 kind。
  const unknownLegacyKind: Buffer<'vec2f'> = explicit.current.chem;
  // @ts-expect-error 显式泛型仍要求指定字段名。
  PingPong.create<'chem'>({ chemical: 'vec2f' }, 16);
  void currentChem;
  void otherSeed;
  void clonedChem;
  void clonedSeed;
  void wrongCloneKind;
  void inferredAnnotated;
  void typedReturn;
  void legacyBuffer;
  void clonedLegacy;
  void unionReturn;
  void unionChem;
  void unionSeed;
  void numericField;
  void unknownLegacyKind;
}
void pingPongTypes;

function forwardPingPong<K extends string>(fields: Record<K, ScalarKind>): Promise<PingPong<K>> {
  return PingPong.create<K>(fields, 16);
}
void forwardPingPong;

function inferForwardPingPong<K extends string>(fields: Record<K, ScalarKind>): Promise<PingPong<K>> {
  return PingPong.create(fields, 16);
}
void inferForwardPingPong;
