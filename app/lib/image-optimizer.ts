import ssim from "ssim.js";
import { decodeHeicBitmap, isHeicFile } from "./heic-decoder";

export type UsageProfile =
  | "480-640"
  | "768-1024"
  | "1280-1440"
  | "1680-1920"
  | "custom";
export type OutputFormat = "avif" | "webp" | "png";
export type OptimizationMode = "photo" | "screenshot" | "transparent-png";
export type QualityTier = "q65" | "q80" | "q85" | "custom";
export const MAX_BATCH_FILES = 10;

export function getUploadCandidates<T>(files: T[], existingCount: number) {
  return files.slice(0, Math.max(0, MAX_BATCH_FILES - existingCount));
}

export interface CropSettings {
  aspectRatio: number | null;
  positionX: number;
  positionY: number;
  // Fractions of the original image; position remains independent of size.
  size?: { width: number; height: number };
}

export interface CropRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ImageProfile {
  id: UsageProfile;
  title: string;
  description: string;
  widths: number[];
  sizes: string;
}

export interface EncodedVariant {
  format: OutputFormat;
  mime: string;
  extension: string;
  blob: Blob;
  size: number;
  quality: number | null;
  similarity: number | null;
  similarityMethod: "ssim" | "pixel" | "unavailable";
  fileName: string;
}

export interface WidthResult {
  width: number;
  height: number;
  variants: EncodedVariant[];
}

export interface OptimizationResult {
  sourceName: string;
  originalWidth: number;
  originalHeight: number;
  originalSize: number;
  profile: ImageProfile;
  crop: CropSettings;
  mode: OptimizationMode;
  results: WidthResult[];
  warnings: string[];
}

export interface PreparedPng {
  file: File;
  key: string;
  originalWidth: number;
  originalHeight: number;
  outputs: Array<{ width: number; height: number; blob: Blob; fileName: string }>;
}

export function preparedPngKey(crop: CropSettings, profile: ImageProfile) {
  return JSON.stringify([crop.aspectRatio, crop.positionX, crop.positionY, crop.size ?? null, profile.widths]);
}

