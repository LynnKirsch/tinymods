import ssim from "ssim.js";

export type UsageProfile =
  | "hero"
  | "two-columns"
  | "three-columns"
  | "four-columns"
  | "five-columns"
  | "custom";
export type OutputFormat = "avif" | "webp" | "png";
type LossyOutputFormat = Exclude<OutputFormat, "png">;
export type OptimizationMode = "photo" | "screenshot";
export type QualityTier = "lighter" | "recommended" | "detail";
export type QualitySelection = Partial<Record<OutputFormat, QualityTier>>;
export type ArchiveFileSelection = `${OutputFormat}:${number}`;

export interface CropSettings {
  aspectRatio: number | null;
  positionX: number;
  positionY: number;
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
  quality: number;
  tier: QualityTier;
  similarity: number | null;
  similarityMethod: "ssim" | "pixel" | "unavailable";
  fileName: string;
}

export interface WidthResult {
  width: number;
  height: number;
  variants: EncodedVariant[];
  recommended: EncodedVariant;
}

export interface OptimizationResult {
  sourceName: string;
  originalWidth: number;
  originalHeight: number;
  originalSize: number;
  profile: ImageProfile;
  crop: CropSettings;
  threshold: number;
  mode: OptimizationMode;
  results: WidthResult[];
  warnings: string[];
}

export const IMAGE_PROFILES: ImageProfile[] = [
  {
    id: "hero",
    title: "Первый экран",
    description: "Фотография на всю ширину окна",
    widths: [1680, 1920],
    sizes: "100vw",
  },
  {
    id: "two-columns",
    title: "Две колонки",
    description: "Две крупные карточки в ряд",
    widths: [1200, 1400],
    sizes: "(min-width: 1024px) 50vw, 100vw",
  },
  {
    id: "three-columns",
    title: "Три колонки",
    description: "Три карточки в ряд",
    widths: [800, 1000],
    sizes: "(min-width: 1024px) 33vw, (min-width: 640px) 50vw, 100vw",
  },
  {
    id: "four-columns",
    title: "Четыре колонки",
    description: "Четыре карточки в ряд",
    widths: [600, 800],
    sizes: "(min-width: 1200px) 25vw, (min-width: 640px) 50vw, 100vw",
  },
  {
    id: "five-columns",
    title: "Пять колонок",
    description: "Пять компактных карточек в ряд",
    widths: [480, 600],
    sizes: "(min-width: 1440px) 20vw, (min-width: 1024px) 33vw, (min-width: 640px) 50vw, 100vw",
  },
  {
    id: "custom",
    title: "Свой размер",
    description: "Точная ширина конкретного блока",
    widths: [360, 720],
    sizes: "360px",
  },
];

export function getAvailableImageProfiles(maxWidth: number) {
  const safeMaxWidth = Math.max(1, Math.floor(maxWidth));
  return IMAGE_PROFILES.filter(
    (profile) =>
      profile.id === "custom" || Math.max(...profile.widths) <= safeMaxWidth,
  );
}

export function createCustomProfile(
  width: number,
  includeRetina: boolean,
  maxWidth = 2560,
) {
  const safeMaxWidth = Math.max(1, Math.min(2560, Math.floor(maxWidth)));
  const exactWidth = Math.min(
    safeMaxWidth,
    Math.min(2560, Math.max(32, Math.round(width))),
  );
  const retinaWidth = exactWidth * 2;
  return {
    id: "custom",
    title: "Свой размер",
    description: `Блок шириной ${exactWidth}px`,
    widths:
      includeRetina && retinaWidth <= safeMaxWidth
        ? [exactWidth, retinaWidth]
        : [exactWidth],
    sizes: `${exactWidth}px`,
  } satisfies ImageProfile;
}

export function createDetectedProfile(
  widths: number[],
  includeRetina: boolean,
  maxWidth = 2560,
) {
  const safeMaxWidth = Math.max(1, Math.min(2560, Math.floor(maxWidth)));
  const requestedWidths = [...new Set(widths)]
    .map((width) => Math.min(2560, Math.max(32, Math.round(width))))
    .filter((width) => width <= safeMaxWidth)
    .sort((a, b) => a - b);
  const exactWidths = requestedWidths.length ? requestedWidths : [safeMaxWidth];
  const outputWidths = includeRetina
    ? [
        ...new Set([
          ...exactWidths,
          ...exactWidths
            .map((width) => width * 2)
            .filter((width) => width <= safeMaxWidth),
        ]),
      ]
    : exactWidths;
  return {
    id: "custom",
    title: "Размеры из кода блока",
    description: `${exactWidths.length} ${exactWidths.length === 1 ? "размер" : "размера"} из кода`,
    widths: outputWidths.sort((a, b) => a - b),
    sizes: "100vw",
  } satisfies ImageProfile;
}

