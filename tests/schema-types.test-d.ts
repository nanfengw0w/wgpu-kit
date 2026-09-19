/**
 * schema 层的**编译期**类型断言(由 `npx tsc --noEmit` 强制执行,CI 兜底)。
 * 这里每一条 `@ts-expect-error` 都是"类型安全 DX"承诺的回归:任何让拼写错误
 * 溜到运行时的 API 退化都会在这里先编译失败。
 */
import { defineSchema, type SchemaInfer } from '../src/core/schema.ts';

type Eq<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;

const Particle = defineSchema({
  pos: 'vec2f',
  species: 'u32',
  home: 'vec3f',
  mass: 'f32',
});

type P = SchemaInfer<typeof Particle.fields>;

// 字段类型逐字映射
const posIsVec2: Eq<P['pos'], { x: number; y: number }> = true;
const speciesIsNum: Eq<P['species'], number> = true;
const homeIsVec3: Eq<P['home'], { x: number; y: number; z: number }> = true;
const massIsNum: Eq<P['mass'], number> = true;
void (posIsVec2 && speciesIsNum && homeIsVec3 && massIsNum);

// 字段名拼错 = 编译错误(运行时校验兜不了的,这里兜)
// @ts-expect-error schema 行对象不允许拼错字段名
const typoRow: P = { pos: { x: 0, y: 0 }, species: 0, home: { x: 0, y: 0, z: 0 }, mass: 1, posx: { x: 0, y: 0 } };
void typoRow;

// 向量分量拼错同样编译期报错
// @ts-expect-error vec2 行没有 z 分量
const typoComp: P['pos'] = { x: 0, y: 0, z: 0 };
void typoComp;

// buffers() 的行写入口与行类型一致
type Bufs = Awaited<ReturnType<typeof Particle.buffers>>;
type PosRows = Parameters<Bufs['pos']['write']>[0];
const rowsMatch: Eq<PosRows[number], P['pos']> = true;
void rowsMatch;

// elementKernel 直接吃 schema.fields(字段名/顺序同源)
const kernelState: typeof Particle.fields = Particle.fields;
void kernelState;
