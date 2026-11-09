import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { register } from "node:module";
import { isMainThread, parentPort, Worker as NodeWorker } from "node:worker_threads";

const encoderUrl = new URL("../node_modules/@jsquash/avif/encode.js", import.meta.url).href;
const wasmUrl = new URL("../node_modules/@jsquash/avif/codec/enc/avif_enc.wasm", import.meta.url).href;

// A controlled async boundary for fallback lifecycle tests; otherwise use the
// real encoder, including all existing byte-for-byte fallback assertions.
const mainEncoder = `
  import encode from ${JSON.stringify(encoderUrl)};
  export default function(data, options) {
    const controlled = globalThis[Symbol.for('optima.avifFallbackTest')];
    return controlled ? controlled(data, options) : encode(data, options);
  }
`;

// The production module uses browser fetch for WASM. Only this Node I/O
// adapter supplies the very same installed binary to its unmodified init().
const nodeEncoder = `
  import encode, { init as initAvif } from ${JSON.stringify(encoderUrl)};
  import { readFile } from 'node:fs/promises';
  import { parentPort, workerData } from 'node:worker_threads';
  export default encode;
  export async function init() {
    if (workerData?.failWasm) throw new Error('Diagnostic WASM initialization failure');
    parentPort?.postMessage({ audit: 'init' });
    return initAvif({ wasmBinary: await readFile(new URL(${JSON.stringify(wasmUrl)})) });
  }
`;
register(`data:text/javascript,${encodeURIComponent(`
  export function resolve(specifier, context, nextResolve) {
    if (specifier === '@jsquash/avif/encode') {
      return nextResolve(${JSON.stringify(`data:text/javascript,${encodeURIComponent(isMainThread ? mainEncoder : nodeEncoder)}`)}, context);
    }
    return nextResolve(specifier, context);
  }
`)}`, import.meta.url);

