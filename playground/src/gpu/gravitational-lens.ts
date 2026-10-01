import { GpuContext, Buffer, elementKernel } from "wgpu-kit";

export const LENS_UNIFORMS = {
  size: "u32",
  time: "f32",
  pointer: "vec2f",
  amount: "f32",
  aspect: "f32",
  light: "f32",
  lensing: "f32",
  grid: "f32",
} as const;

export const LENS_SHADER = `
// A source-plane atlas, sampled by the point-mass thin-lens equation.
// Units are dimensionless angular coordinates. No artificial accretion disk.
fn lensHash(p: vec2f) -> f32 {
  return fract(sin(dot(p, vec2f(127.1, 311.7))) * 43758.5453);
}

fn lensNoise(p: vec2f) -> f32 {
  let cell = floor(p);
  let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f);
  return mix(mix(lensHash(cell), lensHash(cell + vec2f(1, 0)), u.x),
    mix(lensHash(cell + vec2f(0, 1)), lensHash(cell + vec2f(1, 1)), u.x), u.y);
}

fn rotateLens(p: vec2f, a: f32) -> vec2f {
  return vec2f(cos(a) * p.x - sin(a) * p.y, sin(a) * p.x + cos(a) * p.y);
}

fn atlasStars(p: vec2f, density: f32, seed: f32) -> vec3f {
  let cell = floor(p * density);
  let f = fract(p * density) - 0.5;
  let h = lensHash(cell + seed);
  let center = (vec2f(lensHash(cell + 19.7 + seed), lensHash(cell + 81.3)) - 0.5) * 0.62;
  let delta = f - center;
  let r2 = dot(delta, delta);
  let radius = mix(0.035, 0.085, h * h);
  let star = exp(-r2 / (radius * radius)) + 0.055 * exp(-r2 / 0.05);
  let tint = mix(vec3f(0.40, 0.65, 1.0), vec3f(1.0, 0.76, 0.43), lensHash(cell + 6.8));
  return tint * star * step(0.66, h) * (0.48 + h);
}

fn spiralGalaxy(p: vec2f, center: vec2f, radius: f32, angle: f32, tint: vec3f) -> vec3f {
  let q = rotateLens((p - center) / radius, angle) * vec2f(1.0, 1.7);
  let r = length(q);
  let a = atan2(q.y, q.x);
  let spiral = 0.5 + 0.5 * cos(2.0 * a - 5.8 * log(r + 0.13));
  let arms = pow(spiral, 9.0) * exp(-r * 1.65) * smoothstep(0.12, 0.48, r);
  let texture = 0.52 + 0.48 * lensNoise(q * 21.0);
  let disk = exp(-r * r * 2.0) * 0.11;
  let core = exp(-r * r * 55.0);
  let knots = pow(lensNoise(q * 16.0 + 8.3), 8.0) * arms;
  return tint * (disk + arms * texture * 2.9 + knots * 3.0)
    + vec3f(1.0, 0.88, 0.67) * core * 1.25;
}

fn atlasLine(p: vec2f, a: vec2f, b: vec2f) -> f32 {
  let ab = b - a;
  let distanceToLine = length(p - a - ab * clamp(dot(p - a, ab) / dot(ab, ab), 0.0, 1.0));
  return exp(-distanceToLine * distanceToLine / 0.000010);
}

fn sourceAtlas(beta: vec2f, showGrid: f32) -> vec3f {
  var result = vec3f(0.008, 0.015, 0.030);
  let band = beta.y + 0.28 * sin(beta.x * 1.5) + 0.16;
  let dust = exp(-band * band * 7.0) * (0.28 + 0.72 * lensNoise(beta * 5.0));
  result += vec3f(0.023, 0.032, 0.065) * dust;
  result += atlasStars(beta, 23.0, 3.2);
  result += atlasStars(beta + 13.5, 47.0, 7.1) * 0.42;

  // The same three recognizable galaxies exist in the lensed and unlensed views.
  result += spiralGalaxy(beta, vec2f(0.075, -0.025), 0.32, -0.35, vec3f(0.31, 0.69, 1.0));
  result += spiralGalaxy(beta, vec2f(-0.94, 0.40), 0.25, 0.65, vec3f(1.0, 0.52, 0.27));
  result += spiralGalaxy(beta, vec2f(0.96, -0.36), 0.27, -0.72, vec3f(0.76, 0.43, 1.0));

  // A sparse atlas constellation provides a second, geometric distortion cue.
  let a = vec2f(-0.59, -0.59);
  let b = vec2f(-0.24, -0.48);
  let c = vec2f(0.24, -0.67);
  let d = vec2f(0.66, -0.51);
  result += vec3f(0.12, 0.23, 0.32) * (atlasLine(beta, a, b) + atlasLine(beta, b, c) + atlasLine(beta, c, d));
  for (var i = 0u; i < 4u; i++) {
    let point = array<vec2f, 4>(a, b, c, d)[i];
    result += vec3f(0.61, 0.83, 1.0) * exp(-dot(beta - point, beta - point) / 0.00013);
  }
  if (showGrid > 0.5) {
    let q = abs(fract(beta / 0.20 + 0.5) - 0.5) * 0.20;
    let grid = 1.0 - smoothstep(0.001, 0.004, min(q.x, q.y));
    result += vec3f(0.09, 0.23, 0.28) * grid;
  }
  return result;
}

fn userFn(idx: u32, size: u32, time: f32, pointer: vec2f, amount: f32, aspect: f32, light: f32, lensing: f32, grid: f32) {
  let uv = (vec2f(f32(idx % size), f32(idx / size)) + 0.5) / f32(size);
  let theta = (uv - 0.5) * vec2f(2.0 * aspect, 2.0);
  let lens = pointer;
  let offset = theta - lens;
  let radiusSquared = dot(offset, offset);
  // thetaE squared is proportional to mass at fixed observer/lens/source distances.
  let thetaESquared = 0.22 * max(amount, 0.0);
  var beta = theta;
  if (lensing > 0.5) {
    // Inverse ray mapping: observed image angle -> unlensed source angle.
    // The tiny denominator floor only handles the point singularity numerically.
    beta = theta - thetaESquared * offset / max(radiusSquared, 0.000001);
  }
  var rgb = sourceAtlas(beta, grid);
  // A small, non-emissive crosshair marks the lens; this is an interface overlay.
  let cross = (1.0 - smoothstep(0.0015, 0.004, min(abs(offset.x), abs(offset.y))))
    * smoothstep(0.010, 0.014, length(offset))
    * (1.0 - smoothstep(0.032, 0.039, length(offset)));
  rgb = mix(rgb, vec3f(0.72, 0.84, 0.92), cross * 0.70);
  // Identical exposure in both views preserves the source's surface brightness.
  rgb = vec3f(1.0) - exp(-rgb * 1.28);
  color[idx] = vec4f(rgb, 1.0);
}
`;