// Encode the target bytes directly: no Canvas premultiplication round trip.
export async function encodeRgbaPng(data: ImageData): Promise<Blob> {
  if (typeof CompressionStream === "undefined") {
    throw new Error("Браузер не поддерживает точное сохранение PNG (CompressionStream).");
  }
  const { width, height } = data;
  const stride = width * 4;
  const rows = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    rows.set(data.data.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  const compressed = new Uint8Array(await new Response(
    new Blob([rows]).stream().pipeThrough(new CompressionStream("deflate")),
  ).arrayBuffer());
  function chunk(name: string, payload: Uint8Array<ArrayBuffer>) {
    const bytes = new Uint8Array(payload.length + 12);
    const view = new DataView(bytes.buffer);
    view.setUint32(0, payload.length);
    for (let i = 0; i < 4; i += 1) bytes[4 + i] = name.charCodeAt(i);
    bytes.set(payload, 8);
    let crc = 0xffffffff;
    for (let i = 4; i < bytes.length - 4; i += 1) {
      crc ^= bytes[i];
      for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    view.setUint32(bytes.length - 4, (crc ^ 0xffffffff) >>> 0);
    return bytes;
  }
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header[8] = 8;
  header[9] = 6; // 8-bit RGBA, including hidden RGB under alpha=0.
  return new Blob([
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header), chunk("IDAT", compressed), chunk("IEND", new Uint8Array()),
  ], { type: "image/png" });
}

export async function prepareTransparentPng(options: {
  file: File; profile: ImageProfile; crop: CropSettings; prepared?: PreparedPng | null;
}): Promise<PreparedPng> {
  const { file, profile, crop, prepared } = options;
  const key = preparedPngKey(crop, profile);
  if (prepared?.file === file && prepared.key === key) return prepared;
  const bitmap = await createSourceBitmap(file);
  try {
    if (bitmap.width * bitmap.height > 50_000_000) throw new Error("Изображение больше 50 мегапикселей.");
    const rect = calculateCropRect(bitmap.width, bitmap.height, crop);
    const widths = buildTargetWidths(rect.width, profile);
    if (!widths.length) throw new Error("Выбранные размеры недоступны без увеличения кадра.");
    const outputs: PreparedPng["outputs"] = [];
    for (const width of widths) {
      const { height } = calculateOutputDimensions(rect, width);
      const raster = width <= rect.width && height <= rect.height && (width < rect.width || height < rect.height)
        ? await resizeGraphicsPng(bitmap, rect, width)
        : createResizedCanvas(bitmap, rect, width).getContext("2d")!.getImageData(0, 0, width, height);
      const blob = await encodeRgbaPng(raster);
      outputs.push({ width, height, blob, fileName: createVariantFileName(width, height, "png", null) });
    }
    return { file, key, originalWidth: Math.round(rect.width), originalHeight: Math.round(rect.height), outputs };
  } finally {
    bitmap.close();
  }
}

export const IMAGE_PROFILES: ImageProfile[] = [
  { id: "1680-1920", title: "1920 · 1680 px", description: "", widths: [1920, 1680], sizes: "100vw" },
  { id: "1280-1440", title: "1440 · 1280 px", description: "", widths: [1440, 1280], sizes: "100vw" },
  { id: "768-1024", title: "1024 · 768 px", description: "", widths: [1024, 768], sizes: "100vw" },
  { id: "480-640", title: "640 · 480 px", description: "", widths: [640, 480], sizes: "100vw" },
  { id: "custom", title: "СВОЙ РАЗМЕР", description: "", widths: [360], sizes: "360px" },
];

export function getAvailableImageProfiles(maxWidth: number) {
  const safeMaxWidth = Math.max(1, Math.floor(maxWidth));
  return IMAGE_PROFILES.filter(
    (profile) =>
      profile.id === "custom" || profile.widths.some((width) => width <= safeMaxWidth),
  );
}

export function createCustomProfile(
  width: number,
  maxWidth = 2560,
) {
  const safeMaxWidth = Math.max(1, Math.min(2560, Math.floor(maxWidth)));
  const exactWidth = Math.round(width);
  if (!Number.isFinite(width) || !Number.isInteger(width) || width < 32 || width > safeMaxWidth) {
    throw new Error(`Укажите ширину от 32 до ${safeMaxWidth}px без увеличения.`);
  }
  return {
    id: "custom",
    title: "Свой размер",
    description: `Блок шириной ${exactWidth}px`,
    widths: [exactWidth],
    sizes: `${exactWidth}px`,
  } satisfies ImageProfile;
}

const MIME: Record<OutputFormat, string> = {
  avif: "image/avif",
  webp: "image/webp",
  png: "image/png",
};

const EXTENSION: Record<OutputFormat, string> = {
  avif: "avif",
  webp: "webp",
  png: "png",
};

export function createVariantFileName(
  width: number,
  height: number,
  format: OutputFormat,
  quality: number | null,
  ordinal?: number,
) {
  const prefix = ordinal === undefined
    ? "img"
    : `img-${String(Math.max(1, Math.floor(ordinal))).padStart(2, "0")}`;
  const qualityPart = format === "png" || quality === null ? "" : `-q${quality}`;
  return `${prefix}-${width}x${height}${qualityPart}.${EXTENSION[format]}`;
}

export function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} Б`;
  const units = ["КБ", "МБ", "ГБ"];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${units[unitIndex]}`;
}

export function buildTargetWidths(originalWidth: number, profile: ImageProfile) {
  const availableWidth = Math.floor(originalWidth);
  return [...new Set(profile.widths)]
    .filter((width) => Number.isInteger(width) && width > 0 && width <= availableWidth)
    .sort((a, b) => b - a);
}

export function selectResultWidth(
  result: OptimizationResult,
  width: number | null,
) {
  if (width === null) return result;
  const selectedResults = result.results.filter((item) => item.width === width);
  if (!selectedResults.length) return result;

  return {
    ...result,
    profile: {
      ...result.profile,
      widths: [width],
      sizes: `${width}px`,
    },
    results: selectedResults,
  } satisfies OptimizationResult;
}