const OPTIMIZE_CONFIG = {
  threshold: 0.98,
  search: {
    avif: { min: 50, max: 70, fallback: 60 },
    webp: { min: 68, max: 82, fallback: 75 },
  },
} satisfies {
  threshold: number;
  search: Record<LossyOutputFormat, { min: number; max: number; fallback: number }>;
};

const SCREENSHOT_CONFIG = {
  threshold: 0.995,
  search: {
    avif: { min: 78, max: 90, fallback: 86 },
    webp: { min: 88, max: 96, fallback: 92 },
  },
} satisfies typeof OPTIMIZE_CONFIG;

export const AVIF_QUALITY_RANGE = {
  lighter: 45,
  automaticMin: 50,
  automaticMax: 70,
  detail: 80,
} as const;

export const WEBP_QUALITY_RANGE = {
  lighter: 60,
  automaticMin: 68,
  automaticMax: 82,
  detail: 85,
} as const;

export const SCREENSHOT_AVIF_QUALITY_RANGE = {
  lighter: 70,
  automaticMin: 78,
  automaticMax: 90,
  detail: 95,
} as const;

export const SCREENSHOT_WEBP_QUALITY_RANGE = {
  lighter: 82,
  automaticMin: 88,
  automaticMax: 96,
  detail: 100,
} as const;

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

function safeBaseName(fileName: string) {
  return (
    fileName
      .replace(/\.[^.]+$/, "")
      .normalize("NFKD")
      .replace(/[^a-zA-Z0-9а-яА-ЯёЁ_-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "image"
  );
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
  const maxProfileWidth = Math.max(...profile.widths);
  const cappedOriginal = Math.min(originalWidth, maxProfileWidth);
  const widths = profile.widths.filter((width) => width < cappedOriginal);
  widths.push(cappedOriginal);
  return [...new Set(widths)].sort((a, b) => a - b);
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

export function archiveFileSelectionKey(
  format: OutputFormat,
  width: number,
): ArchiveFileSelection {
  return `${format}:${width}`;
}

export function selectArchiveFiles(
  result: OptimizationResult,
  selectedFiles: ArchiveFileSelection[],
  selection?: QualitySelection,
) {
  const selected = new Set(selectedFiles);
  const results = result.results.flatMap((widthResult) => {
    const variants = (["avif", "webp", "png"] as OutputFormat[]).flatMap((format) => {
      if (!selected.has(archiveFileSelectionKey(format, widthResult.width))) return [];
      const tier = selectedTier(selection, format);
      const variant = widthResult.variants.find(
        (item) => item.format === format && item.tier === tier,
      ) ?? widthResult.variants.find(
        (item) => item.format === format && item.tier === "recommended",
      );
      return variant ? [variant] : [];
    });
    if (!variants.length) return [];
    const recommended = variants.includes(widthResult.recommended)
      ? widthResult.recommended
      : [...variants].sort((first, second) => first.size - second.size)[0];
    return [{ ...widthResult, variants, recommended }];
  });
  const widths = results.map((item) => item.width);
  return {
    ...result,
    profile: {
      ...result.profile,
      widths,
      sizes: widths.length === 1 ? `${widths[0]}px` : result.profile.sizes,
    },
    results,
  } satisfies OptimizationResult;
}

export function calculateCropRect(
  sourceWidth: number,
  sourceHeight: number,
  crop: CropSettings,
): CropRect {
  const positionX = Math.min(100, Math.max(0, crop.positionX)) / 100;
  const positionY = Math.min(100, Math.max(0, crop.positionY)) / 100;
  const targetRatio = crop.aspectRatio;
  const sourceRatio = sourceWidth / sourceHeight;

  if (!targetRatio || Math.abs(sourceRatio - targetRatio) < 0.0001) {
    return { x: 0, y: 0, width: sourceWidth, height: sourceHeight };
  }

  if (sourceRatio > targetRatio) {
    const width = sourceHeight * targetRatio;
    return {
      x: (sourceWidth - width) * positionX,
      y: 0,
      width,
      height: sourceHeight,
    };
  }

  const height = sourceWidth / targetRatio;
  return {
    x: 0,
    y: (sourceHeight - height) * positionY,
    width: sourceWidth,
    height,
  };
}

function createResizedCanvas(
  source: CanvasImageSource,
  cropRect: CropRect,
  targetWidth: number,
) {
  const targetHeight = Math.max(
    1,
    Math.round((targetWidth / cropRect.width) * cropRect.height),
  );
  const canvas = document.createElement("canvas");
  canvas.width = targetWidth;
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

function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality: number) {
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
      quality / 100,
    );
  });
}

