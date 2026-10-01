import { Buffer, GpuContext, rawKernel } from "wgpu-kit";

/** A small, genuine XPBD cloth solver. No particle pack, textures, or image assets. */
export const SILK_METADATA = {
  id: "silk-cloth",
  title: "Silk atelier",
  description:
    "Grab a sheet of silk. GPU distance constraints turn your gesture into folds, weight, and satin highlights.",
  tags: ["rawKernel", "XPBD", "compute geometry"],
  hint: "Drag the silk to gather it. Release to let the folds settle. Arrow keys move the grip; Space releases it.",
  parameter: "Breeze",
  min: 0,
  max: 2,
  step: 0.01,
  value: 0.65,
};

const PARAMS = `struct Params { grid:vec4f, hand:vec4f, motion:vec4f, screen:vec4f };`;
export const SILK_INTEGRATE = `${PARAMS}
@group(0) @binding(0) var<storage,read_write> position:array<vec4f>;
@group(0) @binding(1) var<storage,read_write> previous:array<vec4f>;
@group(0) @binding(2) var<uniform> p:Params;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) gid:vec3u) {
  let i=gid.x; if(i>=u32(p.grid.x*p.grid.y)){return;}
  let old=position[i];
  if(i==u32(p.hand.w)){position[i]=vec4f(p.hand.xyz,old.w);previous[i]=position[i];return;}
  if(old.w==0.0){return;}
  let uv=vec2f(f32(i%u32(p.grid.x))/(p.grid.x-1.0),f32(i/u32(p.grid.x))/(p.grid.y-1.0));
  let gust=sin(p.motion.y*1.1+uv.x*5.0+uv.y*3.0)*.7+sin(p.motion.y*.63-uv.y*7.0)*.3;
  let force=vec3f(.15*gust*p.motion.z,-1.2,(.35+gust)*p.motion.z);
  let velocity=(old.xyz-previous[i].xyz)*.983;
  previous[i]=old;
  var next=old.xyz+velocity+force*p.motion.x*p.motion.x;
  // A soft safety volume prevents extreme pointer movement from losing the cloth.
  next=clamp(next,vec3f(-2,-1.8,-1),vec3f(2,1.5,1));
  position[i]=vec4f(next,old.w);
}`;

export const SILK_CONSTRAINT = `${PARAMS}
@group(0) @binding(0) var<storage,read_write> position:array<vec4f>;
@group(0) @binding(1) var<storage,read> edges:array<vec4f>;
@group(0) @binding(2) var<storage,read_write> multipliers:array<f32>;
@group(0) @binding(3) var<uniform> p:Params;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) gid:vec3u) {
  let i=gid.x;if(i>=arrayLength(&edges)){return;}
  let e=edges[i];let a=u32(e.x);let b=u32(e.y);
  let pa=position[a];let pb=position[b];
  let wa=select(pa.w,0.0,a==u32(p.hand.w));let wb=select(pb.w,0.0,b==u32(p.hand.w));
  if(wa+wb==0.0){return;}
  let d=pa.xyz-pb.xyz;let len=length(d);if(len<.000001){return;}
  let alpha=e.w/(p.motion.x*p.motion.x);
  let dl=(-(len-e.z)-alpha*multipliers[i])/(wa+wb+alpha);
  multipliers[i]+=dl;
  let correction=dl*d/len;
  position[a]=vec4f(pa.xyz+wa*correction,pa.w);
  position[b]=vec4f(pb.xyz-wb*correction,pb.w);
}`;

