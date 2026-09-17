import { ERR, type ErrorCode } from './codes.ts';

/**
 * Error hierarchy for wgpu-kit. All errors extend WgpuKitError and carry a
 * stable machine-readable `code` for programmatic handling.
 */
export class WgpuKitError extends Error {
  /** Stable error code, e.g. 'ERR_WGPU_UNAVAILABLE' — safe to switch on. */
  readonly code: ErrorCode;
  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = new.target.name;
    this.code = code;
  }
}

/** WebGPU is unavailable or the adapter could not be acquired. */
export class WebGPUUnavailableError extends WgpuKitError {
  constructor(reason: string) {
    super(
      ERR.WGPU_UNAVAILABLE,
      `WebGPU is unavailable: ${reason}\n` +
      '  Check: 1) Use Chrome/Edge 113+ or Safari 18+. 2) Enable WebGPU in headless mode. 3) Verify GPU drivers and hardware acceleration.',
    );
  }
}

/** WGSL compilation failed. Line numbers are mapped back to user code. */
export class CompileError extends WgpuKitError {
  constructor(kernelName: string, messages: readonly { line: number; msg: string }[], userCodeOffset: number) {
    const mapped = messages
      .map((m) => {
        const userLine = m.line - userCodeOffset;
        const where = userLine > 0 ? `your code, line ${userLine}` : `generated code, line ${m.line} (library issue — please file an issue)`;
        return `  ${where}: ${m.msg}`;
      })
      .join('\n');
    super(ERR.COMPILE, `kernel "${kernelName}" WGSL compilation failed:\n${mapped}`);
  }
}

/** Caller passed an invalid argument (missing resource, type mismatch, bad length, etc.). */
export class UsageError extends WgpuKitError {
  constructor(code: ErrorCode, message: string) {
    super(code, message);
  }
}

/** Compute pipeline creation failed validation (e.g. too many storage buffers). */
export class PipelineError extends WgpuKitError {
  constructor(label: string, detail: string) {
    super(ERR.GENERIC, `compute pipeline "${label}" creation failed: ${detail}`);
  }
}

export { ERR, type ErrorCode } from './codes.ts';

/** Create a compute pipeline with pushErrorScope to surface async validation errors. */
export async function createComputePipelineChecked(
  device: GPUDevice,
  module: GPUShaderModule,
  label: string,
  entryPoint = 'main',
): Promise<GPUComputePipeline> {
  device.pushErrorScope('validation');
  const pipeline = device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint } });
  const err = await device.popErrorScope();
  if (err) {
    throw new PipelineError(label, err.message);
  }
  return pipeline;
}