export const LENS_PRESENT = `
@group(0) @binding(0) var<storage, read> pixels: array<vec4f>;
@group(0) @binding(1) var<uniform> screen: vec4u;

struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
}

@vertex fn vs(@builtin(vertex_index) index: u32) -> VertexOutput {
  let positions = array<vec2f, 3>(vec2f(-1, -1), vec2f(3, -1), vec2f(-1, 3));
  var result: VertexOutput;
  result.position = vec4f(positions[index], 0, 1);
  result.uv = positions[index] * vec2f(0.5, -0.5) + 0.5;
  return result;
}

@fragment fn fs(input: VertexOutput) -> @location(0) vec4f {
  // Bilinear presentation of the compute result, including non-square canvases.
  let xy = clamp(input.uv * f32(screen.x) - 0.5, vec2f(0), vec2f(f32(screen.x - 1u)));
  let lo = vec2u(floor(xy));
  let hi = min(lo + vec2u(1), vec2u(screen.x - 1u));
  let fraction = fract(xy);
  return mix(mix(pixels[lo.y * screen.x + lo.x], pixels[lo.y * screen.x + hi.x], fraction.x),
    mix(pixels[hi.y * screen.x + lo.x], pixels[hi.y * screen.x + hi.x], fraction.x), fraction.y);
}
`;

