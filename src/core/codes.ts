/**
 * Error codes for programmatic identification of wgpu-kit errors.
 * These are stable string constants — safe to switch on in user code.
 */
export const ERR = {
  /** WebGPU is unavailable or the adapter could not be acquired */
  WGPU_UNAVAILABLE: 'ERR_WGPU_UNAVAILABLE',
  /** WGSL compilation failed */
  COMPILE: 'ERR_COMPILE',
  /** Invalid argument passed by the caller */
  USAGE: 'ERR_USAGE',
  /** A required uniform field is missing or has an invalid value */
  UNIFORM_FIELD: 'ERR_UNIFORM_FIELD',
  /** Uniform scalar types are not yet supported */
  UNIFORM_UNSUPPORTED: 'ERR_UNIFORM_UNSUPPORTED',
  /** workgroupSize is outside the valid range */
  WORKGROUP_SIZE: 'ERR_WORKGROUP_SIZE',
  /** A resource (Buffer) is missing from the resources map */
  RESOURCE_MISSING: 'ERR_RESOURCE_MISSING',
  /** A resource type does not match the kernel declaration */
  RESOURCE_TYPE: 'ERR_RESOURCE_TYPE',
  /** Resource lengths are inconsistent across state/inputs */
  RESOURCE_LENGTH: 'ERR_RESOURCE_LENGTH',
  /** Buffer.create received an invalid kind or length */
  BUFFER_CREATE: 'ERR_BUFFER_CREATE',
  /** Buffer.write type or component count mismatch */
  BUFFER_WRITE: 'ERR_BUFFER_WRITE',
  /** MediaRecorder is unavailable or the recording failed */
  MEDIA: 'ERR_MEDIA',
  /** timestamp-query is not supported on this device */
  TIMESTAMP_UNSUPPORTED: 'ERR_TIMESTAMP_UNSUPPORTED',
  /** A generic library error that doesn't fit any specific code */
  GENERIC: 'ERR_GENERIC',
} as const;

export type ErrorCode = (typeof ERR)[keyof typeof ERR];
