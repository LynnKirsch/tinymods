import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import ts from "typescript";
import sharp from "sharp";

// Match Next's extensionless TS import in this Node-only test, including Node 22.13.
const optimizerUrl = new URL("../app/lib/image-optimizer.ts", import.meta.url);
register(`data:text/javascript,${encodeURIComponent(`
  export function resolve(specifier, context, nextResolve) {
    if (specifier === "./heic-decoder" && context.parentURL === ${JSON.stringify(optimizerUrl.href)}) {
      return nextResolve(new URL("./heic-decoder.ts", context.parentURL).href, context);
    }
    if (specifier === "./avif-worker-client" && context.parentURL === ${JSON.stringify(optimizerUrl.href)}) {
      return nextResolve(new URL("./avif-worker-client.ts", context.parentURL).href, context);
    }
    if (specifier === "@jsquash/avif/encode") return nextResolve("@jsquash/avif/encode.js", context);
    if (specifier === "@jsquash/oxipng/optimise") return nextResolve("@jsquash/oxipng/optimise.js", context);
    return nextResolve(specifier, context);
  }
`)}`, import.meta.url);

const {
  calculateCropRect,
  calculateOutputDimensions,
  buildTargetWidths,
  cropSettingsFromRect,
  resizeCropRect,
  createVariantFileName,
  createCustomProfile,
  getAvailableImageProfiles,
  IMAGE_PROFILES,
  resolveEncoderQuality,
  getUploadCandidates,
  MAX_BATCH_FILES,
  defaultOutputSelection,
  toggleOutputSelection,
  selectedResultOutputs,
  outputSelectionKey,
  outputDownloadLabel,
  optimizeImage,
  encodeRgbaPng,
  prepareTransparentPng,
  preparedPngKey,
  parseCustomQuality,
  DEFAULT_ENCODER_QUALITY,
  selectResultWidth,
} = await import(optimizerUrl.href);

