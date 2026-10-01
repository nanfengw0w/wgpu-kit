import { Buffer, GpuContext, PingPong, elementKernel } from 'wgpu-kit';

/** Original GPU-computed folded ribbon. No image assets or simulation presets. */
export async function mountHero(
  canvas: HTMLCanvasElement,
  onStatus: (status: string) => void = () => {},
  options: { reducedMotion?: boolean } = {},
) {
  const W = 192, H = 72, N = W * H;
  const ctx = await GpuContext.get();
  const device = ctx.device;
  const context = canvas.getContext('webgpu');
  if (!context) throw new Error('This browser could not create a WebGPU canvas');
  const format = navigator.gpu.getPreferredCanvasFormat();
  context.configure({ device, format, alphaMode: 'premultiplied' });

  const wave = await PingPong.create({ field: 'vec2f' }, N);
  const positions = await Buffer.create('vec4f', N);
  const normals = await Buffer.create('vec4f', N);

  const propagate = elementKernel({
    name: 'Ribbon pressure / wave propagation',
    state: { next: 'vec2f' },
    inputs: { prev: 'vec2f', surface: 'vec4f' },
    uniforms: { grid: 'vec2u', step: 'f32', origin: 'vec3f', ray: 'vec3f', pressure: 'f32' },
    code: `
      fn userFn(i: u32, grid: vec2u, step: f32, origin: vec3f, ray: vec3f, pressure: f32) {
        let x = i % grid.x;
        let y = i / grid.x;
        let left = y * grid.x + (x + grid.x - 1u) % grid.x;
        let right = y * grid.x + (x + 1u) % grid.x;
        let up = ((y + grid.y - 1u) % grid.y) * grid.x + x;
        let down = ((y + 1u) % grid.y) * grid.x + x;
        let h = prev[i].x;
        let lap = prev[left].x + prev[right].x + prev[up].x + prev[down].x - 4.0 * h;
        let delta = surface[i].xyz - origin;
        let along = dot(delta, ray);
        let toRay = delta - ray * along;
        let brush = exp(-dot(toRay, toRay) * 42.0) * select(0.0, 1.0, along > 0.0);
        let v = (prev[i].y + (0.19 * lap - 0.006 * h + pressure * brush) * step) * pow(0.978, step);
        next[i] = vec2f(clamp(h + v * step, -0.14, 0.14), v);
      }
    `,
  });

  const sculpt = elementKernel({
    name: 'Original folded ribbon / geometry',
    state: { surface: 'vec4f' },
    inputs: { field: 'vec2f' },
    uniforms: { grid: 'vec2u', time: 'f32' },
    code: `
      const TAU: f32 = 6.28318530718;
      fn ribbon(u: f32, v: f32, time: f32) -> vec3f {
        let radial = vec3f(cos(u), 0.0, sin(u));
        let vertical = vec3f(0.0, 1.0, 0.0);
        let radius = 1.15 + 0.10 * cos(3.0 * u + 0.5);
        let center = radial * radius + vertical * (0.20 * sin(2.0 * u));
        let twist = u + 0.28 * sin(2.0 * u + 0.7);
        let wide = radial * cos(twist) + vertical * sin(twist);
        let thin = -radial * sin(twist) + vertical * cos(twist);
        let width = 0.49 + 0.085 * sin(2.0 * u - 0.6);
        let breath = 0.026 * sin(3.0 * u - time * 0.55) * cos(2.0 * v + time * 0.3);
        var p = center + wide * ((width + breath) * cos(v)) + thin * (0.145 * sin(v));
        p.z *= 0.90;
        return p;
      }
      fn userFn(i: u32, grid: vec2u, time: f32) {
        let u = f32(i % grid.x) / f32(grid.x) * TAU;
        let v = f32(i / grid.x) / f32(grid.y) * TAU;
        let p = ribbon(u, v, time);
        let du = ribbon(u + 0.002, v, time) - ribbon(u - 0.002, v, time);
        let dv = ribbon(u, v + 0.002, time) - ribbon(u, v - 0.002, time);
        let normal = normalize(cross(du, dv));
        surface[i] = vec4f(p + normal * field[i].x, 1.0);
      }
    `,
  });

  const deriveNormals = elementKernel({
    name: 'Ribbon surface / finite-difference normals',
    state: { normal: 'vec4f' },
    inputs: { surface: 'vec4f' },
    uniforms: { grid: 'vec2u' },
    code: `
      fn userFn(i: u32, grid: vec2u) {
        let x = i % grid.x;
        let y = i / grid.x;
        let l = y * grid.x + (x + grid.x - 1u) % grid.x;
        let r = y * grid.x + (x + 1u) % grid.x;
        let a = ((y + grid.y - 1u) % grid.y) * grid.x + x;
        let b = ((y + 1u) % grid.y) * grid.x + x;
        normal[i] = vec4f(normalize(cross(surface[r].xyz - surface[l].xyz, surface[b].xyz - surface[a].xyz)), 0.0);
      }
    `,
  });

  await Promise.all([propagate.prepare(), sculpt.prepare(), deriveNormals.prepare()]);

  const camera = device.createBuffer({ size: 96, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const renderCode = `
    struct Camera { matrix: mat4x4f, eye: vec4f, dimensions: vec4f };
    @group(0) @binding(0) var<uniform> camera: Camera;
    @group(0) @binding(1) var<storage, read> surface: array<vec4f>;
    @group(0) @binding(2) var<storage, read> normal: array<vec4f>;
    struct VertexOut {
      @builtin(position) position: vec4f,
      @location(0) world: vec3f,
      @location(1) norm: vec3f,
      @location(2) uv: vec2f,
    };
    @vertex fn vertexMain(@builtin(vertex_index) vertex: u32) -> VertexOut {
      let w = u32(camera.dimensions.x);
      let h = u32(camera.dimensions.y);
      let cell = vertex / 6u;
      let corner = vertex % 6u;
      let dx = select(0u, 1u, corner == 1u || corner == 4u || corner == 5u);
      let dy = select(0u, 1u, corner == 2u || corner == 3u || corner == 5u);
      let x = ((cell % w) + dx) % w;
      let y = ((cell / w) + dy) % h;
      let i = y * w + x;
      var out: VertexOut;
      out.position = camera.matrix * surface[i];
      out.world = surface[i].xyz;
      out.norm = normal[i].xyz;
      out.uv = vec2f(f32(x) / f32(w), f32(y) / f32(h));
      return out;
    }
    fn environment(r: vec3f) -> vec3f {
      var color = mix(vec3f(0.004, 0.008, 0.016), vec3f(0.045, 0.058, 0.079), smoothstep(-0.3, 1.0, r.y));
      let strip = pow(max(dot(r, normalize(vec3f(-0.55, 0.80, 0.42))), 0.0), 30.0);
      let blue = pow(max(dot(r, normalize(vec3f(0.85, 0.20, 0.30))), 0.0), 13.0);
      let pink = pow(max(dot(r, normalize(vec3f(-0.60, -0.10, -0.70))), 0.0), 12.0);
      color += vec3f(4.5, 4.6, 4.8) * strip;
      let softbox = exp(-pow((r.y - 0.48) * 10.0, 2.0)) * (1.0 - smoothstep(0.62, 0.85, abs(r.x)));
      let rimstrip = exp(-pow((r.x + r.z * 0.6 - 0.5) * 18.0, 2.0)) * smoothstep(-0.2, 0.8, r.y);
      color += vec3f(2.7, 3.1, 3.4) * softbox + vec3f(1.1, 0.75, 1.4) * rimstrip;
      color += vec3f(0.10, 0.70, 1.50) * blue;
      color += vec3f(0.78, 0.19, 0.47) * pink;
      color += vec3f(0.20, 0.24, 0.38) * exp(-pow((r.y + 0.08) * 12.0, 2.0));
      return color;
    }
    @fragment fn fragmentMain(in: VertexOut, @builtin(front_facing) front: bool) -> @location(0) vec4f {
      let n = normalize(in.norm) * select(-1.0, 1.0, front);
      let v = normalize(camera.eye.xyz - in.world);
      let facing = clamp(dot(n, v), 0.0, 1.0);
      let fresnel = pow(1.0 - facing, 4.0);
      let reflected = reflect(-v, n);
      let interference = 0.5 + 0.5 * cos(vec3f(0.5, 2.6, 4.7) + 4.2 * facing + 0.9 * in.world.y);
      let alloy = mix(vec3f(0.48, 0.55, 0.68), interference * 0.62 + vec3f(0.20), 0.65);
      let ao = mix(0.54, 1.0, smoothstep(0.35, 1.45, length(in.world.xz)));
      let diffuse = 0.018 + 0.08 * max(dot(n, normalize(vec3f(-0.4, 0.8, 0.7))), 0.0);
      var color = alloy * diffuse * ao + environment(reflected) * mix(alloy, vec3f(1.0), 0.42 + fresnel * 0.58) * ao;
      color += vec3f(0.16, 0.33, 0.49) * fresnel * 0.23;
      color = color / (color + vec3f(0.86));
      color = pow(color, vec3f(1.0 / 2.2));
      return vec4f(color, 1.0);
    }
  `;
  const module = device.createShaderModule({ label: 'Original ribbon / iridescent studio material', code: renderCode });
  const diagnostics = await module.getCompilationInfo();
  const shaderErrors = diagnostics.messages.filter(m => m.type === 'error');
  if (shaderErrors.length) throw new Error(shaderErrors.map(m => `Render WGSL ${m.lineNum}: ${m.message}`).join('\n'));
  const pipeline = await device.createRenderPipelineAsync({
    label: 'Original folded ribbon', layout: 'auto',
    vertex: { module, entryPoint: 'vertexMain' },
    fragment: { module, entryPoint: 'fragmentMain', targets: [{ format }] },
    primitive: { topology: 'triangle-list', cullMode: 'none' },
    depthStencil: { format: 'depth24plus', depthWriteEnabled: true, depthCompare: 'less' },
    multisample: { count: 4 },
  });
  const renderBindings = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0), entries: [
      { binding: 0, resource: { buffer: camera } },
      { binding: 1, resource: { buffer: positions.gpuBuffer } },
      { binding: 2, resource: { buffer: normals.gpuBuffer } },
    ],
  });

  let destroyed = false, paused = false, visible = true;
  let frame = 0, previous = 0, time = 0, announced = false;
  let yaw = 0.32, pitch = 0.54, zoom = 1;
  let targetYaw = yaw, targetPitch = pitch;
  let pointerX = 0, pointerY = 0, pointerInside = false, dragging = false;
  let previousX = 0, previousY = 0;
  let lastInteraction = -Infinity;
  let motionOverride = false;
  let depth: GPUTexture | undefined, msaa: GPUTexture | undefined;
  let pixelW = 0, pixelH = 0;
  const cameraData = new Float32Array(24);
  const grid = { x: W, y: H };
  const zero = new Float32Array(N * 2);
  const abort = new AbortController();
  const signal = abort.signal;
  const oldTouchAction = canvas.style.touchAction;
  canvas.style.touchAction = 'pan-y';

  function resize() {
    const rect = canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 1.7);
    const width = Math.max(1, Math.round(rect.width * dpr));
    const height = Math.max(1, Math.round(rect.height * dpr));
    if (width === pixelW && height === pixelH) return;
    canvas.width = pixelW = width; canvas.height = pixelH = height;
    depth?.destroy(); msaa?.destroy();
    depth = device.createTexture({ size: [width, height], format: 'depth24plus', sampleCount: 4, usage: GPUTextureUsage.RENDER_ATTACHMENT });
    msaa = device.createTexture({ size: [width, height], format, sampleCount: 4, usage: GPUTextureUsage.RENDER_ATTACHMENT });
  }
  function requestFrame() {
    if (!frame && !destroyed && visible) frame = requestAnimationFrame(draw);
  }
  function updatePointer(event: PointerEvent) {
    const rect = canvas.getBoundingClientRect();
    pointerX = (event.clientX - rect.left) / Math.max(1, rect.width) * 2 - 1;
    pointerY = 1 - (event.clientY - rect.top) / Math.max(1, rect.height) * 2;
    lastInteraction = performance.now();
    requestFrame();
  }
  canvas.addEventListener('pointerenter', event => { pointerInside = true; updatePointer(event); }, { signal });
  canvas.addEventListener('pointerleave', () => { pointerInside = false; requestFrame(); }, { signal });
  canvas.addEventListener('pointerdown', event => {
    if (event.button !== 0) return;
    dragging = true; pointerInside = true;
    previousX = event.clientX; previousY = event.clientY;
    canvas.setPointerCapture(event.pointerId);
    updatePointer(event);
  }, { signal });
  canvas.addEventListener('pointermove', event => {
    if (dragging) {
      targetYaw -= (event.clientX - previousX) * 0.006;
      targetPitch = Math.max(-1.15, Math.min(1.15, targetPitch + (event.clientY - previousY) * 0.005));
      previousX = event.clientX; previousY = event.clientY;
    }
    updatePointer(event);
  }, { signal });
  const stopDrag = () => { dragging = false; requestFrame(); };
  canvas.addEventListener('pointerup', stopDrag, { signal });
  canvas.addEventListener('pointercancel', stopDrag, { signal });
  canvas.addEventListener('lostpointercapture', stopDrag, { signal });
  canvas.addEventListener('keydown', event => {
    if (event.key === 'ArrowLeft') targetYaw -= 0.16;
    else if (event.key === 'ArrowRight') targetYaw += 0.16;
    else if (event.key === 'ArrowUp') targetPitch = Math.min(1.15, targetPitch + 0.12);
    else if (event.key === 'ArrowDown') targetPitch = Math.max(-1.15, targetPitch - 0.12);
    else if (event.key === '+' || event.key === '=') zoom = Math.max(0.78, zoom * 0.94);
    else if (event.key === '-') zoom = Math.min(1.4, zoom * 1.06);
    else if (event.key.toLowerCase() === 'r') { reset(); return; }
    else return;
    event.preventDefault(); lastInteraction = performance.now(); requestFrame();
  }, { signal });
  document.addEventListener('visibilitychange', () => {
    previous = 0;
    if (document.hidden) { if (frame) cancelAnimationFrame(frame); frame = 0; }
    else requestFrame();
  }, { signal });
  const resizeObserver = new ResizeObserver(() => requestFrame());
  resizeObserver.observe(canvas);
  const intersectionObserver = new IntersectionObserver(entries => {
    visible = entries[0]?.isIntersecting ?? true;
    previous = 0;
    if (!visible) { if (frame) cancelAnimationFrame(frame); frame = 0; }
    else requestFrame();
  });
  intersectionObserver.observe(canvas);

  const onGPUError = (event: GPUUncapturedErrorEvent) => {
    event.preventDefault();
    paused = true;
    onStatus(`WebGPU error: ${event.error.message}`);
  };
  device.addEventListener('uncapturederror', onGPUError);
  ctx.lost.then(info => {
    if (!destroyed) { paused = true; onStatus(`WebGPU device lost: ${info.message || info.reason}`); }
  });

  function draw(now: number) {
    frame = 0;
    if (destroyed || document.hidden || !visible) return;
    try {
      resize();
      const dt = previous ? Math.min((now - previous) / 1000, 0.025) : 1 / 60;
      previous = now;
      const interacting = dragging || now - lastInteraction < 1700;
      const running = !paused && (!options.reducedMotion || motionOverride || interacting);
      if (running) time += dt;
      if (running && !dragging && !pointerInside && !options.reducedMotion) targetYaw += dt * 0.045;
      const follow = options.reducedMotion ? 1 : 0.14;
      yaw += (targetYaw - yaw) * follow;
      pitch += (targetPitch - pitch) * follow;
      const aspect = pixelW / pixelH;
      const distance = (aspect < 1 ? 5.7 / Math.max(aspect, 0.64) : 5.5) * zoom;
      const eye: Vec3 = [Math.sin(yaw) * Math.cos(pitch) * distance, Math.sin(pitch) * distance, Math.cos(yaw) * Math.cos(pitch) * distance];
      const target: Vec3 = [0, 0.04, 0];
      const forward = normalize(sub(target, eye));
      const right = normalize(cross(forward, [0, 1, 0]));
      const up = cross(right, forward);
      const fov = Math.PI * 0.235;
      const tan = Math.tan(fov / 2);
      const direction = normalize([
        forward[0] + right[0] * pointerX * tan * aspect + up[0] * pointerY * tan,
        forward[1] + right[1] * pointerX * tan * aspect + up[1] * pointerY * tan,
        forward[2] + right[2] * pointerX * tan * aspect + up[2] * pointerY * tan,
      ]);
      cameraData.set(multiply(perspective(fov, aspect, 0.1, 30), lookAt(eye, target)), 0);
      cameraData.set([...eye, time, W, H, 0, 0], 16);
      device.queue.writeBuffer(camera, 0, cameraData);
      const encoder = device.createCommandEncoder({ label: 'Ribbon: waves → geometry → normals → render' });
      propagate.encode(encoder, { next: wave.other.field, prev: wave.current.field, surface: positions }, {
        grid, step: running ? dt * 60 : 0,
        origin: { x: eye[0], y: eye[1], z: eye[2] }, ray: { x: direction[0], y: direction[1], z: direction[2] },
        pressure: pointerInside && interacting ? (dragging ? 0.007 : 0.0025) : 0,
      });
      wave.swap();
      sculpt.encode(encoder, { surface: positions, field: wave.current.field }, { grid, time });
      deriveNormals.encode(encoder, { normal: normals, surface: positions }, { grid });
      const pass = encoder.beginRenderPass({
        colorAttachments: [{ view: msaa!.createView(), resolveTarget: context!.getCurrentTexture().createView(), clearValue: { r: 0, g: 0, b: 0, a: 0 }, loadOp: 'clear', storeOp: 'discard' }],
        depthStencilAttachment: { view: depth!.createView(), depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'discard' },
      });
      pass.setPipeline(pipeline); pass.setBindGroup(0, renderBindings); pass.draw(N * 6); pass.end();
      device.queue.submit([encoder.finish()]);
      propagate.endSubmit(); sculpt.endSubmit(); deriveNormals.endSubmit();
      if (!announced) { announced = true; onStatus(`Live WebGPU · ${N.toLocaleString()} computed vertices`); }
      if (running || Math.abs(targetYaw - yaw) > 0.0005 || Math.abs(targetPitch - pitch) > 0.0005) requestFrame();
    } catch (error) {
      paused = true;
      propagate.endSubmit(); sculpt.endSubmit(); deriveNormals.endSubmit();
      onStatus(`WebGPU: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  function reset() {
    wave.current.field.write(zero); wave.other.field.write(zero);
    targetYaw = yaw = 0.32; targetPitch = pitch = 0.54; zoom = 1; time = 0;
    lastInteraction = performance.now(); requestFrame();
  }
  requestFrame();
  return {
    destroy() {
      if (destroyed) return;
      destroyed = true; if (frame) cancelAnimationFrame(frame);
      abort.abort(); resizeObserver.disconnect(); intersectionObserver.disconnect();
      device.removeEventListener('uncapturederror', onGPUError);
      canvas.style.touchAction = oldTouchAction;
      depth?.destroy(); msaa?.destroy(); camera.destroy();
      propagate.destroy(); sculpt.destroy(); deriveNormals.destroy();
      positions.destroy(); normals.destroy(); wave.destroy();
    },
    setPaused(value: boolean) { paused = value; if (!value) motionOverride = true; previous = 0; requestFrame(); },
    reset,
  };
}

type Vec3 = [number, number, number];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const normalize = (a: Vec3): Vec3 => { const l = Math.hypot(...a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
function lookAt(eye: Vec3, target: Vec3) {
  const z = normalize(sub(eye, target)), x = normalize(cross([0, 1, 0], z)), y = cross(z, x);
  return new Float32Array([x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0, -dot(x, eye), -dot(y, eye), -dot(z, eye), 1]);
}
function perspective(fovy: number, aspect: number, near: number, far: number) {
  const f = 1 / Math.tan(fovy / 2);
  return new Float32Array([f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, far / (near - far), -1, 0, 0, near * far / (near - far), 0]);
}
function multiply(a: Float32Array, b: Float32Array) {
  const out = new Float32Array(16);
  for (let column = 0; column < 4; column++) for (let row = 0; row < 4; row++) {
    out[column * 4 + row] = a[row] * b[column * 4] + a[4 + row] * b[column * 4 + 1] + a[8 + row] * b[column * 4 + 2] + a[12 + row] * b[column * 4 + 3];
  }
  return out;
}