export type LensController = {
  destroy(): void;
  setPaused(value: boolean): void;
  reset(): void;
  setParameter(key: string, value: number): void;
};

/** Mount the point-mass thin-lens example into the existing showcase shell. */
export async function mountGravitationalLens(
  canvas: HTMLCanvasElement,
  onStatus: (status: string) => void,
  options: { reducedMotion?: boolean; theme?: string } = {},
): Promise<LensController> {
  const context = await GpuContext.get();
  const device = context.device;
  const surface = canvas.getContext("webgpu");
  if (!surface) throw new Error("A WebGPU canvas is unavailable.");
  const format = navigator.gpu.getPreferredCanvasFormat();
  surface.configure({ device, format, alphaMode: "opaque" });

  const size = 640;
  const color = await Buffer.create("vec4f", size * size);
  const screen = device.createBuffer({
    size: 16,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(screen, 0, new Uint32Array([size, 0, 0, 0]));
  const kernel = elementKernel({
    name: "gravitational-thin-lens",
    state: { color: "vec4f" },
    uniforms: LENS_UNIFORMS,
    code: LENS_SHADER,
  });
  let pipeline: GPURenderPipeline;
  let bindings: GPUBindGroup;
  try {
    await kernel.prepare();
    const module = device.createShaderModule({ code: LENS_PRESENT });
    pipeline = await device.createRenderPipelineAsync({
      layout: "auto",
      vertex: { module, entryPoint: "vs" },
      fragment: { module, entryPoint: "fs", targets: [{ format }] },
      primitive: { topology: "triangle-list" },
    });
    bindings = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: color.gpuBuffer } },
        { binding: 1, resource: { buffer: screen } },
      ],
    });
  } catch (error) {
    kernel.destroy();
    color.destroy();
    screen.destroy();
    surface.unconfigure();
    throw error;
  }

  let dead = false;
  let failed = false;
  let visible = true;
  let frame = 0;
  let activePointer: number | null = null;
  let amount = 1;
  let lensing = 1;
  let grid = 0;
  let pointer = { x: 0, y: 0 };
  let light = options.theme === "light" ? 1 : 0;
  const previousTouchAction = canvas.style.touchAction;
  const abort = new AbortController();

  const request = () => {
    if (!dead && !failed && !frame) frame = requestAnimationFrame(draw);
  };
  const draw = () => {
    frame = 0;
    if (dead || failed || !visible || document.hidden) return;
    const bounds = canvas.getBoundingClientRect();
    if (bounds.width <= 0 || bounds.height <= 0) return;
    const scale = Math.min(devicePixelRatio || 1, 1.5, Math.sqrt(1500000 / Math.max(1, bounds.width * bounds.height)));
    const width = Math.max(1, Math.round(bounds.width * scale));
    const height = Math.max(1, Math.round(bounds.height * scale));
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;
    try {
      // Compute and presentation share one encoder, in the public composition API.
      const encoder = device.createCommandEncoder();
      kernel.encode(
        encoder,
        { color },
        {
          size,
          time: 0,
          pointer,
          amount,
          aspect: width / height,
          light,
          lensing,
          grid,
        },
      );
      const pass = encoder.beginRenderPass({
        colorAttachments: [
          {
            view: surface.getCurrentTexture().createView(),
            loadOp: "clear",
            storeOp: "store",
            clearValue: { r: 0, g: 0, b: 0, a: 1 },
          },
        ],
      });
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, bindings);
      pass.draw(3);
      pass.end();
      device.queue.submit([encoder.finish()]);
      kernel.endSubmit();
    } catch (error) {
      failed = true;
      onStatus("GPU error: " + String(error));
    }
  };

  const move = (event: PointerEvent) => {
    if (activePointer !== event.pointerId) return;
    const bounds = canvas.getBoundingClientRect();
    if (bounds.width <= 0 || bounds.height <= 0) return;
    pointer = {
      x:
        ((((event.clientX - bounds.left) / bounds.width) * 2 - 1) *
          bounds.width) /
        bounds.height,
      y: ((event.clientY - bounds.top) / bounds.height) * 2 - 1,
    };
    request();
  };
  const down = (event: PointerEvent) => {
    if (!event.isPrimary || event.button !== 0) return;
    activePointer = event.pointerId;
    canvas.setPointerCapture(event.pointerId);
    canvas.focus({ preventScroll: true });
    move(event);
  };
  const up = (event: PointerEvent) => {
    if (activePointer !== event.pointerId) return;
    if (canvas.hasPointerCapture(event.pointerId))
      canvas.releasePointerCapture(event.pointerId);
    activePointer = null;
  };
  const key = (event: KeyboardEvent) => {
    const step = event.shiftKey ? 0.1 : 0.025;
    if (event.key === "ArrowLeft") pointer.x -= step;
    else if (event.key === "ArrowRight") pointer.x += step;
    else if (event.key === "ArrowUp") pointer.y -= step;
    else if (event.key === "ArrowDown") pointer.y += step;
    else return;
    event.preventDefault();
    const aspect = canvas.width / Math.max(1, canvas.height);
    pointer.x = Math.max(-aspect, Math.min(aspect, pointer.x));
    pointer.y = Math.max(-1, Math.min(1, pointer.y));
    request();
  };
  const error = (event: GPUUncapturedErrorEvent) => {
    failed = true;
    if (!dead) onStatus("GPU error: " + event.error.message);
  };
  canvas.style.touchAction = "none";
  canvas.addEventListener("pointerdown", down, { signal: abort.signal });
  canvas.addEventListener("pointermove", move, { signal: abort.signal });
  canvas.addEventListener("pointerup", up, { signal: abort.signal });
  canvas.addEventListener("pointercancel", up, { signal: abort.signal });
  canvas.addEventListener(
    "lostpointercapture",
    () => {
      activePointer = null;
    },
    { signal: abort.signal },
  );
  canvas.addEventListener("keydown", key, { signal: abort.signal });
  document.addEventListener("visibilitychange", request, {
    signal: abort.signal,
  });
  device.addEventListener("uncapturederror", error);
  const observer = new IntersectionObserver((entries) => {
    visible = entries[0].isIntersecting;
    if (visible) request();
  });
  const resizeObserver = new ResizeObserver(request);
  observer.observe(canvas);
  resizeObserver.observe(canvas);
  device.lost.then((info) => {
    if (!dead) {
      failed = true;
      onStatus("GPU device lost: " + info.message);
    }
  });
  request();
  onStatus("Live WebGPU · wgpu-kit 2.0.1");

  return {
    destroy() {
      if (dead) return;
      dead = true;
      cancelAnimationFrame(frame);
      if (activePointer !== null && canvas.hasPointerCapture(activePointer))
        canvas.releasePointerCapture(activePointer);
      abort.abort();
      observer.disconnect();
      resizeObserver.disconnect();
      device.removeEventListener("uncapturederror", error);
      canvas.style.touchAction = previousTouchAction;
      kernel.destroy();
      color.destroy();
      screen.destroy();
      surface.unconfigure();
    },
    // There is no time animation: the atlas stays fixed for an exact comparison.
    // The showcase may hide Pause for this example. Input always requests a frame.
    setPaused() {
      request();
    },
    reset() {
      pointer = { x: 0, y: 0 };
      amount = 1;
      lensing = 1;
      grid = 0;
      request();
    },
    setParameter(key, value) {
      if (!Number.isFinite(value)) return;
      if (key === "amount") amount = Math.max(0.25, Math.min(2.5, value));
      if (key === "lensing") lensing = value > 0.5 ? 1 : 0;
      if (key === "grid") grid = value > 0.5 ? 1 : 0;
      if (key === "theme") light = value;
      if (key === "align") pointer = { x: 0.075, y: -0.025 };
      request();
    },
  };
}