async function encodeAvif(canvas: HTMLCanvasElement, quality: number) {
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("Не удалось прочитать пиксели изображения.");
  const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
  const avif = await import("@jsquash/avif/encode");
  const buffer = await avif.default(imageData, {
    quality,
    speed: 7,
    subsample: 1,
    tune: 2,
  });
  return new Blob([buffer], { type: MIME.avif });
}

async function encodeCanvas(
  canvas: HTMLCanvasElement,
  format: OutputFormat,
  quality: number,
) {
  if (format === "avif") return encodeAvif(canvas, quality);
  if (format === "png") return canvasToBlob(canvas, MIME.png, 100);
  return canvasToBlob(canvas, MIME[format], quality);
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
  quality: number,
  baseName: string,
  tier: QualityTier = "recommended",
) {
  const blob = await encodeCanvas(canvas, format, quality);
  let similarity: number | null = null;
  let similarityMethod: EncodedVariant["similarityMethod"] = "unavailable";
  try {
    const measurement = await measureSimilarity(canvas, blob);
    similarity = measurement.score;
    similarityMethod = measurement.method;
  } catch {
    // Encoding succeeded. Keep the valid file even if this browser cannot
    // decode it a second time for automatic comparison.
  }
  return {
    format,
    mime: MIME[format],
    extension: EXTENSION[format],
    blob,
    size: blob.size,
    quality,
    tier,
    similarity,
    similarityMethod,
    fileName: `${baseName}-${canvas.width}${
      tier === "recommended" ? "" : tier === "lighter" ? "-light" : "-detail"
    }.${EXTENSION[format]}`,
  } satisfies EncodedVariant;
}

async function chooseQuality(
  canvas: HTMLCanvasElement,
  format: LossyOutputFormat,
  baseName: string,
  mode: OptimizationMode = "photo",
) {
  const config = mode === "screenshot" ? SCREENSHOT_CONFIG : OPTIMIZE_CONFIG;
  const range = config.search[format];
  let low = range.min;
  let high = range.max;
  let bestQuality: number | null = null;
  let attempts = 0;

  while (low <= high && attempts < 7) {
    const quality = Math.round((low + high) / 2);
    const candidate = await encodeVariant(
      canvas,
      format,
      quality,
      baseName,
    );
    attempts += 1;

    if (candidate.similarity === null) return range.fallback;
    if (candidate.similarity >= config.threshold) {
      bestQuality = quality;
      high = quality - 1;
    } else {
      low = quality + 1;
    }
  }

  return bestQuality ?? range.max;
}

export function qualityTiers(
  format: OutputFormat,
  recommended: number,
  mode: OptimizationMode = "photo",
) {
  if (format === "png") {
    return [{ tier: "recommended" as const, quality: 100 }];
  }
  const range = mode === "screenshot"
    ? format === "webp"
      ? SCREENSHOT_WEBP_QUALITY_RANGE
      : SCREENSHOT_AVIF_QUALITY_RANGE
    : format === "webp"
      ? WEBP_QUALITY_RANGE
      : AVIF_QUALITY_RANGE;
  return [
    {
      tier: "lighter" as const,
      quality: range.lighter,
    },
    {
      tier: "recommended" as const,
      quality: Math.min(
        range.automaticMax,
        Math.max(range.automaticMin, recommended),
      ),
    },
    {
      tier: "detail" as const,
      quality: range.detail,
    },
  ];
}

function selectRecommended(variants: EncodedVariant[], threshold: number) {
  const automatic = variants.filter(
    (variant) => variant.tier === "recommended",
  );
  const passed = automatic.filter(
    (variant) =>
      variant.similarity !== null &&
      variant.similarity >= threshold - 0.002,
  );
  const measured = automatic.filter((variant) => variant.similarity !== null);
  const pool =
    passed.length > 0
      ? passed
      : measured.length > 0
        ? measured
        : automatic.length > 0
          ? automatic
          : variants;
  return [...pool].sort((a, b) => {
    if (a.size !== b.size) return a.size - b.size;
    return (b.similarity ?? -1) - (a.similarity ?? -1);
  })[0];
}