export function calculateCropRect(
  sourceWidth: number,
  sourceHeight: number,
  crop: CropSettings,
): CropRect {
  const positionX = Math.min(100, Math.max(0, crop.positionX)) / 100;
  const positionY = Math.min(100, Math.max(0, crop.positionY)) / 100;
  let width = sourceWidth * Math.min(1, Math.max(1 / sourceWidth, crop.size?.width ?? 1));
  let height = sourceHeight * Math.min(1, Math.max(1 / sourceHeight, crop.size?.height ?? 1));
  if (crop.aspectRatio && crop.aspectRatio > 0) {
    if (width / height > crop.aspectRatio) width = height * crop.aspectRatio;
    else height = width / crop.aspectRatio;
  }
  return {
    x: (sourceWidth - width) * positionX,
    y: (sourceHeight - height) * positionY,
    width,
    height,
  };
}

export function calculateOutputDimensions(cropRect: CropRect, targetWidth: number) {
  if (!Number.isInteger(targetWidth) || targetWidth < 1 || targetWidth > Math.floor(cropRect.width)) {
    throw new Error("Выбранная ширина требует увеличения кадра.");
  }
  return {
    width: targetWidth,
    height: Math.max(1, Math.round((targetWidth / cropRect.width) * cropRect.height)),
  };
}

export type CropResizeHandle = "n" | "s" | "e" | "w" | "nw" | "ne" | "sw" | "se";

export function cropSettingsFromRect(
  rect: CropRect,
  sourceWidth: number,
  sourceHeight: number,
  aspectRatio: number | null,
): CropSettings {
  return {
    aspectRatio,
    positionX: sourceWidth > rect.width ? (rect.x / (sourceWidth - rect.width)) * 100 : 50,
    positionY: sourceHeight > rect.height ? (rect.y / (sourceHeight - rect.height)) * 100 : 50,
    size: { width: rect.width / sourceWidth, height: rect.height / sourceHeight },
  };
}

// Resize from the pointer-down rectangle, with the opposite edge/corner anchored.
export function resizeCropRect(
  rect: CropRect,
  handle: CropResizeHandle,
  deltaX: number,
  deltaY: number,
  sourceWidth: number,
  sourceHeight: number,
  aspectRatio: number | null,
): CropRect {
  const horizontal = handle.includes("w") ? -1 : handle.includes("e") ? 1 : 0;
  const vertical = handle.includes("n") ? -1 : handle.includes("s") ? 1 : 0;
  const anchorX = horizontal < 0 ? rect.x + rect.width : horizontal > 0 ? rect.x : rect.x + rect.width / 2;
  const anchorY = vertical < 0 ? rect.y + rect.height : vertical > 0 ? rect.y : rect.y + rect.height / 2;
  const maxWidth = horizontal < 0 ? anchorX : horizontal > 0 ? sourceWidth - anchorX : 2 * Math.min(anchorX, sourceWidth - anchorX);
  const maxHeight = vertical < 0 ? anchorY : vertical > 0 ? sourceHeight - anchorY : 2 * Math.min(anchorY, sourceHeight - anchorY);
  const wantedWidth = rect.width + horizontal * deltaX;
  const wantedHeight = rect.height + vertical * deltaY;
  let width = rect.width;
  let height = rect.height;
  if (horizontal && vertical) {
    const ratio = aspectRatio && aspectRatio > 0 ? aspectRatio : rect.width / rect.height;
    // Project both pointer axes onto one proportional size, then clamp that size.
    const wanted = (wantedWidth + wantedHeight / ratio) / (1 + 1 / ratio ** 2);
    const maximum = Math.min(maxWidth, maxHeight * ratio);
    width = Math.min(maximum, Math.max(Math.min(32, maximum), wanted));
    height = width / ratio;
  } else {
    if (horizontal) width = Math.min(maxWidth, Math.max(Math.min(32, maxWidth), wantedWidth));
    if (vertical) height = Math.min(maxHeight, Math.max(Math.min(32, maxHeight), wantedHeight));
  }
  return {
    x: horizontal < 0 ? anchorX - width : horizontal > 0 ? anchorX : anchorX - width / 2,
    y: vertical < 0 ? anchorY - height : vertical > 0 ? anchorY : anchorY - height / 2,
    width,
    height,
  };
}

