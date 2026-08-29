/**
 * CanvasRecorder:零依赖的画布录制(MediaRecorder 封装)。
 * 容器协商:mp4(h264)→ webm(vp9)→ webm,按浏览器能力自动选择。
 * "用户替你生产传播素材"的飞轮从这里开始。
 */
export interface RecordingResult {
  blob: Blob;
  mimeType: string;
  seconds: number;
  bytes: number;
}

const CANDIDATES = [
  // webm 在无头/软件编码环境下最可靠;mp4 的 isTypeSupported 可能"说行但编不动"
  // (实测 headless Edge:mp4 协商成功但产物 0 字节),故排后
  'video/webm;codecs=vp9',
  'video/webm;codecs=vp8',
  'video/webm',
  'video/mp4;codecs=avc1.42E01E',
  'video/mp4',
];

export function pickMime(): string | null {
  if (typeof MediaRecorder === 'undefined') return null;
  for (const m of CANDIDATES) {
    if (MediaRecorder.isTypeSupported(m)) return m;
  }
  return null;
}

export class CanvasRecorder {
  #recorder: MediaRecorder | null = null;
  #chunks: Blob[] = [];
  #startedAt = 0;
  #mime: string;

  constructor() {
    const mime = pickMime();
    if (!mime) throw new Error('当前环境不支持 MediaRecorder 录制(无可用编码)');
    this.#mime = mime;
  }

  get mimeType(): string { return this.#mime; }
  get recording(): boolean { return this.#recorder?.state === 'recording'; }

  start(canvas: HTMLCanvasElement, videoBitsPerSecond = 12_000_000): void {
    if (this.#recorder) throw new Error('已在录制中');
    const stream = canvas.captureStream(60);
    this.#chunks = [];
    this.#recorder = new MediaRecorder(stream, { mimeType: this.#mime, videoBitsPerSecond });
    this.#recorder.ondataavailable = (e) => { if (e.data.size > 0) this.#chunks.push(e.data); };
    this.#startedAt = performance.now();
    this.#recorder.start(250);
  }

  stop(): Promise<RecordingResult> {
    return new Promise((ok, err) => {
      const r = this.#recorder;
      if (!r || r.state !== 'recording') { err(new Error('没有进行中的录制')); return; }
      r.onstop = () => {
        const blob = new Blob(this.#chunks, { type: this.#mime });
        this.#recorder = null;
        if (blob.size === 0) {
          err(new Error(`录制产物为空(${this.#mime});编码器可能不可用,换浏览器或网络前重试`));
          return;
        }
        ok({ blob, mimeType: this.#mime, seconds: (performance.now() - this.#startedAt) / 1000, bytes: blob.size });
      };
      r.stop();
    });
  }
}

/** 触发浏览器下载(录完即得的最后一公里) */
export function downloadBlob(blob: Blob, filename: string): void {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