export const SILK_RENDER = `${PARAMS}
@group(0) @binding(0) var<storage,read> position:array<vec4f>;
@group(0) @binding(1) var<uniform> p:Params;
struct V { @builtin(position) clip:vec4f, @location(0) world:vec3f, @location(1) normal:vec3f, @location(2) tangent:vec3f, @location(3) uv:vec2f };
fn at(x:i32,y:i32)->vec3f {return position[u32(clamp(y,0,i32(p.grid.y)-1))*u32(p.grid.x)+u32(clamp(x,0,i32(p.grid.x)-1))].xyz;}
@vertex fn vs(@builtin(vertex_index) id:u32)->V {
  let nx=u32(p.grid.x);let cell=id/6u;
  let c=array<vec2u,6>(vec2u(0,0),vec2u(1,0),vec2u(0,1),vec2u(0,1),vec2u(1,0),vec2u(1,1))[id%6u];
  let xy=vec2u(cell%(nx-1u),cell/(nx-1u))+c;let w=at(i32(xy.x),i32(xy.y));
  // A wider, weighted geometric normal removes grid-aligned highlight chatter.
  let x=i32(xy.x);let y=i32(xy.y);
  let dx=(at(x+2,y)-at(x-2,y))*2.0+at(x+2,y-1)-at(x-2,y-1)+at(x+2,y+1)-at(x-2,y+1);
  let dy=(at(x,y+2)-at(x,y-2))*2.0+at(x-1,y+2)-at(x-1,y-2)+at(x+1,y+2)-at(x+1,y-2);
  var o:V;o.clip=vec4f((w.x+w.z*.18)*p.screen.z/p.screen.x,(w.y+w.z*.06)*p.screen.z,.5-w.z*.1,1);
  o.world=w;o.normal=normalize(cross(dy,dx));o.tangent=normalize(dx);o.uv=vec2f(xy)/vec2f(p.grid.xy-1.0);return o;
}
@fragment fn fs(v:V,@builtin(front_facing) front:bool)->@location(0) vec4f {
  let eye=normalize(vec3f(.18,.06,3)-v.world);let normal=normalize(v.normal);let n=normal*select(-1.0,1.0,dot(normal,eye)>=0.0);let t=normalize(v.tangent);let b=normalize(cross(n,t));
  let light=normalize(vec3f(-1.4,.30,2.0));let half=normalize(light+eye);
  let nl=max(0.0,dot(n,light));let nh=max(.001,dot(n,half));
  // A normalized anisotropic lobe follows the actual deformed warp/weft frame.
  let ax=.42;let ay=.085;let tx=dot(t,half)/ax;let by=dot(b,half)/ay;
  let spec=exp(-(tx*tx+by*by)/(nh*nh))/(4.0*3.14159*ax*ay*max(.16,nh*nh*nh*nh));
  let edge=pow(1.0-abs(dot(n,eye)),3.0);
  let warp=.5+.5*sin(v.uv.x*1600.0);let weft=.5+.5*sin(v.uv.y*1200.0);
  let aa=clamp(1.0-max(fwidth(v.uv.x)*255.0,fwidth(v.uv.y)*190.0),0.0,1.0);
  let weave=(warp*weft-.25)*.025*aa;
  let base=mix(vec3f(.012,.027,.095),vec3f(.009,.047,.085),p.screen.w);
  var color=base*(.19+.75*nl+weave)+vec3f(.34,.79,.87)*spec*.11+vec3f(.035,.18,.28)*edge*.12;
  let rim=min(min(v.uv.x,1.0-v.uv.x),min(v.uv.y,1.0-v.uv.y));
  let hem=1.0-smoothstep(.008,.015,rim);color=mix(color,color*.7+vec3f(.055,.068,.10),hem*.32);
  color=color/(color+vec3f(.7));return vec4f(pow(color,vec3f(.4545)),1);
}`;

export type SilkController = {
  destroy(): void;
  setPaused(v: boolean): void;
  reset(): void;
  setParameter(key: string, value: number): void;
};