function createResizedCanvas(
  source: CanvasImageSource,
  cropRect: CropRect,
  targetWidth: number,
) {
  const { width: outputWidth, height: targetHeight } = calculateOutputDimensions(cropRect, targetWidth);
  const canvas = document.createElement("canvas");
  canvas.width = outputWidth;
  canvas.height = targetHeight;
  const context = canvas.getContext("2d", {
    alpha: true,
    willReadFrequently: true,
  });
  if (!context) throw new Error("Браузер не предоставил Canvas 2D.");
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.drawImage(
    source,
    cropRect.x,
    cropRect.y,
    cropRect.width,
    cropRect.height,
    0,
    0,
    targetWidth,
    targetHeight,
  );
  return canvas;
}

function lanczos3(distance: number) {
  const x = Math.abs(distance);
  if (x === 0) return 1;
  if (x >= 3) return 0;
  const angle = Math.PI * x;
  return (Math.sin(angle) / angle) * (Math.sin(angle / 3) / (angle / 3));
}

async function resizeGraphicsPng(source: ImageBitmap, crop: CropRect, targetWidth: number) {
  const { width, height } = calculateOutputDimensions(crop, targetWidth);
  if (width > crop.width || height > crop.height || (width === crop.width && height === crop.height)) {
    throw new Error("Lanczos применяется только при уменьшении изображения.");
  }
  let deadline = performance.now() + 12;
  const yieldIfNeeded = async () => {
    if (performance.now() < deadline) return;
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    deadline = performance.now() + 12;
  };
  const axis = async (offset: number, extent: number, count: number, index: number, limit: number) => {
    const scale = extent / count;
    const center = offset + (index + 0.5) * scale - 0.5;
    const first = Math.ceil(center - 3 * scale);
    const last = Math.floor(center + 3 * scale);
    const weights = new Float64Array(last - first + 1);
    let sum = 0;
    for (let i = first; i <= last; i++) {
      sum += weights[i - first] = lanczos3((i - center) / scale);
      if ((i - first + 1) % 16384 === 0) await yieldIfNeeded();
    }
    for (let i = 0; i < weights.length; i++) weights[i] /= sum;
    return {
      first, last, weights,
      footprintFirst: Math.max(0, Math.floor(offset + index * scale)),
      footprintLast: Math.min(limit - 1, Math.ceil(offset + (index + 1) * scale) - 1),
    };
  };
  type Axis = Awaited<ReturnType<typeof axis>>;
  const horizontalAxes = new Map<number, Axis>();
  let coefficientBytes = 0;
  const rows = new Map<number, { pixels: Float32Array; bounds: Uint8Array }>();
  const tiles = new Map<string, ImageData>();
  let currentTile: ImageData | undefined;
  let currentTileX = -1, currentTileY = -1;
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d", { alpha: true, willReadFrequently: true });
  if (!context) throw new Error("Не удалось прочитать пиксели изображения.");
  // At most eight 1024x64 tiles (2 MiB), read 1:1. No Canvas resize.
  const pixel = (x: number, y: number) => {
    const tx = Math.floor(x / 1024) * 1024;
    const ty = Math.floor(y / 64) * 64;
    const key = tx === currentTileX && ty === currentTileY ? "" : `${tx}:${ty}`;
    let tile = key === "" ? currentTile : tiles.get(key);
    if (!tile) {
      canvas.width = Math.min(1024, source.width - tx);
      canvas.height = Math.min(64, source.height - ty);
      context.drawImage(source, tx, ty, canvas.width, canvas.height, 0, 0, canvas.width, canvas.height);
      tile = context.getImageData(0, 0, canvas.width, canvas.height);
      if (tiles.size === 8) tiles.delete(tiles.keys().next().value!);
      tiles.set(key, tile);
    }
    currentTile = tile; currentTileX = tx; currentTileY = ty;
    return { data: tile.data, offset: ((y - ty) * tile.width + x - tx) * 4, endX: tx + tile.width };
  };
  const horizontalRow = async (y: number) => {
    const pixels = new Float32Array(width * 4);
    // Per-source-row footprint extrema: min/max RGBA, ignoring hidden RGB.
    const bounds = new Uint8Array(width * 8);
    for (let x = 0; x < width; x++) {
      let taps = horizontalAxes.get(x);
      if (!taps) {
        taps = await axis(crop.x, crop.width, width, x, source.width);
        if (coefficientBytes + taps.weights.byteLength <= 1024 * 1024) {
          horizontalAxes.set(x, taps);
          coefficientBytes += taps.weights.byteLength;
        }
      }
      let r = 0, g = 0, b = 0, a = 0;
      for (let i = taps.first; i <= taps.last;) {
        const sx = Math.max(0, Math.min(source.width - 1, i));
        const sample = pixel(sx, y);
        const end = i < 0 ? Math.min(-1, taps.last)
          : i >= source.width ? taps.last : Math.min(sample.endX - 1, taps.last);
        let offset = sample.offset;
        for (; i <= end; i++) {
          const aw = sample.data[offset + 3] / 255 * taps.weights[i - taps.first];
          r += sample.data[offset] * aw; g += sample.data[offset + 1] * aw; b += sample.data[offset + 2] * aw; a += aw;
          if (i >= 0 && i < source.width - 1) offset += 4;
        }
      }
      pixels.set([r, g, b, a], x * 4);
      const base = x * 8;
      bounds.set([255, 0, 255, 0, 255, 0, 255, 0], base);
      for (let i = taps.footprintFirst; i <= taps.footprintLast;) {
        const sample = pixel(i, y);
        const end = Math.min(sample.endX - 1, taps.footprintLast);
        let offset = sample.offset;
        for (; i <= end; i++, offset += 4) {
          for (let c = 0; c < 4; c++) {
            if (c < 3 && sample.data[offset + 3] === 0) continue;
            bounds[base + c * 2] = Math.min(bounds[base + c * 2], sample.data[offset + c]);
            bounds[base + c * 2 + 1] = Math.max(bounds[base + c * 2 + 1], sample.data[offset + c]);
          }
        }
      }
      if ((x + 1) % 32 === 0) await yieldIfNeeded();
    }
    return { pixels, bounds };
  };
  const output = new Uint8ClampedArray(width * height * 4);
  try {
    for (let y = 0; y < height; y++) {
      const taps = await axis(crop.y, crop.height, height, y, source.height);
      const first = Math.max(0, taps.first);
      const last = Math.min(source.height - 1, taps.last);
      for (const key of rows.keys()) if (key < first) rows.delete(key);
      for (let row = first; row <= last; row++) {
        if (!rows.has(row)) rows.set(row, await horizontalRow(row));
      }
      for (let x = 0; x < width; x++) {
        const sums = [0, 0, 0, 0];
        for (let i = taps.first; i <= taps.last; i++) {
          const row = rows.get(Math.max(0, Math.min(source.height - 1, i)))!;
          const weight = taps.weights[i - taps.first];
          for (let c = 0; c < 4; c++) sums[c] += row.pixels[x * 4 + c] * weight;
        }
        const alpha = Math.max(0, Math.min(1, sums[3]));
        const offset = (y * width + x) * 4;
        output[offset + 3] = Math.round(alpha * 255);
        for (let c = 0; c < 3; c++) {
          output[offset + c] = output[offset + 3] === 0 ? 0
            : Math.round(Math.max(0, Math.min(255 * alpha, sums[c])) / alpha);
        }
        // Audited anti-ringing: local source pixel footprint, not the wider
        // negative-lobe kernel support and not a global 0..255 clamp.
        for (let c = 0; c < 4; c++) {
          let min = 255, max = 0;
          for (let i = taps.footprintFirst; i <= taps.footprintLast; i++) {
            const bounds = rows.get(i)!.bounds;
            min = Math.min(min, bounds[x * 8 + c * 2]);
            max = Math.max(max, bounds[x * 8 + c * 2 + 1]);
          }
          output[offset + c] = Math.max(min, Math.min(max, output[offset + c]));
        }
        if (output[offset + 3] === 0) output.fill(0, offset, offset + 3);
        if ((x + 1) % 128 === 0) await yieldIfNeeded();
      }
      await yieldIfNeeded();
    }
    return new ImageData(output, width, height);
  } finally {
    rows.clear(); tiles.clear(); horizontalAxes.clear();
    canvas.width = 0; canvas.height = 0;
  }
}