if (!isMainThread) {
  globalThis.ImageData = class ImageData {
    constructor(data, width, height) { Object.assign(this, { data, width, height }); }
  };
  globalThis.self = {
    postMessage(message, transfer = []) {
      parentPort.postMessage(message, transfer);
      if (message.kind === "result") {
        parentPort.postMessage({ audit: "outputDetached", value: message.buffer.byteLength === 0 });
      }
    },
  };
  await import(new URL("../app/lib/avif-worker.ts", import.meta.url));
  parentPort.on("message", (data) => globalThis.self.onmessage({ data }));
} else {
  const { default: test } = await import("node:test");
  const { default: sharp } = await import("sharp");
  const { AvifWorkerClient } = await import(new URL("../app/lib/avif-worker-client.ts", import.meta.url));
  const legacy = await import(encoderUrl);
  await legacy.init({ wasmBinary: await readFile(new URL(wasmUrl)) });

  const tick = () => new Promise((resolve) => setImmediate(resolve));
  const sha = (data) => createHash("sha256").update(new Uint8Array(data)).digest("hex");
  function pixels(width = 16, height = 12, seed = 1, transparent = false) {
    const data = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      data.set([(x * 11 + seed) % 256, (y * 17 + seed) % 256, (x + y + seed) % 256,
        transparent && x < width / 2 ? 0 : 255], (y * width + x) * 4);
    }
    return { data, width, height };
  }

  class FakeWorker {
    onmessage = null;
    onerror = null;
    onmessageerror = null;
    sent = [];
    terminated = false;
    autoInit = true;
    postMessage(message, transfer = []) {
      const received = structuredClone(message, { transfer });
      this.sent.push(received);
      if (received.kind === "init" && this.autoInit) queueMicrotask(() => this.reply(received, { kind: "ready" }));
    }
    reply(request, payload) { this.onmessage?.({ data: { requestId: request.requestId, generation: request.generation, ...payload } }); }
    result(request, value = 1) {
      const buffer = new Uint8Array([value]).buffer;
      const received = structuredClone({ buffer }, { transfer: [buffer] });
      assert.equal(buffer.byteLength, 0);
      this.reply(request, { kind: "result", buffer: received.buffer });
    }
    terminate() { this.terminated = true; }
    get encoding() { return this.sent.filter((request) => request.kind === "encode"); }
  }
  function harness(options = {}) {
    const workers = [];
    const client = new AvifWorkerClient({ ...options, createWorker: () => {
      const worker = new FakeWorker(); workers.push(worker); return worker;
    } });
    return { client, workers };
  }

  test("lazy worker reuse serializes sizes/images/qualities and transfers each owned buffer", async () => {
    const { client, workers } = harness();
    assert.equal(workers.length, 0);
    const first = pixels(16, 12), second = pixels(12, 9, 5);
    const a = client.encode(first, 85), b = client.encode(second, 65);
    await tick();
    const worker = workers[0];
    assert.equal(worker.encoding.length, 1);
    assert.equal(first.data.byteLength, 0);
    assert.equal(second.data.byteLength, 12 * 9 * 4);
    assert.deepEqual([worker.encoding[0].width, worker.encoding[0].height, worker.encoding[0].quality], [16, 12, 85]);
    worker.result(worker.encoding[0], 85);
    assert.equal(new Uint8Array(await a)[0], 85);
    await tick();
    assert.equal(second.data.byteLength, 0);
    assert.deepEqual([worker.encoding[1].width, worker.encoding[1].height, worker.encoding[1].quality], [12, 9, 65]);
    worker.result(worker.encoding[1], 65);
    assert.equal(new Uint8Array(await b)[0], 65);
    assert.equal(workers.length, 1);
    assert.equal(worker.sent.filter((r) => r.kind === "init").length, 1);
    assert.equal(new Set(worker.sent.map((r) => r.requestId)).size, worker.sent.length);
    client.dispose();
    assert.equal(worker.terminated, true);
  });

  test("invalid quality and pixels reject before creating a worker or detaching data", async () => {
    const { client, workers } = harness();
    for (const quality of [0, 101, 85.5, NaN]) await assert.rejects(client.encode(pixels(), quality), /качество/);
    await assert.rejects(client.encode({ ...pixels(), width: 0 }, 85), /пиксельные/);
    const data = pixels();
    await assert.rejects(client.encode({ ...data, height: 99 }, 85), /пиксельные/);
    assert.equal(data.data.byteLength, 16 * 12 * 4);
    assert.equal(workers.length, 0);
  });

  test("ordinary encoding error rejects its request without fallback or losing the next job", async () => {
    const { client, workers } = harness();
    const bad = client.encode(pixels(), 85);
    const rejected = assert.rejects(bad, /file error/);
    const good = client.encode(pixels(), 65);
    await tick();
    const worker = workers[0];
    worker.reply(worker.encoding[0], { kind: "error", fatal: false, message: "file error" });
    await rejected; await tick();
    worker.result(worker.encoding[1], 65);
    assert.equal(new Uint8Array(await good)[0], 65);
    assert.equal(workers.length, 1);
    client.dispose();
  });

  for (const failure of ["WASM", "crash", "messageerror", "protocol"]) {
    test(`${failure} rejects active and queued jobs; next explicit request creates a new worker`, async () => {
      const { client, workers } = harness();
      const settled = Promise.allSettled([client.encode(pixels(), 85), client.encode(pixels(), 65)]);
      await tick();
      const old = workers[0];
      if (failure === "WASM") old.reply(old.encoding[0], { kind: "error", fatal: true, message: "WASM failed" });
      if (failure === "crash") old.onerror({ message: "Worker crashed" });
      if (failure === "messageerror") old.onmessageerror({});
      if (failure === "protocol") old.reply(old.encoding[0], { kind: "result", buffer: "not a buffer" });
      assert.ok((await settled).every((r) => r.status === "rejected"));
      assert.equal(old.terminated, true);
      assert.equal(old.encoding.length, 1, "queued pixels must not be sent after a fatal error");
      const next = client.encode(pixels(), 85); await tick();
      workers[1].result(workers[1].encoding[0], 9);
      assert.equal(new Uint8Array(await next)[0], 9);
      assert.notEqual(old.sent[0].generation, workers[1].sent[0].generation);
      client.dispose();
    });
  }

  test("late generations, unknown IDs and duplicate responses cannot settle a newer request", async () => {
    const { client, workers } = harness();
    const oldPromise = client.encode(pixels(), 85);
    const rejected = assert.rejects(oldPromise, /остановлен/);
    await tick();
    const old = workers[0], oldHandler = old.onmessage, oldRequest = old.encoding[0];
    client.dispose(); await rejected;
    let resolved = false;
    const next = client.encode(pixels(), 65).then((value) => { resolved = true; return value; });
    await tick();
    const current = workers[1], request = current.encoding[0];
    oldHandler({ data: { ...request, kind: "result", buffer: new ArrayBuffer(1) } });
    current.reply({ ...request, generation: oldRequest.generation }, { kind: "result", buffer: new ArrayBuffer(1) });
    current.reply({ ...request, requestId: oldRequest.requestId }, { kind: "result", buffer: new ArrayBuffer(1) });
    await tick(); assert.equal(resolved, false);
    current.result(request, 7); current.result(request, 99);
    assert.equal(new Uint8Array(await next)[0], 7);
    client.dispose();
  });

  test("startup and encoding timeouts settle promises and terminate the failed worker", async () => {
    for (const startup of [true, false]) {
      const worker = new FakeWorker(); worker.autoInit = !startup;
      const client = new AvifWorkerClient({ createWorker: () => worker, timeoutMs: 15 });
      await assert.rejects(client.encode(pixels(), 85), /время ожидания/);
      assert.equal(worker.terminated, true);
      client.dispose();
    }
  });

  test("postMessage/constructor failure rejects without silently running the main encoder", async () => {
    const creation = new AvifWorkerClient({ createWorker: () => { throw Error("Constructor failed"); } });
    await assert.rejects(creation.encode(pixels(), 85), /Constructor failed/);
    const worker = new FakeWorker();
    worker.postMessage = () => { throw new DOMException("Clone failed", "DataCloneError"); };
    const client = new AvifWorkerClient({ createWorker: () => worker });
    await assert.rejects(client.encode(pixels(), 85), /Clone failed/);
    assert.equal(worker.terminated, true);
  });

  test("missing Worker API and explicit constructor denial use the unchanged bounded fallback", async () => {
    const saved = Object.getOwnPropertyDescriptor(globalThis, "Worker");
    try {
      for (const implementation of [undefined, class { constructor() { throw new DOMException("Blocked", "SecurityError"); } }]) {
        Object.defineProperty(globalThis, "Worker", { configurable: true, value: implementation });
        const client = new AvifWorkerClient();
        for (const quality of [65, 85]) {
          const expected = await legacy.default(pixels(), { quality, speed: 8, subsample: 1, tune: 2 });
          const input = pixels();
          assert.equal(sha(await client.encode(input, quality)), sha(expected));
          assert.equal(input.data.byteLength, 16 * 12 * 4, "fallback pixels must remain attached");
        }
        client.dispose();
      }
    } finally {
      if (saved) Object.defineProperty(globalThis, "Worker", saved); else delete globalThis.Worker;
    }
  });

  function deferred() {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
  }

  async function controlledFallback(run) {
    const savedWorker = Object.getOwnPropertyDescriptor(globalThis, "Worker");
    const key = Symbol.for("optima.avifFallbackTest");
    const savedControl = Object.getOwnPropertyDescriptor(globalThis, key);
    const calls = [], starts = [];
    Object.defineProperty(globalThis, "Worker", { configurable: true, value: undefined });
    Object.defineProperty(globalThis, key, { configurable: true, value: (data, options) => {
      const call = { ...deferred(), data, options };
      calls.push(call);
      starts[calls.length - 1]?.resolve(call);
      return call.promise;
    } });
    try {
      await run({ calls, started(index) {
        if (calls[index]) return Promise.resolve(calls[index]);
        return (starts[index] ??= deferred()).promise;
      } });
    } finally {
      if (savedWorker) Object.defineProperty(globalThis, "Worker", savedWorker); else delete globalThis.Worker;
      if (savedControl) Object.defineProperty(globalThis, key, savedControl); else delete globalThis[key];
    }
  }

  for (const cachedUnavailable of [false, true]) {
    test(`dispose rejects obsolete fallback after completion (cached unavailable: ${cachedUnavailable})`, async () => {
      await controlledFallback(async ({ calls, started }) => {
        const client = new AvifWorkerClient();
        try {
          let index = 0;
          if (cachedUnavailable) {
            const warmup = client.encode(pixels(), 85);
            const call = await started(index++);
            const buffer = new ArrayBuffer(4);
            call.resolve(buffer);
            assert.equal(await warmup, buffer);
          }
          const old = client.encode(pixels(), 85);
          const rejected = assert.rejects(old, /cancel fallback/);
          const oldCall = await started(index);
          const cancelled = new Error("cancel fallback");
          client.dispose(cancelled);
          client.dispose(cancelled);
          const next = client.encode(pixels(12, 9), 65);
          assert.equal(calls.length, index + 1, "new job must wait for the old computation to settle");
          oldCall.resolve(new ArrayBuffer(1));
          await rejected;
          const nextCall = await started(index + 1);
          assert.deepEqual([nextCall.data.width, nextCall.data.height, nextCall.options.quality], [12, 9, 65]);
          const fresh = new ArrayBuffer(8);
          nextCall.resolve(fresh);
          assert.equal(await next, fresh, "old result must not replace the new result");
          assert.equal(calls.length, index + 2);
        } finally { client.dispose(); }
      });
    });
  }

  test("fallback errors reject once and the next queued operation still succeeds", async () => {
    await controlledFallback(async ({ calls, started }) => {
      const client = new AvifWorkerClient();
      try {
        const failed = client.encode(pixels(), 85);
        const error = new Error("fallback encode failed");
        const rejected = assert.rejects(failed, (actual) => actual === error);
        const next = client.encode(pixels(), 65);
        const first = await started(0);
        assert.equal(calls.length, 1);
        first.reject(error);
        await rejected;
        const second = await started(1);
        const output = new ArrayBuffer(3);
        second.resolve(output);
        assert.equal(await next, output);
        assert.equal(calls.length, 2);
      } finally { client.dispose(); }
    });
  });

  class NativeWorkerAdapter {
    onmessage = null;
    onerror = null;
    onmessageerror = null;
    initCalls = 0;
    outputDetached = [];
    terminated = false;
    constructor(failWasm = false) {
      this.native = new NodeWorker(new URL(import.meta.url), { workerData: { failWasm }, execArgv: ["--experimental-strip-types"] });
      this.native.on("message", (message) => {
        if (message.audit === "init") { this.initCalls++; return; }
        if (message.audit === "outputDetached") { this.outputDetached.push(message.value); return; }
        this.onmessage?.({ data: message });
      });
      this.native.on("error", (error) => this.onerror?.({ message: error.message }));
      this.native.on("messageerror", (error) => this.onmessageerror?.(error));
      this.native.on("exit", (code) => { if (code && !this.terminated) this.onerror?.({ message: `Worker exited: ${code}` }); });
    }
    postMessage(message, transfer = []) { this.native.postMessage(message, transfer); }
    terminate() { this.terminated = true; void this.native.terminate(); }
  }

  test("actual worker module + native transfers + AVIF WASM match legacy SHA-256, dimensions and alpha", async () => {
    const workers = [];
    const client = new AvifWorkerClient({ createWorker: () => { const w = new NativeWorkerAdapter(); workers.push(w); return w; } });
    try {
      const cases = [[48, 32, 1, 85, false], [32, 21, 1, 65, false], [40, 30, 9, 85, false], [48, 32, 3, 85, true]];
      const expected = [];
      for (const [w, h, seed, quality, alpha] of cases) {
        expected.push(await legacy.default(pixels(w, h, seed, alpha), { quality, speed: 8, subsample: 1, tune: 2 }));
      }
      const inputs = cases.map(([w, h, seed, , alpha]) => pixels(w, h, seed, alpha));
      const actual = await Promise.all(inputs.map((input, i) => client.encode(input, cases[i][3])));
      for (let i = 0; i < actual.length; i++) {
        assert.equal(inputs[i].data.byteLength, 0);
        assert.equal(sha(actual[i]), sha(expected[i]), `case ${i}: exact AVIF bytes`);
        assert.equal(Buffer.from(actual[i]).subarray(4, 12).toString(), "ftypavif");
        const decoded = await sharp(Buffer.from(actual[i])).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
        const reference = await sharp(Buffer.from(expected[i])).ensureAlpha().raw().toBuffer();
        assert.deepEqual([decoded.info.width, decoded.info.height], cases[i].slice(0, 2));
        assert.equal(sha(decoded.data), sha(reference));
        if (cases[i][4]) assert.ok(decoded.data.some((a, index) => index % 4 === 3 && a === 0));
      }
      await tick();
      assert.equal(workers.length, 1);
      assert.equal(workers[0].initCalls, 1);
      assert.deepEqual(workers[0].outputDetached, [true, true, true, true]);
    } finally { client.dispose(); }
  });

  test("actual worker initialization failure rejects once and a later request can recreate WASM", async () => {
    const workers = [];
    const client = new AvifWorkerClient({ createWorker: () => {
      const worker = new NativeWorkerAdapter(workers.length === 0); workers.push(worker); return worker;
    } });
    try {
      await assert.rejects(client.encode(pixels(), 85), /Diagnostic WASM initialization failure/);
      assert.equal(workers[0].terminated, true);
      const result = await client.encode(pixels(), 65);
      const expected = await legacy.default(pixels(), { quality: 65, speed: 8, subsample: 1, tune: 2 });
      assert.equal(sha(result), sha(expected));
      assert.equal(workers.length, 2);
    } finally { client.dispose(); }
  });
}