const componentSource = await readFile(new URL("../app/components/ImageOptimizer.tsx", import.meta.url), "utf8");
const componentAst = ts.createSourceFile("ImageOptimizer.tsx", componentSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

function resultFixture() {
  const webp = {
    format: "webp",
    mime: "image/webp",
    extension: "webp",
    blob: new Blob(["webp"], { type: "image/webp" }),
    size: 4,
    quality: 80,
    similarity: 0.99,
    similarityMethod: "ssim",
    fileName: "img-600x360-q80.webp",
  };
  const avif = {
    ...webp,
    format: "avif",
    mime: "image/avif",
    extension: "avif",
    fileName: "img-600x360-q80.avif",
  };
  const variants = [
    avif,
    webp,
    {
      ...avif,
      format: "png",
      mime: "image/png",
      extension: "png",
      quality: null,
      blob: new Blob(["png"], { type: "image/png" }),
      fileName: "img-600x360.png",
    },
  ];
  return {
    sourceName: "photo.jpg",
    originalWidth: 1000,
    originalHeight: 600,
    originalSize: 100_000,
    profile: {
      id: "custom",
      title: "Свой размер",
      description: "Блок шириной 600px",
      widths: [600],
      sizes: "600px",
    },
    crop: { aspectRatio: 1, positionX: 50, positionY: 50 },
    results: [{
      width: 600,
      height: 360,
      variants,
    }],
    warnings: [],
  };
}

test("quality options resolve to one exact encoder value", () => {
  for (const [tier, value] of [["q65", 65], ["q80", 80], ["q85", 85], ["custom", 72]]) {
    assert.equal(resolveEncoderQuality(tier, "72"), value);
  }
});

test("custom quality outside 1–100 is rejected instead of silently changed", () => {
  for (const value of ["0", "101", "75.5", ""]) assert.throws(() => resolveEncoderQuality("custom", value));
});

test("individual output names use actual dimensions, exact quality and format", () => {
  assert.equal(createVariantFileName(1200, 800, "avif", 65), "img-1200x800-q65.avif");
  assert.equal(createVariantFileName(1200, 800, "avif", 80), "img-1200x800-q80.avif");
  assert.equal(createVariantFileName(1200, 800, "webp", 85), "img-1200x800-q85.webp");
  assert.equal(createVariantFileName(1400, 933, "avif", 67), "img-1400x933-q67.avif");
  assert.equal(createVariantFileName(1000, 600, "png", null), "img-1000x600.png");
  assert.equal(createVariantFileName(1200, 800, "webp", 80, 1), "img-01-1200x800-q80.webp");
});

test("batch admits 1 or 10 files and truncates 11 and additions to capacity", () => {
  assert.equal(MAX_BATCH_FILES, 10);
  for (const count of [1, 10, 11]) {
    const files = Array.from({ length: count }, (_, index) => index);
    assert.deepEqual(getUploadCandidates(files, 0), files.slice(0, 10));
  }
  assert.deepEqual(getUploadCandidates([1, 2, 3, 4, 5], 8), [1, 2]);
  assert.deepEqual(getUploadCandidates([1], 10), []);
});

test("a selected output width keeps only that width", () => {
  const fixture = resultFixture();
  const secondWidth = { ...fixture.results[0], width: 800, height: 480 };
  const selected = selectResultWidth({ ...fixture, results: [...fixture.results, secondWidth] }, 800);
  assert.deepEqual(selected.profile.widths, [800]);
  assert.equal(selected.profile.sizes, "800px");
  assert.deepEqual(selected.results.map((item) => item.width), [800]);
});
test("four exact preset pairs and custom replace the column presets", () => {
  assert.equal(IMAGE_PROFILES.length, 5);
  assert.deepEqual(IMAGE_PROFILES.slice(0, -1).map((profile) => profile.widths),
    [[1920, 1680], [1440, 1280], [1024, 768], [640, 480]]);
  assert.deepEqual(IMAGE_PROFILES.slice(0, -1).map((profile) => profile.title),
    ["1920 · 1680 px", "1440 · 1280 px", "1024 · 768 px", "640 · 480 px"]);
  assert.equal(IMAGE_PROFILES.at(-1)?.id, "custom");
  for (const profile of IMAGE_PROFILES.slice(0, -1)) {
    assert.deepEqual(buildTargetWidths(2000, profile), profile.widths);
  }
});

test("crop rectangle centers a square inside a horizontal image", () => {
  assert.deepEqual(
    calculateCropRect(1000, 600, {
      aspectRatio: 1,
      positionX: 50,
      positionY: 50,
    }),
    { x: 200, y: 0, width: 600, height: 600 },
  );
});

test("crop position can move the square to the right edge", () => {
  assert.deepEqual(
    calculateCropRect(1000, 600, {
      aspectRatio: 1,
      positionX: 100,
      positionY: 50,
    }),
    { x: 400, y: 0, width: 600, height: 600 },
  );
});

test("2:3 crop reduces a horizontal source to the available crop width", () => {
  assert.deepEqual(
    calculateCropRect(1000, 600, {
      aspectRatio: 2 / 3,
      positionX: 50,
      positionY: 50,
    }),
    { x: 300, y: 0, width: 400, height: 600 },
  );
});

test("available profiles never ask for a file wider than the current crop", () => {
  assert.deepEqual(
    getAvailableImageProfiles(1000).map((profile) => profile.id),
    ["768-1024", "480-640", "custom"],
  );
  assert.deepEqual(
    getAvailableImageProfiles(450).map((profile) => profile.id),
    ["custom"],
  );
});

test("custom profile creates only the requested widths", () => {
  assert.deepEqual(createCustomProfile(500, 1000).widths, [500]);
});

test("partially available presets keep only explicit widths, never a crop-sized fallback", () => {
  const profile = IMAGE_PROFILES.find((item) => item.id === "768-1024");
  assert.ok(getAvailableImageProfiles(900).includes(profile));
  assert.deepEqual(buildTargetWidths(900, profile), [768]);
  assert.deepEqual(buildTargetWidths(767, profile), []);
  assert.deepEqual(buildTargetWidths(1023.9, profile), [768]);
  assert.deepEqual(buildTargetWidths(1024, profile), [1024, 768]);
});

test("invalid custom widths are rejected without substituting the maximum", () => {
  assert.throws(() => createCustomProfile(1024, 900));
  assert.throws(() => createCustomProfile(31, 900));
  assert.throws(() => createCustomProfile(500.5, 900));
  assert.throws(() => createCustomProfile(NaN, 900));
  assert.deepEqual(buildTargetWidths(900, { widths: [1024] }), []);
  assert.deepEqual(buildTargetWidths(900, createCustomProfile(768, 900)), [768]);
});

test("live dimensions and output filenames derive from the applied crop ratio", () => {
  const draft = { aspectRatio: 3 / 2, positionX: 50, positionY: 50 };
  const applied = { ...draft };
  const rect = calculateCropRect(4032, 3024, applied);
  for (const [width, height] of [[640, 427], [1024, 683], [1440, 960], [1200, 800]]) {
    assert.deepEqual(calculateOutputDimensions(rect, width), { width, height });
    assert.equal(createVariantFileName(width, height, "avif", 80), `img-${width}x${height}-q80.avif`);
  }
  const wide = calculateCropRect(4032, 3024, { ...applied, aspectRatio: 16 / 9 });
  const size = calculateOutputDimensions(wide, 1200);
  assert.deepEqual(size, { width: 1200, height: 675 });
  assert.equal(createVariantFileName(size.width, size.height, "avif", 80), "img-1200x675-q80.avif");
});

test("no upscale uses resized crop pixels instead of the original image width", () => {
  const crop = cropSettingsFromRect({ x: 500, y: 400, width: 900, height: 600 }, 2000, 1500, 3 / 2);
  const rect = calculateCropRect(2000, 1500, crop);
  assert.equal(rect.width, 900);
  assert.equal(rect.height, 600);
  const profile = IMAGE_PROFILES.find((item) => item.id === "768-1024");
  assert.deepEqual(buildTargetWidths(rect.width, profile), [768]);
  assert.deepEqual(calculateOutputDimensions(rect, 768), { width: 768, height: 512 });
  assert.throws(() => calculateOutputDimensions(rect, 1024));
  assert.throws(() => calculateOutputDimensions({ ...rect, width: 767.99 }, 768));
});

test("moving a crop preserves geometry and resulting dimensions", () => {
  const rect = { x: 100, y: 100, width: 900, height: 600 };
  const first = cropSettingsFromRect(rect, 2000, 1500, 3 / 2);
  const moved = { ...first, positionX: 80, positionY: 70 };
  const before = calculateCropRect(2000, 1500, first);
  const after = calculateCropRect(2000, 1500, moved);
  assert.notEqual(before.x, after.x);
  assert.notEqual(before.y, after.y);
  assert.deepEqual(calculateOutputDimensions(before, 640), calculateOutputDimensions(after, 640));
});

test("corners preserve every fixed preset ratio, the opposite anchor and source bounds", () => {
  for (const ratio of [1, 4 / 5, 3 / 4, 2 / 3, 4 / 3, 3 / 2, 16 / 9]) {
  const rect = { x: 500, y: 400, width: 400 * ratio, height: 400 };
  for (const handle of ["nw", "ne", "sw", "se"]) {
    for (const [dx, dy] of [[-180, 0], [0, -120], [-180, -120], [180, 120], [-5000, 5000], [5000, -5000]]) {
      const resized = resizeCropRect(rect, handle,
        dx * (handle.includes("w") ? -1 : 1), dy * (handle.includes("n") ? -1 : 1),
        2000, 1500, ratio);
      assert.ok(Math.abs(resized.width / resized.height - ratio) < 1e-10, handle);
      if (ratio === 1) assert.equal(resized.width, resized.height);
      if (Math.abs(dx) < 5000) {
        assert.notEqual(resized.width, rect.width);
        assert.notEqual(resized.height, rect.height);
      }
      assert.ok(Math.abs((handle.includes("w") ? resized.x + resized.width : resized.x) -
        (handle.includes("w") ? rect.x + rect.width : rect.x)) < 1e-10);
      assert.ok(Math.abs((handle.includes("n") ? resized.y + resized.height : resized.y) -
        (handle.includes("n") ? rect.y + rect.height : rect.y)) < 1e-10);
      assert.ok(resized.x >= -1e-10 && resized.y >= -1e-10, handle);
      assert.ok(resized.x + resized.width <= 2000 + 1e-10, handle);
      assert.ok(resized.y + resized.height <= 1500 + 1e-10, handle);
      const restored = calculateCropRect(2000, 1500, cropSettingsFromRect(resized, 2000, 1500, ratio));
      assert.ok(Math.abs(restored.width - resized.width) < 1e-10, handle);
      assert.ok(Math.abs(restored.height - resized.height) < 1e-10, handle);
    }
  }
  }
});

for (const handle of ["nw", "ne", "sw", "se"]) {
  test(`original 1500x1000: ${handle} preserves source ratio for X, Y and diagonal drags`, () => {
    const initial = calculateCropRect(1500, 1000, { aspectRatio: null, positionX: 50, positionY: 50 });
    for (const [dx, dy] of [[-300, 0], [0, -200], [-300, -200]]) {
      const resized = resizeCropRect(initial, handle,
        dx * (handle.includes("w") ? -1 : 1), dy * (handle.includes("n") ? -1 : 1),
        1500, 1000, null);
      assert.ok(Math.abs(resized.width / resized.height - 1.5) < 1e-10);
      assert.ok(resized.width < initial.width && resized.height < initial.height);
      assert.equal(handle.includes("w") ? resized.x + resized.width : resized.x,
        handle.includes("w") ? 1500 : 0);
      assert.equal(handle.includes("n") ? resized.y + resized.height : resized.y,
        handle.includes("n") ? 1000 : 0);
    }
  });
}

test("corner size projects both axes onto one proportional rectangle", () => {
  const rect = { x: 300, y: 200, width: 600, height: 400 };
  for (const [dx, dy] of [[150, 0], [0, 100], [150, 100]]) {
    const actual = resizeCropRect(rect, "se", dx, dy, 1500, 1000, null);
    const scale = 1 + (dx * 600 + dy * 400) / (600 ** 2 + 400 ** 2);
    assert.ok(Math.abs(actual.width - 600 * scale) < 1e-10);
    assert.ok(Math.abs(actual.height - 400 * scale) < 1e-10);
  }
});

for (const [edge, handle, rect] of [
  ["left", "nw", { x: 50, y: 400, width: 600, height: 400 }],
  ["right", "se", { x: 850, y: 100, width: 600, height: 400 }],
  ["top", "nw", { x: 600, y: 50, width: 600, height: 400 }],
  ["bottom", "se", { x: 100, y: 550, width: 600, height: 400 }],
]) {
  test(`proportional clamp at ${edge} preserves ratio and opposite anchor`, () => {
    const actual = resizeCropRect(rect, handle, handle.includes("w") ? -5000 : 5000,
      handle.includes("n") ? -5000 : 5000, 1500, 1000, null);
    assert.ok(Math.abs(actual.width / actual.height - 1.5) < 1e-10);
    assert.ok(actual.x >= -1e-10 && actual.y >= -1e-10);
    assert.ok(actual.x + actual.width <= 1500 + 1e-10);
    assert.ok(actual.y + actual.height <= 1000 + 1e-10);
    const boundary = edge === "left" ? actual.x : edge === "right" ? actual.x + actual.width
      : edge === "top" ? actual.y : actual.y + actual.height;
    assert.ok(Math.abs(boundary - (["left", "top"].includes(edge) ? 0 : edge === "right" ? 1500 : 1000)) < 1e-10);
    assert.ok(Math.abs((handle.includes("w") ? actual.x + actual.width : actual.x) -
      (handle.includes("w") ? rect.x + rect.width : rect.x)) < 1e-10);
    assert.ok(Math.abs((handle.includes("n") ? actual.y + actual.height : actual.y) -
      (handle.includes("n") ? rect.y + rect.height : rect.y)) < 1e-10);
  });
}

test("fixed ratio edges resize exactly one axis and custom corners preserve their current shape", () => {
  const rect = { x: 500, y: 400, width: 800, height: 600 };
  for (const handle of ["w", "e", "n", "s"]) {
    for (const [dx, dy] of [[100, 60], [-100, -60], [-5000, 5000], [5000, -5000]]) {
      const resized = resizeCropRect(rect, handle, dx, dy, 2000, 1500, 4 / 3);
      if (handle === "w" || handle === "e") {
        assert.equal(resized.height, rect.height);
        assert.equal(resized.y, rect.y);
      } else {
        assert.equal(resized.width, rect.width);
        assert.equal(resized.x, rect.x);
      }
      assert.ok(resized.x >= 0 && resized.y >= 0);
      assert.ok(resized.x + resized.width <= 2000 && resized.y + resized.height <= 1500);
    }
  }
  for (const handle of ["nw", "ne", "sw", "se"]) {
    const resized = resizeCropRect(rect, handle, 100, 60, 2000, 1500, null);
    assert.ok(Math.abs(resized.width / resized.height - rect.width / rect.height) < 1e-10);
    assert.notEqual(resized.width, rect.width);
    assert.notEqual(resized.height, rect.height);
  }
});

test("side handles in null-ratio mode resize each axis independently", () => {
  const rect = { x: 200, y: 200, width: 1200, height: 800 };
  const horizontal = resizeCropRect(rect, "e", -200, 0, 2000, 1500, null);
  const vertical = resizeCropRect(rect, "s", 0, -200, 2000, 1500, null);
  assert.deepEqual(horizontal, { ...rect, width: 1000 });
  assert.deepEqual(vertical, { ...rect, height: 600 });
  assert.deepEqual(calculateOutputDimensions(rect, 640), { width: 640, height: 427 });
  assert.deepEqual(calculateOutputDimensions(horizontal, 640), { width: 640, height: 512 });
  assert.deepEqual(calculateOutputDimensions(vertical, 640), { width: 640, height: 320 });
});

test("separate image crop settings round-trip without sharing geometry", () => {
  const first = cropSettingsFromRect({ x: 200, y: 100, width: 900, height: 600 }, 2000, 1500, 3 / 2);
  const second = { aspectRatio: 1, positionX: 50, positionY: 50 };
  const draft = { ...first, size: { ...first.size } };
  const resized = resizeCropRect(calculateCropRect(2000, 1500, draft), "e", -120, 0, 2000, 1500, 3 / 2);
  Object.assign(draft, cropSettingsFromRect(resized, 2000, 1500, null));
  assert.equal(calculateCropRect(2000, 1500, first).width, 900);
  assert.equal(calculateCropRect(1000, 600, second).width, 600);
  assert.equal(calculateCropRect(2000, 1500, draft).width, 780);
});


test("batch uses only the common requested widths across different crop geometries", () => {
  const crops = [
    { x: 0, y: 0, width: 2000, height: 1125 },
    { x: 100, y: 100, width: 900, height: 900 },
  ];
  const selected = IMAGE_PROFILES.find((profile) => profile.id === "768-1024");
  const commonWidth = Math.min(...crops.map((crop) => crop.width));
  const batchProfile = { ...selected, widths: buildTargetWidths(commonWidth, selected) };
  assert.deepEqual(batchProfile.widths, [768]);
  assert.deepEqual(crops.map((crop) => buildTargetWidths(crop.width, batchProfile)), [[768], [768]]);
  assert.deepEqual(crops.map((crop) => calculateOutputDimensions(crop, 768)),
    [{ width: 768, height: 432 }, { width: 768, height: 768 }]);
});

test("encoder fallback quality remains 80 and custom input accepts only integers from 1 to 100", () => {
  assert.equal(DEFAULT_ENCODER_QUALITY, 80);
  assert.equal(parseCustomQuality("72"), 72);
  assert.equal(parseCustomQuality("1"), 1);
  assert.equal(parseCustomQuality("100"), 100);
  for (const value of ["", " ", "0", "101", "72.5", "abc"]) {
    assert.equal(parseCustomQuality(value), null, value);
  }
});

test("each chosen quality produces its exact filename without hidden tiers", () => {
  for (const format of ["avif", "webp"]) {
    for (const [tier, quality] of [["q65", 65], ["q80", 80], ["q85", 85], ["custom", 72]]) {
      const actual = resolveEncoderQuality(tier, "72");
      assert.equal(createVariantFileName(1280, 853, format, actual), `img-1280x853-q${quality}.${format}`);
    }
  }
});

test("committed selection defaults to AVIF and supports zero through three downloads", () => {
  const result = resultFixture();
  result.results[0].variants = result.results[0].variants.slice(0, 2);
  result.results[0].variants.push({ ...result.results[0].variants[0], format: "png", quality: null, fileName: "img-600x360.png" });
  let keys = defaultOutputSelection(result);
  assert.equal(selectedResultOutputs(result, keys)[0].variant.format, "avif");
  assert.equal(outputDownloadLabel(selectedResultOutputs(result, keys)), "СКАЧАТЬ 600×360 AVIF");
  keys = toggleOutputSelection(keys, keys[0]);
  assert.deepEqual(keys, []);
  assert.equal(outputDownloadLabel(selectedResultOutputs(result, keys)), "СКАЧАТЬ");
  for (const variant of result.results[0].variants) {
    keys = toggleOutputSelection(keys, outputSelectionKey(600, 360, variant));
    assert.equal(selectedResultOutputs(result, keys).length, keys.length);
    if (keys.length > 1) assert.equal(outputDownloadLabel(selectedResultOutputs(result, keys)), "СКАЧАТЬ ВСЕ");
  }
  const fallback = { ...result, results: [{ ...result.results[0], variants: result.results[0].variants.slice(1) }] };
  assert.equal(selectedResultOutputs(fallback, defaultOutputSelection(fallback))[0].variant.format, "webp");
  assert.deepEqual(defaultOutputSelection({ ...result, results: [] }), []);
});

test("a new result and every target switch select that target's smallest available Blob", () => {
  const context = productionFunctions(["smallestAvailableVariant", "defaultOutputSelectionForTarget", "defaultOutputSelectionForResult", "commitResult"], {
    outputSelectionKey,
  });
  const result = resultFixture();
  result.results[0].variants[0].blob = new Blob([new Uint8Array(200)]);
  result.results[0].variants[1].blob = new Blob([new Uint8Array(150)]);
  let committed = context.commitResult({ id: "a", selectedOutputKeys: ["old"], previewFormat: "avif" }, result);
  assert.equal(committed.previewFormat, "webp");
  assert.equal(selectedResultOutputs(result, committed.selectedOutputKeys)[0].variant.format, "webp");

  const secondOutput = { ...result.results[0], width: 1200, height: 800, variants: result.results[0].variants.map(variant => ({ ...variant })) };
  secondOutput.variants[0].blob = new Blob([new Uint8Array(60)]);
  secondOutput.variants[1].blob = new Blob([new Uint8Array(70)]);
  result.results.push(secondOutput);
  assert.equal(selectedResultOutputs(result, context.defaultOutputSelectionForTarget(result, 1200))[0].variant.format, "avif");
  assert.equal(selectedResultOutputs(result, context.defaultOutputSelectionForTarget(result, 600))[0].variant.format, "webp");

  result.results[0].variants[0].blob = new Blob([new Uint8Array(120)]);
  result.results[0].variants[1].blob = new Blob([new Uint8Array(170)]);
  assert.equal(selectedResultOutputs(result, context.defaultOutputSelectionForTarget(result, 600))[0].variant.format, "avif");
  assert.equal(selectedResultOutputs(result, context.defaultOutputSelectionForTarget(result, 1200))[0].variant.format, "avif");

  for (const onlyFormat of ["avif", "webp"]) {
    const only = { ...resultFixture(), results: [{ ...resultFixture().results[0], variants: [resultFixture().results[0].variants.find(v => v.format === onlyFormat)] }] };
    assert.equal(selectedResultOutputs(only, context.defaultOutputSelectionForResult(only))[0].variant.format, onlyFormat);
  }
  const pngOnly = { ...resultFixture(), results: [{ ...resultFixture().results[0], variants: [resultFixture().results[0].variants.find(v => v.format === "png")] }] };
  assert.equal(selectedResultOutputs(pngOnly, context.defaultOutputSelectionForResult(pngOnly))[0].variant.format, "png",
    "a sole available variant remains selected when AVIF and WebP are absent");

  const tie = resultFixture();
  tie.results[0].variants[0].blob = new Blob([new Uint8Array(12)]);
  tie.results[0].variants[1].blob = new Blob([new Uint8Array(12)]);
  assert.equal(context.smallestAvailableVariant(tie).format, tie.results[0].variants[0].format,
    "equal sizes retain the existing variants order and select one format");
  assert.equal(context.defaultOutputSelectionForResult({ ...tie, results: [] }).length, 0);
  const expectedFormats = ["webp", "avif", "webp"];
  const perPhotoSizes = [[180, 140], [120, 150], [200, 170]];
  for (let index = 0; index < perPhotoSizes.length; index += 1) {
    const photoResult = resultFixture();
    photoResult.results[0].variants[0].blob = new Blob([new Uint8Array(perPhotoSizes[index][0])]);
    photoResult.results[0].variants[1].blob = new Blob([new Uint8Array(perPhotoSizes[index][1])]);
    const photo = context.commitResult({ id: `photo-${index}`, selectedOutputKeys: [] }, photoResult);
    assert.equal(selectedResultOutputs(photo.result, photo.selectedOutputKeys)[0].variant.format, expectedFormats[index]);
  }
});

test("batch download selection uses each ready photo's selected variants in stable item and variant order", () => {
  const context = productionFunctions(["buildBatchDownloadSet", "setReadyPhotoSelection"], { outputSelectionKey });
  const first = resultFixture();
  const second = resultFixture();
  first.results[0].variants = first.results[0].variants.slice(0, 2);
  second.results[0].variants = second.results[0].variants.slice(0, 2);
  const items = [
    { id: "photo-1", result: first, selectedOutputKeys: [outputSelectionKey(600, 360, first.results[0].variants[0])] },
    { id: "photo-2", result: second, selectedOutputKeys: [outputSelectionKey(600, 360, second.results[0].variants[1])] },
    { id: "photo-pending", result: null, selectedOutputKeys: [] },
  ];
  let selected = context.setReadyPhotoSelection(new Set(), ["photo-1", "photo-2"], true);
  assert.deepEqual(context.buildBatchDownloadSet(items, selected).map(({ item, variant }) => `${item.id}:${variant.format}`), [
    "photo-1:avif", "photo-2:webp",
  ]);
  selected = context.setReadyPhotoSelection(selected, ["photo-1", "photo-2"], false);
  assert.deepEqual(Array.from(selected), []);
  selected = context.setReadyPhotoSelection(new Set(["photo-1"]), ["photo-1", "photo-2"], true);
  assert.deepEqual(Array.from(selected), ["photo-1", "photo-2"]);
  assert.deepEqual(context.buildBatchDownloadSet(items, new Set(["photo-pending"])), []);
  assert.deepEqual(context.buildBatchDownloadSet([{ ...items[0], selectedOutputKeys: [] }], new Set(["photo-1"])), []);
  assert.match(componentSource, /selectedBatchItemIds/);
  assert.match(componentSource, /batchSelectAllRef\.current\.indeterminate = batchMasterIndeterminate/);
  assert.match(componentSource, /checked=\{selectedBatchItemIds\.has\(item\.id\)\}/);
  assert.doesNotMatch(componentSource.slice(componentSource.indexOf("function switchBatchItem"), componentSource.indexOf("function applyCropRatioToAll")), /setSelectedBatchItemIds/);
  assert.match(componentSource, /next\.delete\(itemId\)/);
  assert.match(componentSource, /disabled=\{!batchDownloadOutputs\.length \|\| downloadingFiles\}/);
  assert.match(componentSource, /СКАЧАТЬ \$\{batchDownloadOutputs\.length\} ФАЙЛОВ/);
  assert.doesNotMatch(componentSource, /confirm\(|window\.confirm|batch-download-confirmation/);
});

test("batch readiness rejects missing and stale transparent-PNG committed results", () => {
  const context = productionFunctions(["isDownloadableBatchItem"], {
    cropsEqual: (left, right) => JSON.stringify(left) === JSON.stringify(right),
    cropAvailableWidth: () => 500,
    pendingProfile: () => ({ id: "custom", widths: [350] }),
    transparentPngTargetProfile: profile => profile,
    preparedPngKey: (crop, profile) => `${crop.positionX}:${profile.widths.join(",")}`,
    isCurrentOptimizedPng: (mode, result, committedKey, currentKey) =>
      mode === "transparent-png" && result?.mode === "transparent-png" && committedKey === currentKey,
  });
  const current = {
    id: "png", mode: "transparent-png", draftCrop: { positionX: 50 }, appliedCrop: { positionX: 50 }, cropEditing: false,
    result: { mode: "transparent-png", results: [{ variants: [{ blob: new Blob(["png"]) }] }] }, optimizedPngTargetKey: "50:350",
  };
  assert.equal(context.isDownloadableBatchItem(current, 500), true);
  assert.equal(context.isDownloadableBatchItem({ ...current, result: null }, 500), false);
  assert.equal(context.isDownloadableBatchItem({ ...current, optimizedPngTargetKey: "old-target" }, 500), false);
  assert.equal(context.isDownloadableBatchItem({ ...current, draftCrop: { positionX: 60 }, cropEditing: true }, 500), false);
});

test("descending live size order retains crop math and filters unavailable widths", () => {
  const crop = calculateCropRect(2000, 1500, { aspectRatio: 3 / 2, positionX: 50, positionY: 50 });
  const profile = IMAGE_PROFILES.find((item) => item.id === "1280-1440");
  assert.deepEqual(buildTargetWidths(crop.width, profile).map((width) => calculateOutputDimensions(crop, width)),
    [{ width: 1440, height: 960 }, { width: 1280, height: 853 }]);
  assert.deepEqual(buildTargetWidths(1400, profile), [1280]);
});

test("Photo selection hides presets whose primary width exceeds crop, while PNG keeps partial preset targets", () => {
  const context = productionFunctions(["availableSelectionProfiles", "resolveSelectionProfileId"], { getAvailableImageProfiles });
  const photo941 = context.availableSelectionProfiles("photo", 941);
  assert.equal(photo941.some(profile => profile.id === "768-1024"), false);
  assert.equal(context.resolveSelectionProfileId("768-1024", "photo", photo941), "custom");
  assert.ok(photo941.some(profile => profile.id === "480-640"));
  const validPreset = photo941.find(profile => profile.id === "480-640");
  assert.deepEqual(buildTargetWidths(941, validPreset), [640, 480]);

  const png900 = context.availableSelectionProfiles("transparent-png", 900);
  assert.ok(png900.some(profile => profile.id === "768-1024"));
  assert.deepEqual(buildTargetWidths(900, png900.find(profile => profile.id === "768-1024")), [768]);
});

test("shared crop limit and size cards follow the queue minimum, with exact standalone 480", () => {
  const context = productionFunctions(["currentCropLimit", "availableSelectionProfiles", "pendingProfile"], {
    calculateCropRect, buildTargetWidths, createCustomProfile,
  });
  const make = (width) => ({
    sourceInfo: { width, height: 1000 },
    draftCrop: { aspectRatio: null, positionX: 50, positionY: 50 },
    appliedCrop: { aspectRatio: null, positionX: 50, positionY: 50 },
  });
  const queue = [make(1254), make(941), make(640)];
  for (const [activeId, activeWidth] of [["one", 1254], ["two", 941], ["three", 640]]) {
    assert.equal(context.currentCropLimit(queue.map((item, index) => ({ ...item, id: ["one", "two", "three"][index] })), activeId, activeWidth), 640);
  }
  assert.equal(context.currentCropLimit([make(1254)], "one", 1254), 1254, "one image uses its own crop width");
  assert.equal(context.currentCropLimit(queue.slice(0, 2).map((item, index) => ({ ...item, id: ["one", "two"][index] })), "one", 1254),
    941, "removing the smallest queue item raises the shared limit");
  const croppedQueue = [make(1254), make(941), make(590)].map((item, index) => ({ ...item, id: ["one", "two", "three"][index] }));
  assert.equal(context.currentCropLimit(croppedQueue, "one", 1254), 590, "crop changes immediately lower the shared limit");

  const at640 = context.availableSelectionProfiles("photo", 640);
  assert.deepEqual(at640.find(profile => profile.id === "480-640").widths, [640, 480]);
  assert.equal(at640.find(profile => profile.id === "480-640").title, "640 · 480 px");
  assert.equal(at640.some(profile => profile.title === "480 px"), false);
  assert.ok(at640.some(profile => profile.id === "custom"));

  for (const mode of ["photo", "screenshot", "transparent-png"]) {
    for (const limit of [639, 590, 480]) {
      const profiles = context.availableSelectionProfiles(mode, limit);
      const standalone = profiles.find(profile => profile.title === "480 px");
      assert.deepEqual(standalone ? Array.from(standalone.widths) : undefined, [480], `${mode} at ${limit}px has an exact 480 target`);
      assert.equal(profiles.some(profile => profile.title === "640 · 480 px"), false);
      assert.ok(profiles.some(profile => profile.id === "custom"), "custom remains visible");
    }
    const below480 = context.availableSelectionProfiles(mode, 430);
    assert.deepEqual(Array.from(below480, profile => profile.id), ["custom"]);
  }
  assert.deepEqual(buildTargetWidths(590, context.availableSelectionProfiles("photo", 590)[0]), [480]);
  assert.deepEqual(buildTargetWidths(430, createCustomProfile(430, 430)), [430], "430px custom target never upscales");

  const cropped = queue[0];
  const settings = {
    ...cropped, mode: "photo", profileId: "custom", customWidth: "941", customWidthAuto: false,
    customWidthMax: 1254,
  };
  const standaloneTarget = context.pendingProfile({ ...settings, profileId: "480-640" }, 590);
  assert.deepEqual(standaloneTarget.widths, [480], "standalone card resolves to only the 480 target");
  const reconcile = productionFunctions(["reconcileSizeSettings"], { calculateCropRect });
  const clampedManual = reconcile.reconcileSizeSettings(settings, 640);
  assert.equal(clampedManual.customWidth, "640", "width above common limit clamps down");
  assert.equal(clampedManual.customWidthAuto, false, "clamping does not turn a manual width into an auto-follow value");
  assert.equal(reconcile.reconcileSizeSettings(clampedManual, 941).customWidth, "640",
    "raising the limit later does not restore or increase a clamped manual width");
  assert.equal(reconcile.reconcileSizeSettings({ ...settings, customWidth: "500" }, 640).customWidth, "500",
    "manual width below common limit is preserved");
  assert.equal(reconcile.reconcileSizeSettings({ ...settings, customWidth: "500" }, 941).customWidth, "500",
    "raising the limit does not raise a manual width");
  assert.equal(reconcile.reconcileSizeSettings({ ...settings, customWidth: "941" }, 590).customWidth, "590");

  const errorContext = productionFunctions(["batchItemError"], { calculateCropRect, cropsEqual: () => true });
  const item = { ...settings, draftCrop: settings.appliedCrop, customWidth: "941" };
  assert.ok(errorContext.batchItemError(item, 640), "validation rejects custom width over queue limit");
  assert.equal(errorContext.batchItemError({ ...item, customWidth: "500" }, 640), null);
  assert.match(componentSource, /const currentLimit = currentCropLimit\(batchItems, activeItemId, appliedCropWidth, sizeScope\)/);
  assert.match(componentSource, /max=\{effectiveMaxWidth\}/);
});

test("invalidated Photo preset falls back to custom, preserving a valid width or using the new maximum", () => {
  const context = productionFunctions(["reconcileSizeSettings"], {
    getAvailableImageProfiles, calculateCropRect,
  });
  const draftCrop = cropSettingsFromRect({ x: 0, y: 0, width: 941, height: 941 }, 2000, 1500, 1);
  const item = {
    mode: "photo", profileId: "768-1024", customWidthAuto: false,
    sourceInfo: { width: 2000, height: 1500 }, draftCrop, appliedCrop: draftCrop,
  };
  const preserved = context.reconcileSizeSettings({ ...item, customWidth: "900" }, 941, true);
  assert.equal(preserved.profileId, "custom");
  assert.equal(preserved.customWidth, "900");
  const corrected = context.reconcileSizeSettings({ ...item, customWidth: "1024" }, 941, true);
  assert.equal(corrected.profileId, "custom");
  assert.equal(corrected.customWidth, "941");
});

test("direct RGBA PNG and actual OxiPNG preserve every byte, including hidden RGB and five alpha levels", async () => {
  const oxipng = await import("@jsquash/oxipng/optimise.js");
  await oxipng.init(await readFile(new URL("../node_modules/@jsquash/oxipng/codec/pkg/squoosh_oxipng_bg.wasm", import.meta.url)));
  const bytes = Uint8ClampedArray.from([21, 73, 199, 0, 123, 45, 67, 1, 91, 182, 33, 127, 44, 55, 66, 254, 77, 88, 99, 255]);
  const raw = await encodeRgbaPng({ width: 5, height: 1, data: bytes });
  const optimized = await oxipng.default(await raw.arrayBuffer(), { level: 2, optimiseAlpha: false, interlace: false });
  for (const buffer of [Buffer.from(await raw.arrayBuffer()), Buffer.from(optimized)]) {
    const decoded = await sharp(buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    assert.deepEqual([decoded.info.width, decoded.info.height], [5, 1]);
    assert.deepEqual(decoded.data, Buffer.from(bytes));
    assert.deepEqual(Array.from(decoded.data.filter((_, i) => i % 4 === 3)), [0, 1, 127, 254, 255]);
  }
});

test("prepared PNG cache belongs to file/crop/width and contains no ImageData", async () => {
  const file = new File(["png"], "source.png");
  const crop = { aspectRatio: null, positionX: 50, positionY: 50 };
  const profile = createCustomProfile(64, 128);
  const prepared = { file, key: preparedPngKey(crop, profile), originalWidth: 128, originalHeight: 64,
    outputs: [{ width: 64, height: 32, blob: new Blob(["raw PNG"]), fileName: "img-64x32.png" }] };
  assert.equal(await prepareTransparentPng({ file, crop, profile, prepared }), prepared);
  const source = await readFile(optimizerUrl, "utf8");
  const ast = ts.createSourceFile("image-optimizer.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let decodes = 0;
  const context = productionFunctions(["prepareTransparentPng"], {
    preparedPngKey,
    createSourceBitmap: async () => { decodes++; throw new Error("new raster required"); },
  }, ast);
  for (const options of [
    { file: new File(["png"], "other.png"), crop, profile, prepared },
    { file, crop: { ...crop, positionX: 51 }, profile, prepared },
    { file, crop, profile: createCustomProfile(32, 128), prepared },
  ]) await assert.rejects(context.prepareTransparentPng(options), /new raster required/);
  assert.equal(decodes, 3);
  assert.deepEqual(Object.keys(prepared.outputs[0]), ["width", "height", "blob", "fileName"]);
});

test("OxiPNG failure preserves prepared PNG and never starts quality or other encoders", async () => {
  const source = await readFile(optimizerUrl, "utf8");
  const ast = ts.createSourceFile("image-optimizer.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const prepared = { outputs: [{ width: 32, height: 16, blob: new Blob(["PNG"]) }] };
  let retained;
  const context = productionFunctions(["optimizeImage"], {
    DEFAULT_ENCODER_QUALITY, prepareTransparentPng: async () => prepared,
    encodePng: async () => { throw new Error("WASM failed"); },
    createSourceBitmap: () => assert.fail("PNG optimize must not decode again"),
    encodeVariant: () => assert.fail("AVIF/WebP must not run"),
  }, ast);
  await assert.rejects(context.optimizeImage({ file: new File(["x"], "x.png"), profile: {}, crop: {},
    mode: "transparent-png", quality: NaN, onPrepared: value => { retained = value; } }), /Уменьшенный PNG остаётся доступным/);
  assert.equal(retained, prepared);
  assert.equal(retained.outputs[0].blob.size, 3);
});

test("PNG mode is guarded by actual PNG and alpha, including restored stale items", () => {
  const context = productionFunctions(["createBatchItem"], {
    crypto, getAvailableImageProfiles, DEFAULT_ENCODER_QUALITY,
    DEFAULT_CROP: { aspectRatio: null, positionX: 50, positionY: 50 },
  });
  for (const [isPng, hasTransparency, expected] of [[true, true, "transparent-png"], [true, false, "photo"], [false, true, "photo"], [false, false, "photo"]]) {
    const item = context.createBatchItem(new File(["x"], "x.png"),
      { width: 128, height: 64, isPng, hasTransparency, previewUrl: "blob:x" }, "transparent-png");
    assert.equal(item.mode, expected);
  }
  const photoItems = [0, 1, 2].map(index => context.createBatchItem(new File([String(index)], `photo-${index}.jpg`),
    { width: 1280, height: 853, previewUrl: `blob:${index}` }));
  const screenshot = context.createBatchItem(new File(["screen"], "screen.png"),
    { width: 128, height: 64, previewUrl: "blob:screen" }, "screenshot");
  assert.deepEqual(photoItems.map(item => item.qualityTier), ["q85", "q85", "q85"]);
  assert.equal(screenshot.qualityTier, "q85");
  assert.match(componentSource, /disabled=\{!\(sourceInfo\?\.isPng && sourceInfo\.hasTransparency\)\}/);
  assert.match(componentSource, /setOptimizationMode\(item\.mode === "transparent-png" && !\(item\.sourceInfo\.isPng && item\.sourceInfo\.hasTransparency\)/);
  assert.match(componentSource, /optimizationMode !== "transparent-png" \? qualitySelector : null/);
});

test("PNG single handler skips invalid custom quality and retains raw and committed Blobs on Oxi failure", async () => {
  const old = resultFixture();
  const file = new File(["png"], "x.png");
  const prepared = { outputs: [{ blob: new Blob(["raw"]), fileName: "img-64x32.png" }] };
  let issue;
  let preparedPassed;
  const snapshot = { id: "png-item", file, mode: "transparent-png", result: old, sourceInfo: { width: 64, height: 32 },
    appliedCrop: { aspectRatio: null, positionX: 50, positionY: 50 } };
  const context = productionFunctions(["runOptimization"], {
    file, working: false, currentBatchSnapshot: () => snapshot,
    batchItemError: () => null, profile: { id: "custom", widths: [64] }, currentLimit: 64, appliedCrop: {}, activeItemId: snapshot.id,
    qualityTier: "custom", customQuality: "invalid",
    resolveEncoderQuality: () => assert.fail("PNG must not validate quality"),
    setWorking() {}, setProcessingItemId() {}, setProgress() {}, setProgressText() {},
    setError: value => { issue = value; },
    createCustomProfile,
    buildTargetWidths,
    ensurePreparedPng: async () => prepared,
    optimizeImage: async options => {
      assert.equal(options.quality, undefined);
      preparedPassed = options.prepared;
      throw new Error("Oxi failed");
    },
    commitResult: () => assert.fail("failed optimization cannot commit"),
  });
  await context.runOptimization();
  assert.equal(preparedPassed, prepared);
  assert.equal(snapshot.result, old);
  assert.equal(issue, "Oxi failed");
});

test("Optimize CTAs use missing/stale results independently of mode and download selection", () => {
  const lifecycle = productionFunctions(["isOptimizationCurrent", "optimizationSettingsKey", "commitResult", "pendingProfile"], { outputSelectionKey });
  let batchButton;
  function visit(node) {
    if (ts.isJsxElement(node) && node.openingElement.attributes.properties.some(property =>
      ts.isJsxAttribute(property) && property.name.getText(componentAst) === "className" &&
      property.initializer?.getText(componentAst) === '"batch-optimize-all"')) batchButton = node;
    ts.forEachChild(node, visit);
  }
  visit(componentAst);
  assert.ok(batchButton);
  let actions;
  for (let parent = batchButton.parent; parent; parent = parent.parent) {
    if (ts.isConditionalExpression(parent) && parent.condition.getText(componentAst) === "working") {
      actions = parent;
      break;
    }
  }
  assert.ok(actions, "working must continue replacing the action block with progress");
  const code = ts.transpileModule(`globalThis.rendered = (${actions.getText(componentAst)});`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React },
  }).outputText;
  const batchHandler = () => assert.fail("rendering must not start optimization");
  function render(batchItems, optimizationMode, overrides = {}) {
    const active = batchItems.find(item => item.id === overrides.activeItemId) ?? batchItems[0];
    const context = vm.createContext({
      React: { createElement: (tag, props, ...children) => ({ tag, props: props ?? {}, children }) },
      working: false, batchItems, optimizationMode, activeOptimizedTargetCurrent: false,
      activePreparedReady: false, activePreparedOutputs: [], activeItemNumber: 1,
      runOptimization() {}, runBatchOptimization: batchHandler, progress: 0, progressText: "",
      readyBatchItems: [], selectedBatchItemIds: new Set(), selectedOutputKeys: [], batchDownloadOutputs: [],
      selectedReadyCount: 0, batchMasterChecked: false, batchMasterIndeterminate: false,
      activeOptimizationCurrent: lifecycle.isOptimizationCurrent(active, 306),
      batchNeedsOptimization: batchItems.some(item => !lifecycle.isOptimizationCurrent(item, 306)),
      ...overrides,
    });
    vm.runInContext(code, context);
    return context.rendered;
  }
  function find(tree, className) {
    if (!tree || typeof tree !== "object") return undefined;
    if (tree.props?.className?.split(" ").includes(className)) return tree;
    return tree.children?.map(child => find(child, className)).find(Boolean);
  }
  let nextItemId = 0;
  const item = (mode) => ({ id: String(++nextItemId), mode, result: null, file: new File([mode], `${mode}.png`),
    sourceInfo: { width: 306, height: 200 }, profileId: "custom", customWidth: "250", qualityTier: "q80", customQuality: "80",
    appliedCrop: { aspectRatio: null, positionX: 50, positionY: 50 }, selectedOutputKeys: [], optimizedPngDownloadKeys: [] });
  const current = item => lifecycle.commitResult(item, { ...resultFixture(), mode: item.mode }, null,
    lifecycle.optimizationSettingsKey(item, lifecycle.pendingProfile(item, 306), item.mode === "transparent-png" ? undefined : 80));
  for (const mode of ["photo", "screenshot", "transparent-png"]) {
    const single = render([item(mode)], mode);
    assert.equal(find(single, "batch-optimize-all"), undefined, `${mode}: one loaded item`);
    assert.ok(find(single, "primary-button"), `${mode}: individual CTA remains`);
    for (const count of [2, 3]) {
      const queue = Array.from({ length: count }, () => item(mode));
      const button = find(render(queue, mode), "batch-optimize-all");
      assert.ok(button, `${mode}: ${count} items, no ready results or download selection`);
      assert.equal(button.props.onClick, batchHandler);
      assert.equal(button.props.disabled, undefined, "validation remains in the handler");
    }
  }
  const mixed = [item("photo"), item("transparent-png"), item("photo")];
  for (const active of mixed) assert.ok(find(render(mixed, active.mode), "batch-optimize-all"), "active item switching in a mixed queue");
  const partial = [current(item("transparent-png")), current(item("photo")), item("screenshot")];
  for (const [checked, indeterminate, selectedCount] of [[false, false, 0], [false, true, 1], [true, false, 2]]) {
    assert.ok(find(render(partial, "transparent-png", {
      readyBatchItems: partial.slice(0, 2), selectedBatchItemIds: new Set(partial.slice(0, selectedCount).map(item => item.id)),
      selectedReadyCount: selectedCount, batchMasterChecked: checked, batchMasterIndeterminate: indeterminate,
      batchDownloadOutputs: selectedCount ? [{ blob: new Blob(["ready"]) }] : [],
      activeOptimizedTargetCurrent: true,
    }), "batch-optimize-all"), "partial results and master checkbox state cannot hide the batch CTA");
  }
  const completedActive = render(partial, "transparent-png", { activeOptimizedTargetCurrent: true });
  assert.equal(find(completedActive, "primary-button"), undefined, "existing individual PNG lifecycle remains");
  assert.ok(find(completedActive, "batch-optimize-all"));
  const complete = partial.map(current);
  const allCurrent = render(complete, "transparent-png");
  assert.equal(find(allCurrent, "primary-button"), undefined);
  assert.equal(find(allCurrent, "batch-optimize-all"), undefined, "all current hides batch CTA");
  const edited = complete.map((item, index) => index ? item : { ...item, appliedCrop: { ...item.appliedCrop, positionX: 20, size: { width: .9, height: 1 } } });
  assert.ok(find(render(edited, "transparent-png"), "primary-button"));
  assert.ok(find(render(edited, "transparent-png"), "batch-optimize-all"));
  assert.equal(find(render(edited, "photo", { activeItemId: edited[1].id }), "primary-button"), undefined);
  assert.ok(find(render(edited, "photo", { activeItemId: edited[1].id }), "batch-optimize-all"));
  assert.equal(find(render(edited.map((item, index) => index ? item : current(item)), "transparent-png"), "batch-optimize-all"), undefined);
  const processing = render(mixed, "transparent-png", { working: true, progress: 42, progressText: "Processing" });
  assert.ok(find(processing, "progress-panel"));
  assert.equal(find(processing, "batch-action-grid"), undefined);
  assert.equal(find(processing, "batch-optimize-all"), undefined);
});

test("optimization currentness uses applied geometry, effective targets, mode, quality and exact source", () => {
  const context = productionFunctions(["createBatchItem", "optimizationSettingsKey", "isOptimizationCurrent", "pendingProfile", "commitResult", "pendingTargetDimensions"], {
    crypto, DEFAULT_CROP: { aspectRatio: null, positionX: 50, positionY: 50 }, DEFAULT_ENCODER_QUALITY, outputSelectionKey,
  });
  for (const mode of ["photo", "screenshot", "transparent-png"]) {
    const file = new File([mode], `${mode}.png`);
    const base = { ...context.createBatchItem(file, { width: 600, height: 400, isPng: true, hasTransparency: true }, mode),
      profileId: "custom", customWidth: "250", lastValidCustomWidth: "250", customWidthAuto: false };
    const profile = context.pendingProfile(base, 600);
    const key = context.optimizationSettingsKey(base, profile, mode === "transparent-png" ? undefined : 85);
    const committed = context.commitResult(base, { ...resultFixture(), mode }, preparedPngKey(base.appliedCrop, profile), key);
    assert.equal(context.isOptimizationCurrent(committed, 600), true, mode);
    assert.equal(context.isOptimizationCurrent({ ...committed, draftCrop: { ...base.draftCrop, size: { width: .8, height: 1 } }, cropEditing: true }, 600), true, "draft alone is not saved geometry");
    assert.deepEqual(Array.from(context.pendingTargetDimensions(base.sourceInfo,
      { ...base.draftCrop, size: { width: .2, height: 1 } }, profile)), [], "small unsaved crop cannot throw from dimension labels");
    const changed = { ...committed, appliedCrop: { ...base.appliedCrop, size: { width: .8, height: 1 } } };
    assert.equal(context.isOptimizationCurrent(changed, 600), false);
    assert.equal(changed.result, committed.result);
    assert.equal(context.isOptimizationCurrent({ ...committed, appliedCrop: { ...base.appliedCrop } }, 600), true, "identical Save remains current");
    assert.equal(context.isOptimizationCurrent({ ...committed, customWidth: "200" }, 600), false);
    assert.equal(context.isOptimizationCurrent({ ...committed, qualityTier: "q80" }, 600), mode === "transparent-png");
    assert.equal(context.isOptimizationCurrent({ ...committed, mode: mode === "photo" ? "screenshot" : "photo" }, 600), false);
    assert.equal(context.isOptimizationCurrent({ ...committed, file: new File([mode], file.name) }, 600), false, "same metadata does not replace File identity");
    assert.equal(context.isOptimizationCurrent({ ...committed, id: "another-source" }, 600), false);
    assert.equal(context.isOptimizationCurrent({ ...committed, selectedOutputKeys: [], optimizedPngDownloadKeys: ["downloaded"], preparedPngDownloadKey: "downloaded" }, 600), true);
    assert.equal(context.optimizationSettingsKey(base, { ...profile, id: "480-640" }, mode === "transparent-png" ? undefined : 85), key, "UI profile labels do not affect identical output targets");
    assert.equal(context.optimizationSettingsKey({ ...base, appliedCrop: { ...base.appliedCrop, aspectRatio: 1.5 } }, profile,
      mode === "transparent-png" ? undefined : 85), key, "equivalent effective crop has the same identity");
  }
});

test("transient custom width is safe in render predicates, restores last valid and persists by item", async () => {
  let builderCalls = 0;
  const context = productionFunctions(["createBatchItem", "chooseCustomWidth", "finishCustomWidthInput", "handleCustomWidthKeyDown",
    "pendingProfile", "isOptimizationCurrent", "isDownloadableBatchItem", "currentBatchSnapshot", "hydrateBatchItem", "switchBatchItem",
    "batchItemError", "runOptimization", "runBatchOptimization"], {
    crypto, DEFAULT_CROP: { aspectRatio: null, positionX: 50, positionY: 50 }, DEFAULT_ENCODER_QUALITY,
    working: false, cropsEqual: (a, b) => JSON.stringify(a) === JSON.stringify(b),
    createCustomProfile: (...args) => { builderCalls++; return createCustomProfile(...args); },
    isCurrentOptimizedPng: () => true, transparentPngTargetProfile: profile => profile,
    currentLimit: 306, openCropForSizeChange() {}, setError() {},
    optimizeImage: () => assert.fail("invalid draft cannot reach an encoder"),
  });
  for (const name of ["activeItemId", "file", "sourceInfo", "profileId", "customWidth", "lastValidCustomWidth", "customWidthAuto",
    "customWidthMax", "draftCrop", "appliedCrop", "cropEditing", "result", "previewFormat", "previewWidth", "qualityTier", "customQuality", "selectedOutputKeys"]) {
    context[`set${name[0].toUpperCase()}${name.slice(1)}`] = value => { context[name] = value; };
  }
  Object.defineProperty(context, "activeProfileId", { get: () => context.profileId });
  context.setOptimizationMode = mode => { context.optimizationMode = mode; };
  context.setBatchItems = update => { context.batchItems = typeof update === "function" ? update(context.batchItems) : update; };
  const make = name => ({ ...context.createBatchItem(new File([name], name), { width: 306, height: 200, isPng: true, hasTransparency: true }, "transparent-png"),
    profileId: "custom", result: { ...resultFixture(), mode: "transparent-png" }, resultSourceFile: null, resultSettingsKey: "old" });
  const first = make("one.png"), second = { ...make("two.png"), customWidth: "200", lastValidCustomWidth: "200" };
  context.batchItems = [first, second];
  context.hydrateBatchItem(first);
  for (const value of ["", "2", "25", "307", "250.5"]) {
    context.chooseCustomWidth(value);
    const snapshot = context.currentBatchSnapshot();
    assert.equal(snapshot.customWidth, value);
    assert.equal(snapshot.lastValidCustomWidth, "306");
    assert.deepEqual(Array.from(context.pendingProfile(snapshot, 306).widths), []);
    assert.equal(context.isDownloadableBatchItem(snapshot, 306), false);
    assert.equal(context.isOptimizationCurrent(snapshot, 306), false);
    assert.equal(snapshot.result, first.result);
    await context.runOptimization();
    await context.runBatchOptimization();
  }
  assert.equal(builderCalls, 0, "invalid drafts never reach the strict builder in render selectors");
  context.finishCustomWidthInput();
  assert.equal(context.customWidth, "306");
  context.chooseCustomWidth("250");
  assert.equal(context.lastValidCustomWidth, "250");
  assert.deepEqual(Array.from(context.pendingProfile(context.currentBatchSnapshot(), 306).widths), [250]);
  context.chooseCustomWidth("2");
  let prevented = 0, blurred = 0;
  context.handleCustomWidthKeyDown({ key: "Enter", preventDefault() { prevented++; }, currentTarget: { blur() { blurred++; } } });
  assert.equal(context.customWidth, "250");
  assert.equal(prevented, 1); assert.equal(blurred, 1);
  context.switchBatchItem(second.id);
  assert.equal(context.lastValidCustomWidth, "200");
  context.chooseCustomWidth(""); context.finishCustomWidthInput();
  assert.equal(context.customWidth, "200");
  context.switchBatchItem(first.id);
  assert.equal(context.customWidth, "250");
  assert.equal(context.lastValidCustomWidth, "250");
});

test("async individual and batch commits keep keys from encoder snapshots and failures preserve committed keys", async () => {
  const context = productionFunctions(["createBatchItem", "optimizationSettingsKey", "pendingProfile", "commitResult", "isOptimizationCurrent",
    "runOptimization", "runBatchOptimization"], {
    crypto, DEFAULT_CROP: { aspectRatio: null, positionX: 50, positionY: 50 }, DEFAULT_ENCODER_QUALITY, outputSelectionKey,
    working: false, sizeScope: "individual", currentLimit: 941,
    batchItemError: () => null, setWorking() {}, setProcessingItemId() {}, setProgress() {}, setProgressText() {},
    setError() {}, hydrateBatchItem() {}, window: { setTimeout() {} },
  });
  const make = (name, sourceWidth, width) => ({
    ...context.createBatchItem(new File([name], name), { width: sourceWidth, height: 1000 }),
    profileId: "custom", customWidth: String(width), lastValidCustomWidth: String(width), customWidthAuto: false,
  });
  const initial = make("one.jpg", 941, 800);
  let stored = context.commitResult(initial, resultFixture(), null,
    context.optimizationSettingsKey(initial, createCustomProfile(800, 941), 80));
  let pending = { ...stored, qualityTier: "q85" };
  context.file = initial.file;
  context.activeItemId = initial.id;
  context.currentBatchSnapshot = () => pending;
  context.profile = createCustomProfile(800, 941);
  const runKey = context.optimizationSettingsKey(pending, context.profile, 85);
  context.setBatchItems = update => { [stored] = typeof update === "function" ? update([stored]) : update; };
  context.optimizeImage = async options => {
    assert.equal(options.quality, 85);
    assert.deepEqual(Array.from(options.profile.widths), [800]);
    pending = { ...pending, customWidth: "250", qualityTier: "q65" };
    context.profile = createCustomProfile(250, 941);
    return resultFixture();
  };
  await context.runOptimization();
  assert.equal(stored.resultSettingsKey, runKey, "key was captured before await, not from later UI settings");
  assert.equal(stored.resultSourceFile, initial.file);
  const committedResult = stored.result;
  context.optimizeImage = async () => { throw new Error("encoder failed"); };
  await context.runOptimization();
  assert.equal(stored.result, committedResult);
  assert.equal(stored.resultSettingsKey, runKey);
  assert.equal(context.isOptimizationCurrent({ ...pending, result: stored.result, resultSettingsKey: stored.resultSettingsKey,
    resultSourceFile: stored.resultSourceFile }, 941), false, "failure leaves the pending target stale for retry");

  const second = make("two.jpg", 306, 250);
  initial.qualityTier = "q80";
  second.qualityTier = "q80";
  let items = [initial, second];
  const expectedKeys = items.map(item => context.optimizationSettingsKey(item,
    context.pendingProfile(item, item.sourceInfo.width), 80));
  context.batchItems = items;
  context.currentBatchSnapshot = () => null;
  context.currentLimit = 941;
  context.setBatchItems = value => { items = value; };
  let calls = 0;
  context.optimizeImage = async options => {
    assert.deepEqual(Array.from(options.profile.widths), [calls ? 250 : 800], "INDIVIDUAL batch uses each item's own limit");
    calls++;
    context.currentLimit = 32;
    context.sizeScope = "all";
    return resultFixture();
  };
  await context.runBatchOptimization();
  assert.equal(calls, 2);
  assert.deepEqual(Array.from(items, item => item.resultSettingsKey), expectedKeys);
  for (const item of items) assert.equal(context.isOptimizationCurrent(item, item.sourceInfo.width), true);
});

test("explicit size scope uses applied limits and restores individual values after temporary ALL clamping", () => {
  const context = productionFunctions(["createBatchItem", "currentCropLimit", "sizeSettingsForScope", "optimizationSettingsKey", "pendingProfile"], {
    crypto, DEFAULT_CROP: { aspectRatio: null, positionX: 50, positionY: 50 }, DEFAULT_ENCODER_QUALITY,
  });
  const items = [1254, 941, 306].map((width, index) => ({
    ...context.createBatchItem(new File([String(index)], `${index}.png`), { width, height: 1000 }),
    profileId: "custom", customWidth: index === 1 ? "800" : "200", lastValidCustomWidth: index === 1 ? "800" : "200", customWidthAuto: false,
  }));
  const draftOnly = items.map(item => ({ ...item, draftCrop: { ...item.draftCrop, size: { width: .5, height: .5 } } }));
  assert.equal(context.currentCropLimit(draftOnly, items[1].id, undefined, "all"), 306);
  for (const [index, width] of [[0, 1254], [1, 941], [2, 306]]) assert.equal(context.currentCropLimit(draftOnly, items[index].id, undefined, "individual"), width);
  const all = context.sizeSettingsForScope(items, "all");
  assert.equal(all[1].customWidth, "306");
  assert.equal(all[1].individualSizeSettings.customWidth, "800");
  assert.deepEqual(Array.from(context.pendingProfile(all[1], 306).widths), [306]);
  const individual = context.sizeSettingsForScope(all, "individual");
  assert.equal(individual[1].customWidth, "800");
  assert.equal(individual[1].lastValidCustomWidth, "800");
  assert.deepEqual(Array.from(context.pendingProfile(individual[1], 941).widths), [800]);
  assert.equal(context.currentCropLimit(context.sizeSettingsForScope(individual, "all"), items[1].id, undefined, "all"), 306);
  const same = context.sizeSettingsForScope([items[0], items[2]], "all")[0];
  assert.equal(context.optimizationSettingsKey(same, context.pendingProfile(same, 306), 80),
    context.optimizationSettingsKey(items[0], context.pendingProfile(items[0], 1254), 80), "scope itself is absent from the optimization identity");
  assert.match(componentSource, /useState<SizeScope>\("individual"\)/);
  assert.match(componentSource, /sizeScope === "all" && batchItems.length > 1/);
});

test("PNG batch ignores custom Q and keeps prepared Blobs isolated by item", async () => {
  const items = ["one", "two"].map(id => ({ id, file: new File([id], `${id}.png`), mode: "transparent-png",
    sourceInfo: { isPng: true, hasTransparency: true, width: 64, height: 32 }, qualityTier: "custom", customQuality: "invalid",
    appliedCrop: { aspectRatio: null, positionX: 50, positionY: 50 }, result: resultFixture() }));
  const oldResults = items.map(item => item.result);
  let calls = 0;
  let selectedIds = new Set();
  const preparedById = new Map();
  const context = productionFunctions(["runBatchOptimization"], {
    working: false, batchItems: items, currentBatchSnapshot: () => null, currentLimit: 64, createCustomProfile, buildTargetWidths,
    batchItemError: () => null, pendingProfile: () => ({ widths: [64] }), activeItemId: "none",
    ensurePreparedPng: async (id, file) => {
      if (!preparedById.has(id)) preparedById.set(id, { file, outputs: [{ blob: new Blob([file.name]) }] });
      return preparedById.get(id);
    },
    resolveEncoderQuality: () => assert.fail("PNG batch must not validate Q"),
    setBatchItems() {}, setSelectedBatchItemIds: update => { selectedIds = update(selectedIds); },
    outputSelectionKey, hydrateBatchItem() {}, setError() {}, setWorking() {}, setProcessingAll() {},
    setProgress() {}, setProcessingItemId() {}, setProgressText() {}, window: { setTimeout() {} },
    optimizeImage: async options => {
      assert.equal(options.quality, undefined);
      assert.equal(options.prepared, preparedById.get(options.file.name.replace(".png", "")));
      calls++;
      if (calls === 2) throw new Error("second failed");
      return resultFixture();
    },
    commitResult: (item, result) => ({ ...item, result }),
  });
  await context.runBatchOptimization();
  assert.equal(calls, 2);
  assert.deepEqual(Array.from(selectedIds), ["one"], "newly successful results join the selected photo set; failed item does not");
  assert.notEqual(preparedById.get("one"), preparedById.get("two"));
  assert.equal(items[1].result, oldResults[1]);
});

// Execute the actual production handler bodies; no copied implementation.
function productionFunctions(names, bindings, sourceAst = componentAst) {
  const dependencies = {
    smallestAvailableVariant: [],
    defaultOutputSelectionForTarget: ["smallestAvailableVariant"],
    defaultOutputSelectionForResult: ["defaultOutputSelectionForTarget"],
    commitResult: ["smallestAvailableVariant", "defaultOutputSelectionForResult"],
    buildBatchDownloadSet: [],
    setReadyPhotoSelection: [],
    createBatchItem: ["effectiveCropMaximum", "availableSelectionProfiles"],
    availableSelectionProfiles: [],
    currentCropLimit: ["cropAvailableWidth"],
    parseCustomWidth: ["effectiveCropMaximum"],
    sizeSettingsForScope: ["currentCropLimit", "reconcileSizeSettings", "cropAvailableWidth"],
    resolveSelectionProfileId: [],
    reconcileSizeSettings: ["cropAvailableWidth", "effectiveCropMaximum", "availableSelectionProfiles", "resolveSelectionProfileId", "parseCustomWidth"],
    batchItemError: ["cropAvailableWidth", "effectiveCropMaximum", "availableSelectionProfiles", "resolveSelectionProfileId", "cropsEqual"],
    pendingProfile: ["cropAvailableWidth", "availableSelectionProfiles", "resolveSelectionProfileId", "parseCustomWidth"],
    isOptimizationCurrent: ["pendingProfile", "optimizationSettingsKey"],
    acceptFiles: ["hasPngSignature", "hasTransparency", "sizeSettingsForScope"],
    chooseCustomWidth: ["parseCustomWidth"],
    finishCustomWidthInput: ["parseCustomWidth", "effectiveCropMaximum"],
    handleCustomWidthKeyDown: ["finishCustomWidthInput"],
    chooseResultWidth: ["defaultOutputSelectionForTarget", "smallestAvailableVariant"],
    runOptimization: ["transparentPngTargetProfile", "optimizationSettingsKey"],
    runBatchOptimization: ["transparentPngTargetProfile", "cropAvailableWidth", "optimizationSettingsKey", "pendingProfile"],
    syncOptionsToCrop: ["currentCropLimit", "reconcileSizeSettings"],
    applyCrop: ["syncOptionsToCrop"],
    isCurrentPreparedPngTask: [],
    isCurrentOptimizedPng: [],
    handleCropDimensionChange: ["resizeCropRectToDimensions"],
    handleCropDimensionKeyDown: ["finishCropDimensionInput"],
  };
  const required = new Set();
  function requireFunction(name) {
    if (required.has(name)) return;
    required.add(name);
    for (const dependency of dependencies[name] ?? []) {
      if (!(dependency in bindings)) requireFunction(dependency);
    }
  }
  names.forEach(requireFunction);
  names = [...required];
  const found = new Map();
  function visit(node) {
    if (ts.isFunctionDeclaration(node) && names.includes(node.name?.text)) found.set(node.name.text, node.getText(sourceAst));
    ts.forEachChild(node, visit);
  }
  visit(sourceAst);
  assert.equal(found.size, names.length);
  const code = ts.transpileModule([...found.values()].join("\n"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const context = vm.createContext({ exports: {}, Error, calculateCropRect, calculateOutputDimensions, getAvailableImageProfiles,
    createCustomProfile, buildTargetWidths, resolveEncoderQuality, preparedPngKey, IMAGE_PROFILES,
    currentLimit: Number.POSITIVE_INFINITY, sizeScope: "all", sourceInfo: null, lastValidCustomWidth: "360", setCropGuides() {},
    setSelectedBatchItemIds() {}, batchDownloadOutputs: [], preparedPngsRef: { current: new Map() }, ...bindings });
  context.setLastValidCustomWidth ??= value => { context.lastValidCustomWidth = value; };
  vm.runInContext(code, context);
  return context;
}

test("pointer side resize clears fixed ratio, corners retain it and move preserves dimensions", () => {
  const source = { width: 2000, height: 1500, previewUrl: "blob:original" };
  const rect = { x: 500, y: 400, width: 800, height: 600 };
  for (const handle of ["w", "e", "n", "s", "nw", "ne", "sw", "se", null]) {
    const start = { pointerId: 1, startClientX: 0, startClientY: 0, rect };
    const context = productionFunctions(["handleCropPointerMove", "resizedCropSettings"], {
      sourceInfo: source, resizeCropRect, cropSettingsFromRect,
      cropResizeRef: { current: handle ? { ...start, handle } : null },
      cropDragRef: { current: handle ? null : start },
      draftCrop: cropSettingsFromRect(rect, source.width, source.height, 4 / 3),
      updateDraftCrop: next => { context.draftCrop = next; },
    });
    context.handleCropPointerMove({ pointerId: 1, clientX: 100, clientY: 60,
      currentTarget: { getBoundingClientRect: () => ({ width: 2000, height: 1500 }) } });
    const actual = calculateCropRect(source.width, source.height, context.draftCrop);
    if (handle?.length === 1) {
      assert.equal(context.draftCrop.aspectRatio, null);
      assert.notEqual(context.draftCrop.aspectRatio, 4 / 3, "fixed preset must become inactive");
      if (handle === "w" || handle === "e") assert.equal(actual.height, rect.height);
      else assert.equal(actual.width, rect.width);
    } else {
      assert.equal(context.draftCrop.aspectRatio, 4 / 3);
      assert.ok(Math.abs(actual.width / actual.height - 4 / 3) < 1e-10);
      if (!handle) {
        assert.equal(actual.width, rect.width);
        assert.equal(actual.height, rect.height);
        assert.equal(actual.x, rect.x + 100);
        assert.ok(Math.abs(actual.y - (rect.y + 60)) < 1e-10);
      }
    }
  }
  assert.match(componentSource, /isCropPresetActive\(draftCrop, preset\.ratio, sourceInfo\)/);
  assert.match(componentSource, /resizedCropSettings\(rect, handle\.id, sourceInfo, draftCrop\.aspectRatio\)/);
});

test("side resize clears preset and subsequent corners preserve custom ratio in pointer and keyboard paths", () => {
  let keyboardHandler;
  function visit(node) {
    if (ts.isJsxAttribute(node) && node.name.getText(componentAst) === "onKeyDown" &&
      node.initializer?.expression && node.getText(componentAst).includes("resizeCropRect")) {
      assert.equal(keyboardHandler, undefined, "one crop keyboard handler");
      keyboardHandler = node.initializer.expression.getText(componentAst);
    }
    ts.forEachChild(node, visit);
  }
  visit(componentAst);
  assert.ok(keyboardHandler);
  const keyboardCode = ts.transpileModule(`globalThis.resizeByKey = ${keyboardHandler}`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const source = { width: 1500, height: 1000, previewUrl: "blob:original" };
  const original = { aspectRatio: null, positionX: 50, positionY: 50 };
  const active = productionFunctions(["isCropPresetActive"], { calculateCropRect });
  assert.equal(active.isCropPresetActive(original, null, source), true);
  for (const side of ["w", "e", "n", "s"]) {
    const fixed = { x: 300, y: 200, width: 600, height: 450 };
    const customRect = resizeCropRect(fixed, side, 90, 60, 1500, 1000, 4 / 3);
    const settings = productionFunctions(["resizedCropSettings"], { cropSettingsFromRect });
    const custom = settings.resizedCropSettings(customRect, side, source, 4 / 3);
    assert.equal(custom.aspectRatio, null);
    assert.equal(active.isCropPresetActive(custom, 4 / 3, source), false);
    assert.equal(active.isCropPresetActive(custom, null, source), false);
    for (const handle of ["nw", "ne", "sw", "se"]) {
      for (const [key, dx, dy] of [["ArrowRight", 10, 0], ["ArrowDown", 0, 10]]) {
        const makeContext = () => productionFunctions(["handleCropPointerMove", "resizedCropSettings"], {
          sourceInfo: source, draftCropRect: customRect, draftCrop: custom,
          handle: { id: handle }, resizeCropRect, cropSettingsFromRect,
          cropResizeRef: { current: { pointerId: 1, handle, rect: customRect, startClientX: 0, startClientY: 0 } },
          cropDragRef: { current: null },
          updateDraftCrop: next => { updates.push(next); },
        });
        const updates = [];
        const pointer = makeContext();
        pointer.handleCropPointerMove({ pointerId: 1, clientX: dx, clientY: dy,
          currentTarget: { getBoundingClientRect: () => ({ width: 1500, height: 1000 }) } });
        const keyboard = makeContext();
        vm.runInContext(keyboardCode, keyboard);
        let prevented = false;
        keyboard.resizeByKey({ key, preventDefault: () => { prevented = true; } });
        assert.equal(prevented, true);
        const pointerRect = calculateCropRect(1500, 1000, updates[0]);
        const keyboardRect = calculateCropRect(1500, 1000, updates[1]);
        assert.deepEqual(keyboardRect, pointerRect);
        assert.ok(Math.abs(pointerRect.width / pointerRect.height - customRect.width / customRect.height) < 1e-10);
        assert.notEqual(pointerRect.width, customRect.width);
        assert.notEqual(pointerRect.height, customRect.height);
        assert.equal(updates[0].aspectRatio, null);
        assert.equal(updates[1].aspectRatio, null);
      }
    }
  }
});

test("Apply presents only the saved crop and reopening uses the original without cumulative cropping", () => {
  const sourceInfo = { width: 2000, height: 1500, previewUrl: "blob:original" };
  const file = new File(["unchanged source"], "original.png");
  const draftCrop = cropSettingsFromRect({ x: 500, y: 400, width: 800, height: 600 }, 2000, 1500, 4 / 3);
  const committed = resultFixture();
  const context = productionFunctions(["applyCrop", "cropPreviewPresentation"], {
    file, sourceInfo, draftCrop, result: committed, calculateCropRect, cropEditing: true,
    syncOptionsToCrop() {},
    setAppliedCrop: next => { context.appliedCrop = next; },
    setCropEditing: next => { context.cropEditing = next; }, setError() {},
  });
  context.applyCrop();
  assert.equal(context.cropEditing, false);
  const saved = context.cropPreviewPresentation(sourceInfo, context.appliedCrop, false);
  assert.equal(saved.aspectRatio, String(4 / 3));
  assert.ok(Math.abs(parseFloat(saved.imageStyle.left) - -62.5) < 1e-10);
  assert.ok(Math.abs(parseFloat(saved.imageStyle.top) - -400 / 600 * 100) < 1e-10);
  assert.equal(saved.imageStyle.width, "250%");
  assert.equal(saved.imageStyle.height, "250%");
  const editing = context.cropPreviewPresentation(sourceInfo, context.appliedCrop, true);
  assert.equal(editing.aspectRatio, String(2000 / 1500));
  assert.equal(editing.imageStyle, undefined);
  context.applyCrop();
  assert.deepEqual(context.cropPreviewPresentation(sourceInfo, context.appliedCrop, false), saved);
  assert.equal(context.file, file);
  assert.equal(context.result, committed);
  assert.equal(sourceInfo.previewUrl, "blob:original");
});

test("viewing another ready target reselects its smallest format without changing pending targets", async () => {
  const old = resultFixture();
  old.results = [1024, 768].map(width => ({ ...old.results[0], width, height: Math.round(width * 2 / 3) }));
  let encodes = 0;
  let fail = false;
  let lastError = null;
  const names = ["createBatchItem", "currentBatchSnapshot", "hydrateBatchItem", "openCropForSizeChange",
    "chooseResultWidth", "chooseSizeProfile", "chooseCustomWidth", "chooseQuality", "applyCrop",
    "runOptimization", "commitResult", "pendingProfile", "cropAvailableWidth", "batchItemError",
    "cropsEqual", "cropPreviewPresentation"];
  const context = productionFunctions(names, {
    crypto, getAvailableImageProfiles, DEFAULT_ENCODER_QUALITY, calculateCropRect, createCustomProfile,
    buildTargetWidths, resolveEncoderQuality, defaultOutputSelection, outputSelectionKey, IMAGE_PROFILES,
    DEFAULT_CROP: { aspectRatio: null, positionX: 50, positionY: 50 }, working: false,
    setError(value) { lastError = value; }, setWorking() {}, setProcessingItemId() {}, setProgress() {}, setProgressText() {},
    window: { setTimeout() {} },
    optimizeImage: async ({ profile, quality, crop, file }) => {
      encodes++;
      assert.equal(context.result, old);
      assert.equal(profile.widths.length, 1);
      assert.equal(profile.widths[0], 768);
      assert.equal(quality, 80);
      assert.equal(file.name, "original.png");
      assert.deepEqual(JSON.parse(JSON.stringify(crop)), JSON.parse(JSON.stringify(context.appliedCrop)));
      if (fail) throw new Error("encoder failed");
      return { ...old, crop, results: [{ ...old.results[1], variants: old.results[1].variants }] };
    },
  });
  const updateProfile = () => {
    // React batches profileId/customWidth setters; do not validate their intermediate combination.
    if (context.sourceInfo && context.appliedCrop) {
      const availableWidth = calculateCropRect(context.sourceInfo.width, context.sourceInfo.height, context.appliedCrop).width;
      const selectedId = context.resolveSelectionProfileId(context.profileId, context.optimizationMode,
        context.availableSelectionProfiles(context.optimizationMode, availableWidth));
      if (selectedId === "custom" && Number(context.customWidth) > availableWidth) return;
    }
    if (context.sourceInfo && context.appliedCrop) context.profile = context.pendingProfile(context.currentBatchSnapshot(), 2000);
  };
  for (const name of ["activeItemId", "file", "sourceInfo", "profileId", "customWidth", "customWidthAuto",
    "customWidthMax", "draftCrop", "appliedCrop", "cropEditing", "result", "previewFormat", "previewWidth",
    "qualityTier", "customQuality", "selectedOutputKeys"]) {
    context[`set${name[0].toUpperCase()}${name.slice(1)}`] = value => {
      context[name] = value;
      if (name === "profileId") context.activeProfileId = value;
      if (["profileId", "customWidth", "appliedCrop"].includes(name) && context.batchItems) updateProfile();
    };
  }
  context.setOptimizationMode = value => { context.optimizationMode = value; };
  context.setBatchItems = update => { context.batchItems = update(context.batchItems); };
  const item = context.createBatchItem(new File(["original"], "original.png"),
    { width: 2000, height: 1500, previewUrl: "blob:original" });
  assert.equal(item.cropEditing, true, "upload must start with the crop editor open");
  Object.assign(context, item, { activeItemId: item.id, activeProfileId: item.profileId, optimizationMode: item.mode });
  context.batchItems = [item];
  context.hydrateBatchItem(item);
  assert.equal(context.cropEditing, true, "equal initial draft/applied must not close editor");
  assert.equal(context.cropPreviewPresentation(item.sourceInfo, item.appliedCrop, context.cropEditing).imageStyle, undefined);
  context.draftCrop = cropSettingsFromRect({ x: 200, y: 200, width: 1500, height: 1000 }, 2000, 1500, 3 / 2);
  context.applyCrop();
  assert.equal(context.cropEditing, false);
  assert.ok(context.cropPreviewPresentation(item.sourceInfo, context.appliedCrop, false).imageStyle);
  context.result = old;
  context.previewWidth = 1024;
  context.activeProfileId = "768-1024";
  context.profileId = "768-1024";
  context.batchItems = [context.currentBatchSnapshot()];
  context.profile = context.pendingProfile(context.currentBatchSnapshot(), 2000);
  context.chooseQuality("q65");
  assert.equal(context.cropEditing, false, "quality must not reopen crop");
  context.chooseQuality("q80");
  assert.equal(context.qualityTier, "q80");
  context.chooseResultWidth(1024);
  assert.equal(context.cropEditing, false, "same preview width is not a size change");
  const pendingProfileId = context.activeProfileId;
  const pendingCustomWidth = context.customWidth;
  const pendingCrop = JSON.parse(JSON.stringify(context.draftCrop));
  context.chooseResultWidth(768);
  assert.equal(context.cropEditing, false, "viewing a ready target does not open crop editing");
  assert.equal(context.activeProfileId, pendingProfileId);
  assert.equal(context.customWidth, pendingCustomWidth);
  assert.deepEqual(Array.from(context.profile.widths), [1024, 768]);
  assert.equal(context.previewWidth, 768);
  assert.equal(context.qualityTier, "q80", "view target switches preserve the current quality");
  assert.deepEqual(JSON.parse(JSON.stringify(context.draftCrop)), pendingCrop);
  assert.equal(selectedResultOutputs(old, context.selectedOutputKeys)[0].variant.format, "avif",
    "the 768 target reselects its smallest format from its own variants");
  assert.deepEqual(JSON.parse(JSON.stringify(context.draftCrop)), JSON.parse(JSON.stringify(context.appliedCrop)));
  assert.equal(context.cropPreviewPresentation(item.sourceInfo, context.appliedCrop, false).imageStyle !== undefined, true);
  assert.equal(context.result, old);
  assert.equal(encodes, 0);
  context.chooseCustomWidth("900");
  context.chooseCustomWidth("768");
  assert.equal(context.result, old);
  context.applyCrop();
  context.chooseSizeProfile("480-640");
  assert.equal(context.cropEditing, true);
  assert.equal(context.result, old);
  context.applyCrop();
  context.chooseSizeProfile("custom");
  context.applyCrop();
  context.chooseCustomWidth("700");
  assert.equal(context.cropEditing, true);
  assert.equal(context.result, old);
  context.chooseCustomWidth("768");
  context.draftCrop = cropSettingsFromRect({ x: 300, y: 200, width: 1200, height: 800 }, 2000, 1500, 3 / 2);
  context.applyCrop();
  assert.equal(calculateCropRect(2000, 1500, context.appliedCrop).width, 1200);
  context.chooseCustomWidth("768");
  context.applyCrop();
  fail = true;
  await context.runOptimization();
  assert.equal(lastError, "encoder failed");
  assert.equal(context.result, old, "failure retains the previous committed files");
  fail = false;
  await context.runOptimization();
  assert.equal(lastError, null);
  assert.notEqual(context.result, old);
  assert.equal(context.result.results[0].width, 768);
  assert.equal(context.result.results[0].variants[0].quality, 80);
  assert.equal(context.batchItems[0].result, context.result);
  assert.equal(context.cropEditing, false);
});

test("paired target presets survive result viewing, format selection and repeated batch optimization", async () => {
  const fileBytes = (size, format, width, quality = 85) => ({
    format, mime: `image/${format}`, extension: format, blob: new Blob([new Uint8Array(size)]), size,
    quality, similarity: null, similarityMethod: null, fileName: `img-${width}-q${quality}.${format}`,
  });
  const makeResult = () => ({ mode: "photo", results: [
    { width: 1440, height: 960, variants: [fileBytes(90, "avif", 1440), fileBytes(80, "webp", 1440)] },
    { width: 1280, height: 853, variants: [fileBytes(60, "avif", 1280), fileBytes(70, "webp", 1280)] },
  ] });
  const files = [0, 1, 2].map(index => new File([`photo-${index}`], `photo-${index}.jpg`));
  const crop = { aspectRatio: null, positionX: 50, positionY: 50 };
  let context;
  const items = files.map((file, index) => {
    const result = makeResult();
    return { id: `photo-${index}`, file, sourceInfo: { width: 2200, height: 1500 }, mode: "photo",
      profileId: "1280-1440", customWidth: "700", customWidthAuto: false, qualityTier: ["q85", "q80", "q65"][index],
      customQuality: "72", draftCrop: { ...crop }, appliedCrop: { ...crop }, cropEditing: false, result,
      resultSettingsKey: null, resultSourceFile: file, previewWidth: 1440, previewFormat: "avif",
      selectedOutputKeys: defaultOutputSelection(result), selectedBatchItemIds: [], optimizedPngTargetKey: null };
  });
  let working = false;
  let batchError = null;
  const encodedWidths = [];
  const expectedQualities = [85, 80, 65, 80, 65, 65];
  context = productionFunctions(["runBatchOptimization", "chooseResultWidth", "pendingProfile", "optimizationSettingsKey", "isOptimizationCurrent"], {
    batchItems: items, activeItemId: items[0].id, working, sizeScope: "all", currentLimit: 2200,
    profileId: "1280-1440", customWidth: "700", customWidthAuto: false, qualityTier: "q85", customQuality: "72",
    result: items[0].result, previewWidth: 1440, previewFormat: "avif", selectedOutputKeys: [...items[0].selectedOutputKeys],
    cropEditing: false, appliedCrop: crop, draftCrop: crop, file: files[0], sourceInfo: items[0].sourceInfo,
    getAvailableImageProfiles, outputSelectionKey,
    createCustomProfile, buildTargetWidths, calculateCropRect, calculateOutputDimensions, resolveEncoderQuality,
    preparedPngKey, IMAGE_PROFILES, batchItemError: () => null, currentBatchSnapshot: () => {
      const active = context.batchItems.find(item => item.id === context.activeItemId);
      return { ...active, profileId: context.profileId, qualityTier: context.qualityTier, customQuality: context.customQuality,
        previewWidth: context.previewWidth, previewFormat: context.previewFormat, selectedOutputKeys: [...context.selectedOutputKeys] };
    },
    setPreviewWidth(value) { context.previewWidth = value; },
    setPreviewFormat(value) { context.previewFormat = value; },
    setSelectedOutputKeys(value) { context.selectedOutputKeys = value; },
    setWorking(value) { context.working = value; }, setError(value) { batchError = value; }, setProgress() {}, setProgressText() {}, setProcessingItemId() {},
    ensurePreparedPng: async () => assert.fail("Photo batch must not prepare PNG"),
    optimizeImage: async ({ profile, quality }) => {
      const callIndex = encodedWidths.length;
      encodedWidths.push([...profile.widths]);
      assert.equal(quality, expectedQualities[callIndex]);
      return { mode: "photo", results: profile.widths.map(width => ({ width, height: Math.round(width * 2 / 3),
        variants: [fileBytes(90, "avif", width, quality), fileBytes(80, "webp", width, quality)] })) };
    },
    commitResult(item, result, _preparedKey, key) {
      const committed = { ...item, result, resultSettingsKey: key, resultSourceFile: item.file,
        previewWidth: result.results[0]?.width ?? null, previewFormat: "webp",
        selectedOutputKeys: result.results[0] ? [outputSelectionKey(result.results[0].width, result.results[0].height, result.results[0].variants[1])] : [] };
      return committed;
    },
    setBatchItems(update) { context.batchItems = typeof update === "function" ? update(context.batchItems) : update; },
    setSelectedBatchItemIds(update) { context.selectedBatchItemIds = update(context.selectedBatchItemIds ?? new Set()); },
    hydrateBatchItem(item) {
      context.result = item.result; context.previewWidth = item.previewWidth; context.previewFormat = item.previewFormat;
      context.selectedOutputKeys = [...item.selectedOutputKeys]; context.qualityTier = item.qualityTier;
    },
    activeItemId: items[0].id, window: { setTimeout() {} }, document: { getElementById: () => null },
  });
  const beforeKey = context.optimizationSettingsKey(items[0], context.pendingProfile(items[0], 2200), 85);
  items[0].resultSettingsKey = beforeKey;
  assert.deepEqual(Array.from(context.pendingProfile(items[0], 2200).widths), [1440, 1280]);
  assert.equal(context.isOptimizationCurrent(items[0], 2200), true);

  context.selectedOutputKeys = [outputSelectionKey(1440, 960, fileBytes(1, "avif", 1440))];
  context.chooseResultWidth(1280);
  assert.equal(context.previewWidth, 1280);
  assert.equal(context.profileId, "1280-1440");
  assert.equal(context.customWidth, "700");
  assert.equal(context.cropEditing, false);
  assert.equal(selectedResultOutputs(context.result, context.selectedOutputKeys)[0].variant.format, "avif",
    "1280 selects its smallest local variant after a manual 1440 selection");
  assert.deepEqual(Array.from(context.pendingProfile(items[0], 2200).widths), [1440, 1280]);
  assert.equal(context.optimizationSettingsKey(items[0], context.pendingProfile(items[0], 2200), 85), beforeKey,
    "view and download selections do not alter currentness");
  assert.equal(context.isOptimizationCurrent(items[0], 2200), true);

  context.selectedOutputKeys = [outputSelectionKey(1280, 853, fileBytes(1, "webp", 1280))];
  context.chooseResultWidth(1280);
  assert.equal(selectedResultOutputs(context.result, context.selectedOutputKeys)[0].variant.format, "webp",
    "manual selection remains while the current target stays selected");
  await context.runBatchOptimization();
  assert.deepEqual(encodedWidths, [[1440, 1280], [1440, 1280], [1440, 1280]]);
  for (const item of context.batchItems) {
    assert.deepEqual(Array.from(item.result.results.map(output => output.width)), [1440, 1280]);
    assert.deepEqual(JSON.parse(item.resultSettingsKey)[3], [1440, 1280]);
  }

  context.batchItems = context.batchItems.map((item, index) => ({ ...item,
    qualityTier: index === 1 ? "q65" : item.qualityTier,
    appliedCrop: { ...item.appliedCrop, size: { width: 0.9, height: 1 } },
    draftCrop: { ...item.draftCrop, size: { width: 0.9, height: 1 } },
  }));
  context.qualityTier = "q80";
  context.appliedCrop = context.batchItems[0].appliedCrop;
  context.draftCrop = context.batchItems[0].draftCrop;
  context.chooseResultWidth(1280);
  await context.runBatchOptimization();
  assert.equal(batchError, null);
  assert.deepEqual(encodedWidths.slice(3), [[1440, 1280], [1440, 1280], [1440, 1280]],
    "a repeated batch after viewing 1280 keeps both widths for each item");
  assert.deepEqual(context.batchItems.map(item => item.result.results.map(output => output.width)),
    [[1440, 1280], [1440, 1280], [1440, 1280]],
    "quality or applied crop changes keep both paired targets when they remain eligible");
});

test("Photo preset crop fallback and custom 941 stay canonical through Optimize despite Q80 and old preview 768", async () => {
  const old = resultFixture();
  old.results = [768, 640].map(width => ({ ...old.results[0], width, height: Math.round(width * 2 / 3) }));
  const file = new File(["photo"], "photo.jpg");
  let encodedWidth = null;
  let encodedQuality = null;
  const names = ["createBatchItem", "currentBatchSnapshot", "syncOptionsToCrop", "reconcileSizeSettings",
    "cropAvailableWidth", "effectiveCropMaximum", "chooseCustomWidth", "openCropForSizeChange", "applyCrop",
    "runOptimization", "batchItemError", "cropsEqual", "commitResult", "availableSelectionProfiles",
    "resolveSelectionProfileId", "pendingProfile"];
  const context = productionFunctions(names, {
    crypto, getAvailableImageProfiles, DEFAULT_ENCODER_QUALITY, calculateCropRect, cropSettingsFromRect,
    createCustomProfile, buildTargetWidths, resolveEncoderQuality, defaultOutputSelection, outputSelectionKey, IMAGE_PROFILES,
    DEFAULT_CROP: { aspectRatio: null, positionX: 50, positionY: 50 },
    working: false,
    setError(value) { context.error = value; }, setWorking() {}, setProcessingItemId() {}, setProgress() {}, setProgressText() {},
    setProfileId(value) { context.profileId = value; },
    setCustomWidth(value) { context.customWidth = value; },
    setCustomWidthAuto(value) { context.customWidthAuto = value; },
    setCustomWidthMax(value) { context.customWidthMax = value; },
    setDraftCrop(value) { context.draftCrop = value; },
    setAppliedCrop(value) { context.appliedCrop = value; },
    setCropEditing(value) { context.cropEditing = value; },
    setBatchItems(update) { context.batchItems = typeof update === "function" ? update(context.batchItems) : update; },
    window: { setTimeout() {} },
    commitResult: (item, result) => ({ ...item, result }),
    hydrateBatchItem(item) { Object.assign(context, item); },
    optimizeImage: async ({ profile, quality, crop }) => {
      encodedWidth = profile.widths[0];
      encodedQuality = quality;
      const dimensions = calculateOutputDimensions(calculateCropRect(2000, 1500, crop), encodedWidth);
      return { ...old, profile, results: [{ ...old.results[0], ...dimensions }] };
    },
  });
  const item = context.createBatchItem(file, {
    width: 2000, height: 1500, previewUrl: "blob:photo", isPng: false, hasTransparency: false,
  });
  Object.assign(context, item, {
    activeItemId: item.id, profileId: "768-1024", customWidth: "2000", customWidthAuto: true,
    draftCrop: item.appliedCrop, result: old, previewWidth: 768, qualityTier: "q80", customQuality: "80",
    optimizationMode: "photo", selectedOutputKeys: defaultOutputSelection(old), batchItems: [],
  });
  context.batchItems = [{ ...item, profileId: "768-1024", customWidth: "2000" }];
  Object.defineProperty(context, "activeProfileId", {
    get() {
      const maxWidth = calculateCropRect(context.sourceInfo.width, context.sourceInfo.height, context.draftCrop).width;
      return context.resolveSelectionProfileId(context.profileId, context.optimizationMode,
        context.availableSelectionProfiles(context.optimizationMode, maxWidth));
    },
  });
  Object.defineProperty(context, "profile", {
    get() {
      const maxWidth = calculateCropRect(context.sourceInfo.width, context.sourceInfo.height, context.draftCrop).width;
      return context.activeProfileId === "custom"
        ? createCustomProfile(Number(context.customWidth), maxWidth)
        : { ...IMAGE_PROFILES.find(profile => profile.id === context.activeProfileId),
          widths: buildTargetWidths(maxWidth, IMAGE_PROFILES.find(profile => profile.id === context.activeProfileId)) };
    },
  });

  const cropped = cropSettingsFromRect({ x: 0, y: 0, width: 941, height: 941 }, 2000, 1500, 1);
  context.syncOptionsToCrop(cropped, 2000, 1500);
  context.draftCrop = cropped;
  context.applyCrop();
  assert.equal(context.profileId, "custom");
  assert.equal(context.activeProfileId, "custom");
  assert.equal(context.customWidth, "941");

  context.chooseCustomWidth("900");
  context.chooseCustomWidth("941");
  context.applyCrop();
  assert.equal(context.activeProfileId, "custom");
  assert.equal(context.customWidth, "941");
  await context.runOptimization();
  assert.equal(encodedWidth, 941);
  assert.equal(encodedQuality, 80);
  assert.equal(context.result.results[0].width, 941);
  assert.notEqual(context.result.results[0].width, 768);
});

test("quality clicks only update pending quality and never invoke encoding", () => {
  let encodes = 0;
  const chosen = [];
  const context = productionFunctions(["chooseQuality"], {
    setQualityTier: (tier) => chosen.push(tier),
    optimizeImage: () => { encodes++; },
    runOptimization: () => { encodes++; },
    runBatchOptimization: () => { encodes++; },
  });
  for (const tier of ["q65", "q80", "q85", "custom"]) context.chooseQuality(tier);
  assert.deepEqual(chosen, ["q65", "q80", "q85", "custom"]);
  assert.equal(encodes, 0);
  const qualityInput = componentSource.slice(componentSource.indexOf('className="quality-custom-input"'), componentSource.indexOf('className="quality-selector-error"'));
  assert.doesNotMatch(qualityInput, /onBlur|onKeyDown|optimizeImage|runOptimization/);
});

test("actual download handlers sequence selected Blobs 140ms apart and block repeated clicks", async () => {
  for (const count of [1, 2, 3]) {
    const outputs = Array.from({ length: count }, (_, index) => ({ item: {
      id: `photo-${index}`, result: { mode: "photo" }, optimizedPngTargetKey: null, optimizedPngDownloadKeys: [],
    }, width: 100 + index, height: 80, variant: {
      blob: new Blob([String(index)]), fileName: `output-${index}.png`,
    } }));
    const urls = [], clicks = [], revoked = [], timers = [], waits = [], appended = [], removed = [];
    const busy = [];
    const context = productionFunctions(["downloadBlob", "downloadSelectedOutputs"], {
      batchDownloadOutputs: outputs, downloadingFilesRef: { current: false },
      setDownloadingFiles: (value) => busy.push(value),
      URL: {
        createObjectURL(blob) { urls.push(blob); return `blob:test-${urls.length}`; },
        revokeObjectURL(url) { revoked.push(url); },
      },
      document: {
        createElement(tag) {
          assert.equal(tag, "a");
          return { click() { clicks.push({ href: this.href, download: this.download }); }, remove() { removed.push(this); } };
        },
        body: { appendChild(link) { appended.push(link); } },
      },
      window: { setTimeout(fn, delay) {
        if (delay === 140) waits.push(fn);
        else { assert.equal(delay, 1000); timers.push(fn); }
      } },
    });
    const pending = context.downloadSelectedOutputs();
    assert.equal(clicks.length, 1);
    if (count > 1) {
      assert.equal(context.downloadingFilesRef.current, true);
      await context.downloadSelectedOutputs();
      assert.equal(clicks.length, 1);
      // Changing selection after the click must not change the captured loop.
      context.batchDownloadOutputs = [];
    }
    for (let index = 1; index < count; index++) {
      assert.equal(waits.length, 1);
      waits.shift()();
      await Promise.resolve();
      assert.equal(clicks.length, index + 1);
    }
    await pending;
    assert.equal(context.downloadingFilesRef.current, false);
    assert.deepEqual(busy, [true, false]);
    assert.equal(clicks.length, count);
    assert.equal(appended.length, count);
    assert.equal(removed.length, count);
    assert.deepEqual(urls, outputs.map((output) => output.variant.blob));
    assert.deepEqual(clicks.map((click) => click.download), outputs.map((output) => output.variant.fileName));
    assert.equal(revoked.length, 0);
    timers.forEach((fn) => fn());
    assert.deepEqual(revoked, clicks.map((click) => click.href));
  }
  assert.doesNotMatch(componentSource, /browser-zip|JSZip|createZip|downloadZip/);
});

test("transparent PNG downloads are separate, dimension-specific and repeatable", async () => {
  const preparedBlob = new Blob(["prepared"]);
  const optimizedBlob = new Blob(["optimized"]);
  let items = [
    { id: "png-1", result: { mode: "transparent-png" }, optimizedPngTargetKey: "crop-a", preparedPngDownloadKey: null, optimizedPngDownloadKeys: [] },
    { id: "png-2", preparedPngDownloadKey: null, optimizedPngDownloadKeys: [] },
  ];
  const rawDownloads = [];
  const raw = productionFunctions(["downloadPreparedPng"], {
    currentBatchSnapshot: () => ({ id: "png-1", mode: "transparent-png" }),
    working: false,
    activePreparedOutputs: [{ width: 350, height: 117, blob: preparedBlob, fileName: "img-350x117.png" }],
    activePreparedDownloadKey: "crop-a:350x117",
    setBatchItems: update => { items = update(items); },
    downloadBlob: (blob, name) => rawDownloads.push({ blob, name }),
    window: { setTimeout(resolve) { resolve(); } },
  });
  raw.downloadPreparedPng();
  raw.downloadPreparedPng();
  assert.deepEqual(rawDownloads, [
    { blob: preparedBlob, name: "img-350x117.png" },
    { blob: preparedBlob, name: "img-350x117.png" },
  ]);
  assert.equal(items[0].preparedPngDownloadKey, "crop-a:350x117");
  assert.deepEqual(items[0].optimizedPngDownloadKeys, []);
  assert.equal(items[1].preparedPngDownloadKey, null);
  assert.deepEqual(items[1].optimizedPngDownloadKeys, []);

  const presetOutputs = [
    { width: 1920, height: 1280, blob: new Blob(["large"]), fileName: "img-1920x1280.png" },
    { width: 1680, height: 1120, blob: new Blob(["small"]), fileName: "img-1680x1120.png" },
  ];
  const presetDownloads = [];
  const preset = productionFunctions(["downloadPreparedPng"], {
    currentBatchSnapshot: () => ({ id: "png-1", mode: "transparent-png" }),
    activePreparedOutputs: presetOutputs,
    activePreparedDownloadKey: "preset-key:1920x1280,1680x1120",
    setBatchItems: update => { items = update(items); },
    downloadBlob: (blob, name) => presetDownloads.push({ blob, name }),
    window: { setTimeout(resolve) { resolve(); } },
  });
  await preset.downloadPreparedPng();
  assert.deepEqual(presetDownloads, presetOutputs.map(output => ({ blob: output.blob, name: output.fileName })));
  assert.equal(items[0].preparedPngDownloadKey, "preset-key:1920x1280,1680x1120");
  items[0].preparedPngDownloadKey = "crop-a:350x117";

  const optimizedDownloads = [];
  const output = { width: 350, height: 117, variant: { blob: optimizedBlob, fileName: "img-350x117.png" } };
  const optimized = productionFunctions(["downloadSelectedOutputs", "optimizedPngDownloadIdentity"], {
    downloadingFilesRef: { current: false },
    batchDownloadOutputs: [{ item: items[0], ...output }],
    setDownloadingFiles() {},
    setBatchItems: update => { items = update(items); },
    downloadBlob: (blob, name) => optimizedDownloads.push({ blob, name }),
    window: { setTimeout() {} },
  });
  await optimized.downloadSelectedOutputs();
  assert.deepEqual(optimizedDownloads, [{ blob: optimizedBlob, name: "img-350x117.png" }]);
  assert.equal(items[0].preparedPngDownloadKey, "crop-a:350x117");
  assert.deepEqual(Array.from(items[0].optimizedPngDownloadKeys), ["crop-a:350x117"]);
  assert.equal(items[1].preparedPngDownloadKey, null);
  assert.deepEqual(items[1].optimizedPngDownloadKeys, []);

  const previous = { preparedPngDownloadKey: "crop-a:350x117", optimizedPngDownloadKeys: ["crop-a:350x117"] };
  const commit = productionFunctions(["commitResult"], { outputSelectionKey });
  const next = commit.commitResult(previous, resultFixture());
  assert.equal(next.preparedPngDownloadKey, "crop-a:350x117");
  assert.deepEqual(Array.from(next.optimizedPngDownloadKeys), []);
  const pngCommit = commit.commitResult({ ...previous, mode: "transparent-png" }, { ...resultFixture(), mode: "transparent-png" }, "crop-b");
  assert.equal(pngCommit.optimizedPngTargetKey, "crop-b");

  assert.match(componentSource, /activePreparedReady && activePreparedOutputs\.length/);
  assert.match(componentSource, /ГОТОВИМ PNG · \$\{activeTargetDimensionsLabel/);
  assert.match(componentSource, /disabled=\{optimizationMode === "transparent-png" && \(!activePreparedReady \|\| !activePreparedOutputs\.length\)\}/);
  assert.match(componentSource, /!activeOptimizationCurrent \? \(/);
  assert.match(componentSource, /activeOptimizedTargetCurrent\) \?/);
  assert.match(componentSource, /isCurrentPreparedPngTask\(preparedPngTasksRef\.current, itemId, task\)/);
  assert.match(componentSource, /preparedPngKey\(appliedCrop, targetProfile\)/);
  assert.match(componentSource, /file: snapshot\.file, profile: runProfile, crop: snapshot\.appliedCrop/);
  assert.match(componentSource, /СКАЧАТЬ PNG БЕЗ ОПТИМИЗАЦИИ · \$\{activePreparedOutputs\.map\(/);
  assert.match(componentSource, /СКАЧАТЬ ОПТИМИЗИРОВАННЫЙ PNG · \$\{batchDownloadOutputs\[0\]\.width\}×\$\{batchDownloadOutputs\[0\]\.height\} PX/);
  assert.match(componentSource, /Оптимизировать фото \$\{activeItemNumber\}/);
  const progressStart = componentSource.indexOf('className="progress-panel"');
  const progressPanel = componentSource.slice(progressStart, componentSource.indexOf("          ) : (", progressStart));
  assert.match(progressPanel, /progressText/);
  assert.match(progressPanel, /progress}%/);
  assert.match(progressPanel, /className="progress-track"/);
  assert.doesNotMatch(progressPanel, /<small>|Большие фотографии|обрабатываются по очереди/);
  const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  assert.match(css, /\.png-download-button\.is-downloaded/);
  assert.match(css, /\.png-download-button\.is-downloaded:hover/);
  assert.match(css, /\.png-download-raw/);
  assert.match(css, /\.png-download-optimized/);
  assert.match(componentSource, /className=\{`format-result-row\$\{result\.mode === "transparent-png" \? " is-lossless-png" : ""\}/);
  assert.match(componentSource, /result\.mode !== "transparent-png" \? \([\s\S]*?variant\.similarity\.toFixed\(3\)[\s\S]*?Сходство/);
  assert.match(css, /\.format-result-row\.is-lossless-png\s*\{\s*grid-template-columns:\s*20px minmax\(0, 1fr\) minmax\(0, 1fr\)/);
  assert.match(css, /\.png-download-button\.is-downloaded\s*\{[\s\S]*?background:\s*var\(--ui-accent-soft\)[\s\S]*?color:\s*var\(--ui-accent-ink\)/);
  assert.match(css, /\.png-download-button:disabled\s*\{[\s\S]*?background:\s*var\(--ui-surface-3\)[\s\S]*?color:\s*var\(--ui-text-secondary\)/);
  assert.match(css, /\.png-download-optimized > i\s*\{[\s\S]*?color:\s*var\(--ui-accent-ink\)/);
  assert.match(css, /\.png-download-button:disabled:hover\s*\{/);
  assert.match(componentSource, /activePreparedReady && activePreparedDownloaded \? " is-downloaded"/);
  assert.match(componentSource, /activeOptimizedDownloaded \? " is-downloaded"/);
  assert.match(componentSource, /className=\{`primary-button png-download-button png-download-raw\$\{[\s\S]*?is-downloaded/);
  assert.match(componentSource, /className=\{`primary-button result-download-button\$\{[\s\S]*?png-download-optimized[\s\S]*?activeOptimizedDownloaded/);
  assert.match(componentSource, /disabled=\{!activePreparedReady \|\| !activePreparedOutputs\.length\}/);
  assert.match(componentSource, /disabled=\{!batchDownloadOutputs\.length \|\| downloadingFiles\}/);
});

test("transparent PNG preserves preset target sets while custom remains exact and stale preparation cannot win", () => {
  const context = productionFunctions(["transparentPngTargetProfile", "isCurrentPreparedPngTask", "isCurrentOptimizedPng"], { createCustomProfile, buildTargetWidths });
  const preset1920 = { id: "1680-1920", widths: [1920, 1680] };
  const preset1024 = { id: "768-1024", widths: [1024, 768] };
  assert.deepEqual(Array.from(context.transparentPngTargetProfile(preset1920, 2000).widths), [1920, 1680]);
  assert.deepEqual(Array.from(context.transparentPngTargetProfile(preset1024, 1100).widths), [1024, 768]);
  assert.deepEqual(Array.from(context.transparentPngTargetProfile(preset1024, 900).widths), [768]);
  assert.deepEqual(Array.from(context.transparentPngTargetProfile(createCustomProfile(350, 2000), 2000).widths), [350]);
  assert.deepEqual(Array.from(context.transparentPngTargetProfile({ id: "custom", widths: [] }, 1024).widths), []);
  const identityCrop = { aspectRatio: null, positionX: 50, positionY: 50 };
  assert.notEqual(preparedPngKey(identityCrop, { id: "1680-1920", widths: [1920] }),
    preparedPngKey(identityCrop, preset1920), "prepared identity distinguishes a partial preset from its full target set");
  const old = { key: "700", file: new File(["old"], "old.png"), promise: Promise.resolve({}) };
  const middle = { key: "500", file: new File(["middle"], "middle.png"), promise: Promise.resolve({}) };
  const latest = { key: "350", file: new File(["latest"], "latest.png"), promise: Promise.resolve({}) };
  const tasks = new Map([["item", old]]);
  tasks.set("item", middle);
  tasks.set("item", latest);
  assert.equal(context.isCurrentPreparedPngTask(tasks, "item", old), false);
  assert.equal(context.isCurrentPreparedPngTask(tasks, "item", middle), false);
  assert.equal(context.isCurrentPreparedPngTask(tasks, "item", latest), true);
  assert.match(componentSource, /setProfileId\("custom"\);\s*setCustomWidth\(nextWidth\)/);
  let selectedProfile = "768-1024", selectedWidth = "350";
  const customSelection = productionFunctions(["chooseCustomWidth"], {
    get activeProfileId() { return selectedProfile; }, get customWidth() { return selectedWidth; }, sourceInfo: null,
    setProfileId(value) { selectedProfile = value; },
    setCustomWidth(value) { selectedWidth = value; }, setCustomWidthAuto() {},
    openCropForSizeChange() {},
  });
  customSelection.chooseCustomWidth("350");
  assert.equal(selectedProfile, "custom", "typing the existing custom value activates it from a preset");
  assert.equal(selectedWidth, "350");
  const crop = { aspectRatio: null, positionX: 50, positionY: 50 };
  const custom350 = createCustomProfile(350, 1000);
  const custom640 = createCustomProfile(640, 1000);
  assert.notEqual(preparedPngKey(crop, custom350), preparedPngKey(crop, custom640), "new width invalidates prepared/optimized target identity");
  assert.notEqual(preparedPngKey(crop, custom350), preparedPngKey({ ...crop, positionX: 51 }, custom350), "new crop invalidates target identity");
  const committed = { ...resultFixture(), mode: "transparent-png" };
  const oldKey = preparedPngKey(crop, custom350), newKey = preparedPngKey(crop, custom640);
  assert.equal(context.isCurrentOptimizedPng("transparent-png", committed, oldKey, oldKey), true);
  assert.equal(context.isCurrentOptimizedPng("transparent-png", committed, oldKey, newKey), false,
    "350 result must not be shown as the current 640 result");
  assert.equal(context.isCurrentOptimizedPng("transparent-png", committed, oldKey, null), false);
});

test("transparent PNG Optimize prepares and encodes exactly the current preset or custom target set", async () => {
  const file = new File(["png"], "source.png", { type: "image/png" });
  const crop = { aspectRatio: null, positionX: 50, positionY: 50 };
  for (const profile of [
    { id: "custom", widths: [350] },
    { id: "1680-1920", widths: [1920, 1680] },
    { id: "768-1024", widths: [1024, 768] },
  ]) {
    let committed = { id: "item", file, sourceInfo: { width: 2000, height: 1200 }, appliedCrop: crop, mode: "transparent-png", result: null };
    const preparedWidths = [];
    const optimizedWidths = [];
    const context = productionFunctions(["runOptimization"], {
      file, working: false, activeItemId: "item", profile, currentLimit: profile.widths[0],
      optimizationMode: "transparent-png", qualityTier: "q80", customQuality: "80",
      currentBatchSnapshot: () => committed,
      batchItemError: () => null,
      setWorking() {}, setProcessingItemId() {}, setError() {}, setProgress() {}, setProgressText() {},
      window: { setTimeout() {} },
      setBatchItems: update => { [committed] = update([committed]); },
      hydrateBatchItem: next => { committed = next; },
      ensurePreparedPng: async (_id, _file, _crop, targetProfile) => {
        preparedWidths.push(...targetProfile.widths);
        return { key: preparedPngKey(crop, targetProfile), outputs: targetProfile.widths.map(width => ({ width })) };
      },
      preparedPngKey,
      createCustomProfile, buildTargetWidths,
      optimizeImage: async options => {
        assert.deepEqual(Array.from(options.profile.widths), profile.widths);
        assert.deepEqual(Array.from(options.prepared.outputs.map(output => output.width)), profile.widths);
        optimizedWidths.push(...options.profile.widths);
        return { mode: options.mode, results: options.profile.widths.map(width => ({ width, height: 100, variants: [] })) };
      },
      commitResult: (item, result, targetKey) => ({ ...item, result, optimizedPngTargetKey: targetKey }),
    });
    await context.runOptimization();
    assert.deepEqual(preparedWidths, profile.widths);
    assert.deepEqual(optimizedWidths, profile.widths);
    assert.deepEqual(Array.from(committed.result.results, output => output.width), profile.widths);
    assert.equal(committed.optimizedPngTargetKey, preparedPngKey(crop, profile));
  }
  assert.match(componentSource, /!activeOptimizationCurrent \? \(/,
    "the common applied-settings currentness controls Optimize independently of PNG download readiness");
});

test("production optimize handler preserves committed 1024 Q80 until successful replacement", async () => {
  const old = resultFixture();
  old.results[0] = { ...old.results[0], width: 1024, height: 683, variants: old.results[0].variants.slice(0, 2) };
  const sourceFile = new File(["input"], "photo.png");
  const item = { id: "photo-1", file: sourceFile, sourceInfo: { width: 2000, height: 1500 }, mode: "photo",
    appliedCrop: { aspectRatio: null, positionX: 50, positionY: 50 }, resultSettingsKey: "old-settings", resultSourceFile: sourceFile,
    result: old, selectedOutputKeys: defaultOutputSelection(old), qualityTier: "q80", customQuality: "80", profileId: "768-1024" };
  let committed = item;
  let encodes = 0;
  let fail = false;
  const context = productionFunctions(["chooseQuality", "runOptimization", "commitResult"], {
    file: sourceFile, working: false, activeItemId: item.id,
    profile: { widths: [1024] }, appliedCrop: {}, optimizationMode: "photo", qualityTier: "q80", customQuality: "80",
    currentBatchSnapshot: () => ({ ...committed, qualityTier: context.qualityTier }),
    batchItemError: () => null, resolveEncoderQuality, defaultOutputSelection, outputSelectionKey,
    setQualityTier: (tier) => { context.qualityTier = tier; },
    setWorking: () => {}, setProcessingItemId: () => {}, setError: () => {}, setProgress: () => {},
    setProgressText: () => {}, window: { setTimeout() {} },
    setBatchItems: (update) => { [committed] = update([committed]); },
    hydrateBatchItem: (next) => { committed = next; },
    optimizeImage: async ({ quality, profile }) => {
      encodes++;
      assert.equal(committed.result, old);
      if (fail) throw new Error("encoder failed");
      return { ...old, results: [{ width: profile.widths[0], height: 512, variants: old.results[0].variants.map((v) => ({ ...v, quality })) }] };
    },
  });
  context.profile = { widths: [768] };
  assert.equal(committed.result, old);
  context.chooseQuality("q65");
  assert.equal(encodes, 0);
  assert.equal(committed.result.results[0].width, 1024);
  assert.equal(committed.result.results[0].variants[0].quality, 80);
  const selectionBefore = committed.selectedOutputKeys;
  fail = true;
  await context.runOptimization();
  assert.equal(committed.result, old);
  assert.equal(committed.selectedOutputKeys, selectionBefore);
  fail = false;
  await context.runOptimization();
  assert.notEqual(committed.result, old);
  assert.equal(committed.result.results[0].width, 768);
  assert.equal(committed.result.results[0].variants[0].quality, 65);
  assert.deepEqual(Array.from(committed.selectedOutputKeys), defaultOutputSelection(committed.result));
});

test("1100px hides fully unavailable presets and 900px keeps only requested 768px", () => {
  assert.deepEqual(getAvailableImageProfiles(1100).map((profile) => profile.id), ["768-1024", "480-640", "custom"]);
  assert.deepEqual(buildTargetWidths(900, IMAGE_PROFILES.find((profile) => profile.id === "768-1024")), [768]);
  assert.match(componentSource, /availableProfiles\.map\(\(item\)/);
});

test("saved crop updates custom width and keeps batch results while draft-only editing preserves saved settings", () => {
  const names = ["createBatchItem", "currentBatchSnapshot", "hydrateBatchItem", "switchBatchItem",
    "syncOptionsToCrop", "updateDraftCrop", "chooseCustomWidth", "openCropForSizeChange", "applyCrop",
    "handleCropPointerMove", "resizedCropSettings", "reconcileSizeSettings", "cropAvailableWidth",
    "currentCropLimit", "applyCropRatioToBatchItem", "finishCustomWidthInput"];
  const context = productionFunctions(names, {
    crypto, getAvailableImageProfiles, DEFAULT_ENCODER_QUALITY, calculateCropRect, cropSettingsFromRect, resizeCropRect,
    DEFAULT_CROP: { aspectRatio: null, positionX: 50, positionY: 50 }, working: false,
    setError() {},
  });
  for (const name of ["activeItemId", "file", "sourceInfo", "profileId", "customWidth", "customWidthAuto",
    "customWidthMax", "draftCrop", "appliedCrop", "cropEditing", "result", "previewFormat", "previewWidth",
    "qualityTier", "customQuality", "selectedOutputKeys", "cropWidthInput", "cropHeightInput"]) {
    context[`set${name[0].toUpperCase()}${name.slice(1)}`] = value => {
      context[name] = value;
      if (name === "profileId") context.activeProfileId = value;
    };
  }
  context.setOptimizationMode = value => { context.optimizationMode = value; };
  context.setBatchItems = update => { context.batchItems = typeof update === "function" ? update(context.batchItems) : update; };
  Object.defineProperty(context, "currentLimit", { get() {
    const active = context.currentBatchSnapshot();
    const activeWidth = active ? context.cropAvailableWidth(active) : 1;
    return context.currentCropLimit(context.batchItems ?? [], context.activeItemId, activeWidth);
  }});
  const make = (name, width) => context.createBatchItem(new File([name], name),
    { width, height: 2000, previewUrl: name });
  const first = make("one.png", 4000), second = make("two.png", 1180);
  const committed = resultFixture();
  first.result = committed;
  context.batchItems = [first, second];
  context.hydrateBatchItem(first);
  const rect = width => ({ x: 100, y: 100, width, height: 500 });
  const draft = next => context.updateDraftCrop(cropSettingsFromRect(next, 4000, 2000, null));
  for (const width of [914, 860, 752, 680, 615, 2559, 2560, 3000]) {
    const savedWidth = context.customWidth;
    draft(rect(width));
    assert.equal(context.customWidth, savedWidth, "draft-only crop does not change the saved target");
    context.applyCrop();
    const sharedMax = Math.min(width, 1180, 2560);
    assert.equal(context.customWidth, String(sharedMax));
    assert.equal(context.effectiveCropMaximum(Math.min(calculateCropRect(4000, 2000, context.draftCrop).width, 1180)), Number(context.customWidth));
    assert.equal(calculateCropRect(4000, 2000, context.draftCrop).width, width, "export cap must not change crop geometry");
    assert.equal(context.result, committed);
    assert.equal(context.batchItems[0].result, committed);
    if (width === 914 || width === 860) {
      const profiles = getAvailableImageProfiles(width);
      assert.ok(profiles.some(profile => profile.id === "768-1024"));
      assert.ok(profiles.some(profile => profile.id === "480-640"));
      assert.deepEqual(buildTargetWidths(width, profiles.find(profile => profile.id === "768-1024")), [768]);
    }
  }
  context.activeProfileId = "480-640";
  context.profileId = "480-640";
  draft(rect(914));
  context.applyCrop();
  assert.equal(context.profileId, "480-640", "crop sync preserves the selected standard card");
  assert.equal(context.customWidth, "914", "custom maximum remains independent of the standard card");
  draft(rect(860));
  assert.equal(context.customWidth, "914", "draft is separate from applied export settings");
  context.applyCrop();
  assert.equal(context.customWidth, "860");
  draft(rect(752));
  assert.ok(getAvailableImageProfiles(752).some(profile => profile.id === "480-640"));
  assert.equal(context.customWidth, "860", "target remains saved until Apply");
  context.applyCrop();
  assert.equal(context.customWidth, "752", "preset availability must not replace saved custom maximum");
  context.chooseCustomWidth("700");
  assert.equal(context.profileId, "custom", "editing the visible custom input selects its existing target model");
  assert.equal(context.customWidth, "700");
  draft({ ...rect(752), x: 200 });
  assert.equal(context.customWidth, "700", "move preserves manual width");
  draft({ ...rect(752), x: 200, height: 400 });
  assert.equal(context.customWidth, "700", "height-only resize preserves manual width");
  context.applyCrop();
  assert.equal(context.customWidth, "700", "Apply preserves manual width");
  context.chooseCustomWidth("753");
  assert.equal(context.customWidth, "753", "invalid draft is allowed while typing");
  context.finishCustomWidthInput();
  assert.equal(context.customWidth, "700", "blur restores the last valid manual width");
  draft(rect(690));
  assert.equal(context.customWidth, "700");
  context.applyCrop();
  assert.equal(context.customWidth, "690");
  for (const handle of ["nw", "ne", "sw", "se", "w", "e", "n", "s", null]) {
    draft(rect(752)); context.applyCrop(); context.chooseCustomWidth("700");
    const start = { pointerId: 1, startClientX: 0, startClientY: 0, rect: rect(752) };
    context.cropResizeRef = { current: handle ? { ...start, handle } : null };
    context.cropDragRef = { current: handle ? null : start };
    context.handleCropPointerMove({ pointerId: 1, clientX: 10, clientY: 10,
      currentTarget: { getBoundingClientRect: () => ({ width: 4000, height: 2000 }) } });
    const width = calculateCropRect(4000, 2000, context.draftCrop).width;
    assert.equal(context.customWidth, "700", "pointer draft does not change export target");
    context.applyCrop();
    assert.equal(context.customWidth, handle === null || handle === "n" || handle === "s" ? "700"
      : String(context.effectiveCropMaximum(width)), handle);
  }
  draft(rect(752)); context.applyCrop(); context.chooseCustomWidth("700");
  context.switchBatchItem(second.id);
  assert.equal(context.currentLimit, 752, "switching active photo does not raise the shared crop limit");
  context.chooseCustomWidth("650");
  assert.equal(context.customWidth, "650");
  context.switchBatchItem(first.id);
  assert.equal(context.customWidth, "700");
  assert.equal(context.result, committed);
  context.switchBatchItem(second.id);
  assert.equal(context.customWidth, "650");
  const ratioItem = context.currentBatchSnapshot();
  const sameWidth = context.applyCropRatioToBatchItem(ratioItem, 1);
  assert.equal(sameWidth.customWidth, "650", "ratio preserving width preserves manual value");
  const narrower = context.applyCropRatioToBatchItem({ ...ratioItem, customWidth: "900" }, 1 / 2);
  assert.equal(narrower.customWidth, "1000", "ratio width change synchronizes maximum");
  assert.equal(narrower.customWidthAuto, true);
  assert.match(componentSource, /const currentLimit = currentCropLimit\(batchItems, activeItemId, appliedCropWidth, sizeScope\)/);
  assert.match(componentSource, /После кадрирования доступно \{effectiveMaxWidth\}px/);
  assert.match(componentSource, /max=\{effectiveMaxWidth\}/);
});

test("custom width clamps to the shared limit and does not grow when that limit rises", () => {
  const context = productionFunctions(["createBatchItem", "reconcileSizeSettings"], {
    crypto, getAvailableImageProfiles, DEFAULT_ENCODER_QUALITY,
    DEFAULT_CROP: { aspectRatio: null, positionX: 50, positionY: 50 },
  });
  const input = new File(["png"], "one.png");
  let first = context.createBatchItem(input, { width: 474, height: 381, previewUrl: "one" });
  assert.equal(first.profileId, "custom");
  assert.equal(first.customWidth, "474");
  first.draftCrop = cropSettingsFromRect({ x: 0, y: 0, width: 446, height: 381 }, 474, 381, null);
  first = context.reconcileSizeSettings(first, 446);
  assert.equal(first.customWidth, "446");
  first = { ...first, customWidth: "420", customWidthAuto: false };
  assert.equal(context.reconcileSizeSettings(first, 446).customWidth, "420");
  first = { ...first, customWidth: "360" };
  assert.equal(context.reconcileSizeSettings(first, 446).customWidth, "360");
  const second = context.createBatchItem(input, { width: 430, height: 381, previewUrl: "two" });
  assert.equal(second.customWidth, "430");
  assert.equal(context.reconcileSizeSettings(first, 430).customWidth, "360");
  assert.equal(context.reconcileSizeSettings(first, 320).customWidth, "320");
  const large = context.createBatchItem(input, { width: 1100, height: 800, previewUrl: "large" });
  assert.equal(large.customWidth, "1100");
  assert.equal(context.reconcileSizeSettings(large, 474).customWidth, "474");
});

test("custom width is inside the custom selection card, stays visible and keeps its existing state", () => {
  let panel;
  function visit(node) {
    if (ts.isJsxElement(node) && node.openingElement.attributes.properties.some(property =>
      ts.isJsxAttribute(property) && property.name.getText(componentAst) === "className" && property.initializer?.getText(componentAst) === '"custom-size-panel"')) panel = node;
    ts.forEachChild(node, visit);
  }
  visit(componentAst);
  assert.ok(panel);
  let customCard;
  for (let parent = panel.parent; parent; parent = parent.parent) {
    if (ts.isConditionalExpression(parent)) assert.ok(!/activeProfileId\s*===\s*"custom"/.test(parent.condition.getText(componentAst)));
    if (ts.isJsxElement(parent) && parent.openingElement.getText(componentAst).includes("is-custom-profile")) customCard = parent;
  }
  assert.ok(customCard, "width input must belong to the custom profile card, not a separate panel");
  assert.match(customCard.getText(componentAst), /onChange=\{\(\) => chooseSizeProfile\(item\.id\)\}/);
  assert.match(panel.getText(componentAst), /chooseCustomWidth\(event\.target\.value\)/);
  assert.match(panel.getText(componentAst), /Максимум для выбранного кадра/);
  assert.equal((componentSource.match(/className="custom-size-panel"/g) ?? []).length, 1);
  assert.doesNotMatch(componentSource, /`До \$\{effectiveMaxWidth\} px`/);
  assert.match(panel.getText(componentAst), /value=\{customWidth\}/);
  assert.match(panel.getText(componentAst), /max=\{effectiveMaxWidth\}/);
  assert.match(componentSource, /После кадрирования доступно \{effectiveMaxWidth\}px/);
  assert.match(componentSource, /availableProfiles\.map\(\(item\)/);
});

test("crop central guides cross both axes with contrasting edges and cannot intercept handles", async () => {
  const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  // Geometry remains in the original rule; scoped theme overrides only add colors.
  const rule = selector => css.slice(css.indexOf(selector + " {")).split("}")[0];
  const vertical = rule(".crop-center-guide-x");
  const horizontal = rule(".crop-center-guide-y");
  assert.match(vertical, /left: 50%/);
  assert.match(vertical, /height: 100%/);
  assert.match(horizontal, /top: 50%/);
  assert.match(horizontal, /width: 100%/);
  const shared = rule(".crop-center-guides > span");
  assert.match(shared, /background: #F04444/);
  assert.doesNotMatch(shared, /box-shadow|border/);
  assert.match(shared, /pointer-events: none/);
  assert.match(vertical, /width: 1px/);
  assert.match(horizontal, /height: 1px/);
  assert.match(rule(".crop-center-guides"), /inset: 0/);
  assert.match(rule(".crop-center-guides"), /z-index: 2/);
  assert.match(rule(".crop-resize-handle"), /z-index: 3/);
  assert.doesNotMatch(css, /\.crop-grid::(?:before|after)/);
  assert.match(componentSource, /cropEditing && \(cropGuides.x \|\| cropGuides.y\)/);
  assert.match(componentSource, /cropGuides.x \? <span className="crop-center-guide-x"/);
  assert.match(componentSource, /cropGuides.y \? <span className="crop-center-guide-y"/);
  assert.match(rule(".crop-grid"), /pointer-events: none/);
  assert.match(componentSource, /className="crop-grid" aria-hidden="true"/);
  assert.ok(componentSource.includes('data-crop-handle={handle.id}'));
});


test("Optima chrome keeps red guides and crop hit geometry outside its visual overrides", async () => {
  const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  const override = css.split("/* PASS 4: current Image Optimizer chrome;")[1].split("/* Shared help drawer content:")[0];
  assert.ok(override);
  assert.doesNotMatch(override, /crop-center-guide|\.crop-grid/);
  const postcss = (await import("postcss")).default;
  const root = postcss.parse(override.slice(override.indexOf("*/") + 2));
  root.walkRules(rule => {
    assert.ok(rule.selector.startsWith(".release-page"), rule.selector);
    assert.doesNotMatch(rule.selector, /footer|cookie|legal|curve-|service-menu|svg-editor/);
    rule.walkDecls(decl => {
      assert.ok(!decl.prop.startsWith("--"), "Component palettes must inherit V2 root tokens");
      assert.doesNotMatch(decl.value, /#[\da-f]{3,8}\b|\brgba?\(|\bhsla?\(/i, "Components must use semantic colors");
      if (decl.prop === "font-size") assert.doesNotMatch(decl.value, /\b(?:9|10|11)px\b/);
      if (/\b(?:crop-stage|crop-frame|crop-resize-handle|compare)\b/.test(rule.selector)) {
        assert.ok(!["width", "height", "min-width", "min-height", "max-width", "max-height", "left", "top", "right", "bottom", "inset", "transform", "z-index", "padding", "aspect-ratio", "touch-action", "pointer-events"].includes(decl.prop), rule.selector + " " + decl.prop);
      }
    });
  });
  assert.match(css, /\.crop-resize-handle\s*\{[^}]*z-index: 3;[^}]*width: 18px;[^}]*height: 18px;[^}]*transform: translate\(-50%, -50%\);/);
  assert.match(css, /\.crop-center-guides > span\s*\{[^}]*background: #F04444;[^}]*pointer-events: none;/);
});

test("Optimizer visual icons preserve accessible buttons and existing click handlers", () => {
  assert.match(componentSource, /onClick=\{resetImage\}[\s\S]*?aria-label="Удалить активную фотографию из очереди"[\s\S]*?<svg aria-hidden="true"/);
  assert.match(componentSource, /onClick=\{\(\) => removeBatchItem\(item.id\)\}[\s\S]*?<svg aria-hidden="true"/);
  assert.match(componentSource, /<ServiceHelpDrawer open=\{sizeGuideOpen\} onClose=\{\(\) => setSizeGuideOpen\(false\)\}/);
  assert.ok(componentSource.includes('stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"'));
});

test("move smart guides snap independently in visual pixels and release without changing crop dimensions", () => {
  const sourceInfo = { width: 2000, height: 1200 };
  const rect = { x: 400, y: 200, width: 600, height: 400 };
  for (const bounds of [{ width: 500, height: 300 }, { width: 1000, height: 400 }]) {
    const context = productionFunctions(["handleCropPointerMove", "handleCropPointerEnd", "resizedCropSettings"], {
      sourceInfo, resizeCropRect, cropSettingsFromRect,
      cropDragRef: { current: { pointerId: 1, startClientX: 0, startClientY: 0, rect } },
      cropResizeRef: { current: null },
      draftCrop: cropSettingsFromRect(rect, 2000, 1200, null),
      setCropGuides: guides => { context.guides = guides; },
      updateDraftCrop: next => { context.draftCrop = next; },
    });
    const move = (visualX, visualY) => {
      context.handleCropPointerMove({ pointerId: 1,
        clientX: (700 - rect.x) / 2000 * bounds.width + visualX,
        clientY: (400 - rect.y) / 1200 * bounds.height + visualY,
        currentTarget: { getBoundingClientRect: () => bounds } });
      return calculateCropRect(2000, 1200, context.draftCrop);
    };
    for (const [x, y, expectedX, expectedY] of [[8, 8, false, false], [7, 8, true, false], [8, -7, false, true], [0, 0, true, true], [-6, 6, true, true], [-8, 6, false, true], [6, -8, true, false], [20, 20, false, false]]) {
      const actual = move(x, y);
      assert.equal(context.guides.x, expectedX);
      assert.equal(context.guides.y, expectedY);
      assert.equal(actual.width, rect.width);
      assert.equal(actual.height, rect.height);
      if (expectedX) assert.equal(actual.x + actual.width / 2, 1000);
      if (expectedY) assert.equal(actual.y + actual.height / 2, 600);
      if (!expectedX) assert.ok(Math.abs(actual.x - (700 + x * 2000 / bounds.width)) < 1e-8);
      if (!expectedY) assert.ok(Math.abs(actual.y - (400 + y * 1200 / bounds.height)) < 1e-8);
    }
    for (const handle of ["nw", "ne", "sw", "se", "w", "e", "n", "s"]) {
      context.cropResizeRef.current = { ...context.cropDragRef.current, handle };
      move(0, 0);
      assert.equal(context.guides.x, false);
      assert.equal(context.guides.y, false);
    }
    context.cropResizeRef.current = null;
    move(0, 0);
    context.handleCropPointerEnd({ pointerId: 1, currentTarget: { hasPointerCapture: () => false } });
    assert.equal(context.guides.x, false);
    assert.equal(context.guides.y, false);
    assert.equal(context.cropDragRef.current, null);
  }
});

function alphaTileDocument(reads) {
  return { createElement(tag) {
    assert.equal(tag, "canvas");
    const canvas = { width: 0, height: 0 };
    let source, left, top;
    canvas.getContext = () => ({
      clearRect() {},
      drawImage(bitmap, x, y, width, height, dx, dy, dw, dh) {
        assert.deepEqual([dx, dy, dw, dh], [0, 0, width, height]);
        source = bitmap; left = x; top = y;
      },
      getImageData(x, y, width, height) {
        assert.deepEqual([x, y], [0, 0]);
        assert.ok(canvas.width <= 256 && canvas.height <= 256);
        reads.push({ x: left, y: top, width, height });
        const data = new Uint8ClampedArray(width * height * 4);
        for (let row = 0; row < height; row++) for (let column = 0; column < width; column++) {
          data[(row * width + column) * 4 + 3] = source.alphaAt(left + column, top + row);
        }
        return { data };
      },
    });
    return canvas;
  } };
}

test("alpha tiles cover every source pixel, including one transparent edge pixel, independent of format", async () => {
  const width = 513, height = 517;
  for (const transparentPixel of [null, [0, 0], [255, 255], [256, 256], [512, 516]]) {
    const reads = [];
    const context = productionFunctions(["hasTransparency"], {
      document: alphaTileDocument(reads), window: { setTimeout: (fn) => fn() },
    });
    const bitmap = { width, height, alphaAt: (x, y) =>
      transparentPixel && x === transparentPixel[0] && y === transparentPixel[1] ? 254 : 255 };
    assert.equal(await context.hasTransparency(bitmap), transparentPixel !== null);
    if (transparentPixel === null) {
      const coverage = new Uint8Array(width * height);
      for (const tile of reads) for (let y = tile.y; y < tile.y + tile.height; y++) {
        for (let x = tile.x; x < tile.x + tile.width; x++) coverage[y * width + x]++;
      }
      assert.ok(coverage.every((count) => count === 1));
      assert.equal(reads.length, 9);
    } else if (transparentPixel[0] === 0) assert.equal(reads.length, 1);
  }
});

test("acceptFiles scans original decoded pixels before close and keeps format selection independent", async () => {
  const signature = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const transparent = new File([signature], "transparent.png", { type: "image/png" });
  const opaque = new File([signature], "opaque.png", { type: "image/png" });
  const signatureOnly = new File([signature], "image.bin", { type: "application/octet-stream" });
  const mimeOnly = new File(["decoded PNG"], "mime.png", { type: "image/png" });
  const jpeg = new File(["jpeg"], "photo.jpg", { type: "image/jpeg" });
  const fake = new File(["not PNG"], "fake.png", { type: "application/octet-stream" });
  const reads = [], closed = [];
  const context = productionFunctions(["acceptFiles", "createBatchItem", "reconcileSizeSettings", "cropAvailableWidth"], {
    crypto, getAvailableImageProfiles, DEFAULT_ENCODER_QUALITY, MAX_BATCH_FILES, getUploadCandidates, calculateCropRect,
    DEFAULT_CROP: { aspectRatio: null, positionX: 50, positionY: 50 },
    addingFiles: false, batchItems: [], batchAspectRatio: null, activeItemId: null, availableCropWidth: 1,
    currentBatchSnapshot: () => null, isAcceptedFile: file => ["image/png", "image/jpeg"].includes(file.type), isHeicFile: () => false,
    setAddingFiles() {}, setError() {}, previewUrlsRef: { current: new Set() },
    document: alphaTileDocument(reads), window: { setTimeout: (fn) => fn() },
    URL: { createObjectURL: (file) => file.name },
    createImageBitmap: async (file) => ({ width: 474, height: 381,
      alphaAt: (x, y) => file === transparent && x === 473 && y === 380 ? 0 : 255,
      close() { closed.push(file); },
    }),
    setBatchItems: (items) => { context.batchItems = items; },
    hydrateBatchItem: (item) => { context.active = item; },
  });
  await context.acceptFiles([transparent, opaque, signatureOnly, mimeOnly, jpeg, fake]);
  assert.deepEqual(Array.from(context.batchItems, (item) => item.mode),
    ["transparent-png", "photo", "photo", "photo", "photo"]);
  assert.deepEqual(Array.from(context.batchItems, (item) => item.sourceInfo.hasTransparency),
    [true, false, false, false, false]);
  assert.equal(context.active.mode, "transparent-png");
  assert.deepEqual(closed, [transparent, opaque, signatureOnly, mimeOnly, jpeg]);
  assert.equal(reads.length, 20, "each 474x381 decoded original is scanned in four tiles");
});

test("manual crop dimensions preserve fixed ratio, free axes, center and source bounds", () => {
  const context = productionFunctions(["resizeCropRectToDimensions"], {});
  const rect = { x: 600, y: 400, width: 800, height: 450 };
  const fixedWidth = context.resizeCropRectToDimensions(rect, "width", 1600, 2400, 1600, 16 / 9);
  assert.deepEqual({ ...fixedWidth }, { x: 200, y: 175, width: 1600, height: 900 });
  const fixedHeight = context.resizeCropRectToDimensions(rect, "height", 1000, 2400, 1600, 16 / 9);
  assert.deepEqual({ ...fixedHeight }, { x: 111, y: 125, width: 1778, height: 1000 });

  const freeWidth = context.resizeCropRectToDimensions(rect, "width", 1100, 2400, 1600, null);
  assert.equal(freeWidth.width, 1100);
  assert.equal(freeWidth.height, rect.height);
  const freeHeight = context.resizeCropRectToDimensions(rect, "height", 700, 2400, 1600, null);
  assert.equal(freeHeight.width, rect.width);
  assert.equal(freeHeight.height, 700);
  assert.equal(freeWidth.x + freeWidth.width / 2, rect.x + rect.width / 2);
  assert.equal(freeHeight.y + freeHeight.height / 2, rect.y + rect.height / 2);

  const nearEdge = context.resizeCropRectToDimensions({ x: 1900, y: 1350, width: 400, height: 250 },
    "width", 1000, 2400, 1600, null);
  assert.equal(nearEdge.x + nearEdge.width, 2400);
  assert.equal(nearEdge.y + nearEdge.height, 1600);
  const fixedOversize = context.resizeCropRectToDimensions(rect, "width", 4000, 2400, 1600, 16 / 9);
  assert.ok(fixedOversize.width <= 2400 && fixedOversize.height <= 1600);
  assert.ok(Math.abs(fixedOversize.width / fixedOversize.height - 16 / 9) < 0.002);
  assert.ok(Number.isInteger(fixedOversize.width) && Number.isInteger(fixedOversize.height));
  const freeOversize = context.resizeCropRectToDimensions(rect, "height", 2000, 2400, 1600, null);
  assert.equal(freeOversize.width, rect.width);
  assert.equal(freeOversize.height, 1600);
});

test("manual crop input ignores invalid intermediate text and sends valid geometry through updateDraftCrop", () => {
  const sourceInfo = { width: 2400, height: 1600, previewUrl: "blob:original", hasTransparency: false };
  const initialRect = { x: 600, y: 400, width: 800, height: 450 };
  const context = productionFunctions(["handleCropDimensionChange"], {
    sourceInfo,
    draftCropRect: initialRect,
    draftCrop: { aspectRatio: 16 / 9, positionX: 50, positionY: 50 },
    cropSettingsFromRect,
    updateDraftCrop: next => { context.updated = next; },
    setCropWidthInput: value => { context.widthInput = value; },
    setCropHeightInput: value => { context.heightInput = value; },
  });
  for (const invalid of ["", "0", "-2", "2.5", "NaN", "Infinity"]) {
    context.updated = null;
    context.handleCropDimensionChange("width", invalid);
    assert.equal(context.updated, null, invalid);
  }
  context.handleCropDimensionChange("width", "1600");
  assert.ok(context.updated);
  assert.equal(context.updated.aspectRatio, 16 / 9);
  const actual = calculateCropRect(sourceInfo.width, sourceInfo.height, context.updated);
  assert.equal(Math.round(actual.width), 1600);
  assert.equal(Math.round(actual.height), 900);
  context.draftCrop = { aspectRatio: null, positionX: 50, positionY: 50 };
  context.handleCropDimensionChange("height", "700");
  const freeHeight = calculateCropRect(sourceInfo.width, sourceInfo.height, context.updated);
  assert.equal(Math.round(freeHeight.width), initialRect.width);
  assert.equal(Math.round(freeHeight.height), 700);
  assert.match(componentSource, /onBlur=\{\(\) => finishCropDimensionInput\("width"\)\}/);
  assert.match(componentSource, /handleCropDimensionKeyDown/);
  assert.match(componentSource, /const liveCropWidth = draftCropRect \? String\(Math\.round\(draftCropRect\.width\)\)/);
  assert.match(componentSource, /const liveCropHeight = draftCropRect \? String\(Math\.round\(draftCropRect\.height\)\)/);
  assert.match(componentSource, /updateDraftCrop\(cropSettingsFromRect\(rect, sourceInfo\.width, sourceInfo\.height, draftCrop\.aspectRatio\)\)/);
  assert.match(componentSource, /className=\{`crop-stage[\s\S]*sourceInfo\.hasTransparency \? "has-transparency"/);
  assert.match(componentSource, /value=\{cropWidthInput \?\? liveCropWidth\}/);
  assert.match(componentSource, /value=\{cropHeightInput \?\? liveCropHeight\}/);
});

test("manual crop input blur restores canonical dimensions and Enter normalizes the draft", () => {
  const context = productionFunctions(["finishCropDimensionInput", "handleCropDimensionKeyDown"], {
    setCropWidthInput: value => { context.width = value; },
    setCropHeightInput: value => { context.height = value; },
  });
  context.finishCropDimensionInput("width");
  assert.equal(context.width, null, "blur discards empty or invalid width text and renders current crop width");
  context.height = "0060";
  let blurred = false;
  context.handleCropDimensionKeyDown({ key: "Enter", preventDefault() {}, currentTarget: { blur() { blurred = true; } } }, "height");
  assert.equal(context.height, null, "Enter normalizes to the current canonical crop height");
  assert.equal(blurred, true);
});

test("checkerboard is a conditional CSS background behind the crop image surface", async () => {
  const css = readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  assert.match(componentSource, /sourceInfo\.width\}.*sourceInfo\.height.*formatBytes\(file\.size\)/);
  const source = await css;
  assert.match(source, /\.release-page \.optimizer-stage \.crop-stage\.has-transparency\s*\{[^}]*background-color: var\(--ui-surface-1\);[^}]*background-image:[^}]*linear-gradient/s);
  assert.match(source, /\.crop-stage > img\s*\{[^}]*pointer-events: none;/);
  assert.match(source, /\.crop-frame\s*\{\s*position: absolute/);
  assert.match(source, /\.crop-center-guides\s*\{\s*position: absolute/);
});

test("result quality comes from committed variants and ignores pending settings", () => {
  const context = productionFunctions(["committedResultQuality"], {});
  const committed = resultFixture();
  for (const variant of committed.results[0].variants) if (variant.format !== "png") variant.quality = 85;
  context.qualityTier = "q65";
  assert.equal(context.committedResultQuality(committed), 85);
  assert.equal(context.committedResultQuality(null), null);
  const pngOnly = { ...committed, results: [{ ...committed.results[0], variants: committed.results[0].variants.filter((v) => v.format === "png") }] };
  assert.equal(context.committedResultQuality(pngOnly), null);
  assert.match(componentSource, /const resultQuality = committedResultQuality\(result\)/);
  assert.match(componentSource, /sourceInfo\.width\}.*sourceInfo\.height.*formatBytes\(file\.size\)/);
});

test("photo switching restores each pending draft and committed result with selection", () => {
  const context = productionFunctions(["createBatchItem", "currentBatchSnapshot", "hydrateBatchItem", "switchBatchItem", "cropsEqual"], {
    crypto, getAvailableImageProfiles, DEFAULT_ENCODER_QUALITY,
    DEFAULT_CROP: { aspectRatio: null, positionX: 50, positionY: 50 }, working: false,
    setError() {},
  });
  for (const name of ["activeItemId", "file", "sourceInfo", "profileId", "customWidth", "customWidthAuto", "customWidthMax", "draftCrop", "appliedCrop", "cropEditing", "result", "previewFormat", "previewWidth", "qualityTier", "customQuality", "selectedOutputKeys"]) {
    context[`set${name[0].toUpperCase()}${name.slice(1)}`] = (value) => {
      context[name] = value;
      if (name === "profileId") context.activeProfileId = value;
    };
  }
  context.setOptimizationMode = (value) => { context.optimizationMode = value; };
  context.setBatchItems = (update) => { context.batchItems = update(context.batchItems); };
  const first = context.createBatchItem(new File(["1"], "one.png"), { width: 2000, height: 1500, previewUrl: "one" });
  const second = context.createBatchItem(new File(["2"], "two.png"), { width: 1600, height: 1200, previewUrl: "two", isPng: true, hasTransparency: true });
  first.profileId = "768-1024"; first.customWidth = "1024"; first.customQuality = "72";
  first.draftCrop = { aspectRatio: null, positionX: 60, positionY: 40, size: { width: .39, height: .4 } };
  first.appliedCrop = { aspectRatio: 3 / 2, positionX: 50, positionY: 50, size: { width: .45, height: .4 } };
  first.result = resultFixture(); first.selectedOutputKeys = defaultOutputSelection(first.result);
  first.cropEditing = true;
  second.profileId = "480-640"; second.customWidth = "640"; second.qualityTier = "q65";
  second.mode = "transparent-png"; second.customQuality = "67"; second.result = resultFixture();
  second.cropEditing = false;
  context.batchItems = [first, second];
  context.hydrateBatchItem(first);
  context.switchBatchItem(second.id);
  assert.equal(context.profileId, "480-640");
  assert.equal(context.qualityTier, "q65");
  assert.equal(context.optimizationMode, "transparent-png");
  assert.equal(context.result, second.result);
  assert.equal(context.cropEditing, false);
  context.switchBatchItem(first.id);
  assert.equal(context.profileId, "768-1024");
  assert.equal(context.customWidth, "1024");
  assert.equal(context.qualityTier, "q85");
  assert.equal(context.customQuality, "72");
  assert.equal(context.optimizationMode, "photo");
  assert.equal(context.draftCrop.positionX, 60);
  assert.equal(context.draftCrop.aspectRatio, null);
  assert.equal(context.draftCrop.size.width, .39);
  assert.equal(context.appliedCrop.aspectRatio, 3 / 2);
  assert.equal(context.cropEditing, true);
  assert.equal(context.result, first.result);
  assert.deepEqual(Array.from(context.selectedOutputKeys), first.selectedOutputKeys);
});

test("1024x683 filenames use actual output quality and no fictitious PNG quality", () => {
  assert.equal(createVariantFileName(1024, 683, "avif", 80), "img-1024x683-q80.avif");
  assert.equal(createVariantFileName(1024, 683, "webp", 80), "img-1024x683-q80.webp");
  assert.equal(createVariantFileName(1024, 683, "png", null), "img-1024x683.png");
  assert.equal(createVariantFileName(459, 381, "png", null), "img-459x381.png");
});

test("unchanged PNG chooses the smaller Blob without Canvas and keeps the generated filename", async () => {
  const source = await readFile(optimizerUrl, "utf8");
  const ast = ts.createSourceFile("image-optimizer.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const original = new File([new Uint8Array(100)], "private-original-name.png", { type: "image/png" });
  for (const bytes of [90, 100, 110]) {
    const encoded = new Blob([new Uint8Array(bytes)], { type: "image/png" });
    const context = productionFunctions(["encodeVariant"], {
      encodePng: async (data) => { assert.equal(data.byteLength, original.size); return encoded; },
      encodeCanvas: () => { assert.fail("unchanged PNG must not encode Canvas"); },
      measureSimilarity: () => { assert.fail("unchanged PNG must not rasterize for similarity"); },
      MIME: { png: "image/png" }, EXTENSION: { png: "png" }, createVariantFileName,
    }, ast);
    const output = await context.encodeVariant({ width: 459, height: 381 }, "png", null, original);
    assert.equal(output.blob, bytes < original.size ? encoded : original);
    assert.ok(output.size <= original.size);
    assert.equal(output.fileName, "img-459x381.png");
    assert.notEqual(output.fileName, original.name);
  }
});

// Deliberately non-streaming oracle: independently evaluates the complete
// separable filter and then scans each source footprint for anti-ringing.
function referenceGraphicsResize(source, crop, width) {
  const { height } = calculateOutputDimensions(crop, width);
  const kernel = z => Math.abs(z) < 1e-8 ? 1 : Math.abs(z) >= 3 ? 0
    : Math.sin(Math.PI * z) / (Math.PI * z) * Math.sin(Math.PI * z / 3) / (Math.PI * z / 3);
  const weights = (start, size, count, limit) => Array.from({ length: count }, (_, n) => {
    const scale = size / count, center = start + (n + 0.5) * scale - 0.5;
    const taps = [];
    let total = 0;
    for (let i = Math.ceil(center - scale * 3); i <= Math.floor(center + scale * 3); i++) {
      const weight = kernel((i - center) / scale);
      taps.push([Math.max(0, Math.min(limit - 1, i)), weight]); total += weight;
    }
    return taps.map(([index, weight]) => [index, weight / total]);
  });
  const wx = weights(crop.x, crop.width, width, source.width);
  const wy = weights(crop.y, crop.height, height, source.height);
  const intermediate = new Float32Array(width * source.height * 4);
  for (let y = 0; y < source.height; y++) for (let x = 0; x < width; x++) {
    const sum = [0, 0, 0, 0];
    for (const [sx, weight] of wx[x]) {
      const p = (y * source.width + sx) * 4, aw = source.data[p + 3] / 255 * weight;
      for (let c = 0; c < 3; c++) sum[c] += source.data[p + c] * aw;
      sum[3] += aw;
    }
    intermediate.set(sum, (y * width + x) * 4);
  }
  const out = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const sum = [0, 0, 0, 0], p = (y * width + x) * 4;
    for (const [sy, weight] of wy[y]) for (let c = 0; c < 4; c++) sum[c] += intermediate[(sy * width + x) * 4 + c] * weight;
    const alpha = Math.max(0, Math.min(1, sum[3]));
    out[p + 3] = Math.round(alpha * 255);
    for (let c = 0; c < 3; c++) out[p + c] = out[p + 3] === 0 ? 0 : Math.round(Math.max(0, Math.min(255 * alpha, sum[c])) / alpha);
    const min = [255, 255, 255, 255], max = [0, 0, 0, 0];
    for (let sy = Math.max(0, Math.floor(crop.y + y * crop.height / height)); sy < Math.min(source.height, Math.ceil(crop.y + (y + 1) * crop.height / height)); sy++) {
      for (let sx = Math.max(0, Math.floor(crop.x + x * crop.width / width)); sx < Math.min(source.width, Math.ceil(crop.x + (x + 1) * crop.width / width)); sx++) {
        const i = (sy * source.width + sx) * 4;
        for (let c = 0; c < 4; c++) if (c === 3 || source.data[i + 3] > 0) {
          min[c] = Math.min(min[c], source.data[i + c]); max[c] = Math.max(max[c], source.data[i + c]);
        }
      }
    }
    for (let c = 0; c < 4; c++) out[p + c] = Math.max(min[c], Math.min(max[c], out[p + c]));
    if (out[p + 3] === 0) out.fill(0, p, p + 3);
  }
  return out;
}

const optimizerSource = await readFile(optimizerUrl, "utf8");
const optimizerAst = ts.createSourceFile("image-optimizer.ts", optimizerSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

test("Photo encodes only AVIF and WebP; Screenshot keeps PNG and transparent-PNG stays separate", async () => {
  const opaquePixels = Buffer.alloc(120 * 90 * 4, 255);
  const opaquePng = new File([await sharp(opaquePixels, { raw: { width: 120, height: 90, channels: 4 } }).png().toBuffer()],
    "opaque.png", { type: "image/png" });
  const pngEncoderCalls = [];
  const encodedFormats = [];
  const qualities = [];
  const prepared = { originalWidth: 120, originalHeight: 90, outputs: [{ width: 64, height: 48, blob: new Blob(["prepared PNG"], { type: "image/png" }), fileName: "img-64x48.png" }] };
  const context = productionFunctions(["optimizeImage", "encodeVariant"], {
    createSourceBitmap: async file => {
      assert.equal(file, opaquePng);
      return { width: 120, height: 90, close() {} };
    },
    calculateCropRect, calculateOutputDimensions, buildTargetWidths,
    createResizedCanvas: (_bitmap, crop, width) => ({ width, height: calculateOutputDimensions(crop, width).height }),
    hasOriginalPngDimensions: async () => false,
    resizeGraphicsPng: async (_bitmap, crop, width) => ({ width, height: calculateOutputDimensions(crop, width).height }),
    encodePng: async input => {
      pngEncoderCalls.push(input);
      return new Blob(["PNG output"], { type: "image/png" });
    },
    encodeCanvas: async (_canvas, format, quality) => {
      encodedFormats.push(format);
      qualities.push(quality);
      return new Blob([format], { type: `image/${format}` });
    },
    measureSimilarity: async () => ({ score: 0.99, method: "ssim" }),
    MIME: { avif: "image/avif", webp: "image/webp", png: "image/png" },
    EXTENSION: { avif: "avif", webp: "webp", png: "png" },
    createVariantFileName,
    prepareTransparentPng: async () => prepared,
    window: { setTimeout(resolve) { resolve(); } },
  }, optimizerAst);
  const crop = { aspectRatio: null, positionX: 50, positionY: 50 };
  const photoResults = [];
  for (const quality of [65, 80, 85, 72]) {
    const result = await context.optimizeImage({ file: opaquePng, profile: createCustomProfile(64, 120), crop, mode: "photo", quality });
    photoResults.push(result);
    assert.equal(result.originalSize, opaquePng.size, "result source size is the original PNG File.size");
    assert.deepEqual(Array.from(result.results[0].variants, variant => variant.format), ["avif", "webp"]);
    assert.deepEqual(Array.from(result.results[0].variants, variant => variant.quality), [quality, quality]);
    assert.deepEqual(defaultOutputSelection(result), [outputSelectionKey(64, 48, result.results[0].variants[0])]);
    assert.deepEqual(Array.from(selectedResultOutputs(result, Array.from(result.results[0].variants,
      variant => outputSelectionKey(64, 48, variant))), output => output.variant.format), ["avif", "webp"]);
  }
  assert.deepEqual(encodedFormats, ["avif", "webp", "avif", "webp", "avif", "webp", "avif", "webp"]);
  assert.deepEqual(qualities, [65, 65, 80, 80, 85, 85, 72, 72]);
  assert.equal(pngEncoderCalls.length, 0, "Photo must never call the PNG/OxiPNG encoder");

  const screenshot = await context.optimizeImage({ file: opaquePng, profile: createCustomProfile(64, 120), crop, mode: "screenshot", quality: 80 });
  assert.deepEqual(Array.from(screenshot.results[0].variants, variant => variant.format), ["avif", "webp", "png"]);
  assert.equal(pngEncoderCalls.length, 1, "Screenshot retains its current PNG encoder path");
  assert.equal(Array.from(screenshot.results[0].variants).find(variant => variant.format === "png").quality, null);

  const transparent = await context.optimizeImage({ file: opaquePng, profile: createCustomProfile(64, 120), crop,
    mode: "transparent-png", quality: NaN, prepared });
  assert.deepEqual(Array.from(transparent.results[0].variants, variant => variant.format), ["png"]);
  assert.equal(pngEncoderCalls.length, 2, "transparent-PNG keeps its existing separate optimization flow");
  assert.equal(photoResults.every(result => result.mode === "photo"), true);
});

function graphicsResizerHarness() {
  const reads = [], canvases = [];
  let yields = 0;
  class TestImageData {
    constructor(data, width, height) { Object.assign(this, { data, width, height }); }
  }
  class TileCanvas {
    width = 0; height = 0; data;
    getContext() {
      return {
        drawImage: (source, sx, sy, sw, sh, dx, dy, dw, dh) => {
          assert.deepEqual([dx, dy, dw, dh], [0, 0, sw, sh], "source reads must be 1:1");
          this.data = new Uint8ClampedArray(sw * sh * 4);
          for (let y = 0; y < sh; y++) {
            const from = ((sy + y) * source.width + sx) * 4;
            this.data.set(source.data.subarray(from, from + sw * 4), y * sw * 4);
          }
          reads.push([sx, sy, sw, sh]);
        },
        getImageData: () => new TestImageData(this.data, this.width, this.height),
      };
    }
  }
  const ast = ts.createSourceFile("image-optimizer.ts", optimizerSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let clock = 0;
  const context = productionFunctions(["lanczos3", "resizeGraphicsPng"], {
    calculateOutputDimensions, ImageData: TestImageData,
    performance: { now: () => (clock += 0.02) },
    window: { setTimeout(resolve) { yields++; setTimeout(resolve, 0); } },
    document: { createElement() { const canvas = new TileCanvas(); canvases.push(canvas); return canvas; } },
  }, ast);
  return { resize: context.resizeGraphicsPng, reads, canvases, get yields() { return yields; } };
}

test("PNG Lanczos3 matches independent reference across fractional crop and tile/strip boundaries", async () => {
  const source = { width: 2077, height: 650, data: new Uint8ClampedArray(2077 * 650 * 4) };
  for (let y = 0; y < source.height; y++) for (let x = 0; x < source.width; x++) {
    const p = (y * source.width + x) * 4;
    // Text-like bars, thin diagonals, diamonds and isolated high-contrast edges.
    const shape = x % 91 < 4 || y % 73 < 3 || (x + y) % 113 < 5 || Math.abs(x % 80 - 40) + Math.abs(y % 80 - 40) < 20;
    source.data.set([shape ? 64 : 192, shape ? 192 : 64, 90, 255], p);
  }
  const harness = graphicsResizerHarness();
  for (const crop of [{ x: 0, y: 0, width: 2077, height: 650 }, { x: 7.25, y: 3.75, width: 2057.5, height: 641.25 }]) {
    const actual = await harness.resize(source, crop, 350);
    assert.equal(actual.width, 350);
    assert.equal(actual.height, calculateOutputDimensions(crop, 350).height);
    if (crop.x === 0) assert.equal(actual.height, 110);
    assert.deepEqual(Buffer.from(actual.data), Buffer.from(referenceGraphicsResize(source, crop, 350)));
    for (let i = 0; i < actual.data.length; i += 4) {
      assert.ok(actual.data[i] >= 64 && actual.data[i] <= 192, "local edge must not overshoot");
      assert.equal(actual.data[i + 3], 255);
    }
  }
  assert.ok(harness.reads.every(([, , w, h]) => w <= 1024 && h <= 64));
  assert.ok(harness.reads.some(([x]) => x === 1024));
  assert.ok(harness.reads.some(([, y]) => y === 64));
  assert.ok(harness.canvases.every(canvas => canvas.width === 0 && canvas.height === 0));
  assert.ok(harness.yields > 0, "substantial chunks must yield to the event loop");
  await assert.rejects(harness.resize(source, { x: 0, y: 0, width: 350, height: 110 }, 351));
  await assert.rejects(harness.resize(source, { x: 0, y: 0, width: 2077, height: 650 }, 2077));
});

test("PNG Lanczos3 alpha is deterministic and independent of black/white hidden RGB", async () => {
  const source = { width: 128, height: 96, data: new Uint8ClampedArray(128 * 96 * 4) };
  for (let y = 0; y < 96; y++) for (let x = 0; x < 128; x++) {
    const a = Math.max(0, Math.min(255, Math.round((32 - Math.hypot(x - 64, y - 48)) * 32)));
    source.data.set([200, 70, 150, a], (y * 128 + x) * 4);
  }
  const crop = { x: 0, y: 0, width: 128, height: 96 };
  const harness = graphicsResizerHarness();
  const outputs = [];
  for (const hidden of [0, 255, 0]) {
    for (let i = 0; i < source.data.length; i += 4) if (source.data[i + 3] === 0) source.data.fill(hidden, i, i + 3);
    const actual = await harness.resize(source, crop, 32);
    assert.deepEqual(Buffer.from(actual.data), Buffer.from(referenceGraphicsResize(source, crop, 32)));
    outputs.push(Buffer.from(actual.data));
    const alphas = [];
    for (let i = 0; i < actual.data.length; i += 4) {
      alphas.push(actual.data[i + 3]);
      assert.deepEqual([...actual.data.slice(i, i + 3)], actual.data[i + 3] === 0 ? [0, 0, 0] : [200, 70, 150]);
    }
    assert.ok(alphas.includes(0) && alphas.includes(255) && alphas.some(a => a > 0 && a < 255));
  }
  assert.deepEqual(outputs[0], outputs[1]); assert.deepEqual(outputs[0], outputs[2]);
});

test("real OxiPNG output preserves RGBA for unchanged, cropped/resized and opaque PNG", async (t) => {
  // Node has no HTMLCanvasElement. The adapter rasterizes drawImage and uses
  // installed sharp for decoding/WebP. Production PNG uses the actual OxiPNG
  // WASM, never the adapter's PNG encoder. This is not native browser Canvas.
  const avif = await import("@jsquash/avif/encode.js");
  await avif.init({ wasmBinary: await readFile(new URL("../node_modules/@jsquash/avif/codec/enc/avif_enc.wasm", import.meta.url)) });
  const oxipng = await import("@jsquash/oxipng/optimise.js");
  await oxipng.init(await readFile(new URL("../node_modules/@jsquash/oxipng/codec/pkg/squoosh_oxipng_bg.wasm", import.meta.url)));
  const rgba = Buffer.alloc(120 * 90 * 4);
  for (let y = 30; y < 60; y++) for (let x = 40; x < 80; x++) {
    const offset = (y * 120 + x) * 4;
    rgba[offset] = 200; rgba[offset + 3] = 255;
  }
  for (let y = 25; y < 65; y++) rgba.set([64, 192, 90, 127], (y * 120 + y + 18) * 4);
  const input = new File([await sharp(rgba, { raw: { width: 120, height: 90, channels: 4 } }).png().toBuffer()], "transparent.png", { type: "image/png" });
  const calls = [];
  const pixelReads = [];
  const rasters = [];
  class CanvasAdapter {
    width = 0;
    height = 0;
    data;
    getContext() {
      return {
        drawImage: (source, ...args) => {
          const [sx, sy, sw, sh] = args.length === 8 ? args : [0, 0, source.width, source.height];
          this.data = new Uint8ClampedArray(this.width * this.height * 4);
          for (let y = 0; y < this.height; y++) for (let x = 0; x < this.width; x++) {
            const from = (Math.floor(sy + (y + 0.5) * sh / this.height) * source.width + Math.floor(sx + (x + 0.5) * sw / this.width)) * 4;
            this.data.set(source.data.subarray(from, from + 4), (y * this.width + x) * 4);
          }
          rasters.push(this);
        },
        getImageData: () => {
          pixelReads.push({ width: this.width, height: this.height });
          return new ImageData(this.data, this.width, this.height);
        },
      };
    }
    toBlob(callback, type, quality) {
      calls.push({ type, quality });
      assert.notEqual(type, "image/png", "PNG must use OxiPNG, not canvas.toBlob");
      let pipeline = sharp(this.data, { raw: { width: this.width, height: this.height, channels: 4 } });
      pipeline = type === "image/png" ? pipeline.png() : pipeline.webp({ quality: Math.round(quality * 100) });
      pipeline.toBuffer().then((buffer) => callback(new Blob([buffer], { type })), () => callback(null));
    }
  }
  const saved = Object.fromEntries(["document", "window", "createImageBitmap"].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  try {
    globalThis.document = { createElement(tag) { assert.equal(tag, "canvas"); return new CanvasAdapter(); } };
    globalThis.window = { setTimeout };
    globalThis.createImageBitmap = async (blob) => {
      const { data, info } = await sharp(Buffer.from(await blob.arrayBuffer())).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      return { data: new Uint8ClampedArray(data), width: info.width, height: info.height, close() {} };
    };
    const crop = cropSettingsFromRect({ x: 20, y: 15, width: 80, height: 60 }, 120, 90, 4 / 3);
    const runs = [["photo", 65], ["photo", 80], ["photo", 85], ["photo", 72], ["screenshot", 80]];
    for (const [mode, quality] of runs) {
      rasters.length = 0;
      const result = await optimizeImage({ file: input, profile: createCustomProfile(40, 80), crop, mode, quality });
      const output = result.results[0];
      assert.deepEqual([output.width, output.height], [40, 30]);
      assert.deepEqual(output.variants.map((v) => [v.format, v.quality]), mode === "photo"
        ? [["avif", quality], ["webp", quality]]
        : [["avif", quality], ["webp", quality], ["png", null]]);
      if (mode === "photo") {
        assert.equal(output.variants.some(variant => variant.format === "png"), false);
        continue;
      }
      const png = output.variants.find((v) => v.format === "png");
      assert.notEqual(png.blob, input, "transformed output must not fall back to original File");
      assert.equal(png.blob.type, "image/png");
      assert.equal(png.fileName, "img-40x30.png");
      const { data, info } = await sharp(Buffer.from(await png.blob.arrayBuffer())).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      assert.deepEqual([info.width, info.height, info.channels], [40, 30, 4]);
      assert.equal(data[3], 0);
      assert.equal(data[(15 * 40 + 20) * 4 + 3], 255);
      const reference = rasters.find((canvas) => canvas.width === 40 && canvas.height === 30);
      const expected = referenceGraphicsResize({ data: rgba, width: 120, height: 90 }, calculateCropRect(120, 90, crop), 40);
      assert.deepEqual(data, Buffer.from(expected), "Screenshot PNG uses Lanczos pixels and lossless encoding");
      assert.notDeepEqual(data, Buffer.from(reference.data), "graphics PNG must bypass old Canvas pixels");
      t.diagnostic(`${mode} Q${quality}: decoded output PNG Blob 40x30; alpha(0,0)=${data[3]}, alpha(20,15)=255`);
    }
    assert.equal(calls.filter((call) => call.type === "image/png").length, 0);
    assert.deepEqual(calls.filter((call) => call.type === "image/webp").map((call) => call.quality), runs.map(([, quality]) => quality / 100));

    rasters.length = 0;
    const prepared = await prepareTransparentPng({ file: input, profile: createCustomProfile(40, 80), crop });
    const preparedReads = rasters.length;
    const pngOnly = await optimizeImage({ file: input, profile: createCustomProfile(40, 80), crop,
      mode: "transparent-png", quality: NaN, prepared });
    assert.equal(rasters.length, preparedReads, "optimizing prepared PNG must not decode/resize again");
    assert.deepEqual(pngOnly.results[0].variants.map(v => [v.format, v.quality]), [["png", null]]);
    for (const blob of [prepared.outputs[0].blob, pngOnly.results[0].variants[0].blob]) {
      const decoded = await sharp(Buffer.from(await blob.arrayBuffer())).ensureAlpha().raw().toBuffer();
      assert.deepEqual(decoded, Buffer.from(referenceGraphicsResize({ data: rgba, width: 120, height: 90 }, calculateCropRect(120, 90, crop), 40)));
    }
    assert.equal(calls.filter(call => call.type === "image/webp").length, runs.length, "PNG-only must never invoke WebP");

    const fullCrop = { aspectRatio: null, positionX: 50, positionY: 50 };
    // Width > 420 distinguishes full-size encoder reads from metric thumbnails.
    const fullRgba = Buffer.alloc(459 * 381 * 4);
    for (let i = 0; i < fullRgba.length; i += 4) {
      fullRgba[i] = (i / 4) % 256;
      fullRgba[i + 1] = 73;
      fullRgba[i + 2] = 191;
      fullRgba[i + 3] = (i / 4) % 3 === 0 ? 0 : (i / 4) % 3 === 1 ? 127 : 255;
    }
    const fullInput = new File([await sharp(fullRgba, { raw: { width: 459, height: 381, channels: 4 } }).png().toBuffer()], "do-not-download-this-name.png", { type: "image/png" });
    pixelReads.length = 0;
    const unchanged = await optimizeImage({ file: fullInput, profile: createCustomProfile(459, 459), crop: fullCrop, mode: "screenshot" });
    const unchangedPng = unchanged.results[0].variants.find((v) => v.format === "png");
    assert.ok(unchangedPng.size <= fullInput.size);
    assert.equal(unchangedPng.fileName, "img-459x381.png");
    const decoded = await sharp(Buffer.from(await unchangedPng.blob.arrayBuffer())).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    assert.deepEqual([decoded.info.width, decoded.info.height], [459, 381]);
    assert.deepEqual(decoded.data, fullRgba);
    assert.equal(pixelReads.filter((read) => read.width === 459 && read.height === 381).length, 1,
      "only AVIF reads full-resolution Canvas pixels; unchanged PNG bypasses Canvas");

    const fullPrepared = await prepareTransparentPng({ file: fullInput, profile: createCustomProfile(459, 459), crop: fullCrop });
    const unchangedPngOnly = await optimizeImage({ file: fullInput, profile: createCustomProfile(459, 459), crop: fullCrop,
      mode: "transparent-png", quality: NaN, prepared: fullPrepared });
    for (const blob of [fullPrepared.outputs[0].blob, unchangedPngOnly.results[0].variants[0].blob]) {
      const pixels = await sharp(Buffer.from(await blob.arrayBuffer())).ensureAlpha().raw().toBuffer();
      assert.deepEqual(pixels, fullRgba, "unchanged PNG mode uses the same single target raster for both files");
    }

    const opaqueRgba = Buffer.alloc(120 * 90 * 4, 255);
    const opaqueInput = new File([await sharp(opaqueRgba, { raw: { width: 120, height: 90, channels: 4 } }).png().toBuffer()], "opaque.png", { type: "image/png" });
    const opaque = await optimizeImage({ file: opaqueInput, profile: createCustomProfile(60, 120), crop: fullCrop, mode: "screenshot" });
    const opaquePng = opaque.results[0].variants.find((v) => v.format === "png");
    const opaqueDecoded = await sharp(Buffer.from(await opaquePng.blob.arrayBuffer())).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    assert.deepEqual([opaqueDecoded.info.width, opaqueDecoded.info.height], [60, 45]);
    assert.ok(opaqueDecoded.data.every((byte) => byte === 255));
    assert.notEqual(opaquePng.blob, opaqueInput);
  } finally {
    for (const [key, descriptor] of Object.entries(saved)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
});
