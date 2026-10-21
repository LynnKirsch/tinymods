"use client";

import {
  ChangeEvent,
  DragEvent,
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import ServiceHelpDrawer from "./tinymods-shell/ServiceHelpDrawer";
import {
  calculateCropRect,
  calculateOutputDimensions,
  buildTargetWidths,
  cropSettingsFromRect,
  resizeCropRect,
  CropRect,
  CropResizeHandle,
  createCustomProfile,
  CropSettings,
  formatBytes,
  getAvailableImageProfiles,
  IMAGE_PROFILES,
  ImageProfile,
  OptimizationResult,
  OptimizationMode,
  optimizeImage,
  prepareTransparentPng,
  preparedPngKey,
  PreparedPng,
  OutputFormat,
  QualityTier,
  DEFAULT_ENCODER_QUALITY,
  MAX_BATCH_FILES,
  getUploadCandidates,
  parseCustomQuality,
  resolveEncoderQuality,
  outputSelectionKey,
  toggleOutputSelection,
  selectedResultOutputs,
  outputDownloadLabel,
} from "../lib/image-optimizer";
import { decodeHeicBitmap, isHeicFile } from "../lib/heic-decoder";
type SourceInfo = {
  width: number;
  height: number;
  previewUrl: string;
  hasTransparency: boolean;
  isPng?: boolean;
};

type SizeScope = "all" | "individual";
type IndividualSizeSettings = {
  profileId: ImageProfile["id"];
  customWidth: string;
  lastValidCustomWidth: string;
  customWidthAuto: boolean;
  customWidthMax: number | null;
};

type BatchItem = {
  id: string;
  file: File;
  sourceInfo: SourceInfo;
  profileId: ImageProfile["id"];
  customWidth: string;
  lastValidCustomWidth: string;
  customWidthAuto: boolean;
  customWidthMax: number | null;
  individualSizeSettings: IndividualSizeSettings | null;
  draftCrop: CropSettings;
  appliedCrop: CropSettings;
  cropEditing: boolean;
  result: OptimizationResult | null;
  resultSettingsKey: string | null;
  resultSourceFile: File | null;
  previewFormat: OutputFormat | null;
  previewWidth: number | null;
  qualityTier: QualityTier;
  customQuality: string;
  mode: OptimizationMode;
  selectedOutputKeys: string[];
  preparedPngDownloadKey: string | null;
  optimizedPngDownloadKeys: string[];
  optimizedPngTargetKey: string | null;
};

type PreparedPngStatus = { key: string; file: File; status: "preparing" | "ready" | "error"; error?: string };

const ACCEPTED_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/avif",
  "image/heic",
  "image/heif",
];
const ACCEPTED_INPUT = `${ACCEPTED_TYPES.join(",")},.heic,.heif`;

const CROP_PRESETS: Array<{
  id: string;
  label: string;
  description: string;
  ratio: number | null;
}> = [
  { id: "original", label: "Исходное", description: "Пропорции исходника", ratio: null },
  { id: "1-1", label: "1:1", description: "Квадрат", ratio: 1 },
  { id: "4-5", label: "4:5", description: "Вертикальное", ratio: 4 / 5 },
  { id: "3-4", label: "3:4", description: "Вертикальная карточка", ratio: 3 / 4 },
  { id: "2-3", label: "2:3", description: "Высокий кадр", ratio: 2 / 3 },
  { id: "4-3", label: "4:3", description: "Горизонтальная карточка", ratio: 4 / 3 },
  { id: "3-2", label: "3:2", description: "Фотография", ratio: 3 / 2 },
  { id: "16-9", label: "16:9", description: "Широкое", ratio: 16 / 9 },
];

const DEFAULT_CROP: CropSettings = {
  aspectRatio: null,
  positionX: 50,
  positionY: 50,
};


const QUALITY_OPTIONS: Array<{ tier: QualityTier; label: string }> = [
  { tier: "q65", label: "65" },
  { tier: "q80", label: "80" },
  { tier: "q85", label: "85" },
  { tier: "custom", label: "СВОЁ" },
];

const SIZE_GUIDE_ITEMS = IMAGE_PROFILES.filter(profile => profile.id !== "custom").map((profile, index) => ({
  id: profile.id, columns: index + 1, widths: profile.widths,
}));

const CROP_HANDLES: Array<{ id: CropResizeHandle; label: string }> = [
  { id: "n", label: "верхнюю границу" },
  { id: "s", label: "нижнюю границу" },
  { id: "w", label: "левую границу" },
  { id: "e", label: "правую границу" },
  { id: "nw", label: "верхний левый угол" },
  { id: "ne", label: "верхний правый угол" },
  { id: "sw", label: "нижний левый угол" },
  { id: "se", label: "нижний правый угол" },
];

function cropsEqual(first: CropSettings, second: CropSettings) {
  return (
    first.aspectRatio === second.aspectRatio &&
    first.positionX === second.positionX &&
    first.positionY === second.positionY &&
    first.size?.width === second.size?.width &&
    first.size?.height === second.size?.height
  );
}

function cropShapeDimensions(ratio: number) {
  const longestSide = 30;
  if (ratio >= 1) {
    return { width: longestSide, height: longestSide / ratio };
  }
  return { width: longestSide * ratio, height: longestSide };
}

function cropPreviewPresentation(source: SourceInfo, appliedCrop: CropSettings, editing: boolean) {
  const rect = editing
    ? { x: 0, y: 0, width: source.width, height: source.height }
    : calculateCropRect(source.width, source.height, appliedCrop);
  return {
    aspectRatio: String(rect.width / rect.height),
    imageStyle: editing ? undefined : {
      left: `${-rect.x / rect.width * 100}%`,
      top: `${-rect.y / rect.height * 100}%`,
      width: `${source.width / rect.width * 100}%`,
      height: `${source.height / rect.height * 100}%`,
    },
  };
}

function resizedCropSettings(rect: CropRect, handle: CropResizeHandle, source: SourceInfo, ratio: number | null) {
  return cropSettingsFromRect(rect, source.width, source.height, handle.length === 1 ? null : ratio);
}

function resizeCropRectToDimensions(
  rect: CropRect,
  axis: "width" | "height",
  requestedDimension: number,
  sourceWidth: number,
  sourceHeight: number,
  aspectRatio: number | null,
): CropRect {
  let width = axis === "width" ? requestedDimension : rect.width;
  let height = axis === "height" ? requestedDimension : rect.height;

  if (aspectRatio !== null && aspectRatio > 0) {
    if (axis === "width") height = Math.max(1, Math.round(width / aspectRatio));
    else width = Math.max(1, Math.round(height * aspectRatio));

    const scale = Math.min(1, sourceWidth / width, sourceHeight / height);
    width = Math.max(1, Math.round(width * scale));
    height = Math.max(1, Math.round(height * scale));
    if (width > sourceWidth || height > sourceHeight) {
      const correction = Math.min(sourceWidth / width, sourceHeight / height);
      width = Math.max(1, Math.floor(width * correction));
      height = Math.max(1, Math.floor(height * correction));
    }
  } else if (axis === "width") {
    width = Math.min(sourceWidth, Math.max(1, width));
  } else {
    height = Math.min(sourceHeight, Math.max(1, height));
  }

  const centerX = rect.x + rect.width / 2;
  const centerY = rect.y + rect.height / 2;
  const x = Math.min(sourceWidth - width, Math.max(0, centerX - width / 2));
  const y = Math.min(sourceHeight - height, Math.max(0, centerY - height / 2));
  return { x, y, width, height };
}

function isCropPresetActive(crop: CropSettings, presetRatio: number | null, source: SourceInfo) {
  if (crop.aspectRatio !== presetRatio) return false;
  if (presetRatio !== null) return true;
  const rect = calculateCropRect(source.width, source.height, crop);
  return Math.abs(rect.width / rect.height - source.width / source.height) < 1e-10;
}

function extensionLabel(type: string) {
  return type.replace("image/", "").replace("jpeg", "JPG").toUpperCase();
}

function downloadBlob(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function preparedPngDownloadIdentity(prepared: PreparedPng) {
  return `${prepared.key}:${prepared.outputs.map((output) => `${output.width}x${output.height}`).join(",")}`;
}

function optimizedPngDownloadIdentity(targetKey: string, width: number, height: number) {
  return `${targetKey}:${width}x${height}`;
}

function transparentPngTargetProfile(profile: ImageProfile, maxWidth: number) {
  if (profile.id !== "custom") {
    return { ...profile, widths: buildTargetWidths(maxWidth, profile) };
  }
  const width = profile.widths[0];
  return width ? createCustomProfile(width, maxWidth) : { ...profile, widths: [] };
}

function isCurrentPreparedPngTask(
  tasks: Map<string, { key: string; file: File; promise: Promise<PreparedPng> }>,
  itemId: string,
  task: { key: string; file: File; promise: Promise<PreparedPng> },
) {
  return tasks.get(itemId) === task;
}

function isCurrentOptimizedPng(
  mode: OptimizationMode,
  result: OptimizationResult | null,
  committedTargetKey: string | null | undefined,
  currentTargetKey: string | null,
) {
  return mode === "transparent-png" && result?.mode === "transparent-png" &&
    currentTargetKey !== null && committedTargetKey === currentTargetKey;
}

function smallestAvailableVariant(result: OptimizationResult, width = result.results[0]?.width) {
  const output = result.results.find((item) => item.width === width);
  if (!output?.variants.length) return undefined;
  const photoVariants = output.variants.filter((variant) => variant.format === "avif" || variant.format === "webp");
  const candidates = photoVariants.length ? photoVariants : output.variants;
  return candidates.reduce((smallest, variant) => variant.blob.size < smallest.blob.size ? variant : smallest);
}

function defaultOutputSelectionForResult(result: OptimizationResult) {
  const output = result.results[0];
  return output ? defaultOutputSelectionForTarget(result, output.width) : [];
}

function defaultOutputSelectionForTarget(result: OptimizationResult, width: number) {
  const output = result.results.find((item) => item.width === width);
  const variant = smallestAvailableVariant(result, width);
  return output && variant ? [outputSelectionKey(output.width, output.height, variant)] : [];
}

function isDownloadableBatchItem(item: BatchItem, batchLimit: number) {
  if (!item.result?.results.some((output) => output.variants.length > 0)) return false;
  if (item.result.mode !== "transparent-png") return true;
  const targetCrop = item.cropEditing || !cropsEqual(item.draftCrop, item.appliedCrop)
    ? item.draftCrop
    : item.appliedCrop;
  const profile = pendingProfile(item, batchLimit);
  if (!profile.widths.length) return false;
  const targetProfile = transparentPngTargetProfile(profile, Math.min(cropAvailableWidth(item), batchLimit));
  const targetKey = preparedPngKey(targetCrop, targetProfile);
  return isCurrentOptimizedPng(item.mode, item.result, item.optimizedPngTargetKey, targetKey);
}

function buildBatchDownloadSet(items: BatchItem[], selectedIds: Set<string>) {
  return items.filter((item) => selectedIds.has(item.id)).flatMap((item) =>
    item.result?.results.flatMap((output) => output.variants
      .filter((variant) => item.selectedOutputKeys.includes(outputSelectionKey(output.width, output.height, variant)))
      .map((variant) => ({ item, width: output.width, height: output.height, variant }))) ?? [],
  );
}

function setReadyPhotoSelection(selectedIds: Set<string>, readyIds: string[], checked: boolean) {
  const next = new Set(selectedIds);
  for (const id of readyIds) {
    if (checked) next.add(id);
    else next.delete(id);
  }
  return next;
}

function isAcceptedFile(file: File) {
  return ACCEPTED_TYPES.includes(file.type) || isHeicFile(file);
}

async function hasPngSignature(file: File) {
  const signature = new Uint8Array(await file.slice(0, 8).arrayBuffer());
  return signature.length === 8 &&
    [137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => signature[index] === byte);
}

async function hasTransparency(bitmap: ImageBitmap) {
  const tileSize = 256;
  const canvas = document.createElement("canvas");
  canvas.width = Math.min(tileSize, bitmap.width);
  canvas.height = Math.min(tileSize, bitmap.height);
  try {
    const context = canvas.getContext("2d", { alpha: true, willReadFrequently: true });
    if (!context) throw new Error("Не удалось проверить прозрачность изображения.");
    for (let y = 0; y < bitmap.height; y += tileSize) {
      for (let x = 0; x < bitmap.width; x += tileSize) {
        const width = Math.min(tileSize, bitmap.width - x);
        const height = Math.min(tileSize, bitmap.height - y);
        context.clearRect(0, 0, canvas.width, canvas.height);
        context.drawImage(bitmap, x, y, width, height, 0, 0, width, height);
        // At most 256 x 256 RGBA pixels; every source pixel is covered.
        const { data } = context.getImageData(0, 0, width, height);
        for (let index = 3; index < data.length; index += 4) {
          if (data[index] < 255) return true;
        }
      }
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    }
    return false;
  } finally {
    canvas.width = 0;
    canvas.height = 0;
  }
}

function committedResultQuality(result: OptimizationResult | null) {
  return result?.results.flatMap((output) => output.variants)
    .find((variant) => variant.format !== "png" && variant.quality !== null)?.quality ?? null;
}

function createPreviewUrl(source: ImageBitmap) {
  const maxWidth = 1600;
  const width = Math.min(source.width, maxWidth);
  const height = Math.max(1, Math.round((width / source.width) * source.height));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { alpha: true });
  if (!context) throw new Error("Браузер не предоставил Canvas 2D.");
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.drawImage(source, 0, 0, width, height);
  return new Promise<string>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error("Не удалось создать предпросмотр изображения."));
        return;
      }
      resolve(URL.createObjectURL(blob));
    }, "image/png");
  });
}