export async function optimizeImage(options: {
  file: File;
  profile: ImageProfile;
  crop: CropSettings;
  mode?: OptimizationMode;
  onProgress?: (percent: number, message: string) => void;
}) {
  const { file, profile, crop, mode = "photo", onProgress } = options;
  const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  const warnings: string[] = [];

  try {
    if (bitmap.width * bitmap.height > 50_000_000) {
      throw new Error(
        "Изображение больше 50 мегапикселей. Уменьшите исходник и попробуйте снова.",
      );
    }

    const cropRect = calculateCropRect(bitmap.width, bitmap.height, crop);
    const croppedWidth = Math.max(1, Math.round(cropRect.width));
    const croppedHeight = Math.max(1, Math.round(cropRect.height));
    const widths = buildTargetWidths(croppedWidth, profile);
    const baseName = safeBaseName(file.name);
    const largestWidth = widths.at(-1) ?? bitmap.width;
    const largestCanvas = createResizedCanvas(
      bitmap,
      cropRect,
      largestWidth,
    );
    const threshold =
      mode === "screenshot" ? SCREENSHOT_CONFIG.threshold : OPTIMIZE_CONFIG.threshold;
    const formats: OutputFormat[] =
      mode === "screenshot" ? ["png", "webp"] : ["avif", "webp"];
    const qualities = new Map<OutputFormat, number>();
    const encodingErrors: string[] = [];

    if (croppedWidth < Math.max(...profile.widths)) {
      warnings.push(
        `После кадрирования доступно ${croppedWidth}px по ширине. Сервис не стал искусственно увеличивать изображение до ${Math.max(...profile.widths)}px.`,
      );
    }

    onProgress?.(5, "Подбираем качество для современных форматов…");
    for (let index = 0; index < formats.length; index += 1) {
      const format = formats[index];
      try {
        qualities.set(
          format,
          format === "png"
            ? 100
            : await chooseQuality(largestCanvas, format, baseName, mode),
        );
      } catch (error) {
        const reason =
          error instanceof Error ? error.message : "ошибка кодирования";
        encodingErrors.push(`${format.toUpperCase()}: ${reason}`);
        if (format === "avif") {
          warnings.push(
            "AVIF-кодировщик не запустился; комплект собран без AVIF.",
          );
        } else {
          warnings.push(
            `${format.toUpperCase()} пропущен: ${reason}`,
          );
        }
      }
      onProgress?.(
        10 + Math.round(((index + 1) / formats.length) * 20),
        mode === "screenshot"
          ? `Проверяем чёткость ${format.toUpperCase()}…`
          : `Проверяем ${format.toUpperCase()}…`,
      );
    }

    const availableFormats = formats.filter((format) => qualities.has(format));
    if (availableFormats.length === 0) {
      throw new Error(
        `Не удалось создать выходные файлы. ${encodingErrors.join(" · ")}`,
      );
    }

    const results: WidthResult[] = [];
    for (let widthIndex = 0; widthIndex < widths.length; widthIndex += 1) {
      const width = widths[widthIndex];
      const canvas = createResizedCanvas(
        bitmap,
        cropRect,
        width,
      );
      const variants: EncodedVariant[] = [];

      for (const format of availableFormats) {
        const recommendedQuality = qualities.get(format);
        if (recommendedQuality === undefined) continue;
        for (const qualityOption of qualityTiers(format, recommendedQuality, mode)) {
          try {
            variants.push(
              await encodeVariant(
                canvas,
                format,
                qualityOption.quality,
                baseName,
                qualityOption.tier,
              ),
            );
          } catch (error) {
            warnings.push(
              `${format.toUpperCase()} ${width}px Q${qualityOption.quality} пропущен: ${
                error instanceof Error ? error.message : "ошибка"
              }`,
            );
          }
        }
      }

      if (variants.length === 0) {
        throw new Error(`Не удалось подготовить вариант шириной ${width}px.`);
      }

      const recommended = selectRecommended(variants, threshold);
      if (
        recommended.similarity !== null &&
        recommended.similarity < threshold - 0.002
      ) {
        warnings.push(
          `Для ширины ${width}px заданный порог не достигнут; выбран самый близкий по качеству вариант.`,
        );
      }

      results.push({
        width: canvas.width,
        height: canvas.height,
        variants,
        recommended,
      });

      onProgress?.(
        30 + Math.round(((widthIndex + 1) / widths.length) * 68),
        `Готовим ${width}px для сайта…`,
      );
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    }

    if (
      results.some((widthResult) =>
        widthResult.variants.some((variant) => variant.similarity === null),
      )
    ) {
      warnings.push(
        "Часть файлов создана без автоматической проверки сходства. Сравните их ползунком перед публикацией.",
      );
    }

    onProgress?.(100, "Комплект готов");
    return {
      sourceName: file.name,
      originalWidth: croppedWidth,
      originalHeight: croppedHeight,
      originalSize: file.size,
      profile,
      crop,
      threshold,
      mode,
      results,
      warnings: [...new Set(warnings)],
    } satisfies OptimizationResult;
  } finally {
    bitmap.close();
  }
}

