import ImageTracer from "imagetracerjs";
import ssim from "ssim.js";
import {
  calculateGeometryCleanliness,
  countSvgNodes,
  reconstructSvgGeometry,
} from "./reconstruction-engine.ts";

export type TraceDetail = "compact" | "balanced" | "precise";
export type TracePreset = "auto" | "line-icon" | "logo" | "illustration";
export type TraceKind = "line-icon" | "color";
export type VectorMode = "stroke" | "outline" | "geometry";
export type ConstructionKind = "line-icon" | "outline-icon" | "filled-shape" | "multicolor";

export type VectorizeSettings = {
  colors: number;
  detail: TraceDetail;
  removeSpecks: boolean;
  preset: TracePreset;
};

export type VectorizeResult = {
  sourceName: string;
  sourceWidth: number;
  sourceHeight: number;
  traceWidth: number;
  traceHeight: number;
  sourceSize: number;
  svg: string;
  svgBlob: Blob;
  svgSize: number;
  fileName: string;
  pathCount: number;
  colorCount: number;
  durationMs: number;
  traceKind: TraceKind;
  vectorMode: VectorMode;
  traceLabel: string;
  similarity: number;
  structuralSimilarity: number;
  shapeSimilarity: number;
  candidatesTested: number;
  qualityTarget: number;
  constructionKind: ConstructionKind;
  geometryScore: number;
  nodeCount: number;
  draftNodeCount: number;
  primitiveCount: number;
};

type TraceCandidate = {
  svg: string;
  pathCount: number;
  colorCount: number;
  method: string;
  vectorMode: VectorMode;
  geometryScore?: number;
  nodeCount?: number;
  draftNodeCount?: number;
  primitiveCount?: number;
};

type SimilarityMeasurement = {
  score: number;
  structural: number;
  shape: number;
};

type TraceAnalysis = {
  suggestedKind: TraceKind;
  inkColor: string;
  transparentShare: number;
  dominantShare: number;
  fillRatio: number;
  constructionKind: ConstructionKind;
};

type VTracerModule = {
  BinaryImageConverter: {
    new_with_string(params: string): {
      init(): void;
      tick(): boolean;
      free(): void;
    };
  };
  __wbg_set_wasm(exports: WebAssembly.Exports): void;
};

let vTracerPromise: Promise<VTracerModule> | null = null;

const DETAIL_OPTIONS: Record<
  TraceDetail,
  {
    ltres: number;
    qtres: number;
    pathomit: number;
    roundcoords: number;
    maxDimension: number;
    cornerDegrees: number;
    segmentLength: number;
    spliceDegrees: number;
    speckleSize: number;
    pathPrecision: number;
  }
> = {
  compact: {
    ltres: 1.8,
    qtres: 1.8,
    pathomit: 18,
    roundcoords: 0,
    maxDimension: 720,
    cornerDegrees: 82,
    segmentLength: 6,
    spliceDegrees: 58,
    speckleSize: 4,
    pathPrecision: 1,
  },
  balanced: {
    ltres: 1,
    qtres: 1,
    pathomit: 8,
    roundcoords: 1,
    maxDimension: 1100,
    cornerDegrees: 72,
    segmentLength: 4,
    spliceDegrees: 50,
    speckleSize: 3,
    pathPrecision: 2,
  },
  precise: {
    ltres: 0.45,
    qtres: 0.45,
    pathomit: 2,
    roundcoords: 2,
    maxDimension: 1600,
    cornerDegrees: 62,
    segmentLength: 3.5,
    spliceDegrees: 45,
    speckleSize: 2,
    pathPrecision: 2,
  },
};

export const VECTOR_SIMILARITY_TARGET = 0.96;

type Point = { x: number; y: number };

const SKELETON_NEIGHBORS = [
  [0, -1], [1, -1], [1, 0], [1, 1],
  [0, 1], [-1, 1], [-1, 0], [-1, -1],
] as const;

function alphaMask(imageData: ImageData, threshold: number) {
  const mask = new Uint8Array(imageData.width * imageData.height);
  for (let pixel = 0; pixel < mask.length; pixel += 1) {
    mask[pixel] = imageData.data[pixel * 4 + 3] / 255 >= threshold ? 1 : 0;
  }
  return mask;
}

function compatibleImageData(width: number, height: number, data: Uint8ClampedArray) {
  return typeof ImageData === "undefined"
    ? { width, height, data } as ImageData
    : new ImageData(data, width, height);
}

/**
 * Converts any monochrome transparent raster to one canonical RGB color while
 * preserving alpha byte-for-byte. Geometry and quality ranking can then depend
 * only on the silhouette, never on whether the uploaded icon was black or white.
 */
export function canonicalizeMonochromeAlpha(imageData: ImageData, inkColor = "#000000") {
  const [red, green, blue] = colorToRgb(inkColor);
  const data = new Uint8ClampedArray(imageData.data.length);
  for (let index = 0; index < data.length; index += 4) {
    data[index] = red;
    data[index + 1] = green;
    data[index + 2] = blue;
    data[index + 3] = imageData.data[index + 3];
  }
  return compatibleImageData(imageData.width, imageData.height, data);
}

/** Zhang–Suen thinning leaves a one-pixel medial axis inside a binary stroke. */
export function thinAlphaMask(source: Uint8Array, width: number, height: number) {
  const mask = new Uint8Array(source);
  const marked: number[] = [];
  let changed = true;
  const neighborValues = (index: number) => {
    const x = index % width;
    const y = Math.floor(index / width);
    return SKELETON_NEIGHBORS.map(([dx, dy]) => mask[(y + dy) * width + x + dx]);
  };

  while (changed) {
    changed = false;
    for (let pass = 0; pass < 2; pass += 1) {
      marked.length = 0;
      for (let y = 1; y < height - 1; y += 1) {
        for (let x = 1; x < width - 1; x += 1) {
          const index = y * width + x;
          if (!mask[index]) continue;
          const neighbors = neighborValues(index);
          const count = neighbors.reduce((sum, value) => sum + value, 0);
          if (count < 2 || count > 6) continue;
          let transitions = 0;
          for (let neighbor = 0; neighbor < 8; neighbor += 1) {
            if (!neighbors[neighbor] && neighbors[(neighbor + 1) % 8]) transitions += 1;
          }
          if (transitions !== 1) continue;
          const north = neighbors[0];
          const east = neighbors[2];
          const south = neighbors[4];
          const west = neighbors[6];
          const firstTriplet = pass === 0 ? north * east * south : north * east * west;
          const secondTriplet = pass === 0 ? east * south * west : north * south * west;
          if (!firstTriplet && !secondTriplet) marked.push(index);
        }
      }
      if (marked.length) {
        changed = true;
        marked.forEach((index) => { mask[index] = 0; });
      }
    }
  }
  return mask;
}

