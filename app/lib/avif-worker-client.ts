type RequestIdentity = { requestId: number; generation: number };

export type AvifWorkerRequest = RequestIdentity & (
  | { kind: "init" }
  | { kind: "encode"; pixels: ArrayBuffer; width: number; height: number; quality: number }
);

export type AvifWorkerResponse = RequestIdentity & (
  | { kind: "ready" }
  | { kind: "result"; buffer: ArrayBuffer }
  | { kind: "error"; message: string; fatal: boolean }
);

type PendingRequest = {
  kind: AvifWorkerRequest["kind"];
  generation: number;
  resolve: (response: AvifWorkerResponse) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

class WorkerUnavailableError extends Error {}

function createWorker() {
  if (typeof Worker === "undefined") throw new WorkerUnavailableError("Web Worker API недоступен.");
  try {
    return new Worker(new URL("./avif-worker.ts", import.meta.url), { type: "module", name: "optima-avif" });
  } catch (error) {
    if (error instanceof Error && ["NotSupportedError", "SecurityError"].includes(error.name)) {
      throw new WorkerUnavailableError(error.message);
    }
    throw error;
  }
}

async function encodeOnMainThread(imageData: ImageData, quality: number) {
  const avif = await import("@jsquash/avif/encode");
  return avif.default(imageData, { quality, speed: 8, subsample: 1, tune: 2 });
}

// One active request owns its target pixels. Queued calls retain their own,
// untransferred ImageData until the preceding call has settled.
export class AvifWorkerClient {
  private worker: Worker | null = null;
  private ready: Promise<Worker> | null = null;
  private generation = 0;
  private requestId = 0;
  private epoch = 0;
  private interruption = new Error("AVIF Worker остановлен.");
  private unavailable = false;
  private tail: Promise<void> = Promise.resolve();
  private pending = new Map<number, PendingRequest>();
  private createWorker: () => Worker;
  private timeoutMs: number;

  constructor(options: { createWorker?: () => Worker; timeoutMs?: number } = {}) {
    this.createWorker = options.createWorker ?? createWorker;
    this.timeoutMs = options.timeoutMs ?? 180_000;
  }

  encode(imageData: ImageData, quality: number): Promise<ArrayBuffer> {
    if (!Number.isInteger(quality) || quality < 1 || quality > 100) {
      return Promise.reject(new Error("Введите целое качество от 1 до 100."));
    }
    const { data, width, height } = imageData;
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 ||
      !(data instanceof Uint8ClampedArray) || !(data.buffer instanceof ArrayBuffer) ||
      data.byteOffset !== 0 || data.byteLength !== width * height * 4 || data.buffer.byteLength !== data.byteLength) {
      return Promise.reject(new Error("Некорректные пиксельные данные AVIF."));
    }
    const epoch = this.epoch;
    const task = this.tail.then(async () => {
      if (epoch !== this.epoch) throw this.interruption;
      if (this.unavailable) {
        const buffer = await encodeOnMainThread(imageData, quality);
        if (epoch !== this.epoch) throw this.interruption;
        return buffer;
      }
      let worker: Worker;
      try {
        worker = await this.ensureWorker();
      } catch (error) {
        // Capability/constructor failures happen before transferring pixels.
        // WASM, asset, timeout and encoding failures never enter this fallback.
        if (!(error instanceof WorkerUnavailableError)) throw error;
        this.unavailable = true;
        const buffer = await encodeOnMainThread(imageData, quality);
        if (epoch !== this.epoch) throw this.interruption;
        return buffer;
      }
      if (epoch !== this.epoch) throw this.interruption;
      const response = await this.request(worker, {
        kind: "encode", pixels: data.buffer as ArrayBuffer, width, height, quality,
      }, [data.buffer as ArrayBuffer]);
      if (epoch !== this.epoch) throw this.interruption;
      if (response.kind !== "result") throw new Error("Некорректный ответ AVIF Worker.");
      return response.buffer;
    });
    this.tail = task.then(() => undefined, () => undefined);
    return task;
  }

  dispose(error = new Error("AVIF Worker остановлен.")) {
    this.interruption = error;
    this.epoch += 1;
    this.generation += 1;
    const worker = this.worker;
    this.worker = null;
    this.ready = null;
    if (worker) {
      worker.onmessage = null;
      worker.onerror = null;
      worker.onmessageerror = null;
      worker.terminate();
    }
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private ensureWorker(): Promise<Worker> {
    if (this.ready) return this.ready;
    let worker: Worker;
    try { worker = this.createWorker(); }
    catch (error) {
      if (!(error instanceof WorkerUnavailableError)) {
        this.dispose(error instanceof Error ? error : new Error(String(error)));
      }
      throw error;
    }
    this.worker = worker;
    const generation = ++this.generation;
    worker.onmessage = (event: MessageEvent<AvifWorkerResponse>) => {
      if (this.worker !== worker || this.generation !== generation) return;
      const response = event.data;
      if (!response || response.generation !== generation) return;
      const pending = this.pending.get(response.requestId);
      if (!pending || pending.generation !== generation) return;
      if (response.kind === "error") {
        const error = new Error(response.message);
        if (response.fatal) { this.dispose(error); return; }
        clearTimeout(pending.timer);
        this.pending.delete(response.requestId);
        pending.reject(error);
        return;
      }
      if ((pending.kind === "init" && response.kind !== "ready") ||
        (pending.kind === "encode" && (response.kind !== "result" || !(response.buffer instanceof ArrayBuffer)))) {
        this.dispose(new Error("Некорректный ответ AVIF Worker."));
        return;
      }
      clearTimeout(pending.timer);
      this.pending.delete(response.requestId);
      pending.resolve(response);
    };
    worker.onerror = (event) => {
      if (this.worker === worker && this.generation === generation) {
        this.dispose(new Error(event.message || "Аварийное завершение AVIF Worker."));
      }
    };
    worker.onmessageerror = () => {
      if (this.worker === worker && this.generation === generation) {
        this.dispose(new Error("Не удалось прочитать сообщение AVIF Worker."));
      }
    };
    const ready = this.request(worker, { kind: "init" }).then(() => worker);
    if (this.worker === worker) this.ready = ready;
    return ready;
  }

  private request(
    worker: Worker,
    payload: { kind: "init" } | { kind: "encode"; pixels: ArrayBuffer; width: number; height: number; quality: number },
    transfer: Transferable[] = [],
  ): Promise<AvifWorkerResponse> {
    const requestId = ++this.requestId;
    const generation = this.generation;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.worker === worker && this.generation === generation) {
          this.dispose(new Error("Превышено время ожидания AVIF Worker."));
        }
      }, this.timeoutMs);
      this.pending.set(requestId, { kind: payload.kind, generation, resolve, reject, timer });
      try {
        worker.postMessage({ ...payload, requestId, generation } satisfies AvifWorkerRequest, transfer);
      } catch (error) {
        this.dispose(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }
}

let sharedClient: AvifWorkerClient | undefined;

export function encodeAvifInWorker(imageData: ImageData, quality: number) {
  if (!sharedClient) {
    sharedClient = new AvifWorkerClient();
    if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
      window.addEventListener("pagehide", () => sharedClient?.dispose());
    }
  }
  return sharedClient.encode(imageData, quality);
}