/** Greedy coloring produces disjoint edges within each dispatch: no float atomics or write races. */
export function makeSilkModel(nx = 65, ny = 49) {
  const initial = new Float32Array(nx * ny * 4);
  for (let y = 0; y < ny; y++)
    for (let x = 0; x < nx; x++) {
      const u = x / (nx - 1),
        v = y / (ny - 1),
        i = (y * nx + x) * 4;
      initial.set(
        [
          (u - 0.5) * 2.12,
          0.82 - v * 1.5 - 0.16 * Math.sin(u * Math.PI) * (1 - v * 0.35),
          0.15 * Math.sin(u * Math.PI * 3) * (0.15 + 0.85 * v) +
            0.06 * Math.sin(u * Math.PI) * Math.sin(v * Math.PI),
          y === 0 && (x === 0 || x === nx - 1) ? 0 : 1,
        ],
        i,
      );
    }
  const edges: number[][] = [];
  const add = (a: number, b: number, compliance: number) => {
    const d = Math.hypot(
      initial[a * 4] - initial[b * 4],
      initial[a * 4 + 1] - initial[b * 4 + 1],
      initial[a * 4 + 2] - initial[b * 4 + 2],
    );
    edges.push([a, b, d, compliance]);
  };
  for (let y = 0; y < ny; y++)
    for (let x = 0; x < nx; x++) {
      const i = y * nx + x;
      if (x + 1 < nx) add(i, i + 1, 0);
      if (y + 1 < ny) add(i, i + nx, 0);
      if (x + 1 < nx && y + 1 < ny) {
        add(i, i + nx + 1, 0.000001);
        add(i + 1, i + nx, 0.000001);
      }
      if (x + 2 < nx) add(i, i + 2, 0.00004);
      if (y + 2 < ny) add(i, i + nx * 2, 0.00004);
    }
  const used = Array.from({ length: nx * ny }, () => new Set<number>());
  const colors: number[][] = [];
  for (const e of edges) {
    let c = 0;
    while (used[e[0]].has(c) || used[e[1]].has(c)) c++;
    used[e[0]].add(c);
    used[e[1]].add(c);
    (colors[c] ??= []).push(...e);
  }
  return { nx, ny, initial, colors: colors.map((v) => new Float32Array(v)) };
}