function formatExactBytes(bytes: number) {
  if (bytes < 1024) return `${bytes.toLocaleString("ru-RU")} Б`;
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toLocaleString("ru-RU", {
      minimumFractionDigits: 1,
      maximumFractionDigits: 1,
    })} КБ`;
  }
  return `${(bytes / 1024 / 1024).toLocaleString("ru-RU", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })} МБ`;
}

function cropAvailableWidth(item: BatchItem, useDraft = false) {
  const crop = useDraft ? item.draftCrop : item.appliedCrop;
  return Math.max(
    1,
    Math.floor(
      calculateCropRect(item.sourceInfo.width, item.sourceInfo.height, crop).width,
    ),
  );
}

function effectiveCropMaximum(width: number) {
  return Math.max(1, Math.min(2560, Math.floor(width)));
}

function currentCropLimit(items: BatchItem[], activeItemId: string | null, activeCropWidth?: number, scope: SizeScope = "all") {
  if (!items.length) return Math.max(1, activeCropWidth ?? 1);
  if (scope === "individual") {
    const active = items.find((item) => item.id === activeItemId);
    return Math.max(1, activeCropWidth ?? (active ? cropAvailableWidth(active) : 1));
  }
  return Math.min(...items.map((item) =>
    item.id === activeItemId && activeCropWidth !== undefined
      ? activeCropWidth
      : cropAvailableWidth(item),
  ));
}

function availableSelectionProfiles(mode: OptimizationMode, maxWidth: number) {
  const safeMaxWidth = Math.max(1, Math.floor(maxWidth));
  const availableProfiles = getAvailableImageProfiles(safeMaxWidth);
  const modeProfiles = mode === "photo" ? availableProfiles.filter(
    (profile) => profile.id === "custom" || profile.widths[0] <= safeMaxWidth,
  ) : availableProfiles;

  if (safeMaxWidth < 480 || safeMaxWidth >= 640) return modeProfiles;

  const paired480 = getAvailableImageProfiles(640).find((profile) => profile.id === "480-640");
  if (!paired480) return modeProfiles;
  return [
    { ...paired480, title: "480 px", widths: [480], sizes: "480px" },
    ...modeProfiles.filter((profile) => profile.id !== "480-640" && profile.id !== "custom"),
    ...modeProfiles.filter((profile) => profile.id === "custom"),
  ];
}

function resolveSelectionProfileId(
  profileId: ImageProfile["id"],
  mode: OptimizationMode,
  availableProfiles: ImageProfile[],
) {
  if (availableProfiles.some((profile) => profile.id === profileId)) return profileId;
  return mode === "photo" ? "custom" : (availableProfiles[0]?.id ?? "custom");
}

function reconcileSizeSettings(item: BatchItem, currentLimit: number, cropWidthChanged = false): BatchItem {
  const profiles = availableSelectionProfiles(item.mode, currentLimit);
  const maximum = effectiveCropMaximum(Math.min(cropAvailableWidth(item), currentLimit));
  const requested = Number(item.customWidth);
  const requestedIsInteger = Number.isInteger(requested) && requested >= 32;
  const requestedIsValid = Number.isInteger(requested) && requested >= 32 && requested <= maximum;
  const selectedPhotoPresetBecameUnavailable = item.mode === "photo" &&
    item.profileId !== "custom" && !profiles.some((profile) => profile.id === item.profileId);
  const preserveCustomFallback = selectedPhotoPresetBecameUnavailable && requestedIsValid;
  const manuallyClamped = !cropWidthChanged && !item.customWidthAuto && requestedIsInteger && requested > maximum;
  const prefill = !preserveCustomFallback && !manuallyClamped &&
    (cropWidthChanged || item.customWidthAuto);
  const customWidth = manuallyClamped || prefill ? String(maximum) : item.customWidth;
  const previousValid = Number(item.lastValidCustomWidth ?? item.customWidth);
  const lastValidCustomWidth = parseCustomWidth(customWidth, maximum) !== null ? customWidth
    : String(Number.isInteger(previousValid) && previousValid >= 32 ? Math.min(previousValid, maximum) : maximum);
  return {
    ...item,
    profileId: resolveSelectionProfileId(item.profileId, item.mode, profiles),
    customWidth,
    lastValidCustomWidth,
    customWidthAuto: manuallyClamped ? false : prefill ? true : item.customWidthAuto,
    customWidthMax: maximum,
  };
}

function sizeSettingsForScope(items: BatchItem[], scope: SizeScope): BatchItem[] {
  const sharedLimit = currentCropLimit(items, null);
  return items.map((item) => {
    if (scope === "individual") {
      const restored = { ...item, ...item.individualSizeSettings, individualSizeSettings: null };
      return reconcileSizeSettings(restored, cropAvailableWidth(restored));
    }
    const individualSizeSettings = item.individualSizeSettings ?? {
      profileId: item.profileId, customWidth: item.customWidth,
      lastValidCustomWidth: item.lastValidCustomWidth, customWidthAuto: item.customWidthAuto,
      customWidthMax: item.customWidthMax,
    };
    return reconcileSizeSettings({ ...item, individualSizeSettings }, sharedLimit);
  });
}

function parseCustomWidth(value: string, limit: number): number | null {
  const width = Number(value);
  return Number.isInteger(width) && width >= 32 && width <= effectiveCropMaximum(limit) ? width : null;
}

function createBatchItem(file: File, sourceInfo: SourceInfo, mode: OptimizationMode = "photo"): BatchItem {
  const availableWidth = sourceInfo.width;
  const availableProfiles = availableSelectionProfiles(mode, availableWidth);
  const profileId =
    availableProfiles.find((item) => item.id !== "custom")?.id ?? "custom";
  const customWidth = effectiveCropMaximum(availableWidth);

  return {
    id: crypto.randomUUID(),
    file,
    sourceInfo,
    profileId,
    customWidth: String(customWidth),
    lastValidCustomWidth: String(customWidth),
    customWidthAuto: true,
    customWidthMax: customWidth,
    individualSizeSettings: null,
    draftCrop: { ...DEFAULT_CROP },
    appliedCrop: { ...DEFAULT_CROP },
    cropEditing: true,
    result: null,
    resultSettingsKey: null,
    resultSourceFile: null,
    previewFormat: null,
    previewWidth: null,
    qualityTier: "q85",
    customQuality: String(DEFAULT_ENCODER_QUALITY),
    mode: mode === "transparent-png" && !(sourceInfo.isPng && sourceInfo.hasTransparency) ? "photo" : mode,
    selectedOutputKeys: [],
    preparedPngDownloadKey: null,
    optimizedPngDownloadKeys: [],
    optimizedPngTargetKey: null,
  };
}

function applyCropRatioToBatchItem(
  item: BatchItem,
  aspectRatio: number,
): BatchItem {
  const nextCrop: CropSettings = {
    aspectRatio,
    positionX: item.draftCrop.positionX,
    positionY: item.draftCrop.positionY,
  };
  const availableWidth = Math.max(
    1,
    Math.floor(
      calculateCropRect(
        item.sourceInfo.width,
        item.sourceInfo.height,
        nextCrop,
      ).width,
    ),
  );
  return reconcileSizeSettings({
    ...item,
    draftCrop: { ...nextCrop },
    appliedCrop: { ...nextCrop },
    cropEditing: true,
    customWidthAuto: Math.abs(
      calculateCropRect(item.sourceInfo.width, item.sourceInfo.height, nextCrop).width -
      calculateCropRect(item.sourceInfo.width, item.sourceInfo.height, item.draftCrop).width,
    ) > 0.0001 ? true : item.customWidthAuto,
  }, availableWidth);
}

function batchItemError(item: BatchItem, currentLimit = cropAvailableWidth(item)) {
  if (!cropsEqual(item.draftCrop, item.appliedCrop)) {
    return "Сохраните кадр";
  }

  const availableProfiles = availableSelectionProfiles(item.mode, currentLimit);
  const profileId = resolveSelectionProfileId(item.profileId, item.mode, availableProfiles);
  if (profileId !== "custom") return null;

  const requestedWidth = Number(item.customWidth);
  if (
    !Number.isInteger(requestedWidth) ||
    requestedWidth < 32 ||
    requestedWidth > effectiveCropMaximum(Math.min(cropAvailableWidth(item), currentLimit))
  ) {
    return `Укажите размер 32–${effectiveCropMaximum(Math.min(cropAvailableWidth(item), currentLimit))}px`;
  }
  return null;
}

function pendingProfile(item: BatchItem, batchLimit: number): ImageProfile {
  const limit = Math.min(cropAvailableWidth(item), batchLimit);
  const available = availableSelectionProfiles(item.mode, limit);
  const selectedId = resolveSelectionProfileId(item.profileId, item.mode, available);
  const selected = available.find((profile) => profile.id === selectedId) ?? available[0];
  if (selected.id !== "custom") return { ...selected, widths: buildTargetWidths(limit, selected) };
  const width = parseCustomWidth(item.customWidth, limit);
  return width === null ? { ...selected, widths: [] } : createCustomProfile(width, limit);
}

function optimizationSettingsKey(item: BatchItem, profile: ImageProfile, quality: number | undefined): string | null {
  const crop = calculateCropRect(item.sourceInfo.width, item.sourceInfo.height, item.appliedCrop);
  const widths = buildTargetWidths(crop.width, profile);
  if (!widths.length || (item.mode !== "transparent-png" && (!Number.isInteger(quality) || quality! < 1 || quality! > 100))) return null;
  return JSON.stringify([item.id, item.mode, [crop.x, crop.y, crop.width, crop.height], widths,
    item.mode === "transparent-png" ? null : quality]);
}

function pendingTargetDimensions(source: SourceInfo, crop: CropSettings, profile: ImageProfile) {
  const rect = calculateCropRect(source.width, source.height, crop);
  return buildTargetWidths(rect.width, profile).map((width) => calculateOutputDimensions(rect, width));
}

function isOptimizationCurrent(item: BatchItem, limit: number): boolean {
  if (!item.result || !item.resultSettingsKey || item.resultSourceFile !== item.file) return false;
  const profile = pendingProfile(item, limit);
  if (!profile.widths.length) return false;
  let quality: number | undefined;
  try { quality = item.mode === "transparent-png" ? undefined : resolveEncoderQuality(item.qualityTier, item.customQuality); }
  catch { return false; }
  return item.resultSettingsKey === optimizationSettingsKey(item, profile, quality);
}

function commitResult(item: BatchItem, result: OptimizationResult, optimizedPngTargetKey: string | null = null, resultSettingsKey: string | null = null): BatchItem {
  const firstOutput = result.results[0];
  const selected = smallestAvailableVariant(result, firstOutput?.width);
  return {
    ...item,
    result,
    resultSettingsKey,
    resultSourceFile: item.file,
    optimizedPngTargetKey: result.mode === "transparent-png" ? optimizedPngTargetKey : null,
    optimizedPngDownloadKeys: [],
    previewWidth: firstOutput?.width ?? null,
    previewFormat: selected?.format ?? null,
    selectedOutputKeys: defaultOutputSelectionForResult(result),
  };
}

export default function ImageOptimizer() {
  const [cropGuides, setCropGuides] = useState({ x: false, y: false });
  const inputRef = useRef<HTMLInputElement>(null);
  const previewUrlsRef = useRef(new Set<string>());
  const cropDragRef = useRef<{
    pointerId: number;
    startClientX: number;
    startClientY: number;
    rect: CropRect;
  } | null>(null);
  const cropResizeRef = useRef<{
    pointerId: number;
    startClientX: number;
    startClientY: number;
    rect: CropRect;
    handle: CropResizeHandle;
  } | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [sourceInfo, setSourceInfo] = useState<SourceInfo | null>(null);
  const [batchItems, setBatchItems] = useState<BatchItem[]>([]);
  const [selectedBatchItemIds, setSelectedBatchItemIds] = useState<Set<string>>(() => new Set());
  const batchSelectAllRef = useRef<HTMLInputElement>(null);
  const [batchAspectRatio, setBatchAspectRatio] = useState<number | null>(null);
  const [sizeScope, setSizeScope] = useState<SizeScope>("individual");
  const [activeItemId, setActiveItemId] = useState<string | null>(null);
  const [addingFiles, setAddingFiles] = useState(false);
  const [processingItemId, setProcessingItemId] = useState<string | null>(null);
  const [profileId, setProfileId] = useState<ImageProfile["id"]>("1680-1920");
  const [customWidth, setCustomWidth] = useState("360");
  const [lastValidCustomWidth, setLastValidCustomWidth] = useState("360");
  const [customWidthAuto, setCustomWidthAuto] = useState(true);
  const [customWidthMax, setCustomWidthMax] = useState<number | null>(null);
  const [downloadingFiles, setDownloadingFiles] = useState(false);
  const downloadingFilesRef = useRef(false);
  const preparedPngsRef = useRef(new Map<string, PreparedPng>());
  const preparedPngTasksRef = useRef(new Map<string, { key: string; file: File; promise: Promise<PreparedPng> }>());
  const [preparedPngViews, setPreparedPngViews] = useState(new Map<string, PreparedPng>());
  const [preparedPngStatuses, setPreparedPngStatuses] = useState(new Map<string, PreparedPngStatus>());
  const [draftCrop, setDraftCrop] = useState<CropSettings>(DEFAULT_CROP);
  const [appliedCrop, setAppliedCrop] = useState<CropSettings>(DEFAULT_CROP);
  const [cropWidthInput, setCropWidthInput] = useState<string | null>(null);
  const [cropHeightInput, setCropHeightInput] = useState<string | null>(null);
  const [cropEditing, setCropEditing] = useState(true);
  const [optimizationMode, setOptimizationMode] = useState<OptimizationMode>("photo");
  const [dragging, setDragging] = useState(false);
  const [working, setWorking] = useState(false);
  const [progress, setProgress] = useState(0);
  const [progressText, setProgressText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<OptimizationResult | null>(null);
  const [previewFormat, setPreviewFormat] = useState<OutputFormat | null>(null);
  const [previewWidth, setPreviewWidth] = useState<number | null>(null);
  const [qualityTier, setQualityTier] = useState<QualityTier>("q85");
  const [selectedOutputKeys, setSelectedOutputKeys] = useState<string[]>([]);
  const [sizeGuideOpen, setSizeGuideOpen] = useState(false);
  const [customQuality, setCustomQuality] = useState(String(DEFAULT_ENCODER_QUALITY));
  const parsedCustomQuality = parseCustomQuality(customQuality);
  const validCustomQuality = parsedCustomQuality !== null;
  const selectedQualityTier = qualityTier;

  const draftCropRect = useMemo(() => {
    if (!sourceInfo) return null;
    return calculateCropRect(sourceInfo.width, sourceInfo.height, draftCrop);
  }, [draftCrop, sourceInfo]);

  const cropDirty = !cropsEqual(draftCrop, appliedCrop);
  const cropPresentation = sourceInfo ? cropPreviewPresentation(sourceInfo, appliedCrop, cropEditing) : null;
  const draftAspectRatio =
    draftCrop.aspectRatio ??
    (sourceInfo ? sourceInfo.width / sourceInfo.height : 16 / 9);
  const sourceAspectRatio = sourceInfo
    ? sourceInfo.width / sourceInfo.height
    : draftAspectRatio;
  const canMoveCropX = Boolean(sourceInfo && draftCropRect && draftCropRect.width < sourceInfo.width - 0.0001);
  const canMoveCropY = Boolean(sourceInfo && draftCropRect && draftCropRect.height < sourceInfo.height - 0.0001);

  const appliedCropWidth = sourceInfo
    ? Math.max(1, Math.floor(calculateCropRect(sourceInfo.width, sourceInfo.height, appliedCrop).width))
    : 1;
  const currentLimit = currentCropLimit(batchItems, activeItemId, appliedCropWidth, sizeScope);
  const effectiveMaxWidth = effectiveCropMaximum(currentLimit);
  const availableProfiles = useMemo(
    () => availableSelectionProfiles(optimizationMode, currentLimit),
    [optimizationMode, currentLimit],
  );
  const activeProfileId = resolveSelectionProfileId(profileId, optimizationMode, availableProfiles);

  const profile = useMemo(() => {
    if (activeProfileId === "custom") {
      const requestedWidth = Number(customWidth);
      if (!Number.isInteger(requestedWidth) || requestedWidth < 32 || requestedWidth > effectiveMaxWidth) {
        return { ...IMAGE_PROFILES.at(-1)!, widths: [] };
      }
      return createCustomProfile(requestedWidth, currentLimit);
    }
    const selected = availableProfiles.find((item) => item.id === activeProfileId) ??
      availableProfiles[0] ?? IMAGE_PROFILES.at(-1)!;
    return { ...selected, widths: buildTargetWidths(currentLimit, selected) };
  }, [
    activeProfileId,
    availableProfiles,
    customWidth,
    effectiveMaxWidth,
    currentLimit,
  ]);
  const targetProfile = useMemo(
    () => optimizationMode === "transparent-png"
      ? transparentPngTargetProfile(profile, currentLimit)
      : profile,
    [optimizationMode, profile, currentLimit],
  );

  const setPreparedPngStatus = useCallback((itemId: string, status: PreparedPngStatus | null) => {
    setPreparedPngStatuses((current) => {
      const existing = current.get(itemId);
      if (status && existing?.key === status.key && existing.file === status.file && existing.status === status.status && existing.error === status.error) return current;
      if (!status && !existing) return current;
      const next = new Map(current);
      if (status) next.set(itemId, status);
      else next.delete(itemId);
      return next;
    });
  }, []);

  const ensurePreparedPng = useCallback((
    itemId: string,
    sourceFile: File,
    crop: CropSettings,
    targetProfile: ImageProfile,
  ) => {
    const key = preparedPngKey(crop, targetProfile);
    const cached = preparedPngsRef.current.get(itemId);
    if (cached?.file === sourceFile && cached.key === key) return Promise.resolve(cached);
    const pending = preparedPngTasksRef.current.get(itemId);
    if (pending?.key === key && pending.file === sourceFile) return pending.promise;

    setPreparedPngStatus(itemId, { key, file: sourceFile, status: "preparing" });
    const task = { key, file: sourceFile, promise: Promise.resolve(null as unknown as PreparedPng) };
    task.promise = prepareTransparentPng({ file: sourceFile, crop, profile: targetProfile })
      .then((prepared) => {
        if (isCurrentPreparedPngTask(preparedPngTasksRef.current, itemId, task)) {
          preparedPngsRef.current.set(itemId, prepared);
          preparedPngTasksRef.current.delete(itemId);
          setPreparedPngViews((current) => new Map(current).set(itemId, prepared));
          setBatchItems((items) => items.map((item) => item.id === itemId
            ? { ...item, preparedPngDownloadKey: null }
            : item));
          setPreparedPngStatus(itemId, { key, file: sourceFile, status: "ready" });
        }
        return prepared;
      })
      .catch((nextError) => {
        if (isCurrentPreparedPngTask(preparedPngTasksRef.current, itemId, task)) {
          preparedPngTasksRef.current.delete(itemId);
          setPreparedPngStatus(itemId, {
            key,
            file: sourceFile,
            status: "error",
            error: nextError instanceof Error ? nextError.message : "Не удалось подготовить PNG.",
          });
        }
        throw nextError;
      });
    preparedPngTasksRef.current.set(itemId, task);
    return task.promise;
  }, [setBatchItems, setPreparedPngStatus]);

  const liveCropWidth = draftCropRect ? String(Math.round(draftCropRect.width)) : "";
  useEffect(() => {
    if (!activeItemId) return;
    const prepared = preparedPngsRef.current.get(activeItemId);
    if (prepared && (prepared.file !== file || prepared.key !== preparedPngKey(appliedCrop, targetProfile) || cropDirty)) {
      preparedPngsRef.current.delete(activeItemId);
      preparedPngTasksRef.current.delete(activeItemId);
      setPreparedPngViews((current) => {
        if (!current.has(activeItemId)) return current;
        const next = new Map(current);
        next.delete(activeItemId);
        return next;
      });
      setBatchItems((items) => items.map((item) => item.id === activeItemId && item.preparedPngDownloadKey
        ? { ...item, preparedPngDownloadKey: null }
        : item));
      setPreparedPngStatus(activeItemId, null);
    }
  }, [activeItemId, file, appliedCrop, targetProfile, cropDirty, setPreparedPngStatus]);
  useEffect(() => {
    if (!activeItemId || !file || !sourceInfo || optimizationMode !== "transparent-png" || cropDirty || !targetProfile.widths.length) return;
    const key = preparedPngKey(appliedCrop, targetProfile);
    const cached = preparedPngsRef.current.get(activeItemId);
    if (cached?.file === file && cached.key === key) return;
    const status = preparedPngStatuses.get(activeItemId);
    if (status?.key === key && status.file === file && (status.status === "preparing" || status.status === "error")) return;
    void ensurePreparedPng(activeItemId, file, appliedCrop, targetProfile).catch(() => {});
  }, [activeItemId, file, sourceInfo, optimizationMode, cropDirty, appliedCrop, targetProfile, preparedPngStatuses, ensurePreparedPng]);
  const liveCropHeight = draftCropRect ? String(Math.round(draftCropRect.height)) : "";
  const liveCustomWidth = Number(customWidth);
  const customWidthInvalid = activeProfileId === "custom" &&
    (!Number.isInteger(liveCustomWidth) || liveCustomWidth < 32 || liveCustomWidth > effectiveMaxWidth);

  const largestResult = result?.results[0];
  const comparisonResult = useMemo(() => {
    if (!result || !largestResult) return null;
    return result.results.find((item) => item.width === previewWidth) ?? largestResult;
  }, [largestResult, previewWidth, result]);
  const availableFormats = comparisonResult
    ? (["avif", "webp", "png"] as OutputFormat[]).filter((format) =>
        comparisonResult.variants.some((variant) => variant.format === format),
      )
    : [];
  const defaultFormat = previewFormat ?? availableFormats[0] ?? "webp";
  const comparisonFormats = comparisonResult
    ? availableFormats.flatMap((format) => {
        const variant = comparisonResult.variants.find((item) => item.format === format);
        return variant ? [variant] : [];
      })
    : [];
  const comparedVariant = comparisonFormats.find((variant) => variant.format === defaultFormat)
    ?? comparisonFormats[0];
  const selectedOutputs = selectedResultOutputs(result, selectedOutputKeys);
  const activeDownloadItem = batchItems.find((item) => item.id === activeItemId);
  const pendingTargetCrop = cropEditing || cropDirty ? draftCrop : appliedCrop;
  const expectedPreparedKey = optimizationMode === "transparent-png" && activeItemId && file && targetProfile.widths.length
    ? preparedPngKey(pendingTargetCrop, targetProfile)
    : null;
  const activePreparedPng = activeItemId ? preparedPngViews.get(activeItemId) : undefined;
  const activePreparedOutputs = activePreparedPng?.file === file && activePreparedPng.key === expectedPreparedKey
    ? targetProfile.widths.map((width) => activePreparedPng.outputs.find((output) => output.width === width))
      .filter((output): output is PreparedPng["outputs"][number] => Boolean(output))
    : [];
  const activePreparedDownloadKey = activePreparedPng && activePreparedOutputs.length === targetProfile.widths.length
    ? preparedPngDownloadIdentity(activePreparedPng)
    : null;
  const activePreparedStatus = activeItemId ? preparedPngStatuses.get(activeItemId) : undefined;
  const currentPreparedStatus = activePreparedStatus?.key === expectedPreparedKey && activePreparedStatus.file === file
    ? activePreparedStatus
    : undefined;
  const activePreparedReady = Boolean(
    optimizationMode === "transparent-png" && !cropDirty && targetProfile.widths.length > 0 &&
      activePreparedOutputs.length === targetProfile.widths.length && currentPreparedStatus?.status !== "error",
  );
  const activePreparedDownloaded = Boolean(
    activePreparedDownloadKey && activeDownloadItem?.preparedPngDownloadKey === activePreparedDownloadKey,
  );
  const activeOptimizedOutput = result?.mode === "transparent-png" ? selectedOutputs[0] : undefined;
  const activeOptimizedTargetCurrent = isCurrentOptimizedPng(
    optimizationMode, result, activeDownloadItem?.optimizedPngTargetKey, expectedPreparedKey,
  );
  const activeOptimizedDownloadKey = activeOptimizedOutput
    ? optimizedPngDownloadIdentity(expectedPreparedKey ?? "", activeOptimizedOutput.width, activeOptimizedOutput.height)
    : null;
  const activeOptimizedDownloaded = Boolean(
    activeOptimizedDownloadKey && activeDownloadItem?.optimizedPngDownloadKeys?.includes(activeOptimizedDownloadKey),
  );
  const resultQuality = committedResultQuality(result);
  const activeTargetDimensions = sourceInfo ? pendingTargetDimensions(sourceInfo, pendingTargetCrop, targetProfile) : [];
  const activeTargetDimensionsLabel = activeTargetDimensions.length
    ? activeTargetDimensions.map(({ width, height }) => `${width}×${height} PX`).join(" · ")
    : "…";
  const optimizedPreview = useMemo(() => {
    const output = result?.results.find((item) => item.width === previewWidth) ?? result?.results[0];
    const variant = output?.variants.find((item) => item.format === previewFormat) ?? output?.variants[0];
    return variant ? URL.createObjectURL(variant.blob) : null;
  }, [result, previewWidth, previewFormat]);
  const activeResultViewReady = Boolean(
    result && largestResult && comparisonResult && comparedVariant && optimizedPreview &&
    (result.mode !== "transparent-png" || activeOptimizedTargetCurrent),
  );
  useEffect(() => {
    const previewUrls = previewUrlsRef.current;
    return () => {
      previewUrls.forEach((url) => URL.revokeObjectURL(url));
      previewUrls.clear();
    };
  }, []);

  useEffect(() => {
    return () => {
      if (optimizedPreview) URL.revokeObjectURL(optimizedPreview);
    };
  }, [optimizedPreview]);


  function currentBatchSnapshot(
    overrides: Partial<BatchItem> = {},
  ): BatchItem | null {
    if (!activeItemId || !file || !sourceInfo) return null;
    const storedItem = batchItems.find((item) => item.id === activeItemId);
    if (!storedItem) return null;

    return {
      ...storedItem,
      file,
      sourceInfo,
      profileId: activeProfileId,
      customWidth,
      lastValidCustomWidth,
      customWidthAuto,
      customWidthMax,
      draftCrop: { ...draftCrop },
      appliedCrop: { ...appliedCrop },
      cropEditing,
      result,
      previewFormat,
      previewWidth,
      qualityTier,
      customQuality,
      mode: optimizationMode === "transparent-png" && !(sourceInfo.isPng && sourceInfo.hasTransparency) ? "photo" : optimizationMode,
      selectedOutputKeys: [...selectedOutputKeys],
      ...overrides,
    };
  }

  function hydrateBatchItem(item: BatchItem) {
    setActiveItemId(item.id);
    setFile(item.file);
    setSourceInfo(item.sourceInfo);
    setProfileId(item.profileId);
    setCustomWidth(item.customWidth);
    setLastValidCustomWidth(item.lastValidCustomWidth);
    setCustomWidthAuto(item.customWidthAuto);
    setCustomWidthMax(item.customWidthMax);
    setDraftCrop({ ...item.draftCrop });
    setAppliedCrop({ ...item.appliedCrop });
    setCropEditing(item.cropEditing);
    setResult(item.result);
    setPreviewFormat(item.previewFormat);
    setPreviewWidth(item.previewWidth);
    setQualityTier(item.qualityTier);
    setCustomQuality(item.customQuality);
    setOptimizationMode(item.mode === "transparent-png" && !(item.sourceInfo.isPng && item.sourceInfo.hasTransparency) ? "photo" : item.mode);
    setSelectedOutputKeys([...item.selectedOutputKeys]);
    setError(null);
  }

  function switchBatchItem(itemId: string) {
    if (working || itemId === activeItemId) return;
    const nextItem = batchItems.find((item) => item.id === itemId);
    if (!nextItem) return;
    const currentSnapshot = currentBatchSnapshot();
    if (currentSnapshot) {
      setBatchItems((items) =>
        items.map((item) =>
          item.id === currentSnapshot.id ? currentSnapshot : item,
        ),
      );
    }
    hydrateBatchItem(nextItem);
  }

  function applyCropRatioToAll(aspectRatio: number) {
    if (working || batchItems.length < 2) return;
    setBatchAspectRatio(aspectRatio);
    const currentSnapshot = currentBatchSnapshot();
    const currentItems = batchItems.map((item) =>
      currentSnapshot && item.id === currentSnapshot.id ? currentSnapshot : item,
    );
    const scopedItems = sizeSettingsForScope(currentItems, "all");
    const croppedItems = scopedItems.map((item) =>
      applyCropRatioToBatchItem(item, aspectRatio),
    );
    const nextSizeLimit = currentCropLimit(croppedItems, null);
    const nextItems = croppedItems.map((item) => reconcileSizeSettings(item, nextSizeLimit));
    setSizeScope("all");
    setBatchItems(nextItems);
    const nextActiveItem =
      nextItems.find((item) => item.id === activeItemId) ?? nextItems[0];
    if (nextActiveItem) hydrateBatchItem(nextActiveItem);
    setError(null);
  }

  function useIndividualCropRatios() {
    if (working) return;
    setBatchAspectRatio(null);
    const snapshot = currentBatchSnapshot();
    const items = batchItems.map((item) => snapshot && item.id === snapshot.id ? snapshot : item);
    const nextItems = sizeSettingsForScope(items, "individual");
    setSizeScope("individual");
    setBatchItems(nextItems);
    const active = nextItems.find((item) => item.id === activeItemId);
    if (active) hydrateBatchItem(active);
    setError(null);
  }

  function clearEditor() {
    preparedPngsRef.current.clear();
    preparedPngTasksRef.current.clear();
    setPreparedPngViews(new Map());
    setPreparedPngStatuses(new Map());
    setActiveItemId(null);
    setFile(null);
    setSourceInfo(null);
    setResult(null);
    setError(null);
    setPreviewFormat(null);
    setPreviewWidth(null);
    setQualityTier("q85");
    setCustomQuality(String(DEFAULT_ENCODER_QUALITY));
    setSelectedOutputKeys([]);
    setSelectedBatchItemIds(new Set());
    setOptimizationMode("photo");
    setDraftCrop({ ...DEFAULT_CROP });
    setAppliedCrop({ ...DEFAULT_CROP });
    setCropEditing(true);
    setCustomWidthAuto(true);
    setCustomWidthMax(null);
    setLastValidCustomWidth("360");
    setBatchAspectRatio(null);
    setSizeScope("individual");
  }

  function removeBatchItem(itemId: string) {
    if (working) return;
    preparedPngsRef.current.delete(itemId);
    preparedPngTasksRef.current.delete(itemId);
    setPreparedPngViews((current) => {
      if (!current.has(itemId)) return current;
      const next = new Map(current);
      next.delete(itemId);
      return next;
    });
    setPreparedPngStatus(itemId, null);
    const currentSnapshot = currentBatchSnapshot();
    const currentItems = batchItems.map((item) =>
      currentSnapshot && item.id === currentSnapshot.id ? currentSnapshot : item,
    );
    const removedIndex = currentItems.findIndex((item) => item.id === itemId);
    if (removedIndex < 0) return;
    const removedItem = currentItems[removedIndex];
    URL.revokeObjectURL(removedItem.sourceInfo.previewUrl);
    previewUrlsRef.current.delete(removedItem.sourceInfo.previewUrl);
    const remaining = currentItems.filter((item) => item.id !== itemId);
    const remainingItems = sizeSettingsForScope(remaining, sizeScope);
    setBatchItems(remainingItems);
    setSelectedBatchItemIds((selected) => {
      const next = new Set(selected);
      next.delete(itemId);
      return next;
    });

    const nextItem =
      remainingItems.find((item) => item.id === activeItemId) ??
      remainingItems[Math.min(removedIndex, remainingItems.length - 1)] ?? null;
    if (nextItem) hydrateBatchItem(nextItem);
    else clearEditor();
  }

  function syncOptionsToCrop(
    nextCrop: CropSettings,
    sourceWidth: number,
    sourceHeight: number,
  ) {
    const snapshot = currentBatchSnapshot();
    const itemsWithAppliedCrop = batchItems.map((item) =>
      snapshot && item.id === snapshot.id ? { ...snapshot, draftCrop: nextCrop, appliedCrop: nextCrop, cropEditing: false } : item,
    );
    const nextSizeLimit = currentCropLimit(itemsWithAppliedCrop, snapshot?.id ?? null,
      Math.floor(calculateCropRect(sourceWidth, sourceHeight, nextCrop).width), sizeScope);
    let nextActiveItem: BatchItem | null = null;
    if (snapshot) {
      const previousWidth = calculateCropRect(sourceWidth, sourceHeight, snapshot.appliedCrop).width;
      const nextWidth = calculateCropRect(sourceWidth, sourceHeight, nextCrop).width;
      const widthChanged = Math.abs(nextWidth - previousWidth) > 0.0001;
      // Export settings follow the saved crop; moving a draft alone does not stale a result.
      const next = reconcileSizeSettings({ ...snapshot, draftCrop: nextCrop, appliedCrop: nextCrop, cropEditing: false }, nextSizeLimit, widthChanged);
      nextActiveItem = next;
      setProfileId(next.profileId);
      setCustomWidth(next.customWidth);
      setLastValidCustomWidth(next.lastValidCustomWidth);
      setCustomWidthAuto(next.customWidthAuto);
      setCustomWidthMax(next.customWidthMax);
    }
    setBatchItems((items) => items.map((item) => {
      if (snapshot && item.id === snapshot.id) {
        return nextActiveItem ?? item;
      }
      return sizeScope === "all" ? reconcileSizeSettings(item, nextSizeLimit) : item;
    }));
  }

  async function acceptFiles(nextFiles: File[]) {
    if (!nextFiles.length || addingFiles) return;
    const currentSnapshot = currentBatchSnapshot();
    const storedItems = batchItems.map((item) =>
      currentSnapshot && item.id === currentSnapshot.id ? currentSnapshot : item,
    );
    const availableSlots = MAX_BATCH_FILES - storedItems.length;
    if (availableSlots <= 0) {
      setError("Можно добавить не более 10 изображений");
      return;
    }

    setAddingFiles(true);
    setError(null);
    const candidates = getUploadCandidates(nextFiles, storedItems.length);
    const preparedItems: BatchItem[] = [];
    const skipped: string[] = [];

    for (const nextFile of candidates) {
      const png = nextFile.type === "image/png" || await hasPngSignature(nextFile);
      if (!isAcceptedFile(nextFile) && !png) {
        skipped.push(`${nextFile.name}: неподдерживаемый формат`);
        continue;
      }
      if (nextFile.size > 40 * 1024 * 1024) {
        skipped.push(`${nextFile.name}: больше 40 МБ`);
        continue;
      }

      try {
        let bitmap: ImageBitmap | null = null;
        let previewUrl: string | null = null;
        try {
          bitmap = isHeicFile(nextFile)
            ? await decodeHeicBitmap(nextFile)
            : await createImageBitmap(nextFile, {
                imageOrientation: "from-image",
              });
          const sourceHasTransparency = await hasTransparency(bitmap);
          previewUrl = isHeicFile(nextFile)
            ? await createPreviewUrl(bitmap)
            : URL.createObjectURL(nextFile);
          previewUrlsRef.current.add(previewUrl);
          const originalItem = createBatchItem(nextFile, {
            width: bitmap.width,
            height: bitmap.height,
            previewUrl,
            hasTransparency: sourceHasTransparency,
            isPng: png,
          }, png && sourceHasTransparency ? "transparent-png" : "photo");
          const nextItem = batchAspectRatio
            ? applyCropRatioToBatchItem(originalItem, batchAspectRatio)
            : originalItem;
          preparedItems.push(nextItem);
        } finally {
          bitmap?.close();
          if (previewUrl && !previewUrlsRef.current.has(previewUrl)) {
            URL.revokeObjectURL(previewUrl);
          }
        }
      } catch (nextError) {
        skipped.push(
          `${nextFile.name}: ${nextError instanceof Error ? nextError.message : "браузер не смог открыть файл"}`,
        );
      }
    }

    const wasTruncated = nextFiles.length > availableSlots;
    const allItems = [...storedItems, ...preparedItems];
    const nextItems = sizeSettingsForScope(allItems, sizeScope);
    setBatchItems(nextItems);
    const nextActive = nextItems.find((item) => item.id === activeItemId) ?? nextItems[0];
    if (nextActive) hydrateBatchItem(nextActive);
    const notices = [...skipped];
    if (wasTruncated) {
      notices.push("Можно добавить не более 10 изображений");
    }
    if (notices.length) setError(notices.join(" · "));
    setAddingFiles(false);
  }

  function handleInput(event: ChangeEvent<HTMLInputElement>) {
    const nextFiles = Array.from(event.target.files ?? []);
    if (nextFiles.length) void acceptFiles(nextFiles);
    event.target.value = "";
  }

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragging(false);
    const nextFiles = Array.from(event.dataTransfer.files ?? []);
    if (nextFiles.length) void acceptFiles(nextFiles);
  }

  function resetImage() {
    if (activeItemId) removeBatchItem(activeItemId);
  }

  function updateDraftCrop(nextCrop: CropSettings) {
    setCropEditing(true);
    setCropWidthInput(null);
    setCropHeightInput(null);
    setDraftCrop(nextCrop);
    setError(null);
  }

  function handleCropDimensionChange(axis: "width" | "height", value: string) {
    if (axis === "width") setCropWidthInput(value);
    else setCropHeightInput(value);
    if (!sourceInfo || !draftCropRect || !/^[0-9]+$/.test(value)) return;

    const requestedDimension = Number(value);
    if (!Number.isSafeInteger(requestedDimension) || requestedDimension <= 0) return;
    const rect = resizeCropRectToDimensions(
      draftCropRect,
      axis,
      requestedDimension,
      sourceInfo.width,
      sourceInfo.height,
      draftCrop.aspectRatio,
    );
    updateDraftCrop(cropSettingsFromRect(rect, sourceInfo.width, sourceInfo.height, draftCrop.aspectRatio));
  }

  function finishCropDimensionInput(axis: "width" | "height") {
    if (axis === "width") setCropWidthInput(null);
    else setCropHeightInput(null);
  }

  function handleCropDimensionKeyDown(event: ReactKeyboardEvent<HTMLInputElement>, axis: "width" | "height") {
    if (event.key !== "Enter") return;
    event.preventDefault();
    finishCropDimensionInput(axis);
    event.currentTarget.blur();
  }

  function handleCropPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (working || !draftCropRect || !sourceInfo || event.button !== 0) return;
    const handle = (event.target as HTMLElement).closest<HTMLElement>("[data-crop-handle]")?.dataset.cropHandle as CropResizeHandle | undefined;
    const onFrame = (event.target as HTMLElement).closest(".crop-frame");
    if (!handle && !onFrame) return;
    if (!handle && !canMoveCropX && !canMoveCropY) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    setCropGuides({ x: false, y: false });
    const start = {
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      rect: { ...draftCropRect },
    };
    if (handle) cropResizeRef.current = { ...start, handle };
    else cropDragRef.current = start;
  }

  function handleCropPointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const resizing = cropResizeRef.current;
    const moving = cropDragRef.current;
    const drag = resizing ?? moving;
    if (!drag || drag.pointerId !== event.pointerId || !sourceInfo) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    const deltaX = ((event.clientX - drag.startClientX) / bounds.width) * sourceInfo.width;
    const deltaY = ((event.clientY - drag.startClientY) / bounds.height) * sourceInfo.height;
    if (resizing) {
      setCropGuides({ x: false, y: false });
      const rect = resizeCropRect(resizing.rect, resizing.handle, deltaX, deltaY, sourceInfo.width, sourceInfo.height, draftCrop.aspectRatio);
      updateDraftCrop(resizedCropSettings(rect, resizing.handle, sourceInfo, draftCrop.aspectRatio));
    } else {
      const rect = {
        ...drag.rect,
        x: Math.min(sourceInfo.width - drag.rect.width, Math.max(0, drag.rect.x + deltaX)),
        y: Math.min(sourceInfo.height - drag.rect.height, Math.max(0, drag.rect.y + deltaY)),
      };
      // Measure proximity in visual pixels; keep drag anchored to its initial rectangle.
      const snapX = Math.abs(rect.x + rect.width / 2 - sourceInfo.width / 2) <= 7 * sourceInfo.width / bounds.width;
      const snapY = Math.abs(rect.y + rect.height / 2 - sourceInfo.height / 2) <= 7 * sourceInfo.height / bounds.height;
      if (snapX) rect.x = (sourceInfo.width - rect.width) / 2;
      if (snapY) rect.y = (sourceInfo.height - rect.height) / 2;
      setCropGuides({ x: snapX, y: snapY });
      updateDraftCrop({
        ...draftCrop,
        positionX: sourceInfo.width > rect.width ? (rect.x / (sourceInfo.width - rect.width)) * 100 : 50,
        positionY: sourceInfo.height > rect.height ? (rect.y / (sourceInfo.height - rect.height)) * 100 : 50,
      });
    }
  }

  function handleCropPointerEnd(event: ReactPointerEvent<HTMLDivElement>) {
    if (cropDragRef.current?.pointerId !== event.pointerId && cropResizeRef.current?.pointerId !== event.pointerId) return;
    cropDragRef.current = null;
    cropResizeRef.current = null;
    setCropGuides({ x: false, y: false });
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  function applyCrop() {
    if (sourceInfo) syncOptionsToCrop(draftCrop, sourceInfo.width, sourceInfo.height);
    setAppliedCrop(draftCrop);
    setCropEditing(false);

    setError(null);
  }

  function openCropForSizeChange() {
    if (!result) return;
    setDraftCrop({ ...appliedCrop, size: appliedCrop.size ? { ...appliedCrop.size } : undefined });
    setCropEditing(true);
    setError(null);
  }

  function chooseSizeProfile(nextProfileId: ImageProfile["id"]) {
    if (nextProfileId === activeProfileId) return;
    setProfileId(nextProfileId);
    openCropForSizeChange();
  }

  function chooseCustomWidth(nextWidth: string) {
    if (nextWidth === customWidth && activeProfileId === "custom") return;
    setProfileId("custom");
    setCustomWidth(nextWidth);
    if (parseCustomWidth(nextWidth, currentLimit) !== null) setLastValidCustomWidth(nextWidth);
    setCustomWidthAuto(false);
    openCropForSizeChange();
  }

  function finishCustomWidthInput() {
    const width = parseCustomWidth(customWidth, currentLimit);
    if (width !== null) {
      setCustomWidth(String(width));
      setLastValidCustomWidth(String(width));
      return;
    }
    const previous = Number(lastValidCustomWidth);
    const restored = String(Math.min(previous, effectiveCropMaximum(currentLimit)));
    setCustomWidth(restored);
    setLastValidCustomWidth(restored);
  }

  function handleCustomWidthKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    if (event.key !== "Enter") return;
    event.preventDefault();
    finishCustomWidthInput();
    event.currentTarget.blur();
  }

  function chooseResultWidth(width: number) {
    if (!result || working || width === (previewWidth ?? result.results[0]?.width)) return;
    setPreviewWidth(width);
    setSelectedOutputKeys(defaultOutputSelectionForTarget(result, width));
    const selectedVariant = smallestAvailableVariant(result, width);
    if (selectedVariant) setPreviewFormat(selectedVariant.format);
  }

  async function runOptimization() {
    if (!file || working) return;
    const snapshot = currentBatchSnapshot();
    if (!snapshot) return;
    const issue = batchItemError(snapshot, currentLimit);
    if (issue) { setError(issue); return; }
    let quality: number | undefined;
    try { quality = snapshot.mode === "transparent-png" ? undefined : resolveEncoderQuality(snapshot.qualityTier, snapshot.customQuality); }
    catch (nextError) { setError((nextError as Error).message); return; }
    if (!profile.widths.length) { setError("Выберите доступный размер."); return; }
    const runProfile = snapshot.mode === "transparent-png"
      ? transparentPngTargetProfile(profile, currentLimit)
      : profile;
    const resultSettingsKey = optimizationSettingsKey(snapshot, runProfile, quality);
    setWorking(true);
    setProcessingItemId(activeItemId);
    setError(null);
    setProgress(0);
    try {
      const prepared = snapshot.mode === "transparent-png"
        ? await ensurePreparedPng(snapshot.id, snapshot.file, snapshot.appliedCrop, runProfile)
        : undefined;
      const nextResult = await optimizeImage({
        file: snapshot.file, profile: runProfile, crop: snapshot.appliedCrop, mode: snapshot.mode, quality,
        ...(snapshot.mode === "transparent-png" ? {
          prepared,
        } : {}),
        onProgress: (nextProgress, message) => {
          setProgress(nextProgress);
          setProgressText(message);
        },
      });
      const nextItem = commitResult(snapshot, nextResult, prepared?.key ?? null, resultSettingsKey);
      setBatchItems((items) => items.map((item) => item.id === nextItem.id ? nextItem : item));
      setSelectedBatchItemIds((selected) => new Set(selected).add(nextItem.id));
      hydrateBatchItem(nextItem);
      window.setTimeout(() => document.getElementById("results")?.scrollIntoView({ behavior: "smooth", block: "start" }), 100);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Не удалось обработать изображение.");
    } finally {
      setProcessingItemId(null);
      setWorking(false);
    }
  }

  async function runBatchOptimization() {
    if (working) return;
    const snapshot = currentBatchSnapshot();
    let workingItems = batchItems.map((item) => snapshot && item.id === snapshot.id ? snapshot : item);
    if (!workingItems.length) return;
    const jobs: Array<{ item: BatchItem; profile: ImageProfile; quality: number | undefined; resultSettingsKey: string | null }> = [];
    for (const item of workingItems) {
      try {
        const itemLimit = sizeScope === "all" ? currentLimit : cropAvailableWidth(item);
        const issue = batchItemError(item, itemLimit);
        if (issue) throw new Error(issue);
        const mode = item.mode === "transparent-png" && !(item.sourceInfo.isPng && item.sourceInfo.hasTransparency) ? "photo" : item.mode;
        const snapshotItem = { ...item, mode };
        const selectedProfile = pendingProfile(snapshotItem, itemLimit);
        const itemProfile = mode === "transparent-png"
          ? transparentPngTargetProfile(selectedProfile, itemLimit) : selectedProfile;
        const quality = mode === "transparent-png" ? undefined : resolveEncoderQuality(item.qualityTier, item.customQuality);
        jobs.push({ item: snapshotItem, profile: itemProfile, quality,
          resultSettingsKey: optimizationSettingsKey(snapshotItem, itemProfile, quality) });
      } catch (nextError) {
        setBatchItems(workingItems);
        hydrateBatchItem(item);
        setError(`${item.file.name}: ${(nextError as Error).message}`);
        return;
      }
    }
    setWorking(true);
    setError(null);
    setProgress(0);
    try {
      for (let index = 0; index < jobs.length; index += 1) {
        const { item, profile: itemProfile, quality, resultSettingsKey } = jobs[index];
        setProcessingItemId(item.id);
        const prepared = item.mode === "transparent-png"
          ? await ensurePreparedPng(item.id, item.file, item.appliedCrop, itemProfile)
          : undefined;
        const nextResult = await optimizeImage({
          file: item.file, profile: itemProfile, crop: item.appliedCrop, mode: item.mode, quality,
          ...(item.mode === "transparent-png" ? {
            prepared,
          } : {}),
          onProgress: (itemProgress, message) => {
            setProgress(Math.round(((index + itemProgress / 100) / jobs.length) * 100));
            setProgressText(`Фото ${index + 1} из ${jobs.length}: ${message}`);
          },
        });
        const nextItem = commitResult(item, nextResult, prepared?.key ?? null, resultSettingsKey);
        workingItems = workingItems.map((current) => current.id === nextItem.id ? nextItem : current);
        setBatchItems(workingItems);
        setSelectedBatchItemIds((selected) => new Set(selected).add(nextItem.id));
        if (nextItem.id === activeItemId) hydrateBatchItem(nextItem);
      }
      window.setTimeout(() => document.getElementById("results")?.scrollIntoView({ behavior: "smooth", block: "start" }), 100);
    } catch (nextError) {
      setBatchItems(workingItems);
      setError(nextError instanceof Error ? nextError.message : "Не удалось обработать все изображения.");
    } finally {
      setProcessingItemId(null);
      setWorking(false);
    }
  }

  const liveSnapshot = currentBatchSnapshot();
  const visibleBatchItems = batchItems.map((item) =>
    liveSnapshot && item.id === liveSnapshot.id ? liveSnapshot : item,
  );
  const activeOptimizationCurrent = liveSnapshot ? isOptimizationCurrent(liveSnapshot, currentLimit) : false;
  const batchNeedsOptimization = visibleBatchItems.some((item) =>
    !isOptimizationCurrent(item, sizeScope === "all" ? currentLimit : cropAvailableWidth(item)),
  );
  const readyBatchItems = visibleBatchItems.filter((item) =>
    isDownloadableBatchItem(item, sizeScope === "all" ? currentLimit : cropAvailableWidth(item)),
  );
  const readyBatchItemIds = readyBatchItems.map((item) => item.id);
  const selectedReadyCount = readyBatchItemIds.filter((id) => selectedBatchItemIds.has(id)).length;
  const batchMasterChecked = readyBatchItemIds.length > 0 && selectedReadyCount === readyBatchItemIds.length;
  const batchMasterIndeterminate = selectedReadyCount > 0 && !batchMasterChecked;
  const batchDownloadOutputs = buildBatchDownloadSet(readyBatchItems, selectedBatchItemIds);
  const batchDownloadLabel = batchDownloadOutputs.length > 1
    ? `СКАЧАТЬ ${batchDownloadOutputs.length} ФАЙЛОВ`
    : batchDownloadOutputs[0]?.item.result?.mode === "transparent-png"
      ? `СКАЧАТЬ ОПТИМИЗИРОВАННЫЙ PNG · ${batchDownloadOutputs[0].width}×${batchDownloadOutputs[0].height} PX`
      : outputDownloadLabel(batchDownloadOutputs);
  useEffect(() => {
    if (batchSelectAllRef.current) batchSelectAllRef.current.indeterminate = batchMasterIndeterminate;
  }, [batchMasterIndeterminate]);

  function toggleBatchItemSelection(itemId: string) {
    setSelectedBatchItemIds((selected) => {
      const next = new Set(selected);
      if (next.has(itemId)) next.delete(itemId);
      else next.add(itemId);
      return next;
    });
  }

  function toggleReadyPhotoSelection(checked: boolean) {
    setSelectedBatchItemIds((selected) => setReadyPhotoSelection(selected, readyBatchItemIds, checked));
  }

  function renderBatchPhotoSwitcher() {
    if (visibleBatchItems.length <= 1) return null;
    return (
      <div className="result-photo-switcher">
        <header>
          <span>
            <strong>Готовые фотографии</strong>
            <small>Выберите фото для просмотра результата</small>
          </span>
          <div className="result-batch-selection">
            <em>{selectedReadyCount} из {readyBatchItems.length}</em>
            <label>
              <input
                ref={batchSelectAllRef}
                type="checkbox"
                checked={batchMasterChecked}
                disabled={working || !readyBatchItems.length}
                aria-label="Выбрать все готовые фотографии"
                onChange={(event) => toggleReadyPhotoSelection(event.currentTarget.checked)}
              />
              <span>Выбрать все</span>
            </label>
          </div>
        </header>
        <div>
          {visibleBatchItems.map((item, index) => (
            <div className="result-photo-card" key={item.id}>
              <button
                className={`result-photo-card-preview${item.id === activeItemId ? " is-active" : ""}`}
                type="button"
                onClick={() => switchBatchItem(item.id)}
                disabled={working || !isDownloadableBatchItem(item, sizeScope === "all" ? currentLimit : cropAvailableWidth(item))}
                aria-pressed={item.id === activeItemId}
                aria-label={item.result
                  ? `Показать результат фото ${index + 1}: ${item.file.name}`
                  : `Фото ${index + 1} ещё не обработано`}
              >
                {/* Local preview URLs are rendered directly in the result switcher. */}
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={item.sourceInfo.previewUrl} alt="" />
                <span>
                  <small>Фото {index + 1}</small>
                  <strong>{item.file.name}</strong>
                  <em>{item.result ? "Показать результат" : "Не обработано"}</em>
                </span>
              </button>
              <label className="result-photo-select">
                <input
                  type="checkbox"
                  checked={selectedBatchItemIds.has(item.id)}
                disabled={working || !isDownloadableBatchItem(item, sizeScope === "all" ? currentLimit : cropAvailableWidth(item))}
                  aria-label={`Выбрать фото ${index + 1} для скачивания`}
                  onChange={() => toggleBatchItemSelection(item.id)}
                />
              </label>
            </div>
          ))}
        </div>
      </div>
    );
  }
  const activeItemNumber = Math.max(
    1,
    visibleBatchItems.findIndex((item) => item.id === activeItemId) + 1,
  );
  const batchAspectPreset = CROP_PRESETS.find(
    (preset) => preset.ratio === batchAspectRatio,
  );
  const hasIndividualCropOverrides = Boolean(
    batchAspectRatio &&
      visibleBatchItems.some(
        (item) => item.appliedCrop.aspectRatio !== batchAspectRatio,
      ),
  );

  function chooseQuality(tier: QualityTier) {
    setQualityTier(tier);
  }

  async function downloadPreparedPng() {
    const item = currentBatchSnapshot();
    if (!item || item.mode !== "transparent-png" || !activePreparedOutputs.length || !activePreparedDownloadKey) return;
    for (let index = 0; index < activePreparedOutputs.length; index += 1) {
      const output = activePreparedOutputs[index];
      downloadBlob(output.blob, output.fileName);
      if (index < activePreparedOutputs.length - 1) {
        await new Promise((resolve) => window.setTimeout(resolve, 140));
      }
    }
    setBatchItems((items) => items.map((current) => current.id === item.id
      ? { ...current, preparedPngDownloadKey: activePreparedDownloadKey }
      : current));
  }

  async function downloadSelectedOutputs() {
    if (downloadingFilesRef.current || !batchDownloadOutputs.length) return;
    const outputs = [...batchDownloadOutputs];
    downloadingFilesRef.current = true;
    setDownloadingFiles(true);
    try {
      for (let index = 0; index < outputs.length; index += 1) {
        const { item, width, height, variant } = outputs[index];
        downloadBlob(variant.blob, variant.fileName);
        if (item.result?.mode === "transparent-png") {
          const key = optimizedPngDownloadIdentity(item.optimizedPngTargetKey ?? "", width, height);
          setBatchItems((items) => items.map((current) => current.id === item.id
            ? { ...current, optimizedPngDownloadKeys: current.optimizedPngDownloadKeys.includes(key)
              ? current.optimizedPngDownloadKeys : [...current.optimizedPngDownloadKeys, key] }
            : current));
        }
        if (index < outputs.length - 1) {
          await new Promise((resolve) => window.setTimeout(resolve, 140));
        }
      }
    } finally {
      downloadingFilesRef.current = false;
      setDownloadingFiles(false);
    }
  }

  const qualitySelector = (
    <fieldset className="quality-selector" disabled={working}>
      <legend>КАЧЕСТВО</legend>
      <div className="quality-selector-options" role="group" aria-label="Качество кодирования">
        {QUALITY_OPTIONS.map((option) => (
          <button
            type="button"
            key={option.tier}
            data-quality-tier={option.tier}
            className={selectedQualityTier === option.tier ? "is-active" : ""}
            aria-pressed={selectedQualityTier === option.tier}
            onClick={() => chooseQuality(option.tier)}
          >{option.label}</button>
        ))}
        {selectedQualityTier === "custom" ? (
          <input
            className="quality-custom-input"
            type="text"
            inputMode="numeric"
            value={customQuality}
            aria-label="Своё качество кодирования от 1 до 100"
            aria-invalid={!validCustomQuality}
            title="Целое число от 1 до 100"
            onChange={(event) => setCustomQuality(event.target.value)}
          />
        ) : null}
      </div>
      {selectedQualityTier === "custom" && !validCustomQuality ? (
        <small className="quality-selector-error" role="status">Введите целое число от 1 до 100</small>
      ) : null}
    </fieldset>
  );

  return (
  <>
    <input
      ref={inputRef}
      type="file"
      accept={ACCEPTED_INPUT}
      onChange={handleInput}
      multiple
      disabled={addingFiles || working || batchItems.length >= MAX_BATCH_FILES}
      hidden
    />

    {!file || !sourceInfo ? (
      <section className="optimizer-upload-landing">
        <div
          className={`dropzone dropzone-landing ${dragging ? "is-dragging" : ""}`}
          onDragEnter={(event) => {
            event.preventDefault();
            setDragging(true);
          }}
          onDragOver={(event) => event.preventDefault()}
          onDragLeave={() => setDragging(false)}
          onDrop={handleDrop}
          onClick={() => inputRef.current?.click()}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              inputRef.current?.click();
            }
          }}
          role="button"
          tabIndex={0}
        >
          <div className="upload-icon" aria-hidden="true">
            <span><svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" focusable="false"><path d="M12 17V3m-6 6 6-6 6 6M4 16v5h16v-5" /></svg></span>
          </div>

          <strong>
            {addingFiles
              ? "Добавляем изображения…"
              : `Загрузите до ${MAX_BATCH_FILES} изображений`}
          </strong>

          <p>
            Перетащите файлы сюда или нажмите, чтобы выбрать изображения
          </p>

          <small>
            PNG · JPEG · HEIC / HEIF · WebP · AVIF · до 40 МБ каждый
          </small>
        </div>
      </section>
    ) : (
      <div className={`optimizer-shell ${result ? "has-results" : ""}`}>
        <div className="optimizer-topline">
          <span>
            Очередь · {batchItems.length} из {MAX_BATCH_FILES}
          </span>

          <span className="local-badge">
            <i aria-hidden="true" /> Обработка в браузере
          </span>
        </div>

        <fieldset className="processing-mode" disabled={working}>
          <legend>Режим обработки</legend>

          <label className={optimizationMode === "photo" ? "is-active" : ""}>
            <input
              type="radio"
              name="optimization-mode"
              value="photo"
              checked={optimizationMode === "photo"}
              onChange={() => {
                setOptimizationMode("photo");
                          }}
            />

            <span>
              <strong>Фото</strong>
              <small>Минимальный вес с контролем деталей</small>
            </span>

            <i aria-hidden="true"><svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" focusable="false"><rect x="3" y="4" width="18" height="16" rx="2" /><path d="m3 16 6-6 4 4 3-3 5 5" /><circle cx="16" cy="8" r="1" /></svg></i>
          </label>

          <label
            className={optimizationMode === "screenshot" ? "is-active" : ""}
          >
            <input
              type="radio"
              name="optimization-mode"
              value="screenshot"
              checked={optimizationMode === "screenshot"}
              onChange={() => {
                setOptimizationMode("screenshot");
                          }}
            />

            <span>
              <strong>Скриншот</strong>
              <small>Строгая проверка текста, линий и интерфейса</small>
            </span>

            <i aria-hidden="true"><svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" focusable="false"><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 8h18M7 12h10M7 16h6" /></svg></i>
          </label>
          <label className={optimizationMode === "transparent-png" ? "is-active" : ""}>
            <input type="radio" name="optimization-mode" value="transparent-png"
              disabled={!(sourceInfo?.isPng && sourceInfo.hasTransparency)}
              checked={optimizationMode === "transparent-png"}
              onChange={() => { if (sourceInfo?.isPng && sourceInfo.hasTransparency) setOptimizationMode("transparent-png"); }} />
            <span><strong>PNG с прозрачностью</strong><small>Для PNG с прозрачным фоном</small></span>
            <i aria-hidden="true"><svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" focusable="false"><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M3 9h18M3 15h18M9 3v18M15 3v18" /></svg></i>
          </label>
        </fieldset>



<div className="optimizer-body">
          <section className="batch-queue" aria-label="Очередь фотографий">
            <header className="batch-queue-header">
              <span>
                <strong>Фотографии в работе</strong>
                <small>
                  Настройки сохраняются отдельно для каждого кадра · готово {readyBatchItems.length}
                  {" "}из {visibleBatchItems.length}
                </small>
              </span>
              <div>
                <button
                  className="batch-add-button"
                  type="button"
                  onClick={() => inputRef.current?.click()}
                  disabled={
                    addingFiles || working || batchItems.length >= MAX_BATCH_FILES
                  }
                >
                  {addingFiles
                    ? "Добавляем…"
                    : batchItems.length >= MAX_BATCH_FILES
                      ? "Очередь заполнена"
                      : "+ Добавить фото"}
                </button>
              </div>
            </header>
            <div className="batch-strip">
              {visibleBatchItems.map((item, index) => {
                const itemIssue =
                  visibleBatchItems.length > 1
                    ? cropsEqual(item.draftCrop, item.appliedCrop)
                      ? null
                      : "Сохраните кадр"
                    : batchItemError(item, currentLimit);
                const isProcessing = processingItemId === item.id;
                const status = isProcessing
                  ? "Обработка…"
                    : itemIssue
                    ? itemIssue
                    : item.result
                      ? `Готово · размеров: ${item.result.results.length}`
                      : "Готов к настройке";
                return (
                  <div
                    className={`${item.id === activeItemId ? "is-active" : ""} ${itemIssue ? "has-issue" : ""} ${item.result ? "is-complete" : ""}`}
                    key={item.id}
                  >
                    <button
                      className="batch-card-main"
                      type="button"
                      onClick={() => switchBatchItem(item.id)}
                      disabled={working}
                      aria-pressed={item.id === activeItemId}
                    >
                      {/* Local preview URLs are rendered directly in the queue. */}
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={item.sourceInfo.previewUrl} alt="" />
                      <span>
                        <small>Фото {index + 1}</small>
                        <strong>{item.file.name}</strong>
                        <em>{status}</em>
                      </span>
                    </button>
                    <button
                      className="batch-card-remove"
                      type="button"
                      onClick={() => removeBatchItem(item.id)}
                      disabled={working}
                      aria-label={`Удалить ${item.file.name} из очереди`}
                    >
                      <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" focusable="false"><path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7" /></svg>
                    </button>
                  </div>
                );
              })}
            </div>
            {visibleBatchItems.length > 1 ? (
              <div className="batch-crop-toolbar">
                <div className="batch-crop-toolbar-heading">
                  <span>
                    <strong>Пропорции кадров</strong>
                    <small>
                      По отдельности — выберите фотографию выше. Для всех сразу —
                      нажмите нужный формат ниже.
                    </small>
                  </span>
                  <em>
                    {batchAspectPreset
                      ? `${hasIndividualCropOverrides ? "Общий по умолчанию" : "Для всей очереди"} · ${batchAspectPreset.label}`
                      : "По отдельности"}
                  </em>
                </div>
                <div className="batch-crop-presets" role="group" aria-label="Применить пропорции ко всем фотографиям">
                  <button
                    className={`batch-crop-individual ${batchAspectRatio === null ? "is-active" : ""}`}
                    type="button"
                    onClick={useIndividualCropRatios}
                    aria-pressed={batchAspectRatio === null}
                  >
                    <i aria-hidden="true">≠</i>
                    <span>По отдельности</span>
                  </button>
                  {CROP_PRESETS.filter((preset) => preset.ratio !== null).map(
                    (preset) => {
                      const ratio = preset.ratio as number;
                      const shape = cropShapeDimensions(ratio);
                      const isActive = batchAspectRatio === ratio;
                      return (
                        <button
                          className={isActive ? "is-active" : ""}
                          type="button"
                          onClick={() => applyCropRatioToAll(ratio)}
                          aria-pressed={isActive}
                          key={preset.id}
                        >
                          <i aria-hidden="true">
                            <b style={{ width: shape.width * 0.72, height: shape.height * 0.72 }} />
                          </i>
                          <span>{preset.label}</span>
                        </button>
                      );
                    },
                  )}
                </div>
                <p>
                  Общие пропорции применяются к текущим и ко всем новым фотографиям,
                  пока вы не выберете другой формат или «По отдельности». Композицию
                  любого кадра всё равно можно поправить отдельно.
                </p>
              </div>
            ) : null}
          </section>

          <div className="source-row">
            {/* Blob URL is created locally and cannot use Next's image loader. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={sourceInfo.previewUrl} alt="Загруженный оригинал" />
            <div>
              <strong>{file.name}</strong>
              <span>
                Фото {activeItemNumber} из {batchItems.length} · {sourceInfo.width} ×{" "}
                {sourceInfo.height} · {formatBytes(file.size)} · {extensionLabel(file.type)}
              </span>
            </div>
            <button
              className="icon-button"
              type="button"
              onClick={resetImage}
              disabled={working}
              aria-label="Удалить активную фотографию из очереди"
            >
              <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" focusable="false"><path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7" /></svg>
            </button>
          </div>

          <fieldset className="setting-group crop-setting-group" disabled={working}>
            <legend>Сначала подготовьте кадр</legend>
            <div className="crop-intro">
              <span>
                <strong>Выберите пропорции и композицию</strong>
                <small>Лишние части не попадут в оптимизированные файлы</small>
              </span>
              <em>{cropDirty ? "Есть несохранённые изменения" : "Кадр сохранён"}</em>
            </div>

            <div className="crop-ratios" aria-label="Соотношение сторон">
              {CROP_PRESETS.map((preset) => {
                const isActive = isCropPresetActive(draftCrop, preset.ratio, sourceInfo);
                const shape = cropShapeDimensions(
                  preset.ratio ?? sourceAspectRatio,
                );
                return (
                  <button
                    className={isActive ? "is-active" : ""}
                    type="button"
                    onClick={() =>
                      updateDraftCrop({
                        aspectRatio: preset.ratio,
                        positionX: 50,
                        positionY: 50,
                      })
                    }
                    aria-pressed={isActive}
                    key={preset.id}
                  >
                    <span className="crop-ratio-shape" aria-hidden="true">
                      <i style={{ width: shape.width, height: shape.height }} />
                    </span>
                    <span className="crop-ratio-copy">
                      <strong>{preset.label}</strong>
                      <small>{preset.description}</small>
                    </span>
                  </button>
                );
              })}
            </div>

            <div className={`crop-preview-layout ${result ? "has-result" : ""}`}>
            <div
              className={`crop-stage crop-stage-with-frame ${cropEditing ? "is-editing" : "is-applied"} ${cropEditing && (canMoveCropX || canMoveCropY) ? "is-movable" : ""} ${sourceInfo.hasTransparency ? "has-transparency" : ""}`}
              style={{ aspectRatio: cropPresentation?.aspectRatio }}
              onPointerDown={handleCropPointerDown}
              onPointerMove={handleCropPointerMove}
              onPointerUp={handleCropPointerEnd}
              onPointerCancel={handleCropPointerEnd}
              aria-label="Предпросмотр кадра. Перемещайте рамку или изменяйте её границы и углы."
            >
              {/* Presentation crops the original URL; processing still uses File + appliedCrop. */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={sourceInfo.previewUrl} style={cropPresentation?.imageStyle} alt={cropEditing ? "Предпросмотр кадрирования" : "Сохранённый кадр"} draggable={false} />
              {cropEditing && (cropGuides.x || cropGuides.y) ? (
                <span className="crop-center-guides" aria-hidden="true">
                  {cropGuides.x ? <span className="crop-center-guide-x" /> : null}
                  {cropGuides.y ? <span className="crop-center-guide-y" /> : null}
                </span>
              ) : null}
              {cropEditing && draftCropRect ? (
                <div
                  className="crop-frame"
                  style={{
                    left: `${draftCropRect.x / sourceInfo.width * 100}%`,
                    top: `${draftCropRect.y / sourceInfo.height * 100}%`,
                    width: `${draftCropRect.width / sourceInfo.width * 100}%`,
                    height: `${draftCropRect.height / sourceInfo.height * 100}%`,
                  }}
                >
                  <span className="crop-grid" aria-hidden="true" />
                  {CROP_HANDLES.map((handle) => (
                    <button
                      key={handle.id}
                      type="button"
                      className={`crop-resize-handle crop-resize-${handle.id}`}
                      data-crop-handle={handle.id}
                      aria-label={`Изменить ${handle.label} кадра`}
                      onKeyDown={(event) => {
                        if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
                        event.preventDefault();
                        const dx = event.key === "ArrowLeft" ? -10 : event.key === "ArrowRight" ? 10 : 0;
                        const dy = event.key === "ArrowUp" ? -10 : event.key === "ArrowDown" ? 10 : 0;
                        const rect = resizeCropRect(draftCropRect, handle.id, dx, dy, sourceInfo.width, sourceInfo.height, draftCrop.aspectRatio);
                        updateDraftCrop(resizedCropSettings(rect, handle.id, sourceInfo, draftCrop.aspectRatio));
                      }}
                    />
                  ))}
                </div>
              ) : null}
            </div>
            </div>
            {cropEditing ? <p className="crop-frame-help">Перемещайте рамку · тяните границы или углы</p> : null}
            {cropEditing && draftCropRect ? (
              <div className="crop-dimensions">
                <span className="crop-dimensions-label">Размер области</span>
                <label>
                  <span className="visually-hidden">Ширина области кадрирования в пикселях оригинала</span>
                  <input
                    type="text"
                    inputMode="numeric"
                    value={cropWidthInput ?? liveCropWidth}
                    onChange={(event) => handleCropDimensionChange("width", event.target.value)}
                    onBlur={() => finishCropDimensionInput("width")}
                    onKeyDown={(event) => handleCropDimensionKeyDown(event, "width")}
                    aria-label="Ширина области кадрирования в пикселях оригинала"
                  />
                </label>
                <span className="crop-dimensions-times" aria-hidden="true">×</span>
                <label>
                  <span className="visually-hidden">Высота области кадрирования в пикселях оригинала</span>
                  <input
                    type="text"
                    inputMode="numeric"
                    value={cropHeightInput ?? liveCropHeight}
                    onChange={(event) => handleCropDimensionChange("height", event.target.value)}
                    onBlur={() => finishCropDimensionInput("height")}
                    onKeyDown={(event) => handleCropDimensionKeyDown(event, "height")}
                    aria-label="Высота области кадрирования в пикселях оригинала"
                  />
                </label>
                <span className="crop-dimensions-unit">px</span>
              </div>
            ) : null}

            <div className="crop-save-row">
              <span>
                <small>Кадрирование выполняется из оригинала перед сжатием</small>
              </span>
              <button type="button" onClick={applyCrop} disabled={!cropDirty}>
                {cropDirty ? "Сохранить кадр" : "Кадр сохранён ✓"}
              </button>
            </div>
          </fieldset>

          <fieldset className="setting-group" disabled={working}>
            <legend>ВЫБЕРИТЕ РАЗМЕР</legend>
            <div className="profile-availability" aria-live="polite">
              <strong>После кадрирования доступно {effectiveMaxWidth}px</strong>
            </div>
            <div className="profile-grid">
              {availableProfiles.map((item) => (
                <div
                  className={`profile-card ${activeProfileId === item.id ? "is-selected" : ""} ${item.id === "custom" ? "is-custom-profile" : ""}`}
                  key={item.id}
                >
                  <label>
                    <input
                      type="radio"
                      name="profile"
                      value={item.id}
                      checked={activeProfileId === item.id}
                      onChange={() => chooseSizeProfile(item.id)}
                    />
                    <span className="profile-title-row">
                      <strong>{item.title}</strong>
                    </span>
                  </label>
                  {item.id === "custom" ? (
                    <>
                    <div className="custom-size-panel">
                      <label>
                        <span>Нужная ширина файла</span>
                        <span className="number-input">
                          <input
                            type="number"
                            min="32"
                            max={effectiveMaxWidth}
                            step="1"
                            inputMode="numeric"
                            value={customWidth}
                            onChange={(event) => chooseCustomWidth(event.target.value)}
                            onBlur={finishCustomWidthInput}
                            onKeyDown={handleCustomWidthKeyDown}
                            aria-label="Нужная ширина файла в пикселях"
                            aria-invalid={customWidthInvalid}
                          />
                          <i>px</i>
                        </span>
                      </label>
                      <p className="custom-size-help">
                        {customWidthInvalid ? "Укажите целую ширину в допустимом диапазоне. " : ""}
                        {sizeScope === "all" && batchItems.length > 1
                          ? `Максимум для всей очереди — ${effectiveMaxWidth}px по самому маленькому кадру.`
                          : `Максимум для выбранного кадра — ${effectiveMaxWidth}px.`}
                      </p>
                    </div>
                    <div className="custom-profile-actions">
                      <button
                        className="profile-size-guide-button"
                        type="button"
                        onClick={() => setSizeGuideOpen((current) => !current)}
                        aria-expanded={sizeGuideOpen}
                        aria-controls="size-guide-panel"
                      >
                        <i aria-hidden="true">?</i>
                        Как выбрать размер
                      </button>
                    </div>
                    </>
                  ) : null}
                </div>
              ))}
            </div>
            <ServiceHelpDrawer open={sizeGuideOpen} onClose={() => setSizeGuideOpen(false)} id="size-guide-panel" title="Как выбрать ширину файла" theme="optima">
              <p className="size-guide-lead">Размер файла зависит от места изображения на странице. Ширина экрана и ширина фотографии — разные значения.</p>
              <p className="size-guide-context">Пример сетки на экране 1920 px. Количество карточек условное: отступы и сетка вашего сайта могут отличаться.</p>
              <div className="size-guide-list">
                {SIZE_GUIDE_ITEMS.map((guideItem) => (
                  <article key={guideItem.id}>
                    <h3>{guideItem.columns} {guideItem.columns === 1 ? "карточка" : "карточки"} в ряду</h3>
                    <div className="size-guide-grid" style={{ gridTemplateColumns: `repeat(${guideItem.columns}, minmax(0, 1fr))` }} aria-hidden="true">
                      {Array.from({ length: guideItem.columns }, (_, index) => <span key={index} />)}
                    </div>
                    <p className="size-guide-widths"><span>Выходные ширины:</span>{" "}<strong>{guideItem.widths.join(" · ")} px</strong></p>
                  </article>
                ))}
              </div>
              <div className="size-guide-note"><h3>Свой размер</h3><p>Укажите точную ширину от 32 px до доступного максимума, но не больше 2560 px. Optima не увеличивает исходник: после кадрирования часть размеров может стать недоступна.</p></div>
              <div className="size-guide-note"><h3>Когда нужен больший файл?</h3><p>Когда изображение занимает большую часть страницы или важно сохранить лица, текст и мелкие детали. Сравните готовые AVIF и WebP и выберите подходящий файл.</p></div>
            </ServiceHelpDrawer>
          </fieldset>

          {optimizationMode !== "transparent-png" ? qualitySelector : null}

          {optimizationMode === "transparent-png" ? (
            <>
              <button
                className={`primary-button png-download-button png-download-raw${activePreparedReady && activePreparedDownloaded ? " is-downloaded" : ""}`}
                type="button"
                disabled={!activePreparedReady || !activePreparedOutputs.length}
                onClick={() => void downloadPreparedPng()}
              >
                <span>{activePreparedReady && activePreparedOutputs.length
                  ? `СКАЧАТЬ PNG БЕЗ ОПТИМИЗАЦИИ · ${activePreparedOutputs.map(({ width, height }) => `${width}×${height} PX`).join(" · ")}`
                  : `ГОТОВИМ PNG · ${activeTargetDimensionsLabel}…`}</span>
                <i aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" focusable="false"><path d="M12 3v12m0 0 5-5m-5 5-5-5M5 20h14" /></svg></i>
              </button>
              {currentPreparedStatus?.status === "error"
                ? <p className="prepared-png-status" role="alert">{currentPreparedStatus.error}</p>
                : null}
            </>
          ) : null}

          {working ? (
            <div className="progress-panel" aria-live="polite">
              <div>
                <span>{progressText}</span>
                <strong>{progress}%</strong>
              </div>
              <div className="progress-track"><span style={{ width: `${progress}%` }} /></div>
            </div>
          ) : (
            <div className={`batch-action-grid ${batchItems.length === 1 ? "is-single" : ""}`}>
              {!activeOptimizationCurrent ? (
                <button className="primary-button" type="button"
                  disabled={optimizationMode === "transparent-png" && (!activePreparedReady || !activePreparedOutputs.length)}
                  onClick={() => void runOptimization()}>
                  <span>{`Оптимизировать фото ${activeItemNumber}`}</span>
                  <i aria-hidden="true"><svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" focusable="false"><path d="M6 18 18 6M6 6h12v12" /></svg></i>
                </button>
              ) : null}
              {batchItems.length > 1 && batchNeedsOptimization ? (
                <button
                  className="batch-optimize-all"
                  type="button"
                  onClick={runBatchOptimization}
                >
                  <span>Оптимизировать всю очередь</span>
                  <strong>{batchItems.length} фото</strong>
                </button>
              ) : null}
            </div>
          )}
        </div>


      {error ? <p className="error-message">{error}</p> : null}

      {!activeResultViewReady ? renderBatchPhotoSwitcher() : null}
      {!activeResultViewReady && batchDownloadOutputs.length > 0 ? (
        <button className="primary-button result-download-button" type="button" disabled={downloadingFiles}
          onClick={() => void downloadSelectedOutputs()}>
          <span>{batchDownloadLabel}</span>
          <i aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" focusable="false"><path d="M12 3v12m0 0 5-5m-5 5-5-5M5 20h14" /></svg></i>
        </button>
      ) : null}

      {result && largestResult && comparisonResult && comparedVariant && optimizedPreview &&
        (result.mode !== "transparent-png" || activeOptimizedTargetCurrent) ? (
        <section className="results" id="results">
          {visibleBatchItems.length > 1 ? (
            <div className="result-photo-switcher">
              <header>
                <span>
                  <strong>Готовые фотографии</strong>
                  <small>Выберите фотографию для просмотра результата</small>
                </span>
                <div className="result-batch-selection">
                  <em>{selectedReadyCount} из {readyBatchItems.length}</em>
                  <label>
                    <input
                      ref={batchSelectAllRef}
                      type="checkbox"
                      checked={batchMasterChecked}
                      disabled={working || !readyBatchItems.length}
                      aria-label="Выбрать все готовые фотографии"
                      onChange={(event) => toggleReadyPhotoSelection(event.currentTarget.checked)}
                    />
                    <span>Выбрать все</span>
                  </label>
                </div>
              </header>
              <div>
                {visibleBatchItems.map((item, index) => (
                  <div className="result-photo-card" key={item.id}>
                    <button
                      className={`result-photo-card-preview${item.id === activeItemId ? " is-active" : ""}`}
                      type="button"
                      onClick={() => switchBatchItem(item.id)}
                      disabled={working || !isDownloadableBatchItem(item, sizeScope === "all" ? currentLimit : cropAvailableWidth(item))}
                      aria-pressed={item.id === activeItemId}
                      aria-label={
                        item.result
                          ? `Показать результат фото ${index + 1}: ${item.file.name}`
                          : `Фото ${index + 1} ещё не обработано`
                      }
                    >
                    {/* Local preview URLs are rendered directly in the result switcher. */}
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={item.sourceInfo.previewUrl} alt="" />
                    <span>
                      <small>Фото {index + 1}</small>
                      <strong>{item.file.name}</strong>
                      <em>{item.result ? "Показать результат" : "Не обработано"}</em>
                    </span>
                    </button>
                    <label className="result-photo-select">
                      <input
                        type="checkbox"
                        checked={selectedBatchItemIds.has(item.id)}
                      disabled={working || !isDownloadableBatchItem(item, sizeScope === "all" ? currentLimit : cropAvailableWidth(item))}
                        aria-label={`Выбрать фото ${index + 1} для скачивания`}
                        onChange={() => toggleBatchItemSelection(item.id)}
                      />
                    </label>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
          <div className="result-stage">
            <div className="comparison-preview">
              <div className="preview-size-bar">
                <span>
                  <strong>Размер для просмотра</strong>
                  <small>Исходный размер: {sourceInfo.width} × {sourceInfo.height} px · {formatBytes(file.size)}</small>
                </span>
                <div>
                  {result.results.map((widthResult) => (
                    <button
                      className={comparisonResult.width === widthResult.width ? "is-active" : ""}
                      type="button"
                      onClick={() => chooseResultWidth(widthResult.width)}
                      disabled={working}
                      aria-pressed={comparisonResult.width === widthResult.width}
                      key={widthResult.width}
                    >
                      {widthResult.width}px
                    </button>
                  ))}
                </div>
              </div>
              <div className="compare" style={{ aspectRatio: `${comparisonResult.width} / ${comparisonResult.height}` }}>
                {/* Local Blob preview stays in the browser. */}
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={optimizedPreview ?? undefined} alt={`Оптимизированное изображение ${comparisonResult.width}px`} />
              </div>
            </div>
            <div className="format-comparison">
            <div className="format-comparison-title">
              <div>
                <div className="format-heading"><span>Готовые файлы</span>
                  {resultQuality !== null ? <b className="result-quality">Q{resultQuality}</b> : null}
                </div>
                <strong>{comparisonResult.width} × {comparisonResult.height} px</strong>
              </div>
              <small>Выберите файлы для скачивания</small>
            </div>
            <div className="format-comparison-list">
              {comparisonFormats.map((variant) => {
                const key = outputSelectionKey(comparisonResult.width, comparisonResult.height, variant);
                return (
                  <label className={`format-result-row${result.mode === "transparent-png" ? " is-lossless-png" : ""} ${selectedOutputKeys.includes(key) ? "is-selected" : ""}`} key={variant.format}>
                    <input
                      type="checkbox"
                      checked={selectedOutputKeys.includes(key)}
                      aria-label={`Выбрать ${variant.format.toUpperCase()} ${comparisonResult.width}×${comparisonResult.height}`}
                      onChange={() => {
                        setSelectedOutputKeys((keys) => toggleOutputSelection(keys, key));
                        setPreviewFormat(variant.format);
                      }}
                    />
                    <span><strong>{variant.format.toUpperCase()}</strong>{variant.format === "png" ? <small>Без потерь</small> : null}</span>
                    <span><strong>{formatExactBytes(variant.size)}</strong><small>{comparisonResult.width}×{comparisonResult.height}</small></span>
                    {result.mode !== "transparent-png" ? (
                      <span><strong>{variant.similarity === null ? "—" : variant.similarity.toFixed(3)}</strong><small>Сходство</small></span>
                    ) : null}
                  </label>
                );
              })}
            </div>
            <button className={`primary-button result-download-button${result.mode === "transparent-png" ? ` png-download-button png-download-optimized${activeOptimizedDownloaded ? " is-downloaded" : ""}` : ""}`} type="button" disabled={!batchDownloadOutputs.length || downloadingFiles} onClick={() => void downloadSelectedOutputs()}>
              <span>{batchDownloadOutputs.length > 1
                ? `СКАЧАТЬ ${batchDownloadOutputs.length} ФАЙЛОВ`
                : batchDownloadOutputs[0]?.item.result?.mode === "transparent-png"
                  ? `СКАЧАТЬ ОПТИМИЗИРОВАННЫЙ PNG · ${batchDownloadOutputs[0].width}×${batchDownloadOutputs[0].height} PX`
                  : outputDownloadLabel(batchDownloadOutputs)}</span><i aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" focusable="false"><path d="M12 3v12m0 0 5-5m-5 5-5-5M5 20h14" /></svg></i>
            </button>
            </div>
          </div>

          {result.warnings.length ? (
            <div className="warnings">
              {result.warnings.map((warning) => <p key={warning}>{warning}</p>)}
            </div>
          ) : null}

          {error ? <p className="error-message">{error}</p> : null}

        </section>
      ) : null}
    </div>
       )}
    </>
  );
}
