import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { cpus, platform, release, totalmem } from "node:os";
import { resolve, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
let sharp;

const [stage, directory, ...args] = process.argv.slice(2);
const expectedRef = "refs/heads/ci/optima-verify-avif-chroma";
assert.equal(process.env.GITHUB_ACTIONS, "true", "Run only on the GitHub Actions runner");
assert.equal(process.env.GITHUB_REF, expectedRef);
assert.equal(platform(), "linux", "maxRSS method is calibrated for Linux");
const codec = "@jsquash/avif";
const options = { speed: 8, tune: 2 };
const chroma = { 1: "4:2:0", 3: "4:4:4" };
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function run(command, parameters, timeout = 45_000) {
  const result = spawnSync(command, parameters, { encoding: "utf8", timeout, maxBuffer: 512 * 1024 });
  if (result.error || result.status !== 0) {
    throw new Error(command + " failed (" + (result.error?.message ?? result.signal ?? result.status) + "): " +
      result.stderr?.trim());
  }
  return result.stdout;
}

async function encodeTrial() {
  const [input, target, ...numbers] = args;
  const [width, height, quality, subsample] = numbers.map(Number);
  const data = Uint8ClampedArray.from(await readFile(input));
  assert.equal(data.length, width * height * 4);
  const referenceSha256 = sha256(data);
  const importStart = performance.now();
  const encoder = await import("@jsquash/avif/encode.js");
  const wasm = await readFile(new URL(import.meta.resolve(codec + "/codec/enc/avif_enc.wasm")));
  const loadMs = performance.now() - importStart;
  const initStart = performance.now();
  await encoder.init({ wasmBinary: wasm });
  const initMs = performance.now() - initStart;
  const preEncodeRssKiB = process.resourceUsage().maxRSS;
  const pixels = { data, width, height };
  const configuration = { ...options, quality, subsample };
  await encoder.default(pixels, configuration);
  global.gc();
  const timesMs = [];
  const outputHashes = [];
  let output;
  for (let trial = 0; trial < 3; trial += 1) {
    const start = performance.now();
    output = Buffer.from(await encoder.default(pixels, configuration));
    timesMs.push(performance.now() - start);
    outputHashes.push(sha256(output));
  }
  assert.equal(new Set(outputHashes).size, 1, "Encoding must be deterministic in this trial");
  assert.equal(sha256(data), referenceSha256, "Input pixels changed");
  const peakRssKiB = process.resourceUsage().maxRSS;
  await writeFile(target, output);
  process.stdout.write(JSON.stringify({
    loadMs, initMs, preEncodeRssKiB, peakRssKiB, timesMs, medianMs: median(timesMs),
    outputBytes: output.length, outputSha256: outputHashes[0], referenceSha256,
  }));
}

function boxes(data) {
  const result = [];
  for (let offset = 0; offset < data.length;) {
    assert.ok(data.length - offset >= 8, "Truncated AVIF box header");
    const size = data.readUInt32BE(offset) || data.length - offset;
    assert.ok(size >= 8 && size <= data.length - offset, "Invalid AVIF box length");
    result.push({ type: data.toString("ascii", offset + 4, offset + 8),
      payload: data.subarray(offset + 8, offset + size) });
    offset += size;
  }
  return result;
}

function requireBox(data, type) {
  const box = boxes(data).find((item) => item.type === type);
  assert.ok(box, "Missing AVIF box: " + type);
  return box.payload;
}

async function analyzeMetadata(path, subsample) {
  const data = await readFile(path);
  const meta = requireBox(data, "meta").subarray(4); // FullBox version and flags
  const properties = requireBox(requireBox(meta, "iprp"), "ipco");
  // AV1-ISOBMFF section 2.3.3 defines the av1C fields. The alpha image is monochrome.
  const color = boxes(properties).filter(({ type }) => type === "av1C").map(({ payload }) => {
    assert.ok(payload.length >= 4 && payload[0] === 0x81, "Invalid AV1 configuration");
    return payload[2];
  }).filter((flags) => !(flags & 0x10));
  assert.equal(color.length, 1, "Expected one color AV1 configuration");
  const [flags] = color;
  assert.equal(flags & 0x60, 0, "Expected 8-bit AVIF");
  const subsamplingBits = (flags >> 2) & 3;
  assert.equal(subsamplingBits, subsample === 1 ? 3 : 0, "Unexpected chroma metadata");
  return subsamplingBits === 3 ? "yuv420p" : "yuv444p";
}

async function loadMetric() {
  const metricPath = process.env.AVIF_METRIC_ENTRY;
  if (metricPath) {
    try {
      const { loadScorer } = await import(pathToFileURL(metricPath).href);
      const scorer = await loadScorer();
      const probe = { data: new Uint8Array(48 * 48 * 3).fill(131), width: 48, height: 48 };
      assert.ok(Math.abs(scorer.score(probe, probe) - 100) < 0.1);
      return { name: "SSIMULACRA2", implementation: "bytecut-ssimulacra2 0.1.0",
        source: "https://www.npmjs.com/package/bytecut-ssimulacra2/v/0.1.0", tolerance: 1,
        score: (reference, decoded, width, height) =>
          scorer.score({ data: reference, width, height }, { data: decoded, width, height }) };
    } catch (error) {
      console.warn("SSIMULACRA2 startup failed:", error.message);
    }
  }
  const { ssim } = await import("ssim.js");
  return { name: "RGB SSIM", implementation: "ssim.js 3.5.0 (three independent channel scores, arithmetic mean)",
    source: "https://www.npmjs.com/package/ssim.js/v/3.5.0", tolerance: 0.005,
    score(reference, decoded, width, height) {
      function channel(rgb, offset) {
        const data = new Uint8ClampedArray(width * height * 4);
        for (let pixel = 0; pixel < width * height; pixel += 1) {
          data.fill(rgb[pixel * 3 + offset], pixel * 4, pixel * 4 + 3);
          data[pixel * 4 + 3] = 255;
        }
        return { data, width, height };
      }
      return [0, 1, 2].reduce((sum, offset) =>
        sum + ssim(channel(reference, offset), channel(decoded, offset), { downsample: "none" }).mssim, 0) / 3;
    } };
}

function composite(rgba, background) {
  const rgb = new Uint8Array(rgba.length / 4 * 3);
  for (let i = 0, j = 0; i < rgba.length; i += 4, j += 3) {
    const opacity = rgba[i + 3] / 255;
    for (let c = 0; c < 3; c += 1) rgb[j + c] = Math.round(rgba[i + c] * opacity + background * (1 - opacity));
  }
  return rgb;
}

async function comparePixels(path, rgba, width, height, alpha, metric) {
  const { data, info } = await sharp(path).toColourspace("srgb").ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  assert.deepEqual([info.width, info.height, info.channels], [width, height, 4]);
  let alphaError = 0;
  let transparentPixels = 0;
  for (let i = 3; i < data.length; i += 4) {
    alphaError += Math.abs(rgba[i] - data[i]);
    if (data[i] < 255) transparentPixels += 1;
  }
  assert.ok(alpha ? transparentPixels > 0 : transparentPixels === 0, "Unexpected transparency");
  const scores = (alpha ? [0, 255] : [255]).map((background) => metric.score(
    composite(rgba, background), composite(data, background), width, height,
  ));
  assert.ok(scores.every(Number.isFinite), "Invalid metric result");
  return { data, scores, score: scores.reduce((a, b) => a + b, 0) / scores.length,
    alphaMae: alphaError / (width * height), transparentPixels };
}

async function savePreview(path, data, width, height, fixtureId) {
  const image = () => sharp(data, { raw: { width, height, channels: 4 } });
  await image().png().toFile(path + ".png");
  const cropWidth = Math.min(width, 160);
  const cropHeight = Math.min(height, 112);
  const focus = {
    "fine-text": [0.36, 0.35], dashboard: [0.45, 0.64], "sharp-edges": [0.44, 0.56],
    "gradient-texture": [0.5, 0.76], portrait: [0.52, 0.28], "mesa-sunrise": [0.5, 0.42],
  }[fixtureId] ?? [0.5, 0.5];
  const left = Math.max(0, Math.min(width - cropWidth, Math.round(width * focus[0] - cropWidth / 2)));
  const top = Math.max(0, Math.min(height - cropHeight, Math.round(height * focus[1] - cropHeight / 2)));
  await image().extract({ left, top, width: cropWidth, height: cropHeight })
    .resize(cropWidth * 3, cropHeight * 3, { kernel: "nearest" }).png().toFile(path + "-crop.png");
}

function pairRows(rows) {
  return rows.filter((row) => row.subsample === 1 && row.success).flatMap((base) => {
    const test = rows.find((row) => row.id === base.id && row.quality === base.quality && row.subsample === 3 && row.success);
    if (!test) return [];
    return [{ id: base.id, group: base.group, quality: base.quality, base, test,
      bytesDelta: test.outputBytes - base.outputBytes,
      bytesPercent: (test.outputBytes / base.outputBytes - 1) * 100,
      timePercent: (test.medianMs / base.medianMs - 1) * 100,
      peakDeltaKiB: test.peakRssKiB - base.peakRssKiB,
      scoreDelta: test.score - base.score,
    }];
  });
}

const decimal = (number) => number.toFixed(3);
async function report(dir, meta, rows, errors) {
  const pairs = pairRows(rows);
  await writeFile(join(dir, "results.json"), JSON.stringify({ ...meta, rows, pairs, errors }, null, 2) + "\n");
  const lines = [
    "# AVIF chroma — " + stage, "",
    "Encoder " + meta.codecVersion + " / Node " + process.version + " / " + meta.decoder + ".",
    "Metric: " + meta.metric.name + " (" + meta.metric.implementation + "). Higher is better.",
    "SSIMULACRA2 uses a 1-point descriptive band; RGB SSIM uses 0.005. These bands do not establish a perceptual threshold.",
    "Scores for the transparent fixture average RGB scores on black and white sRGB backgrounds. Alpha MAE is in JSON.",
    "Three timed encodes per case after one warmup. WASM import/load and initialization are separate in JSON.",
    "Peak RSS uses Linux process.resourceUsage().maxRSS in an isolated Node child for each case and includes initialization, warmup and encoding.",
    "These timings and memory measurements describe Node and single-thread WASM on this runner.",
    "JPEG sources may already contain artifacts. Quality is measured relative to the common prepared sRGB raster.",
    "Fixed Q results compare equal settings; the two quality levels supply only a limited view of quality versus size.", "",
    "| Fixture | Q | Prepared RGBA bytes | 420 bytes | 444 bytes | Δ bytes | Δ size % | 420 score | 444 score | 420 ms | 444 ms | 420 peak KiB | 444 peak KiB |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
    ...pairs.map(({ id, quality, base, test, bytesDelta, bytesPercent }) =>
      "| " + [id, quality, base.preparedBytes, base.outputBytes, test.outputBytes, bytesDelta, decimal(bytesPercent),
        decimal(base.score), decimal(test.score), decimal(base.medianMs), decimal(test.medianMs),
        base.peakRssKiB, test.peakRssKiB].join(" | ") + " |"),
    "", "| Group | Q | Pairs | Improved | Similar | Lower | Median size Δ % | Median time Δ % | Median peak RSS Δ KiB |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|",
  ];
  for (const quality of [65, 85]) {
    for (const group of ["all", "photo", "screenshot", "graphic", "alpha"]) {
      const batch = pairs.filter((pair) => pair.quality === quality && (group === "all" || pair.group === group));
      if (!batch.length) continue;
      const improved = batch.filter((pair) => pair.scoreDelta > meta.metric.tolerance).length;
      const lower = batch.filter((pair) => pair.scoreDelta < -meta.metric.tolerance).length;
      lines.push("| " + [group, quality, batch.length, improved, batch.length - improved - lower, lower,
        decimal(median(batch.map((pair) => pair.bytesPercent))), decimal(median(batch.map((pair) => pair.timePercent))),
        decimal(median(batch.map((pair) => pair.peakDeltaKiB)))].join(" | ") + " |");
    }
  }
  lines.push("", "Successful cases: " + rows.filter((row) => row.success).length + ". Errors: " + errors.length + ".");
  for (const error of errors) lines.push("- " + error.replaceAll("\n", " "));
  await writeFile(join(dir, "summary.md"), lines.join("\n") + "\n");
  console.log(lines.join("\n"));
}

async function benchmark() {
  assert.ok(["smoke", "full"].includes(stage));
  assert.ok(directory && process.env.RUNNER_TEMP);
  const output = resolve(directory);
  const referencePath = join(process.env.RUNNER_TEMP, "optima-avif-reference-" + stage + ".rgba");
  await mkdir(output, { recursive: true });
  const rows = [];
  const errors = [];
  const meta = { stage };
  try {
    ({ default: sharp } = await import("sharp"));
    sharp.concurrency(1);
    const { fixtures, prepare } = await import("./avif-chroma-fixtures.mjs");
    const packageInfo = JSON.parse(await readFile(new URL(import.meta.resolve(codec + "/package.json")), "utf8"));
    assert.equal(packageInfo.version, "2.1.1");
    const { defaultOptions } = await import("@jsquash/avif/meta.js");
    const metric = await loadMetric();
    const { score: _score, ...metricInfo } = metric;
    Object.assign(meta, {
      commit: process.env.GITHUB_SHA, runnerImage: process.env.ImageVersion, node: process.version,
      system: release(), cpu: cpus()[0].model, logicalCpuCount: cpus().length, memoryBytes: totalmem(),
      codecVersion: packageInfo.version, options: { ...defaultOptions, ...options },
      decoder: "sharp " + sharp.versions.sharp + " / libheif " + sharp.versions.heif,
      metadataTool: "AVIF av1C fields (AV1-ISOBMFF section 2.3.3)", metric: metricInfo,
    });

    const preview = [];
    let index = 0;
    for (const fixture of fixtures(stage)) {
      const { width, height, data, provenance } = await prepare(fixture, stage);
      assert.ok(width > 0 && height > 0 && Math.max(width, height) <= 960);
      await writeFile(referencePath, data);
      const referenceSha256 = sha256(data);
      await savePreview(join(output, fixture.id + "-reference"), data, width, height, fixture.id);
      for (const quality of [65, 85]) {
        const order = (index + (quality === 85 ? 1 : 0)) % 2 === 0 ? [1, 3] : [3, 1];
        for (const subsample of order) {
          const label = fixture.id + "-q" + quality + "-" + (subsample === 1 ? "420" : "444");
          const path = join(output, label + ".avif");
          const row = { id: fixture.id, category: fixture.category, group: fixture.group, width, height,
            ...options, quality, subsample, chroma: chroma[subsample], preparedBytes: data.length,
            referenceSha256, provenance, success: false, decoded: false };
          rows.push(row);
          try {
            const trial = JSON.parse(run(process.execPath, ["--expose-gc", fileURLToPath(import.meta.url), "trial", output,
              referencePath, path, width, height, quality, subsample].map(String), 60_000));
            assert.equal(trial.referenceSha256, referenceSha256);
            Object.assign(row, trial);
            row.pixelFormat = await analyzeMetadata(path, subsample);
            const { data: decoded, ...scores } = await comparePixels(path, data, width, height, fixture.alpha, metric);
            row.decoded = true;
            Object.assign(row, scores);
            if (quality === 85) await savePreview(join(output, label), decoded, width, height, fixture.id);
            row.success = true;
          } catch (error) {
            row.error = error.message;
            throw new Error(label + ": " + error.message, { cause: error });
          }
        }
      }
      preview.push(fixture.id);
      index += 1;
    }
    const dashboard = preview.map((id) => "<section><h2>" + id + "</h2>" +
      ["", "-crop"].map((crop) => "<div>" + [[id + "-reference", "Reference"], [id + "-q85-420", "Q85 4:2:0"],
        [id + "-q85-444", "Q85 4:4:4"]].map(([file, caption]) =>
        '<figure><figcaption>' + caption + (crop ? " · 3×" : " · 100%") + '</figcaption><img src="' + file + crop +
          '.png" alt="' + caption + '"></figure>').join("") + "</div>").join("") + "</section>").join("");
    await writeFile(join(output, "compare.html"), '<!doctype html><html lang="en"><meta charset="utf-8">' +
      '<title>AVIF comparison</title><style>body{font:16px system-ui}section>div{display:flex;overflow:auto;gap:8px}' +
      'figure{margin:8px 0}img{display:block;background:#aaa}</style><h1>AVIF comparison</h1>' + dashboard + "</html>");
  } catch (error) {
    errors.push(error.stack ?? error.message);
    process.exitCode = 1;
  }
  meta.metric ??= { name: "Unavailable", implementation: "Unavailable", tolerance: 0 };
  await report(output, meta, rows, errors);
}

if (stage === "trial") await encodeTrial();
else await benchmark();