function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality?: number) {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          reject(new Error(`Не удалось создать ${type}.`));
          return;
        }
        const actualType = blob.type.toLowerCase().split(";", 1)[0];
        const typeMatches = actualType === type;
        if (!typeMatches) {
          reject(new Error(`Формат ${type} не поддерживается этим браузером.`));
          return;
        }
        resolve(blob);
      },
      type,
      quality === undefined ? undefined : quality / 100,
    );
  });
}

async function encodeAvif(canvas: HTMLCanvasElement, quality: number) {
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("Не удалось прочитать пиксели изображения.");
  const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
  const { encodeAvifInWorker } = await import("./avif-worker-client");
  const buffer = await encodeAvifInWorker(imageData, quality);
  return new Blob([buffer], { type: MIME.avif });
}

async function encodeCanvas(
  canvas: HTMLCanvasElement,
  format: OutputFormat,
  quality: number | null,
) {
  if (format === "png") {
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("Не удалось прочитать пиксели изображения.");
    // Only the current output's pixels live here, until encoding completes.
    return encodePng(context.getImageData(0, 0, canvas.width, canvas.height));
  }
  if (quality === null) throw new Error("Не указано качество кодирования.");
  if (format === "avif") return encodeAvif(canvas, quality);
  return canvasToBlob(canvas, MIME[format], quality);
}