function chamferDistance(mask: Uint8Array, width: number, height: number) {
  const diagonal = Math.SQRT2;
  const distance = new Float32Array(mask.length);
  distance.fill(width + height);
  for (let index = 0; index < mask.length; index += 1) {
    if (!mask[index]) distance[index] = 0;
  }
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      if (!mask[index]) continue;
      if (x > 0) distance[index] = Math.min(distance[index], distance[index - 1] + 1);
      if (y > 0) distance[index] = Math.min(distance[index], distance[index - width] + 1);
      if (x > 0 && y > 0) distance[index] = Math.min(distance[index], distance[index - width - 1] + diagonal);
      if (x + 1 < width && y > 0) distance[index] = Math.min(distance[index], distance[index - width + 1] + diagonal);
    }
  }
  for (let y = height - 1; y >= 0; y -= 1) {
    for (let x = width - 1; x >= 0; x -= 1) {
      const index = y * width + x;
      if (!mask[index]) continue;
      if (x + 1 < width) distance[index] = Math.min(distance[index], distance[index + 1] + 1);
      if (y + 1 < height) distance[index] = Math.min(distance[index], distance[index + width] + 1);
      if (x + 1 < width && y + 1 < height) distance[index] = Math.min(distance[index], distance[index + width + 1] + diagonal);
      if (x > 0 && y + 1 < height) distance[index] = Math.min(distance[index], distance[index + width - 1] + diagonal);
    }
  }
  return distance;
}

function skeletonNeighbors(mask: Uint8Array, width: number, height: number, index: number) {
  const x = index % width;
  const y = Math.floor(index / width);
  const neighbors: number[] = [];
  for (const [dx, dy] of SKELETON_NEIGHBORS) {
    const nextX = x + dx;
    const nextY = y + dy;
    if (nextX < 0 || nextY < 0 || nextX >= width || nextY >= height) continue;
    const next = nextY * width + nextX;
    if (!mask[next]) continue;
    // A diagonal is redundant when a two-step orthogonal connection exists.
    if (dx && dy && (mask[y * width + nextX] || mask[nextY * width + x])) continue;
    neighbors.push(next);
  }
  return neighbors;
}

function edgeKey(first: number, second: number) {
  return first < second ? `${first}:${second}` : `${second}:${first}`;
}

function pointDistance(first: Point, second: Point) {
  return Math.hypot(first.x - second.x, first.y - second.y);
}

function perpendicularDistance(point: Point, start: Point, end: Point) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  if (!dx && !dy) return pointDistance(point, start);
  const position = Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / (dx * dx + dy * dy)));
  return pointDistance(point, { x: start.x + position * dx, y: start.y + position * dy });
}

function simplifyOpenPoints(points: Point[], tolerance: number): Point[] {
  if (points.length <= 2) return points;
  let farthestIndex = 0;
  let farthestDistance = 0;
  for (let index = 1; index < points.length - 1; index += 1) {
    const distance = perpendicularDistance(points[index], points[0], points[points.length - 1]);
    if (distance > farthestDistance) {
      farthestDistance = distance;
      farthestIndex = index;
    }
  }
  if (farthestDistance <= tolerance) return [points[0], points[points.length - 1]];
  const left = simplifyOpenPoints(points.slice(0, farthestIndex + 1), tolerance);
  const right = simplifyOpenPoints(points.slice(farthestIndex), tolerance);
  return [...left.slice(0, -1), ...right];
}

function simplifyClosedPoints(points: Point[], tolerance: number) {
  const ring = pointDistance(points[0], points[points.length - 1]) < 0.01 ? points.slice(0, -1) : points;
  if (ring.length <= 4) return [...ring, ring[0]];
  let first = 0;
  let second = 1;
  let longest = 0;
  for (let index = 1; index < ring.length; index += 1) {
    const distance = pointDistance(ring[0], ring[index]);
    if (distance > longest) { longest = distance; second = index; }
  }
  longest = 0;
  for (let index = 0; index < ring.length; index += 1) {
    const distance = pointDistance(ring[second], ring[index]);
    if (distance > longest) { longest = distance; first = index; }
  }
  const low = Math.min(first, second);
  const high = Math.max(first, second);
  const forward = ring.slice(low, high + 1);
  const backward = [...ring.slice(high), ...ring.slice(0, low + 1)];
  const simplified = [
    ...simplifyOpenPoints(forward, tolerance).slice(0, -1),
    ...simplifyOpenPoints(backward, tolerance).slice(0, -1),
  ];
  return [...simplified, simplified[0]];
}

type SkeletonChain = { points: Point[]; closed: boolean; length: number; endpointDegrees: [number, number] };

function traceSkeleton(mask: Uint8Array, width: number, height: number, coordinateOffset: number) {
  const active: number[] = [];
  const adjacency = new Map<number, number[]>();
  for (let index = 0; index < mask.length; index += 1) {
    if (!mask[index]) continue;
    active.push(index);
    adjacency.set(index, skeletonNeighbors(mask, width, height, index));
  }
  const visited = new Set<string>();
  const chains: SkeletonChain[] = [];
  const toPoint = (index: number): Point => ({ x: index % width + coordinateOffset, y: Math.floor(index / width) + coordinateOffset });

  const walk = (start: number, firstNext: number) => {
    const indexes = [start];
    let previous = start;
    let current = firstNext;
    visited.add(edgeKey(previous, current));
    while (true) {
      indexes.push(current);
      const options = adjacency.get(current) ?? [];
      if (options.length !== 2 || current === start) break;
      const next = options[0] === previous ? options[1] : options[0];
      const key = edgeKey(current, next);
      if (visited.has(key)) break;
      visited.add(key);
      previous = current;
      current = next;
    }
    const points = indexes.map(toPoint);
    const length = points.slice(1).reduce((sum, point, index) => sum + pointDistance(points[index], point), 0);
    chains.push({
      points,
      closed: indexes.length > 2 && indexes[0] === indexes[indexes.length - 1],
      length,
      endpointDegrees: [(adjacency.get(indexes[0]) ?? []).length, (adjacency.get(indexes[indexes.length - 1]) ?? []).length],
    });
  };

  for (const index of active) {
    const neighbors = adjacency.get(index) ?? [];
    if (neighbors.length === 2) continue;
    for (const next of neighbors) {
      if (!visited.has(edgeKey(index, next))) walk(index, next);
    }
  }
  for (const index of active) {
    for (const next of adjacency.get(index) ?? []) {
      if (!visited.has(edgeKey(index, next))) walk(index, next);
    }
  }
  return chains;
}