function selectedTier(
  selection: QualitySelection | undefined,
  format: OutputFormat,
) {
  return selection?.[format] ?? "recommended";
}

function variantsByFormat(
  result: OptimizationResult,
  format: OutputFormat,
  selection?: QualitySelection,
) {
  const tier = selectedTier(selection, format);
  return result.results
    .map((widthResult) =>
      widthResult.variants.find(
        (variant) => variant.format === format && variant.tier === tier,
      ) ??
      widthResult.variants.find(
        (variant) =>
          variant.format === format && variant.tier === "recommended",
      ),
    )
    .filter((variant): variant is EncodedVariant => Boolean(variant));
}

export function createPictureMarkup(
  result: OptimizationResult,
  selection?: QualitySelection,
) {
  const avif = variantsByFormat(result, "avif", selection);
  const webp = variantsByFormat(result, "webp", selection);
  const png = variantsByFormat(result, "png", selection);
  const fallback = png.at(-1) ?? webp.at(-1) ?? avif.at(-1);
  if (!fallback) return "";

  const sourceLine = (format: OutputFormat, variants: EncodedVariant[]) =>
    variants.length
      ? `  <source type="${MIME[format]}" srcset="${variants
          .map((variant) => `${variant.fileName} ${result.results.find((item) => item.variants.includes(variant))?.width ?? ""}w`)
          .join(", ")}" sizes="${result.profile.sizes}">`
      : null;

  const sources = [
    sourceLine("avif", avif),
    sourceLine("webp", webp),
  ].filter((line): line is string => Boolean(line));

  return [
    "<picture>",
    ...sources,
    `  <img src="${fallback.fileName}" width="${result.results.at(-1)?.width}" height="${result.results.at(-1)?.height}" sizes="${result.profile.sizes}" alt="" loading="lazy" decoding="async">`,
    "</picture>",
  ].join("\n");
}

export function createManifest(
  result: OptimizationResult,
  selection?: QualitySelection,
) {
  return JSON.stringify(
    {
      source: result.sourceName,
      original: {
        width: result.originalWidth,
        height: result.originalHeight,
        bytes: result.originalSize,
      },
      profile: result.profile.id,
      mode: result.mode ?? "photo",
      sizes: result.profile.sizes,
      qualityTarget: result.threshold,
      selectedQuality: {
        avif: selectedTier(selection, "avif"),
        webp: selectedTier(selection, "webp"),
      },
      crop: {
        aspectRatio: result.crop.aspectRatio,
        positionX: result.crop.positionX,
        positionY: result.crop.positionY,
      },
      outputs: result.results.map((widthResult) => ({
        width: widthResult.width,
        height: widthResult.height,
        recommendedFormat: widthResult.recommended.format,
        variants: (["avif", "webp", "png"] as OutputFormat[])
          .flatMap((format) => {
            const variant =
              widthResult.variants.find(
                (item) =>
                  item.format === format &&
                  item.tier === selectedTier(selection, format),
              ) ??
              widthResult.variants.find(
                (item) =>
                  item.format === format && item.tier === "recommended",
              );
            return variant ? [variant] : [];
          })
          .map((variant) => ({
            file: variant.fileName,
            format: variant.format,
            tier: variant.tier,
            bytes: variant.size,
            encoderQuality: variant.quality,
            similarity:
              variant.similarity === null
                ? null
                : Number(variant.similarity.toFixed(5)),
            similarityMethod: variant.similarityMethod,
          })),
      })),
    },
    null,
    2,
  );
}