async function encodePng(data: ArrayBuffer | ImageData) {
  const { default: optimise } = await import("@jsquash/oxipng/optimise");
  const buffer = await optimise(data, {
    level: 2,
    optimiseAlpha: false,
    interlace: false,
  });
  return new Blob([buffer], { type: MIME.png });
}

async function hasOriginalPngDimensions(file: File, width: number, height: number) {
  const header = await file.slice(0, 24).arrayBuffer();
  const signature = new Uint8Array(header);
  if (signature.length < 24 ||
    ![137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => signature[index] === byte)) {
    return false;
  }
  const view = new DataView(header);
  return view.getUint32(12) === 0x49484452 && // IHDR
    view.getUint32(16) === width && view.getUint32(20) === height;
}

function comparisonImageData(
  source: CanvasImageSource,
  sourceWidth: number,
  sourceHeight: number,
  forcedWidth?: number,
  forcedHeight?: number,
) {
  const compareWidth = forcedWidth ?? Math.min(420, sourceWidth);
  const compareHeight =
    forcedHeight ??
    Math.max(1, Math.round((compareWidth / sourceWidth) * sourceHeight));
  const canvas = document.createElement("canvas");
  canvas.width = compareWidth;
  canvas.height = compareHeight;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("Не удалось сравнить изображения.");
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.drawImage(source, 0, 0, compareWidth, compareHeight);
  return context.getImageData(0, 0, compareWidth, compareHeight);
}

function loadBlobImage(blob: Blob) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const image = new Image();
    image.decoding = "async";
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Браузер не смог открыть созданный файл для проверки."));
    };
    image.src = url;
  });
}

async function candidateImageData(
  candidate: Blob,
  width: number,
  height: number,
) {
  try {
    const bitmap = await createImageBitmap(candidate);
    try {
      return comparisonImageData(
        bitmap,
        bitmap.width,
        bitmap.height,
        width,
        height,
      );
    } finally {
      bitmap.close();
    }
  } catch {
    const image = await loadBlobImage(candidate);
    return comparisonImageData(
      image,
      image.naturalWidth,
      image.naturalHeight,
      width,
      height,
    );
  }
}

function pixelSimilarity(reference: ImageData, candidate: ImageData) {
  if (
    reference.width !== candidate.width ||
    reference.height !== candidate.height
  ) {
    return 0;
  }

  let squaredError = 0;
  let samples = 0;
  for (let index = 0; index < reference.data.length; index += 4) {
    const red = reference.data[index] - candidate.data[index];
    const green = reference.data[index + 1] - candidate.data[index + 1];
    const blue = reference.data[index + 2] - candidate.data[index + 2];
    squaredError += red * red + green * green + blue * blue;
    samples += 3;
  }

  const normalizedRmse = Math.sqrt(squaredError / samples) / 255;
  return Math.max(0, Math.min(1, 1 - normalizedRmse));
}

async function measureSimilarity(reference: HTMLCanvasElement, candidate: Blob) {
  const referenceData = comparisonImageData(
    reference,
    reference.width,
    reference.height,
  );
  const candidateData = await candidateImageData(
    candidate,
    referenceData.width,
    referenceData.height,
  );

  try {
    const score = ssim(referenceData, candidateData, {
      downsample: "original",
    }).mssim;
    if (Number.isFinite(score)) {
      return { score, method: "ssim" as const };
    }
  } catch {
    // Some browsers fail inside ssim.js even though the encoded file is valid.
  }

  return {
    score: pixelSimilarity(referenceData, candidateData),
    method: "pixel" as const,
  };
}