function rounded(value: number) {
  return Number(value.toFixed(2)).toString();
}

/** Reconstructs a line icon as editable centerline paths with a true SVG stroke. */
export function buildCenterlineStrokeSvg(
  imageData: ImageData,
  inkColor: string,
  threshold: number,
  tolerance: number,
  widthMultiplier = 1,
  coordinateOffset = 0.5,
) {
  const mask = alphaMask(imageData, threshold);
  const skeleton = thinAlphaMask(mask, imageData.width, imageData.height);
  const distance = chamferDistance(mask, imageData.width, imageData.height);
  const radii: number[] = [];
  for (let index = 0; index < skeleton.length; index += 1) {
    if (skeleton[index] && distance[index] > 0) radii.push(distance[index]);
  }
  if (!radii.length) throw new Error("Не удалось восстановить ось штриха.");
  radii.sort((first, second) => first - second);
  const medianRadius = radii[Math.floor(radii.length / 2)];
  const strokeWidth = Math.max(1, medianRadius * 2 * widthMultiplier);
  const minimumBranch = Math.max(1.5, strokeWidth * 0.65);
  const chains = traceSkeleton(skeleton, imageData.width, imageData.height, coordinateOffset)
    .filter((chain) => {
      if (chain.closed) return chain.length >= strokeWidth * 1.5;
      const terminalBranch = chain.endpointDegrees.includes(1) && chain.endpointDegrees.some((degree) => degree > 2);
      return !terminalBranch || chain.length >= minimumBranch;
    });
  const paths = chains.flatMap((chain) => {
    if (chain.points.length < 2) return [];
    const points = chain.closed
      ? simplifyClosedPoints(chain.points, tolerance)
      : simplifyOpenPoints(chain.points, tolerance);
    if (points.length < 2) return [];
    const commands = [`M${rounded(points[0].x)} ${rounded(points[0].y)}`];
    points.slice(1).forEach((point) => commands.push(`L${rounded(point.x)} ${rounded(point.y)}`));
    if (chain.closed) commands.push("Z");
    return [commands.join("")];
  });
  if (!paths.length) throw new Error("Не удалось построить центральную линию штриха.");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${imageData.width}" height="${imageData.height}" viewBox="0 0 ${imageData.width} ${imageData.height}"><path d="${paths.join("")}" fill="none" stroke="${inkColor}" stroke-width="${rounded(strokeWidth)}" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  return { svg, pathCount: paths.length, colorCount: 1, strokeWidth };
}

