import assert from "node:assert/strict";
import test from "node:test";
import ImageTracer from "imagetracerjs";
import {
  analyzeTraceSource,
  buildCenterlineStrokeSvg,
  canonicalizeMonochromeAlpha,
  calculateContourSimilarity,
  calculateVectorSimilarity,
  compactTracedSvg,
  traceLayeredLineIcon,
  thinAlphaMask,
} from "../app/lib/png-vectorizer.ts";
import {
  calculateGeometryCleanliness,
  countSvgNodes,
  fitCirclePrimitive,
  simplifyGeometryPoints,
} from "../app/lib/reconstruction-engine.ts";
import {
  countCurveNodes,
  parsePathData,
  serializeSubpath,
  splitCubicSegment,
} from "../app/lib/svg-curve-editor.ts";

test("compacts traced paths, removes transparent layers and repeated paint attributes", () => {
  const compacted = compactTracedSvg(
    `<svg width="10" height="10" xmlns="http://www.w3.org/2000/svg">
      <path fill="rgb(255,255,255)" stroke="rgb(255,255,255)" stroke-width="0" opacity="0" d="M 0 0 L 10 0 Z " />
      <path fill="rgb(216,241,112)" stroke="rgb(216,241,112)" stroke-width="0" opacity="1" d="M 1 1 L 4 1 Z " />
      <path fill="rgb(216,241,112)" stroke="rgb(216,241,112)" stroke-width="0" opacity="1" d="M 5 5 L 8 5 Z " />
    </svg>`,
    10,
    10,
  );

  assert.match(compacted.svg, /viewBox="0 0 10 10"/);
  assert.match(compacted.svg, /fill="#d8f170"/);
  assert.doesNotMatch(compacted.svg, /stroke|opacity="0"|desc=/);
  assert.equal((compacted.svg.match(/<path/g) ?? []).length, 1);
  assert.equal(compacted.colorCount, 1);
});

test("ImageTracer output becomes a real path-only SVG", () => {
  const width = 12;
  const height = 12;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * 4;
      const inside = x >= 3 && x <= 8 && y >= 3 && y <= 8;
      data[index] = inside ? 23 : 255;
      data[index + 1] = inside ? 33 : 255;
      data[index + 2] = inside ? 29 : 255;
      data[index + 3] = inside ? 255 : 0;
    }
  }

  const rawSvg = ImageTracer.imagedataToSVG(
    { width, height, data },
    { numberofcolors: 2, pathomit: 0, strokewidth: 0, viewbox: true },
  );
  const compacted = compactTracedSvg(rawSvg, width, height);

  assert.match(compacted.svg, /^<svg[^>]+><path/);
  assert.doesNotMatch(compacted.svg, /<image|data:image\/png/);
  assert.ok(compacted.pathCount >= 1);
});

test("detects a transparent single-color drawing as a line icon", () => {
  const width = 10;
  const height = 10;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 2; y < 8; y += 1) {
    for (let x = 4; x < 7; x += 1) {
      const index = (y * width + x) * 4;
      data[index] = 91;
      data[index + 1] = 148;
      data[index + 2] = 154;
      data[index + 3] = x === 4 ? 150 : 255;
    }
  }

  const analysis = analyzeTraceSource({ width, height, data });
  assert.equal(analysis.suggestedKind, "line-icon");
  assert.equal(analysis.constructionKind, "line-icon");
  assert.match(analysis.inkColor, /^#[0-9a-f]{6}$/);
  assert.ok(analysis.transparentShare > 0.5);
  assert.ok(analysis.dominantShare > 0.9);
});

test("black and white PNGs with the same alpha mask produce identical geometry", () => {
  const width = 32;
  const height = 32;
  const makeIcon = (channel) => {
    const data = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const index = (y * width + x) * 4;
        const distance = Math.hypot(x + 0.5 - 16, y + 0.5 - 16);
        const alpha = distance <= 10 ? 255 : distance <= 11 ? 110 : 0;
        data[index] = channel;
        data[index + 1] = channel;
        data[index + 2] = channel;
        data[index + 3] = alpha;
      }
    }
    return { width, height, data };
  };
  const black = makeIcon(0);
  const white = makeIcon(255);
  assert.deepEqual(
    [...canonicalizeMonochromeAlpha(black).data],
    [...canonicalizeMonochromeAlpha(white).data],
  );
  const blackTrace = traceLayeredLineIcon(black, "#000000", "precise", true);
  const whiteTrace = traceLayeredLineIcon(white, "#ffffff", "precise", true);
  const pathData = (svg) => [...svg.matchAll(/ d="([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(pathData(blackTrace.svg), pathData(whiteTrace.svg));
  assert.match(blackTrace.svg, /fill="#000(?:000)?"/);
  assert.match(whiteTrace.svg, /fill="#fff(?:fff)?"/);
});

test("scores an identical transparent icon higher than a shifted contour", () => {
  const width = 16;
  const height = 16;
  const createIcon = (offset) => {
    const data = new Uint8ClampedArray(width * height * 4);
    for (let y = 4; y < 12; y += 1) {
      for (let x = 4 + offset; x < 12 + offset && x < width; x += 1) {
        const index = (y * width + x) * 4;
        data[index] = 91;
        data[index + 1] = 148;
        data[index + 2] = 154;
        data[index + 3] = 255;
      }
    }
    return { width, height, data };
  };

  const reference = createIcon(0);
  const identical = calculateVectorSimilarity(reference, createIcon(0));
  const shifted = calculateVectorSimilarity(reference, createIcon(2));

  assert.equal(identical.score, 1);
  assert.equal(identical.shape, 1);
  assert.ok(shifted.score < identical.score);
  assert.ok(shifted.shape < identical.shape);
});