async function encodeVariant(
  canvas: HTMLCanvasElement,
  format: OutputFormat,
  quality: number | null,
  originalPng?: File,
  pngPixels?: ImageData,
) {
  const unchangedPng = format === "png" ? originalPng : undefined;
  const encodedBlob = unchangedPng
    ? await encodePng(await unchangedPng.arrayBuffer())
    : format === "png" && pngPixels ? await encodePng(pngPixels)
      : await encodeCanvas(canvas, format, quality);
  const blob = unchangedPng && unchangedPng.size <= encodedBlob.size
    ? unchangedPng
    : encodedBlob;
  // The unchanged PNG path is lossless and never rasterizes its output through
  // Canvas, including for similarity measurement (which can round RGB).
  let similarity: number | null = unchangedPng ? 1 : null;
  let similarityMethod: EncodedVariant["similarityMethod"] = unchangedPng ? "pixel" : "unavailable";
  if (!unchangedPng) {
    try {
      const measurement = await measureSimilarity(canvas, blob);
      similarity = measurement.score;
      similarityMethod = measurement.method;
    } catch {
      // Encoding succeeded. Keep the valid file even if this browser cannot
      // decode it a second time to measure similarity.
    }
  }
  return {
    format,
    mime: MIME[format],
    extension: EXTENSION[format],
    blob,
    size: blob.size,
    quality,
    similarity,
    similarityMethod,
    fileName: createVariantFileName(canvas.width, canvas.height, format, format === "png" ? null : quality),
  } satisfies EncodedVariant;
}

export const DEFAULT_ENCODER_QUALITY = 80;

export function parseCustomQuality(value: string) {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const quality = Number(trimmed);
  return Number.isInteger(quality) && quality >= 1 && quality <= 100 ? quality : null;
}

export function resolveEncoderQuality(tier: QualityTier, customValue: string) {
  if (tier === "q65") return 65;
  if (tier === "q80") return 80;
  if (tier === "q85") return 85;
  const quality = parseCustomQuality(customValue);
  if (quality === null) throw new Error("Введите целое число от 1 до 100");
  return quality;
}

export function outputSelectionKey(width: number, height: number, variant: EncodedVariant) {
  return `${width}x${height}:${variant.format}:${variant.quality ?? "lossless"}`;
}

export function defaultOutputSelection(result: OptimizationResult, width = result.results[0]?.width) {
  const output = result.results.find((item) => item.width === width);
  const variant = output?.variants.find((item) => item.format === "avif") ?? output?.variants[0];
  return output && variant ? [outputSelectionKey(output.width, output.height, variant)] : [];
}

export function toggleOutputSelection(keys: string[], key: string) {
  return keys.includes(key) ? keys.filter((item) => item !== key) : [...keys, key];
}

export function selectedResultOutputs(result: OptimizationResult | null, keys: string[]) {
  return result?.results.flatMap((output) => output.variants
    .filter((variant) => keys.includes(outputSelectionKey(output.width, output.height, variant)))
    .map((variant) => ({ width: output.width, height: output.height, variant }))) ?? [];
}

export function outputDownloadLabel(outputs: ReturnType<typeof selectedResultOutputs>) {
  if (outputs.length > 1) return "СКАЧАТЬ ВСЕ";
  const output = outputs[0];
  return output
    ? `СКАЧАТЬ ${output.width}×${output.height} ${output.variant.format.toUpperCase()}`
    : "СКАЧАТЬ";
}

async function createSourceBitmap(file: File) {
  if (isHeicFile(file)) return decodeHeicBitmap(file);
  return createImageBitmap(file, { imageOrientation: "from-image" });
}