function safeBaseName(fileName: string) {
  return (
    fileName
      .replace(/\.[^.]+$/, "")
      .normalize("NFKD")
      .replace(/[^a-zA-Z0-9а-яА-ЯёЁ_-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "icon"
  );
}

function compactColor(value: string) {
  const match = value.match(/rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)/i);
  if (!match) return value.toLowerCase();
  const hex = match
    .slice(1)
    .map((channel) => Number(channel).toString(16).padStart(2, "0"))
    .join("");
  if (hex[0] === hex[1] && hex[2] === hex[3] && hex[4] === hex[5]) {
    return `#${hex[0]}${hex[2]}${hex[4]}`;
  }
  return `#${hex}`;
}

function compactPathData(value: string) {
  return value
    .trim()
    .replace(/\s+/g, " ")
    .replace(/\s*([A-Za-z])\s*/g, "$1");
}

function colorToRgb(value: string) {
  const compact = compactColor(value);
  const shortHex = compact.match(/^#([0-9a-f])([0-9a-f])([0-9a-f])$/i);
  if (shortHex) {
    return shortHex.slice(1).map((channel) => Number.parseInt(`${channel}${channel}`, 16));
  }
  const longHex = compact.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  return longHex ? longHex.slice(1).map((channel) => Number.parseInt(channel, 16)) : [0, 0, 0];
}

function isLightColor(value: string) {
  const [red, green, blue] = colorToRgb(value);
  return red * 0.2126 + green * 0.7152 + blue * 0.0722 > 180;
}

export function analyzeTraceSource(imageData: ImageData): TraceAnalysis {
  const buckets = new Map<string, number>();
  let transparent = 0;
  let visible = 0;
  let redSum = 0;
  let greenSum = 0;
  let blueSum = 0;
  let weightSum = 0;
  let opaque = 0;
  let minX = imageData.width;
  let minY = imageData.height;
  let maxX = -1;
  let maxY = -1;

  for (let index = 0; index < imageData.data.length; index += 4) {
    const alpha = imageData.data[index + 3];
    if (alpha < 20) {
      transparent += 1;
      continue;
    }
    visible += 1;
    const pixel = index / 4;
    const x = pixel % imageData.width;
    const y = Math.floor(pixel / imageData.width);
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
    if (alpha >= 128) opaque += 1;
    const weight = alpha / 255;
    const red = imageData.data[index];
    const green = imageData.data[index + 1];
    const blue = imageData.data[index + 2];
    redSum += red * weight;
    greenSum += green * weight;
    blueSum += blue * weight;
    weightSum += weight;
    const key = `${red >> 4},${green >> 4},${blue >> 4}`;
    buckets.set(key, (buckets.get(key) ?? 0) + weight);
  }

  const dominantWeight = Math.max(0, ...buckets.values());
  const dominantShare = weightSum ? dominantWeight / weightSum : 0;
  const pixelCount = imageData.width * imageData.height;
  const transparentShare = pixelCount ? transparent / pixelCount : 0;
  const average = weightSum
    ? [redSum / weightSum, greenSum / weightSum, blueSum / weightSum]
    : [0, 0, 0];
  const inkColor = `#${average
    .map((channel) => Math.round(channel).toString(16).padStart(2, "0"))
    .join("")}`;

  const boundsArea = maxX >= minX && maxY >= minY
    ? (maxX - minX + 1) * (maxY - minY + 1)
    : 0;
  const boundsWidth = maxX >= minX ? maxX - minX + 1 : 0;
  const boundsHeight = maxY >= minY ? maxY - minY + 1 : 0;
  const elongation = boundsWidth && boundsHeight
    ? Math.max(boundsWidth, boundsHeight) / Math.min(boundsWidth, boundsHeight)
    : 1;
  const fillRatio = boundsArea ? opaque / boundsArea : 0;
  // Alpha variation around a dominant RGB value is anti-aliasing, not extra color.
  const multicolor = visible > 0 && dominantShare < 0.58;
  const constructionKind: ConstructionKind = multicolor
    ? "multicolor"
    : fillRatio < 0.42 || (elongation > 1.8 && transparentShare > 0.25)
      ? "line-icon"
      : fillRatio < 0.72
        ? "outline-icon"
        : "filled-shape";
  return {
    suggestedKind: constructionKind === "multicolor" ? "color" : "line-icon",
    inkColor,
    transparentShare,
    dominantShare,
    fillRatio,
    constructionKind,
  };
}

export function compactTracedSvg(rawSvg: string, width: number, height: number) {
  const paths = [...rawSvg.matchAll(/<path\s+([^>]*?)\/?\s*>/g)];
  const groups = new Map<string, { fill: string; opacity: number; paths: string[] }>();

  paths.forEach((pathMatch) => {
    const attributes = new Map<string, string>();
    for (const attribute of pathMatch[1].matchAll(/([\w-]+)="([^"]*)"/g)) {
      attributes.set(attribute[1], attribute[2]);
    }
    const opacity = Number(attributes.get("opacity") ?? "1");
    const pathData = attributes.get("d");
    if (!pathData || !Number.isFinite(opacity) || opacity <= 0.005) return;

    const fill = compactColor(attributes.get("fill") ?? "#000");
    const roundedOpacity = Math.round(opacity * 100) / 100;
    const key = `${fill}|${roundedOpacity}`;
    const current = groups.get(key) ?? { fill, opacity: roundedOpacity, paths: [] };
    current.paths.push(compactPathData(pathData));
    groups.set(key, current);
  });

  const body = [...groups.values()]
    .map(({ fill, opacity, paths: groupedPaths }) => {
      const opacityAttribute = opacity < 1 ? ` opacity="${opacity}"` : "";
      return `<path fill="${fill}"${opacityAttribute} d="${groupedPaths.join("")}"/>`;
    })
    .join("");

  return {
    svg: `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${body}</svg>`,
    pathCount: groups.size,
    colorCount: groups.size,
  };
}

function prepareLineCanvas(imageData: ImageData, threshold: number) {
  const prepared = new ImageData(
    new Uint8ClampedArray(imageData.data),
    imageData.width,
    imageData.height,
  );
  for (let index = 0; index < prepared.data.length; index += 4) {
    const alpha = prepared.data[index + 3] / 255;
    const gray = alpha >= threshold ? 0 : 255;
    prepared.data[index] = gray;
    prepared.data[index + 1] = gray;
    prepared.data[index + 2] = gray;
    prepared.data[index + 3] = 255;
  }
  return prepared;
}

function compactBinarySvg(rawSvg: SVGSVGElement, width: number, height: number, inkColor: string) {
  const pathElements = [...rawSvg.querySelectorAll("path")];
  const maskPaths = pathElements.flatMap((path) => {
    const data = path.getAttribute("d");
    if (!data) return [];
    let current: Element | null = path;
    let fill = "#000";
    while (current) {
      const candidate = current.getAttribute("fill");
      if (candidate) {
        fill = candidate;
        break;
      }
      current = current.parentElement;
    }
    const maskFill = isLightColor(fill) ? "#000" : "#fff";
    const fillRule = path.getAttribute("fill-rule");
    const transform = path.getAttribute("transform");
    return [`<path fill="${maskFill}"${fillRule ? ` fill-rule="${fillRule}"` : ""}${transform ? ` transform="${transform}"` : ""} d="${compactPathData(data)}"/>`];
  });
  if (!maskPaths.length) {
    throw new Error("Не удалось построить контур этой иконки.");
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><mask id="ink" maskUnits="userSpaceOnUse" x="0" y="0" width="${width}" height="${height}"><rect width="${width}" height="${height}" fill="#000"/>${maskPaths.join("")}</mask><rect width="${width}" height="${height}" fill="${inkColor}" mask="url(#ink)"/></svg>`;
  return { svg, pathCount: maskPaths.length, colorCount: 1 };
}

async function loadVTracer() {
  if (!vTracerPromise) {
    vTracerPromise = Promise.all([
      import("vtracer-webapp/vtracer_webapp_bg.js"),
      import("vtracer-webapp/vtracer_webapp_bg.wasm?url"),
    ]).then(async ([bindings, wasmAsset]) => {
      const response = await fetch(wasmAsset.default);
      if (!response.ok) throw new Error("Не удалось загрузить модуль плавных кривых.");
      const imports = {
        "./vtracer_webapp_bg.js": bindings as unknown as WebAssembly.ModuleImports,
      };
      let instance: WebAssembly.Instance;
      try {
        const source = await WebAssembly.instantiateStreaming(response.clone(), imports);
        instance = source.instance;
      } catch {
        const source = await WebAssembly.instantiate(await response.arrayBuffer(), imports);
        instance = source.instance;
      }
      bindings.__wbg_set_wasm(instance.exports);
      const start = instance.exports.__wbindgen_start;
      if (typeof start === "function") start();
      return bindings as unknown as VTracerModule;
    }).catch((error) => {
      vTracerPromise = null;
      throw error;
    });
  }
  return vTracerPromise;
}

async function traceLineIcon(
  canvas: HTMLCanvasElement,
  imageData: ImageData,
  detailName: TraceDetail,
  removeSpecks: boolean,
  inkColor: string,
  threshold: number,
) {
  const { BinaryImageConverter } = await loadVTracer();
  const detail = DETAIL_OPTIONS[detailName];
  const svgElement = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  canvas.id = `optima-trace-canvas-${id}`;
  svgElement.id = `optima-trace-svg-${id}`;
  svgElement.setAttribute("viewBox", `0 0 ${canvas.width} ${canvas.height}`);
  const host = document.createElement("div");
  host.hidden = true;
  host.append(canvas, svgElement);
  document.body.append(host);

  const context = canvas.getContext("2d", { alpha: true, willReadFrequently: true });
  if (!context) {
    host.remove();
    throw new Error("Браузер не предоставил Canvas 2D.");
  }
  context.putImageData(prepareLineCanvas(imageData, threshold), 0, 0);

  const radians = (degrees: number) => degrees / 180 * Math.PI;
  const converter = BinaryImageConverter.new_with_string(JSON.stringify({
    canvas_id: canvas.id,
    svg_id: svgElement.id,
    mode: "spline",
    clustering_mode: "binary",
    hierarchical: "stacked",
    corner_threshold: radians(Math.min(detail.cornerDegrees, detailName === "precise" ? 42 : 52)),
    length_threshold: detailName === "compact" ? 4.5 : 3.5,
    max_iterations: 16,
    splice_threshold: radians(Math.min(detail.spliceDegrees, detailName === "precise" ? 32 : 38)),
    filter_speckle: removeSpecks ? (detailName === "compact" ? 4 : 1) : 0,
    color_precision: 2,
    layer_difference: 16,
    path_precision: detailName === "compact" ? detail.pathPrecision : 3,
  }));

  try {
    converter.init();
    let finished = false;
    while (!finished) {
      const frameStarted = performance.now();
      while (!finished && performance.now() - frameStarted < 18) {
        finished = converter.tick();
      }
      if (!finished) {
        await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
      }
    }
    return {
      ...compactBinarySvg(svgElement, canvas.width, canvas.height, inkColor),
      method: `spline-${threshold}`,
      vectorMode: "outline" as const,
    };
  } finally {
    converter.free();
    host.remove();
  }
}

function prepareOpaqueLineMask(imageData: ImageData, threshold: number, inkColor: string) {
  const [red, green, blue] = colorToRgb(inkColor);
  const prepared = compatibleImageData(
    imageData.width,
    imageData.height,
    new Uint8ClampedArray(imageData.data.length),
  );
  for (let index = 0; index < prepared.data.length; index += 4) {
    const visible = imageData.data[index + 3] / 255 >= threshold;
    prepared.data[index] = visible ? red : 255;
    prepared.data[index + 1] = visible ? green : 255;
    prepared.data[index + 2] = visible ? blue : 255;
    prepared.data[index + 3] = visible ? 255 : 0;
  }
  return prepared;
}

export function traceLayeredLineIcon(
  imageData: ImageData,
  inkColor: string,
  detailName: TraceDetail,
  removeSpecks: boolean,
) {
  const alphaOnlySource = canonicalizeMonochromeAlpha(imageData);
  const alphaLevels = detailName === "precise"
    ? [255, 208, 152, 96, 48, 20]
    : detailName === "balanced"
      ? [255, 190, 112, 40]
      : [255, 144, 40];
  const tolerance = detailName === "precise" ? 0.9 : detailName === "balanced" ? 1.4 : 2.1;
  const rawSvg = ImageTracer.imagedataToSVG(alphaOnlySource, {
    ltres: tolerance,
    qtres: tolerance,
    pathomit: removeSpecks ? 1 : 0,
    rightangleenhance: false,
    colorsampling: 0,
    numberofcolors: alphaLevels.length + 1,
    mincolorratio: 0,
    colorquantcycles: 1,
    layering: 0,
    strokewidth: 0,
    linefilter: false,
    roundcoords: detailName === "compact" ? 1 : 3,
    viewbox: true,
    desc: false,
    blurradius: 0,
    pal: [
      ...alphaLevels.map((alpha) => ({ r: 0, g: 0, b: 0, a: alpha })),
      { r: 255, g: 255, b: 255, a: 0 },
    ],
  });
  const compacted = compactTracedSvg(rawSvg, imageData.width, imageData.height);
  const outputColor = compactColor(inkColor);
  return {
    ...compacted,
    svg: compacted.svg.replaceAll('fill="#000"', `fill="${outputColor}"`),
    colorCount: 1,
    method: `alpha-layers-${alphaLevels.length}`,
    vectorMode: "outline" as const,
  };
}

function traceBinaryLineIcon(
  imageData: ImageData,
  inkColor: string,
  detailName: TraceDetail,
  removeSpecks: boolean,
  threshold: number,
) {
  const prepared = prepareOpaqueLineMask(imageData, threshold, inkColor);
  const [red, green, blue] = colorToRgb(inkColor);
  const tolerance = detailName === "precise" ? 0.9 : detailName === "balanced" ? 1.4 : 2.1;
  const rawSvg = ImageTracer.imagedataToSVG(prepared, {
    ltres: tolerance,
    qtres: tolerance,
    pathomit: removeSpecks ? 1 : 0,
    rightangleenhance: false,
    colorsampling: 0,
    numberofcolors: 2,
    mincolorratio: 0,
    colorquantcycles: 1,
    layering: 0,
    strokewidth: 0,
    linefilter: false,
    roundcoords: detailName === "compact" ? 1 : 3,
    viewbox: true,
    desc: false,
    blurradius: 0,
    pal: [
      { r: red, g: green, b: blue, a: 255 },
      { r: 255, g: 255, b: 255, a: 0 },
    ],
  });
  return {
    ...compactTracedSvg(rawSvg, imageData.width, imageData.height),
    colorCount: 1,
    method: `quadratic-${threshold}`,
    vectorMode: "outline" as const,
  };
}

function matteOnWhite(imageData: ImageData) {
  const data = new Uint8ClampedArray(imageData.data.length);
  for (let index = 0; index < data.length; index += 4) {
    const alpha = imageData.data[index + 3] / 255;
    data[index] = Math.round(imageData.data[index] * alpha + 255 * (1 - alpha));
    data[index + 1] = Math.round(imageData.data[index + 1] * alpha + 255 * (1 - alpha));
    data[index + 2] = Math.round(imageData.data[index + 2] * alpha + 255 * (1 - alpha));
    data[index + 3] = 255;
  }
  return { width: imageData.width, height: imageData.height, data } as ImageData;
}

function fallbackPixelSimilarity(reference: ImageData, candidate: ImageData) {
  let squaredError = 0;
  let samples = 0;
  for (let index = 0; index < reference.data.length; index += 4) {
    for (let channel = 0; channel < 3; channel += 1) {
      const difference = reference.data[index + channel] - candidate.data[index + channel];
      squaredError += difference * difference;
      samples += 1;
    }
  }
  return samples ? Math.max(0, 1 - Math.sqrt(squaredError / samples) / 255) : 1;
}

function alphaBoundaryMask(imageData: ImageData, threshold = 0.42) {
  const { width, height } = imageData;
  const solid = new Uint8Array(width * height);
  const boundary = new Uint8Array(width * height);
  for (let pixel = 0; pixel < solid.length; pixel += 1) {
    solid[pixel] = imageData.data[pixel * 4 + 3] / 255 >= threshold ? 1 : 0;
  }
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      const current = solid[index];
      const neighbors = [
        x > 0 ? solid[index - 1] : 0,
        x + 1 < width ? solid[index + 1] : 0,
        y > 0 ? solid[index - width] : 0,
        y + 1 < height ? solid[index + width] : 0,
      ];
      if (neighbors.some((neighbor) => neighbor !== current)) boundary[index] = 1;
    }
  }
  return boundary;
}

function boundaryDistanceMap(boundary: Uint8Array, width: number, height: number) {
  const diagonal = Math.SQRT2;
  const maximum = width + height;
  const distances = new Float32Array(boundary.length);
  for (let index = 0; index < boundary.length; index += 1) {
    distances[index] = boundary[index] ? 0 : maximum;
  }
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      if (x > 0) distances[index] = Math.min(distances[index], distances[index - 1] + 1);
      if (y > 0) distances[index] = Math.min(distances[index], distances[index - width] + 1);
      if (x > 0 && y > 0) distances[index] = Math.min(distances[index], distances[index - width - 1] + diagonal);
      if (x + 1 < width && y > 0) distances[index] = Math.min(distances[index], distances[index - width + 1] + diagonal);
    }
  }
  for (let y = height - 1; y >= 0; y -= 1) {
    for (let x = width - 1; x >= 0; x -= 1) {
      const index = y * width + x;
      if (x + 1 < width) distances[index] = Math.min(distances[index], distances[index + 1] + 1);
      if (y + 1 < height) distances[index] = Math.min(distances[index], distances[index + width] + 1);
      if (x + 1 < width && y + 1 < height) distances[index] = Math.min(distances[index], distances[index + width + 1] + diagonal);
      if (x > 0 && y + 1 < height) distances[index] = Math.min(distances[index], distances[index + width - 1] + diagonal);
    }
  }
  return distances;
}

export function calculateContourSimilarity(reference: ImageData, candidate: ImageData) {
  if (reference.width !== candidate.width || reference.height !== candidate.height) return 0;
  const referenceBoundary = alphaBoundaryMask(reference);
  const candidateBoundary = alphaBoundaryMask(candidate);
  const referenceIndexes: number[] = [];
  const candidateIndexes: number[] = [];
  for (let index = 0; index < referenceBoundary.length; index += 1) {
    if (referenceBoundary[index]) referenceIndexes.push(index);
    if (candidateBoundary[index]) candidateIndexes.push(index);
  }
  if (!referenceIndexes.length && !candidateIndexes.length) return 1;
  if (!referenceIndexes.length || !candidateIndexes.length) return 0;
  const referenceDistances = boundaryDistanceMap(referenceBoundary, reference.width, reference.height);
  const candidateDistances = boundaryDistanceMap(candidateBoundary, candidate.width, candidate.height);
  const samples = [
    ...referenceIndexes.map((index) => candidateDistances[index]),
    ...candidateIndexes.map((index) => referenceDistances[index]),
  ].sort((first, second) => first - second);
  const mean = samples.reduce((sum, value) => sum + value, 0) / samples.length;
  const percentile90 = samples[Math.min(samples.length - 1, Math.floor(samples.length * 0.9))];
  const contourError = mean * 0.68 + percentile90 * 0.32;
  const tolerance = Math.max(1.5, Math.max(reference.width, reference.height) * 0.04);
  return Math.max(0, Math.min(1, 1 - contourError / tolerance));
}

export function calculateVectorSimilarity(
  reference: ImageData,
  candidate: ImageData,
): SimilarityMeasurement {
  if (reference.width !== candidate.width || reference.height !== candidate.height) {
    return { score: 0, structural: 0, shape: 0 };
  }

  let alphaError = 0;
  let alphaUnion = 0;
  let colorError = 0;
  let colorSamples = 0;
  for (let index = 0; index < reference.data.length; index += 4) {
    const referenceAlpha = reference.data[index + 3] / 255;
    const candidateAlpha = candidate.data[index + 3] / 255;
    const relevance = Math.max(referenceAlpha, candidateAlpha);
    alphaError += Math.abs(referenceAlpha - candidateAlpha);
    alphaUnion += relevance;
    if (relevance > 0.01) {
      for (let channel = 0; channel < 3; channel += 1) {
        colorError += Math.abs(reference.data[index + channel] - candidate.data[index + channel]) / 255 * relevance;
        colorSamples += relevance;
      }
    }
  }

  const alphaShape = alphaUnion ? Math.max(0, 1 - alphaError / alphaUnion) : 1;
  const contour = calculateContourSimilarity(reference, candidate);
  const shape = alphaShape * 0.42 + contour * 0.58;
  const color = colorSamples ? Math.max(0, 1 - colorError / colorSamples) : 1;
  const referenceMatte = matteOnWhite(reference);
  const candidateMatte = matteOnWhite(candidate);
  let structural = fallbackPixelSimilarity(referenceMatte, candidateMatte);
  try {
    const measured = ssim(referenceMatte, candidateMatte, { downsample: "original" }).mssim;
    if (Number.isFinite(measured)) structural = measured;
  } catch {
    // The alpha/shape comparison still provides a deterministic quality gate.
  }
  const score = Math.max(0, Math.min(1, shape * 0.62 + structural * 0.28 + color * 0.1));
  return { score, structural, shape };
}

async function renderSvgToImageData(svg: string, width: number, height: number) {
  const blob = new Blob([svg], { type: "image/svg+xml;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const image = new Image();
  image.decoding = "async";
  image.src = url;
  try {
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d", { alpha: true, willReadFrequently: true });
    if (!context) throw new Error("Браузер не предоставил Canvas 2D.");
    context.clearRect(0, 0, width, height);
    context.drawImage(image, 0, 0, width, height);
    return context.getImageData(0, 0, width, height);
  } finally {
    URL.revokeObjectURL(url);
  }
}

function comparisonImageData(imageData: ImageData, maxDimension = 512) {
  const scale = Math.min(1, maxDimension / Math.max(imageData.width, imageData.height));
  if (scale === 1) return imageData;
  const source = document.createElement("canvas");
  source.width = imageData.width;
  source.height = imageData.height;
  const sourceContext = source.getContext("2d", { alpha: true });
  if (!sourceContext) return imageData;
  sourceContext.putImageData(imageData, 0, 0);

  const target = document.createElement("canvas");
  target.width = Math.max(1, Math.round(imageData.width * scale));
  target.height = Math.max(1, Math.round(imageData.height * scale));
  const targetContext = target.getContext("2d", { alpha: true, willReadFrequently: true });
  if (!targetContext) return imageData;
  targetContext.imageSmoothingEnabled = true;
  targetContext.imageSmoothingQuality = "high";
  targetContext.drawImage(source, 0, 0, target.width, target.height);
  return targetContext.getImageData(0, 0, target.width, target.height);
}

function calculateMultiScaleSimilarity(
  reference: ImageData,
  candidate: ImageData,
): SimilarityMeasurement {
  const maxDimension = Math.max(reference.width, reference.height);
  const levels = (maxDimension <= 128
    ? [
        { maximum: maxDimension, weight: 0.9 },
        { maximum: 64, weight: 0.07 },
        { maximum: 32, weight: 0.03 },
      ]
    : [
        { maximum: maxDimension, weight: 0.68 },
        { maximum: 128, weight: 0.17 },
        { maximum: 64, weight: 0.1 },
        { maximum: 32, weight: 0.05 },
      ]).filter((level, index) => index === 0 || level.maximum < maxDimension);
  let totalWeight = 0;
  let score = 0;
  let structural = 0;
  let shape = 0;
  for (const level of levels) {
    const levelReference = level.maximum === maxDimension
      ? reference
      : comparisonImageData(reference, level.maximum);
    const levelCandidate = level.maximum === maxDimension
      ? candidate
      : comparisonImageData(candidate, level.maximum);
    const measurement = calculateVectorSimilarity(levelReference, levelCandidate);
    totalWeight += level.weight;
    score += measurement.score * level.weight;
    structural += measurement.structural * level.weight;
    shape += measurement.shape * level.weight;
  }
  return {
    score: score / totalWeight,
    structural: structural / totalWeight,
    shape: shape / totalWeight,
  };
}

async function selectMostSimilarCandidate(
  reference: ImageData,
  candidates: TraceCandidate[],
  detail: TraceDetail,
  geometryOnly = false,
) {
  const comparisonReference = geometryOnly
    ? canonicalizeMonochromeAlpha(reference)
    : reference;
  const scored: Array<Required<TraceCandidate> & { similarity: SimilarityMeasurement }> = [];
  for (const candidate of candidates) {
    try {
      const renderedSource = await renderSvgToImageData(candidate.svg, reference.width, reference.height);
      const rendered = geometryOnly
        ? canonicalizeMonochromeAlpha(renderedSource)
        : renderedSource;
      const nodeCount = candidate.nodeCount ?? countSvgNodes(candidate.svg);
      const draftNodeCount = candidate.draftNodeCount ?? nodeCount;
      const primitiveCount = candidate.primitiveCount ?? 0;
      const geometryScore = candidate.geometryScore ?? calculateGeometryCleanliness(
        nodeCount,
        draftNodeCount,
        primitiveCount,
        Math.max(1, candidate.pathCount),
        Math.max(reference.width, reference.height),
      );
      scored.push({
        ...candidate,
        nodeCount,
        draftNodeCount,
        primitiveCount,
        geometryScore,
        similarity: calculateMultiScaleSimilarity(comparisonReference, rendered),
      });
    } catch {
      // A candidate that the browser cannot render must never become the winner.
    }
  }
  if (!scored.length) throw new Error("Не удалось проверить сходство SVG с исходником.");
  scored.sort((first, second) => {
    const scoreDifference = second.similarity.score - first.similarity.score;
    if (Math.abs(scoreDifference) > 0.001) return scoreDifference;
    return first.svg.length - second.svg.length;
  });
  const bestScore = scored[0].similarity.score;
  const visualTolerance = detail === "precise" ? 0.0008 : detail === "balanced" ? 0.004 : 0.01;
  const visualWeight = detail === "precise" ? 0.96 : detail === "balanced" ? 0.8 : 0.65;
  const acceptanceFloor = bestScore - visualTolerance;
  const finalists = scored
    .filter((candidate) => candidate.similarity.score >= acceptanceFloor)
    .sort((first, second) => {
      const firstQuality = first.similarity.score * visualWeight + first.geometryScore * (1 - visualWeight);
      const secondQuality = second.similarity.score * visualWeight + second.geometryScore * (1 - visualWeight);
      if (Math.abs(secondQuality - firstQuality) > 0.001) return secondQuality - firstQuality;
      return first.svg.length - second.svg.length;
    });
  const best = finalists[0] ?? scored[0];
  return { best, candidatesTested: scored.length };
}

function traceColorImage(imageData: ImageData, settings: VectorizeSettings) {
  const detail = DETAIL_OPTIONS[settings.detail];
  const rawSvg = ImageTracer.imagedataToSVG(imageData, {
    ltres: detail.ltres,
    qtres: detail.qtres,
    pathomit: settings.removeSpecks ? detail.pathomit : 0,
    rightangleenhance: false,
    colorsampling: 2,
    numberofcolors: Math.min(24, Math.max(2, Math.round(settings.colors))),
    mincolorratio: settings.removeSpecks ? 0.01 : 0,
    colorquantcycles: 3,
    layering: 0,
    strokewidth: 0,
    linefilter: false,
    roundcoords: detail.roundcoords,
    viewbox: true,
    desc: false,
    blurradius: settings.detail === "compact" ? 1 : 0,
    blurdelta: 24,
  });
  return {
    ...compactTracedSvg(rawSvg, imageData.width, imageData.height),
    method: `color-${settings.detail}`,
    vectorMode: "outline" as const,
  };
}

export async function vectorizePng(
  file: File,
  settings: VectorizeSettings,
): Promise<VectorizeResult> {
  const startedAt = performance.now();
  const sourceUrl = URL.createObjectURL(file);
  const image = new Image();
  image.decoding = "async";
  image.src = sourceUrl;
  try {
    await image.decode();
  } catch {
    URL.revokeObjectURL(sourceUrl);
    throw new Error("Браузер не смог декодировать этот PNG.");
  }
  const sourceWidth = image.naturalWidth;
  const sourceHeight = image.naturalHeight;
  const detail = DETAIL_OPTIONS[settings.detail];
  const scale = Math.min(1, detail.maxDimension / Math.max(sourceWidth, sourceHeight));
  const traceWidth = Math.max(1, Math.round(sourceWidth * scale));
  const traceHeight = Math.max(1, Math.round(sourceHeight * scale));
  const canvas = document.createElement("canvas");
  canvas.width = traceWidth;
  canvas.height = traceHeight;
  const context = canvas.getContext("2d", { alpha: true, willReadFrequently: true });
  if (!context) {
    URL.revokeObjectURL(sourceUrl);
    throw new Error("Браузер не предоставил Canvas 2D.");
  }

  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.clearRect(0, 0, traceWidth, traceHeight);
  context.drawImage(image, 0, 0, traceWidth, traceHeight);
  const imageData = context.getImageData(0, 0, traceWidth, traceHeight);
  URL.revokeObjectURL(sourceUrl);

  for (let index = 0; index < imageData.data.length; index += 4) {
    if (imageData.data[index + 3] < 4) {
      imageData.data[index] = 255;
      imageData.data[index + 1] = 255;
      imageData.data[index + 2] = 255;
      imageData.data[index + 3] = 0;
    }
  }

  const analysis = analyzeTraceSource(imageData);
  const traceKind: TraceKind = settings.preset === "line-icon"
    ? "line-icon"
    : settings.preset === "auto"
      ? analysis.suggestedKind
      : "color";

  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  const candidates: TraceCandidate[] = [];
  if (traceKind === "line-icon") {
    const thresholds = settings.detail === "compact"
      ? [0.42, 0.58]
      : settings.detail === "balanced"
        ? [0.34, 0.48, 0.62]
        : [0.32, 0.46, 0.58, 0.7];
    candidates.push(traceLayeredLineIcon(
      imageData,
      analysis.inkColor,
      settings.detail,
      settings.removeSpecks,
    ));
    const geometryScale = Math.max(imageData.width, imageData.height) / 512;
    const geometryTolerances = (settings.detail === "precise"
      ? [0.55, 0.8, 1.05]
      : settings.detail === "balanced"
        ? [1, 1.4, 1.8]
        : [2, 2.8])
      .map((value) => value * geometryScale);
    const geometryTensions = settings.detail === "compact" ? [0.18] : [0.16, 0.21];
    for (const threshold of thresholds) {
      const draft = traceBinaryLineIcon(
        imageData,
        analysis.inkColor,
        settings.detail,
        settings.removeSpecks,
        threshold,
      );
      candidates.push(draft);
      for (const tolerance of geometryTolerances) {
        for (const tension of geometryTensions) {
          try {
            const reconstructed = reconstructSvgGeometry(
              draft.svg,
              imageData.width,
              imageData.height,
              {
                tolerance,
                tension,
                sampleSpacing: Math.max(0.65, 0.9 * geometryScale),
              },
            );
            candidates.push({
              ...reconstructed,
              colorCount: 1,
              pathCount: reconstructed.contourCount,
              method: `reconstruction-${threshold}-${tolerance}-${tension}`,
              vectorMode: "geometry",
            });
          } catch {
            // The untouched draft remains available when a contour cannot be reconstructed.
          }
        }
      }
    }
    const splineThresholds = imageData.width * imageData.height > 600_000
      ? thresholds.slice(0, 2)
      : thresholds;
    for (const threshold of splineThresholds) {
      try {
        candidates.push(await traceLineIcon(
          canvas,
          imageData,
          settings.detail,
          settings.removeSpecks,
          analysis.inkColor,
          threshold,
        ));
      } catch {
        // The quadratic candidates remain available if WASM cannot initialize.
      }
    }
  } else {
    candidates.push(traceColorImage(imageData, settings));
    if (settings.detail !== "precise") {
      candidates.push(traceColorImage(imageData, { ...settings, detail: "precise" }));
    }
  }
  const comparableSource = comparisonImageData(imageData);
  const selection = await selectMostSimilarCandidate(
    comparableSource,
    candidates,
    settings.detail,
    traceKind === "line-icon",
  );
  const compacted = selection.best;
  if (!compacted.pathCount || (!compacted.svg.includes("<path") && !compacted.svg.includes("<mask"))) {
    throw new Error("Не удалось найти непрозрачную графику в PNG.");
  }

  const svgBlob = new Blob([compacted.svg], { type: "image/svg+xml;charset=utf-8" });
  return {
    sourceName: file.name,
    sourceWidth,
    sourceHeight,
    traceWidth,
    traceHeight,
    sourceSize: file.size,
    svg: compacted.svg,
    svgBlob,
    svgSize: svgBlob.size,
    fileName: `${safeBaseName(file.name)}.svg`,
    pathCount: compacted.pathCount,
    colorCount: compacted.colorCount,
    durationMs: Math.round(performance.now() - startedAt),
    traceKind,
    vectorMode: compacted.vectorMode,
    traceLabel: compacted.vectorMode === "geometry"
      ? "Reconstruction · чистая геометрия"
      : compacted.vectorMode === "stroke"
        ? "Линейная иконка · восстановлен stroke"
      : traceKind === "line-icon"
        ? "Линейная иконка · точный контур"
        : "Цветная графика · проверено по PNG",
    similarity: compacted.similarity.score,
    structuralSimilarity: compacted.similarity.structural,
    shapeSimilarity: compacted.similarity.shape,
    candidatesTested: selection.candidatesTested,
    qualityTarget: VECTOR_SIMILARITY_TARGET,
    constructionKind: analysis.constructionKind,
    geometryScore: compacted.geometryScore,
    nodeCount: compacted.nodeCount,
    draftNodeCount: compacted.draftNodeCount,
    primitiveCount: compacted.primitiveCount,
  };
}
