import type { AvifWorkerRequest, AvifWorkerResponse } from "./avif-worker-client";

type Encoder = typeof import("@jsquash/avif/encode").default;

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<AvifWorkerRequest>) => void) | null;
  onmessageerror: (() => void) | null;
  postMessage: (message: AvifWorkerResponse, transfer?: Transferable[]) => void;
};

let encoder: Promise<Encoder> | undefined;
let generation: number | undefined;
let lastRequestId = 0;
let queue: Promise<void> = Promise.resolve();

function getEncoder() {
  if (!encoder) {
    encoder = import("@jsquash/avif/encode").then(async (avif) => {
      await avif.init();
      return avif.default;
    });
  }
  return encoder;
}

async function handle(request: AvifWorkerRequest) {
  if (request.kind === "init" && generation === undefined) generation = request.generation;
  if (request.generation !== generation || request.requestId <= lastRequestId) return;
  lastRequestId = request.requestId;
  const identity = { requestId: request.requestId, generation: request.generation };
  try {
    const encode = await getEncoder();
    if (request.kind === "init") {
      scope.postMessage({ ...identity, kind: "ready" });
      return;
    }
    const imageData = new ImageData(new Uint8ClampedArray(request.pixels), request.width, request.height);
    const buffer = await encode(imageData, {
      quality: request.quality,
      speed: 8,
      subsample: 1,
      tune: 2,
    });
    scope.postMessage({ ...identity, kind: "result", buffer }, [buffer]);
  } catch (error) {
    // A failed WASM instance is never reused or retried for the same request.
    scope.postMessage({ ...identity, kind: "error", fatal: true,
      message: error instanceof Error ? error.message : String(error) });
  }
}

scope.onmessage = (event) => { queue = queue.then(() => handle(event.data)); };
scope.onmessageerror = () => { throw new Error("Не удалось прочитать запрос AVIF Worker."); };