export async function optimizeImage(options: {
  file: File;
  profile: ImageProfile;
  crop: CropSettings;
  mode?: OptimizationMode;
  quality?: number;
  prepared?: PreparedPng | null;
  onPrepared?: (prepared: PreparedPng) => void;
  onProgress?: (percent: number, message: string) => void;
}) {
  const { file, profile, crop, mode = "photo", quality = DEFAULT_ENCODER_QUALITY, onProgress } = options;
  if (mode === "transparent-png") {
    const prepared = await prepareTransparentPng(options);
    options.onPrepared?.(prepared);
    const results: WidthResult[] = [];
    for (const output of prepared.outputs) {
      let blob: Blob;
      try { blob = await encodePng(await output.blob.arrayBuffer()); }
      catch { throw new Error("Не удалось оптимизировать PNG. Уменьшенный PNG остаётся доступным для скачивания."); }
      results.push({ width: output.width, height: output.height, variants: [{
        format: "png", mime: "image/png", extension: "png", blob, size: blob.size,
        quality: null, similarity: null, similarityMethod: "unavailable", fileName: output.fileName,
      }] });
    }
    onProgress?.(100, "PNG готов");
    return {
      sourceName: file.name, originalWidth: prepared.originalWidth, originalHeight: prepared.originalHeight,
      originalSize: file.size, profile, crop, mode, results, warnings: [],
    } satisfies OptimizationResult;
  }
  if (!Number.isInteger(quality) || quality < 1 || quality > 100) {
    throw new Error("Введите целое качество от 1 до 100.");
  }
  const bitmap = await createSourceBitmap(file);
  const warnings: string[] = [];

  try {
    if (bitmap.width * bitmap.height > 50_000_000) {
      throw new Error("Изображение больше 50 мегапикселей. Уменьшите исходник и попробуйте снова.");
    }

    const cropRect = calculateCropRect(bitmap.width, bitmap.height, crop);
    const croppedWidth = Math.max(1, Math.round(cropRect.width));
    const croppedHeight = Math.max(1, Math.round(cropRect.height));
    const widths = buildTargetWidths(cropRect.width, profile);
    if (!widths.length) throw new Error("Выбранные размеры недоступны без увеличения кадра.");
    const formats: OutputFormat[] = mode === "photo"
      ? ["avif", "webp"]
      : ["avif", "webp", "png"];

    if (croppedWidth < Math.max(...profile.widths)) {
      warnings.push(`После кадрирования доступно ${croppedWidth}px по ширине. Изображение не будет увеличено.`);
    }

    const results: WidthResult[] = [];
    for (let widthIndex = 0; widthIndex < widths.length; widthIndex += 1) {
      const width = widths[widthIndex];
      const canvas = createResizedCanvas(bitmap, cropRect, width);
      const variants: EncodedVariant[] = [];
      const unchangedPng = cropRect.x === 0 && cropRect.y === 0 &&
        cropRect.width === bitmap.width && cropRect.height === bitmap.height &&
        canvas.width === bitmap.width && canvas.height === bitmap.height &&
        await hasOriginalPngDimensions(file, bitmap.width, bitmap.height);

      for (const format of formats) {
          try {
            variants.push(await encodeVariant(
              canvas,
              format,
              format === "png" ? null : quality,
              format === "png" && unchangedPng ? file : undefined,
              format === "png" && mode === "screenshot" &&
                canvas.width <= cropRect.width && canvas.height <= cropRect.height &&
                (canvas.width < cropRect.width || canvas.height < cropRect.height)
                ? await resizeGraphicsPng(bitmap, cropRect, width) : undefined,
            ));
          } catch (error) {
            warnings.push(`${format.toUpperCase()} ${width}px пропущен: ${error instanceof Error ? error.message : "ошибка"}`);
          }
      }

      if (!variants.length) {
        throw new Error(`Не удалось подготовить варианты шириной ${width}px.`);
      }
      results.push({ width: canvas.width, height: canvas.height, variants });
      onProgress?.(10 + Math.round(((widthIndex + 1) / widths.length) * 88), `Готовим ${width}px для сайта…`);
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    }

    if (results.some((widthResult) => widthResult.variants.some((variant) => variant.similarity === null))) {
      warnings.push("Для части файлов метрика сходства недоступна.");
    }

    onProgress?.(100, "Комплект готов");
    return {
      sourceName: file.name,
      originalWidth: croppedWidth,
      originalHeight: croppedHeight,
      originalSize: file.size,
      profile,
      crop,
      mode,
      results,
      warnings: [...new Set(warnings)],
    } satisfies OptimizationResult;
  } finally {
    bitmap.close();
  }
}