test("contour gate rejects a polygonal substitute for a smooth low-resolution circle", () => {
  const width = 100;
  const height = 100;
  const createShape = (inside) => {
    const data = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const index = (y * width + x) * 4;
        const visible = inside(x + 0.5, y + 0.5);
        data[index] = 0;
        data[index + 1] = 0;
        data[index + 2] = 0;
        data[index + 3] = visible ? 255 : 0;
      }
    }
    return { width, height, data };
  };
  const circle = createShape((x, y) => Math.hypot(x - 50, y - 50) <= 38);
  const octagon = createShape((x, y) => {
    const dx = Math.abs(x - 50);
    const dy = Math.abs(y - 50);
    return Math.max(dx, dy) <= 38 && dx + dy <= 54;
  });
  assert.equal(calculateContourSimilarity(circle, circle), 1);
  assert.ok(calculateContourSimilarity(circle, octagon) < 0.9);
  assert.ok(calculateVectorSimilarity(circle, circle).score > calculateVectorSimilarity(circle, octagon).score);
});

test("thins a filled bar to a one-pixel centerline", () => {
  const width = 18;
  const height = 12;
  const mask = new Uint8Array(width * height);
  for (let y = 3; y < 9; y += 1) {
    for (let x = 3; x < 15; x += 1) mask[y * width + x] = 1;
  }
  const skeleton = thinAlphaMask(mask, width, height);
  const active = [...skeleton].filter(Boolean).length;
  assert.ok(active >= 5 && active <= 12);
});

test("reconstructs a transparent line as a real rounded SVG stroke", () => {
  const width = 24;
  const height = 16;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 5; y < 11; y += 1) {
    for (let x = 4; x < 20; x += 1) {
      const index = (y * width + x) * 4;
      data[index] = 100;
      data[index + 1] = 150;
      data[index + 2] = 156;
      data[index + 3] = 255;
    }
  }
  const result = buildCenterlineStrokeSvg({ width, height, data }, "#64969c", 0.5, 0.45);
  assert.match(result.svg, /fill="none"/);
  assert.match(result.svg, /stroke="#64969c"/);
  assert.match(result.svg, /stroke-linecap="round"/);
  assert.match(result.svg, /stroke-linejoin="round"/);
  assert.ok(result.strokeWidth >= 5 && result.strokeWidth <= 8);
  assert.ok(result.pathCount >= 1);
});

test("reduces a nearly straight trace to two meaningful points", () => {
  const points = Array.from({ length: 20 }, (_, index) => ({
    x: index,
    y: index * 0.5 + (index % 2 ? 0.03 : -0.03),
  }));
  const simplified = simplifyGeometryPoints(points, 0.08);
  assert.equal(simplified.length, 2);
  assert.deepEqual(simplified[0], points[0]);
  assert.deepEqual(simplified[1], points.at(-1));
});

test("recognizes a sampled circular contour as one geometric primitive", () => {
  const points = Array.from({ length: 32 }, (_, index) => {
    const angle = index / 32 * Math.PI * 2;
    return { x: 48 + Math.cos(angle) * 20, y: 36 + Math.sin(angle) * 20 };
  });
  const circle = fitCirclePrimitive(points);
  assert.ok(circle);
  assert.ok(Math.abs(circle.center.x - 48) < 0.01);
  assert.ok(Math.abs(circle.center.y - 36) < 0.01);
  assert.ok(Math.abs(circle.radius - 20) < 0.01);
});

test("scores compact semantic geometry above an overloaded draft", () => {
  const clean = calculateGeometryCleanliness(12, 96, 6, 2, 128);
  const noisy = calculateGeometryCleanliness(74, 96, 2, 2, 128);
  assert.ok(clean > noisy);
  assert.equal(countSvgNodes('<svg><path d="M0 0L10 0C10 2 8 4 6 4Z"/></svg>'), 3);
});

test("curve editor normalizes lines, cubic curves and arcs into editable nodes", () => {
  const subpaths = parsePathData("M10 10L40 10C50 10 50 40 40 40A15 15 0 0 1 10 40Z");
  assert.equal(subpaths.length, 1);
  assert.equal(subpaths[0].closed, true);
  assert.ok(subpaths[0].nodes.length >= 4);
  assert.match(serializeSubpath(subpaths[0]), /^M10 10/);
  assert.match(serializeSubpath(subpaths[0]), /C/);
  assert.match(serializeSubpath(subpaths[0]), /Z$/);
});

test("adding an editor node splits a cubic without changing its shape", () => {
  const subpath = parsePathData("M0 0C20 0 20 20 40 20")[0];
  const start = subpath.nodes[0];
  const end = subpath.nodes[1];
  const inserted = splitCubicSegment(start, end, 0.5);
  subpath.nodes.splice(1, 0, inserted);
  const document = {
    width: 40,
    height: 20,
    viewBox: { x: 0, y: 0, width: 40, height: 20 },
    paths: [{
      id: "path-test",
      paint: {
        fill: "none",
        stroke: "#000",
        strokeWidth: 2,
        strokeLinecap: "round",
        strokeLinejoin: "round",
        fillRule: "nonzero",
        opacity: 1,
      },
      subpaths: [subpath],
    }],
  };
  assert.equal(countCurveNodes(document), 3);
  assert.deepEqual(
    { x: Number(inserted.x.toFixed(3)), y: Number(inserted.y.toFixed(3)) },
    { x: 20, y: 10 },
  );
});