export async function mountSilk(
  canvas: HTMLCanvasElement,
  onStatus: (s: string) => void,
  options: { reducedMotion?: boolean; theme?: string; onFrame?: () => void } = {},
): Promise<SilkController> {
  const { device } = await GpuContext.get();
  const surface = canvas.getContext("webgpu");
  if (!surface) throw Error("A WebGPU canvas is unavailable.");
  const format = navigator.gpu.getPreferredCanvasFormat();
  surface.configure({ device, format, alphaMode: "opaque" });
  const model = makeSilkModel();
  const count = model.nx * model.ny;
  const position = await Buffer.create("vec4f", count),
    previous = await Buffer.create("vec4f", count);
  const param = device.createBuffer({
    size: 64,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  const groups = await Promise.all(
    model.colors.map(async (data) => {
      const edges = await Buffer.create("vec4f", data.length / 4);
      edges.write(data);
      return { edges, lambda: await Buffer.create("f32", data.length / 4) };
    }),
  );
  const integrate = rawKernel(SILK_INTEGRATE, "main", "silk-verlet-prediction"),
    constrain = rawKernel(
      SILK_CONSTRAINT,
      "main",
      "silk-xpbd-colored-constraints",
    );
  await Promise.all([integrate.prepare(), constrain.prepare()]);
  const shader = device.createShaderModule({
    code: SILK_RENDER,
    label: "silk-anisotropic-satin",
  });
  const pipeline = await device.createRenderPipelineAsync({
    layout: "auto",
    vertex: { module: shader, entryPoint: "vs" },
    fragment: { module: shader, entryPoint: "fs", targets: [{ format }] },
    primitive: { cullMode: "none" },
    depthStencil: {
      format: "depth24plus",
      depthCompare: "less",
      depthWriteEnabled: true,
    },
  });
  const group = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: position.gpuBuffer } },
      { binding: 1, resource: { buffer: param } },
    ],
  });
  let ready = false;
  let canvasRect = canvas.getBoundingClientRect();
  function requestDraw() {
    if(ready&&!dead&&visible&&!document.hidden&&!frame)frame=requestAnimationFrame(draw);
  }
  const visibility = () => {last=0;if(document.hidden){cancelAnimationFrame(frame);frame=0;}else{dirty=true;requestDraw();}};
  document.addEventListener('visibilitychange',visibility);
  let accumulator = 0;
  let dead = false,
    paused = !!options.reducedMotion,
    visible = true,
    dirty = true,
    time = 0,
    frame = 0,
    last = 0,
    wind = 0.65,
    light = options.theme === "light" ? 1 : 0;
  let depth: GPUTexture | null = null,
    width = 0,
    height = 0,
    grab = -1,
    down = false,
    token = 0,
    hand = [0, 0, 0.4];
  const entries = [
    { binding: 0, resource: { buffer: position.gpuBuffer } },
    { binding: 1, resource: { buffer: previous.gpuBuffer } },
    { binding: 2, resource: { buffer: param } },
  ];
  const edgeEntries = groups.map((g) => [
    { binding: 0, resource: { buffer: position.gpuBuffer } },
    { binding: 1, resource: { buffer: g.edges.gpuBuffer } },
    { binding: 2, resource: { buffer: g.lambda.gpuBuffer } },
    { binding: 3, resource: { buffer: param } },
  ]);
  const reset = () => {
    position.write(model.initial);
    previous.write(model.initial);
    grab = -1;
    down = false;
    token++;
    time = 0;
    last = 0;
    accumulator = 0;
    dirty = true;requestDraw();
  };
  reset();
  const point = (e: PointerEvent) => {
    const r = canvas.getBoundingClientRect();
    return {
      x: ((e.clientX - r.left) / r.width) * 2 - 1,
      y: 1 - ((e.clientY - r.top) / r.height) * 2,
      aspect: r.width / r.height,
    };
  };
  const updateHand = (e: PointerEvent) => {
    const q = point(e);
    hand[0] = Math.max(
      -1.5,
      Math.min(1.5, (q.x * q.aspect) / 0.9 - hand[2] * 0.18),
    );
    hand[1] = Math.max(-1.15, Math.min(1.15, q.y / 0.9 - hand[2] * 0.06));
    dirty = true;requestDraw();
  };
  const press = async (e: PointerEvent) => {
    if (e.button !== 0) return;
    down = true;
    const ticket = ++token;
    canvas.setPointerCapture(e.pointerId);
    canvas.focus({ preventScroll: true });
    const q = point(e);
    try {
      const data = await position.read();
      if (dead || !down || ticket !== token) return;
      let best = 0.13 * 0.13,
        found = -1;
      for (let i = 0; i < count; i++) {
        if (data[i * 4 + 3] === 0) continue;
        const x = ((data[i * 4] + data[i * 4 + 2] * 0.18) * 0.9) / q.aspect,
          y = (data[i * 4 + 1] + data[i * 4 + 2] * 0.06) * 0.9;
        const d = (x - q.x) ** 2 + (y - q.y) ** 2;
        if (d < best) {
          best = d;
          found = i;
        }
      }
      if (found >= 0) {
        grab = found;
        hand = [
          data[found * 4],
          data[found * 4 + 1],
          Math.min(0.65, data[found * 4 + 2] + 0.18),
        ];
        updateHand(e);
      }
    } catch (err) {
      if (!dead) onStatus("GPU error: " + String(err));
    }
  };
  const move = (e: PointerEvent) => {
    if (down && grab >= 0) updateHand(e);
  };
  const release = () => {
    down = false;
    grab = -1;
    token++;
    dirty = true;requestDraw();
  };
  const key = (e: KeyboardEvent) => {
    if (e.key === " ") {
      e.preventDefault();
      release();
      return;
    }
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key))
      return;
    e.preventDefault();
    if (grab < 0) {
      grab = Math.floor(model.ny * 0.55) * model.nx + Math.floor(model.nx / 2);
      hand = [0, 0, 0.4];
    }
    if (e.key === "ArrowLeft") hand[0] -= 0.045;
    if (e.key === "ArrowRight") hand[0] += 0.045;
    if (e.key === "ArrowUp") hand[1] += 0.045;
    if (e.key === "ArrowDown") hand[1] -= 0.045;
    dirty = true;requestDraw();
  };
  canvas.addEventListener("pointerdown", press);
  canvas.addEventListener("pointermove", move);
  canvas.addEventListener("pointerup", release);
  canvas.addEventListener("pointercancel", release);
  canvas.addEventListener("lostpointercapture", release);
  canvas.addEventListener("keydown", key);
  canvas.style.touchAction = "none";
  const observer = new IntersectionObserver((es) => {
    visible = es[0].isIntersecting;
    last = 0;
    dirty = true;requestDraw();
  });
  observer.observe(canvas);
  const resizeObserver = new ResizeObserver(() => {
    canvasRect=canvas.getBoundingClientRect();
    dirty = true;requestDraw();
    last = 0;
  });
  resizeObserver.observe(canvas);
  const error = (e: GPUUncapturedErrorEvent) => {
    if (!dead) {
      paused = true;
      onStatus("GPU error: " + e.error.message);
    }
  };
  device.addEventListener("uncapturederror", error);
  const draw = (now: number) => {
    frame=0;
    if (dead) return;
    if (!visible || document.hidden || (paused && !dirty)) return;
    const dt = last ? Math.min(0.033, (now - last) / 1000) : 1 / 60;
    last = now;
    if (!paused) time += dt;
    dirty = false;
    const r = canvasRect,
      d = Math.min(devicePixelRatio || 1, 1.5,Math.sqrt(750000/Math.max(1,r.width*r.height))),
      w = Math.max(1, Math.round(r.width * d)),
      h = Math.max(1, Math.round(r.height * d));
    if (w !== width || h !== height) {
      width = w;
      height = h;
      canvas.width = w;
      canvas.height = h;
      depth?.destroy();
      depth = device.createTexture({
        size: [w, h],
        format: "depth24plus",
        usage: GPUTextureUsage.RENDER_ATTACHMENT,
      });
    }
    const subdt = 1 / 120;
    if (!paused) accumulator = Math.min(accumulator + dt, 0.034);
    const substeps = Math.min(4, Math.floor(accumulator / subdt));
    if (!paused) accumulator -= substeps * subdt;
    device.queue.writeBuffer(
      param,
      0,
      new Float32Array([
        model.nx,
        model.ny,
        0,
        0,
        ...hand,
        grab < 0 ? count : grab,
        subdt,
        time,
        wind,
        0,
        width / height,
        height,
        0.9,
        light,
      ]),
    );
    try {
      const encoder = device.createCommandEncoder();
      if (!paused) {
        for (let s = 0; s < substeps; s++) {
          for (const g of groups) encoder.clearBuffer(g.lambda.gpuBuffer);
          integrate.encode(encoder, entries, Math.ceil(count / 64));
          for (let k = 0; k < 4; k++)
            groups.forEach((g, i) =>
              constrain.encode(
                encoder,
                edgeEntries[i],
                Math.ceil(g.edges.length / 64),
              ),
            );
        }
      }
      const bg = {r:0.018+(0.72-0.018)*light,g:0.028+(0.76-0.028)*light,b:0.038+(0.76-0.038)*light,a:1};
      const pass = encoder.beginRenderPass({
        colorAttachments: [
          {
            view: surface.getCurrentTexture().createView(),
            loadOp: "clear",
            storeOp: "store",
            clearValue: bg,
          },
        ],
        depthStencilAttachment: {
          view: depth!.createView(),
          depthClearValue: 1,
          depthLoadOp: "clear",
          depthStoreOp: "store",
        },
      });
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, group);
      pass.draw((model.nx - 1) * (model.ny - 1) * 6);
      pass.end();
      device.queue.submit([encoder.finish()]);
      options.onFrame?.();
    } catch (e) {
      paused = true;
      onStatus("GPU error: " + String(e));
    }
    if(!paused)requestDraw();
  };
  ready=true;requestDraw();
  onStatus("Live WebGPU · wgpu-kit 2.0.1");
  return {
    destroy() {
      if(dead)return;
      dead = true;
      document.removeEventListener('visibilitychange',visibility);
      token++;
      cancelAnimationFrame(frame);
      observer.disconnect();
      resizeObserver.disconnect();
      canvas.removeEventListener("pointerdown", press);
      canvas.removeEventListener("pointermove", move);
      canvas.removeEventListener("pointerup", release);
      canvas.removeEventListener("pointercancel", release);
      canvas.removeEventListener("lostpointercapture", release);
      canvas.removeEventListener("keydown", key);
      device.removeEventListener("uncapturederror", error);
      integrate.destroy();
      constrain.destroy();
      position.destroy();
      previous.destroy();
      groups.forEach((g) => {
        g.edges.destroy();
        g.lambda.destroy();
      });
      param.destroy();
      depth?.destroy();
      surface.unconfigure();
    },
    setPaused(v) {
      paused = v;
      if(v){down=false;grab=-1;token++;}
      last = 0;
      dirty = true;requestDraw();
    },
    reset,
    setParameter(key, value) {
      if (key === "amount") wind = Math.max(0, Math.min(2, value));
      if (key === "theme") light = value;
      dirty = true;requestDraw();
    },
  };
}
