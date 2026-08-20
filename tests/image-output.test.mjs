import assert from "node:assert/strict";
import test from "node:test";

import {
  AVIF_QUALITY_RANGE,
  archiveFileSelectionKey,
  calculateCropRect,
  createCustomProfile,
  createManifest,
  createPictureMarkup,
  getAvailableImageProfiles,
  IMAGE_PROFILES,
  qualityTiers,
  selectArchiveFiles,
  selectResultWidth,
  WEBP_QUALITY_RANGE,
  SCREENSHOT_AVIF_QUALITY_RANGE,
  SCREENSHOT_WEBP_QUALITY_RANGE,
} from "../app/lib/image-optimizer.ts";

function resultFixture() {
  const webp = {
    format: "webp",
    mime: "image/webp",
    extension: "webp",
    blob: new Blob(["webp"], { type: "image/webp" }),
    size: 4,
    quality: 82,
    tier: "recommended",
    similarity: 0.99,
    similarityMethod: "ssim",
    fileName: "photo-600.webp",
  };
  const avif = {
    ...webp,
    format: "avif",
    mime: "image/avif",
    extension: "avif",
    fileName: "photo-600.avif",
  };
  const variants = [
    avif,
    webp,
    {
      ...avif,
      tier: "lighter",
      quality: 76,
      size: 3,
      fileName: "photo-600-light.avif",
    },
    {
      ...webp,
      tier: "lighter",
      quality: 76,
      size: 3,
      fileName: "photo-600-light.webp",
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
    threshold: 0.98,
    results: [{
      width: 600,
      height: 360,
      variants,
      recommended: variants[0],
    }],
    warnings: [],
  };
}

test("picture output contains only AVIF and WebP", () => {
  const markup = createPictureMarkup(resultFixture());
  assert.match(markup, /image\/avif/);
  assert.match(markup, /image\/webp/);
  assert.equal((markup.match(/<source[^>]+sizes=/g) ?? []).length, 2);
  assert.doesNotMatch(markup, /jpe?g/i);
});

test("picture output follows the selected quality tier", () => {
  const markup = createPictureMarkup(resultFixture(), {
    avif: "lighter",
    webp: "lighter",
  });
  assert.match(markup, /photo-600-light\.avif/);
  assert.match(markup, /photo-600-light\.webp/);
});

test("screenshot output keeps a lossless PNG fallback next to WebP", () => {
  const fixture = resultFixture();
  const webp = fixture.results[0].variants.find(
    (variant) => variant.format === "webp" && variant.tier === "recommended",
  );
  const png = {
    ...webp,
    format: "png",
    mime: "image/png",
    extension: "png",
    quality: 100,
    fileName: "screen-600.png",
  };
  const screenshot = {
    ...fixture,
    mode: "screenshot",
    results: [{
      ...fixture.results[0],
      variants: [png, webp],
      recommended: png,
    }],
  };
  const markup = createPictureMarkup(screenshot);

  assert.match(markup, /image\/webp/);
  assert.match(markup, /<img src="screen-600\.png"/);
});

test("a package can keep only one selected output width", () => {
  const fixture = resultFixture();
  const secondWidth = {
    ...fixture.results[0],
    width: 800,
    height: 480,
    variants: fixture.results[0].variants.map((variant) => ({
      ...variant,
      fileName: variant.fileName.replace("600", "800"),
    })),
  };
  const selected = selectResultWidth(
    { ...fixture, results: [...fixture.results, secondWidth] },
    800,
  );

  assert.deepEqual(selected.profile.widths, [800]);
  assert.equal(selected.profile.sizes, "800px");
  assert.deepEqual(selected.results.map((item) => item.width), [800]);
  assert.match(createPictureMarkup(selected), /800w/);
  assert.doesNotMatch(createPictureMarkup(selected), /600w/);
});

test("direct downloads keep only checked formats and sizes", () => {
  const fixture = resultFixture();
  const secondWidth = {
    ...fixture.results[0],
    width: 800,
    height: 480,
    variants: fixture.results[0].variants.map((variant) => ({
      ...variant,
      fileName: variant.fileName.replace("600", "800"),
    })),
  };
  const selected = selectArchiveFiles(
    { ...fixture, results: [...fixture.results, secondWidth] },
    [
      archiveFileSelectionKey("avif", 600),
      archiveFileSelectionKey("webp", 800),
    ],
  );

  assert.deepEqual(selected.results.map((item) => item.width), [600, 800]);
  assert.deepEqual(
    selected.results.map((item) => item.variants.map((variant) => variant.format)),
    [["avif"], ["webp"]],
  );
  const markup = createPictureMarkup(selected);
  assert.match(markup, /photo-600\.avif 600w/);
  assert.match(markup, /photo-800\.webp 800w/);
  assert.doesNotMatch(markup, /photo-600\.webp|photo-800\.avif/);
});

test("WebP choices span the safer Q60 to Q85 range", () => {
  assert.deepEqual(WEBP_QUALITY_RANGE, {
    lighter: 60,
    automaticMin: 68,
    automaticMax: 82,
    detail: 85,
  });
  assert.deepEqual(qualityTiers("webp", 74), [
    { tier: "lighter", quality: 60 },
    { tier: "recommended", quality: 74 },
    { tier: "detail", quality: 85 },
  ]);
  assert.equal(qualityTiers("webp", 40)[1].quality, 68);
  assert.equal(qualityTiers("webp", 96)[1].quality, 82);
});

test("AVIF choices use a separate high-quality Q45 to Q80 range", () => {
  assert.deepEqual(AVIF_QUALITY_RANGE, {
    lighter: 45,
    automaticMin: 50,
    automaticMax: 70,
    detail: 80,
  });
  assert.deepEqual(qualityTiers("avif", 62), [
    { tier: "lighter", quality: 45 },
    { tier: "recommended", quality: 62 },
    { tier: "detail", quality: 80 },
  ]);
  assert.equal(qualityTiers("avif", 34)[1].quality, 50);
  assert.equal(qualityTiers("avif", 94)[1].quality, 70);
});

test("screenshot mode keeps a higher quality floor for text and UI lines", () => {
  assert.deepEqual(SCREENSHOT_WEBP_QUALITY_RANGE, {
    lighter: 82,
    automaticMin: 88,
    automaticMax: 96,
    detail: 100,
  });
  assert.deepEqual(SCREENSHOT_AVIF_QUALITY_RANGE, {
    lighter: 70,
    automaticMin: 78,
    automaticMax: 90,
    detail: 95,
  });
  assert.deepEqual(qualityTiers("webp", 91, "screenshot"), [
    { tier: "lighter", quality: 82 },
    { tier: "recommended", quality: 91 },
    { tier: "detail", quality: 100 },
  ]);
});

test("built-in presets contain five grids plus custom and only two widths", () => {
  assert.equal(IMAGE_PROFILES.length, 6);
  assert.deepEqual(IMAGE_PROFILES[0].widths, [1680, 1920]);
  assert.deepEqual(IMAGE_PROFILES[1].widths, [1200, 1400]);
  assert.ok(IMAGE_PROFILES.slice(0, -1).every((profile) => profile.widths.length === 2));
  assert.equal(IMAGE_PROFILES.at(-1)?.id, "custom");
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
    ["three-columns", "four-columns", "five-columns", "custom"],
  );
  assert.deepEqual(
    getAvailableImageProfiles(450).map((profile) => profile.id),
    ["custom"],
  );
});

test("custom Retina is added only when the crop contains a true 2x width", () => {
  assert.deepEqual(createCustomProfile(500, true, 1000).widths, [500, 1000]);
  assert.deepEqual(createCustomProfile(600, true, 1000).widths, [600]);
});

test("manifest records the saved composition", () => {
  const manifest = JSON.parse(createManifest(resultFixture()));
  assert.deepEqual(manifest.crop, {
    aspectRatio: 1,
    positionX: 50,
    positionY: 50,
  });
  assert.equal(manifest.qualityTarget, 0.98);
  assert.deepEqual(manifest.selectedQuality, {
    avif: "recommended",
    webp: "recommended",
  });
});
