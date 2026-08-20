"use client";

import {
  ChangeEvent,
  DragEvent,
  PointerEvent as ReactPointerEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import {
  archiveFileSelectionKey,
  ArchiveFileSelection,
  buildTargetWidths,
  calculateCropRect,
  createPictureMarkup,
  createCustomProfile,
  createDetectedProfile,
  EncodedVariant,
  CropSettings,
  formatBytes,
  getAvailableImageProfiles,
  IMAGE_PROFILES,
  ImageProfile,
  OptimizationResult,
  OptimizationMode,
  optimizeImage,
  OutputFormat,
  QualitySelection,
  QualityTier,
  selectArchiveFiles,
} from "../lib/image-optimizer";
import { createBrowserZip } from "../lib/browser-zip";
import {
  analyzeBlockCode,
  BlockCodeAnalysis,
} from "../lib/block-code-analyzer";

type SourceInfo = {
  width: number;
  height: number;
  previewUrl: string;
};

type SelectedQuality = Required<QualitySelection>;

type BatchItem = {
  id: string;
  file: File;
  sourceInfo: SourceInfo;
  profileId: ImageProfile["id"];
  customWidth: string;
  includeRetina: boolean;
  draftCrop: CropSettings;
  appliedCrop: CropSettings;
  blockCode: string;
  codeAnalysis: BlockCodeAnalysis | null;
  selectedCodeWidths: number[];
  useCodeWidths: boolean;
  codeError: string | null;
  result: OptimizationResult | null;
  previewFormat: OutputFormat | null;
  previewWidth: number | null;
  qualitySelection: SelectedQuality;
  comparePosition: number;
};

const ACCEPTED_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/avif",
  "image/heic",
  "image/heif",
];
const ACCEPTED_INPUT = `${ACCEPTED_TYPES.join(",")},.heic,.heif`;
const MAX_BATCH_FILES = 8;

const CROP_PRESETS: Array<{
  id: string;
  label: string;
  description: string;
  ratio: number | null;
}> = [
  { id: "original", label: "Исходное", description: "Без обрезки", ratio: null },
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

const DEFAULT_QUALITY_SELECTION: SelectedQuality = {
  avif: "recommended",
  webp: "recommended",
  png: "recommended",
};

const QUALITY_TIER_LABELS: Record<QualityTier, { title: string; description: string }> = {
  lighter: {
    title: "Легче",
    description: "Меньше вес, проверьте мелкие детали",
  },
  recommended: {
    title: "Рекомендуем",
    description: "Автоподбор с безопасным запасом качества",
  },
  detail: {
    title: "Максимум деталей",
    description: "Верхняя граница без избыточного Q100",
  },
};

const SIZE_GUIDE_ITEMS = [
  { columns: 1, title: "На весь экран", sizes: "1680 · 1920px", note: "обложка и первый экран" },
  { columns: 2, title: "Две колонки", sizes: "1200 · 1400px", note: "две крупные карточки" },
  { columns: 3, title: "Три колонки", sizes: "800 · 1000px", note: "каталог и направления" },
  { columns: 4, title: "Четыре колонки", sizes: "600 · 800px", note: "услуги и номера" },
  { columns: 5, title: "Пять колонок", sizes: "480 · 600px", note: "компактная сетка" },
];

function cropsEqual(first: CropSettings, second: CropSettings) {
  return (
    first.aspectRatio === second.aspectRatio &&
    first.positionX === second.positionX &&
    first.positionY === second.positionY
  );
}

function clampPercent(value: number) {
  return Math.min(100, Math.max(0, Math.round(value)));
}

function cropShapeDimensions(ratio: number) {
  const longestSide = 30;
  if (ratio >= 1) {
    return { width: longestSide, height: longestSide / ratio };
  }
  return { width: longestSide * ratio, height: longestSide };
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

function isHeicFile(file: File) {
  return file.type === "image/heic" ||
    file.type === "image/heif" ||
    /\.(heic|heif)$/i.test(file.name);
}

function isAcceptedFile(file: File) {
  return ACCEPTED_TYPES.includes(file.type) || isHeicFile(file);
}

async function prepareInputFile(file: File) {
  if (!isHeicFile(file)) return file;
  const { default: heic2any } = await import("heic2any");
  const converted = await heic2any({
    blob: file,
    toType: "image/png",
    quality: 1,
  });
  const blob = Array.isArray(converted) ? converted[0] : converted;
  if (!blob) throw new Error("HEIC не содержит доступного изображения.");
  const fileName = `${file.name.replace(/\.(heic|heif)$/i, "") || "photo"}.png`;
  return new File([blob], fileName, {
    type: "image/png",
    lastModified: file.lastModified,
  });
}

function waitForNextDownload() {
  return new Promise<void>((resolve) => window.setTimeout(resolve, 140));
}

function similarityLabel(variant: EncodedVariant) {
  if (variant.similarity === null) return "сходство: проверить вручную";
  const metric = variant.similarityMethod === "ssim" ? "SSIM" : "сходство";
  return `${metric} ${variant.similarity.toFixed(3)}`;
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

function formatDifference(
  variant: EncodedVariant,
  winner: EncodedVariant,
  threshold: number,
) {
  if (variant === winner) return "Победитель";
  if (variant.similarity !== null && variant.similarity < threshold - 0.002) {
    return "Ниже цели";
  }
  if (variant.similarity === null) return "Без проверки";

  const difference = Math.round((variant.size / winner.size - 1) * 100);
  if (difference > 0) return `+${difference}% к весу`;
  if (difference < 0) return `${Math.abs(difference)}% легче`;
  return "Тот же вес";
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

function createBatchItem(file: File, sourceInfo: SourceInfo): BatchItem {
  const availableWidth = sourceInfo.width;
  const availableProfiles = getAvailableImageProfiles(availableWidth);
  const profileId =
    availableProfiles.find((item) => item.id !== "custom")?.id ?? "custom";
  const customWidth = Math.min(360, availableWidth);

  return {
    id: crypto.randomUUID(),
    file,
    sourceInfo,
    profileId,
    customWidth: String(customWidth),
    includeRetina: customWidth * 2 <= availableWidth,
    draftCrop: { ...DEFAULT_CROP },
    appliedCrop: { ...DEFAULT_CROP },
    blockCode: "",
    codeAnalysis: null,
    selectedCodeWidths: [],
    useCodeWidths: false,
    codeError: null,
    result: null,
    previewFormat: null,
    previewWidth: null,
    qualitySelection: { ...DEFAULT_QUALITY_SELECTION },
    comparePosition: 52,
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
  const availableProfiles = getAvailableImageProfiles(availableWidth);
  const profileId = availableProfiles.some(
    (profile) => profile.id === item.profileId,
  )
    ? item.profileId
    : (availableProfiles.find((profile) => profile.id !== "custom")?.id ??
      "custom");
  const currentCustomWidth = Number(item.customWidth);
  const nextCustomWidth = Number.isFinite(currentCustomWidth)
    ? Math.min(currentCustomWidth, availableWidth)
    : Math.min(360, availableWidth);
  const selectedCodeWidths = [
    ...new Set(item.selectedCodeWidths.map((width) => Math.min(width, availableWidth))),
  ];
  const canIncludeRetina = item.useCodeWidths
    ? selectedCodeWidths.some((width) => width * 2 <= availableWidth)
    : nextCustomWidth >= 32 && nextCustomWidth * 2 <= availableWidth;

  return {
    ...item,
    profileId,
    customWidth: String(nextCustomWidth),
    includeRetina:
      profileId === "custom" && item.includeRetina && !canIncludeRetina
        ? false
        : item.includeRetina,
    selectedCodeWidths,
    draftCrop: { ...nextCrop },
    appliedCrop: { ...nextCrop },
    result: null,
    previewFormat: null,
    previewWidth: null,
    qualitySelection: { ...DEFAULT_QUALITY_SELECTION },
  };
}

function batchItemError(item: BatchItem) {
  if (!cropsEqual(item.draftCrop, item.appliedCrop)) {
    return "Сохраните кадр";
  }

  const availableWidth = cropAvailableWidth(item);
  const availableProfiles = getAvailableImageProfiles(availableWidth);
  const profileId = availableProfiles.some(
    (profile) => profile.id === item.profileId,
  )
    ? item.profileId
    : (availableProfiles[0]?.id ?? "custom");
  if (profileId !== "custom") return null;

  if (item.useCodeWidths) {
    if (!item.selectedCodeWidths.length) return "Выберите размер из кода";
    if (item.selectedCodeWidths.some((width) => width > availableWidth)) {
      return `Максимум ${availableWidth}px`;
    }
    return null;
  }

  const requestedWidth = Number(item.customWidth);
  if (
    !Number.isFinite(requestedWidth) ||
    requestedWidth < 32 ||
    requestedWidth > availableWidth
  ) {
    return `Укажите размер 32–${availableWidth}px`;
  }
  return null;
}

function batchFolderName(fileName: string, index: number) {
  const base = fileName
    .replace(/\.[^.]+$/, "")
    .normalize("NFKD")
    .replace(/[^a-zA-Z0-9а-яА-ЯёЁ_-]+/g, "-")
    .replace(/^-+|-+$/g, "") || `photo-${index + 1}`;
  return `${String(index + 1).padStart(2, "0")}-${base}`;
}

function zipDownloadName(fileName: string) {
  const base = batchFolderName(fileName, 0).replace(/^01-/, "") || "images";
  return `optima-${base}.zip`;
}

export default function ImageOptimizer() {
  const inputRef = useRef<HTMLInputElement>(null);
  const previewUrlsRef = useRef(new Set<string>());
  const cropDragRef = useRef<{
    pointerId: number;
    startClientX: number;
    startClientY: number;
    startPositionX: number;
    startPositionY: number;
  } | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [sourceInfo, setSourceInfo] = useState<SourceInfo | null>(null);
  const [batchItems, setBatchItems] = useState<BatchItem[]>([]);
  const [batchAspectRatio, setBatchAspectRatio] = useState<number | null>(null);
  const [activeItemId, setActiveItemId] = useState<string | null>(null);
  const [addingFiles, setAddingFiles] = useState(false);
  const [processingAll, setProcessingAll] = useState(false);
  const [processingItemId, setProcessingItemId] = useState<string | null>(null);
  const [profileId, setProfileId] = useState<ImageProfile["id"]>("hero");
  const [customWidth, setCustomWidth] = useState("360");
  const [includeRetina, setIncludeRetina] = useState(true);
  const [codeHelperOpen, setCodeHelperOpen] = useState(false);
  const [blockCode, setBlockCode] = useState("");
  const [codeAnalysis, setCodeAnalysis] = useState<BlockCodeAnalysis | null>(null);
  const [selectedCodeWidths, setSelectedCodeWidths] = useState<number[]>([]);
  const [useCodeWidths, setUseCodeWidths] = useState(false);
  const [codeError, setCodeError] = useState<string | null>(null);
  const [draftCrop, setDraftCrop] = useState<CropSettings>(DEFAULT_CROP);
  const [appliedCrop, setAppliedCrop] = useState<CropSettings>(DEFAULT_CROP);
  const [optimizationMode, setOptimizationMode] = useState<OptimizationMode>("photo");
  const [dragging, setDragging] = useState(false);
  const [working, setWorking] = useState(false);
  const [progress, setProgress] = useState(0);
  const [progressText, setProgressText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<OptimizationResult | null>(null);
  const [comparePosition, setComparePosition] = useState(52);
  const [previewFormat, setPreviewFormat] = useState<OutputFormat | null>(null);
  const [previewWidth, setPreviewWidth] = useState<number | null>(null);
  const [qualitySelection, setQualitySelection] = useState<SelectedQuality>(
    DEFAULT_QUALITY_SELECTION,
  );
  const [sizeGuideOpen, setSizeGuideOpen] = useState(false);
  const sizeGuideTriggerRef = useRef<HTMLButtonElement>(null);
  const sizeGuideCloseRef = useRef<HTMLButtonElement>(null);
  const [copied, setCopied] = useState(false);
  const [excludedPackageFiles, setExcludedPackageFiles] = useState<ArchiveFileSelection[]>([]);
  const [downloadingFiles, setDownloadingFiles] = useState(false);
  const [downloadStatus, setDownloadStatus] = useState<string | null>(null);

  const appliedCropRect = useMemo(() => {
    if (!sourceInfo) return null;
    return calculateCropRect(sourceInfo.width, sourceInfo.height, appliedCrop);
  }, [appliedCrop, sourceInfo]);

  const draftCropRect = useMemo(() => {
    if (!sourceInfo) return null;
    return calculateCropRect(sourceInfo.width, sourceInfo.height, draftCrop);
  }, [draftCrop, sourceInfo]);

  const cropDirty = !cropsEqual(draftCrop, appliedCrop);
  const draftAspectRatio =
    draftCrop.aspectRatio ??
    (sourceInfo ? sourceInfo.width / sourceInfo.height : 16 / 9);
  const sourceAspectRatio = sourceInfo
    ? sourceInfo.width / sourceInfo.height
    : draftAspectRatio;
  const canMoveCropX = Boolean(
    draftCrop.aspectRatio && sourceAspectRatio > draftAspectRatio + 0.0001,
  );
  const canMoveCropY = Boolean(
    draftCrop.aspectRatio && sourceAspectRatio < draftAspectRatio - 0.0001,
  );

  const availableCropWidth = Math.max(
    1,
    Math.floor(draftCropRect?.width ?? sourceInfo?.width ?? 1),
  );
  const batchCropLimits = batchItems.map((item, index) => ({
    id: item.id,
    index,
    fileName: item.file.name,
    width:
      item.id === activeItemId
        ? availableCropWidth
        : cropAvailableWidth(item, true),
  }));
  const smallestBatchPhoto = batchCropLimits.length
    ? batchCropLimits.reduce((smallest, item) =>
        item.width < smallest.width ? item : smallest,
      )
    : null;
  const sizeLimitWidth =
    batchItems.length > 1 && smallestBatchPhoto
      ? smallestBatchPhoto.width
      : availableCropWidth;
  const availableProfiles = useMemo(
    () => getAvailableImageProfiles(sizeLimitWidth),
    [sizeLimitWidth],
  );
  const hiddenProfilesCount =
    IMAGE_PROFILES.filter((item) => item.id !== "custom").length -
    availableProfiles.filter((item) => item.id !== "custom").length;
  const numericCustomWidth = Number(customWidth);
  const canIncludeRetina = useCodeWidths
    ? selectedCodeWidths.some((width) => width * 2 <= sizeLimitWidth)
    : Number.isFinite(numericCustomWidth) &&
      numericCustomWidth >= 32 &&
      numericCustomWidth * 2 <= sizeLimitWidth;
  const activeProfileId = availableProfiles.some((item) => item.id === profileId)
    ? profileId
    : (availableProfiles[0]?.id ?? "custom");

  const profile = useMemo(() => {
    if (activeProfileId === "custom") {
      if (useCodeWidths && selectedCodeWidths.length) {
        return createDetectedProfile(
          selectedCodeWidths,
          includeRetina,
          sizeLimitWidth,
        );
      }
      return createCustomProfile(
        Number(customWidth) || Math.min(360, sizeLimitWidth),
        includeRetina,
        sizeLimitWidth,
      );
    }
    return (
      IMAGE_PROFILES.find((item) => item.id === activeProfileId) ??
      availableProfiles[0] ??
      IMAGE_PROFILES.at(-1)!
    );
  }, [
    activeProfileId,
    availableProfiles,
    customWidth,
    includeRetina,
    selectedCodeWidths,
    sizeLimitWidth,
    useCodeWidths,
  ]);

  const largestDetectedSize = useMemo(() => {
    const sizes = codeAnalysis?.sizes ?? [];
    if (!sizes.length) return null;
    const width = Math.max(...sizes.map((item) => item.width));
    return {
      width,
      screens: [...new Set(sizes.filter((item) => item.width === width).map((item) => item.screen))],
    };
  }, [codeAnalysis]);

  const plannedCodeWidths = useMemo(() => {
    if (!useCodeWidths || !selectedCodeWidths.length || !appliedCropRect) return [];
    return buildTargetWidths(Math.round(appliedCropRect.width), profile);
  }, [appliedCropRect, profile, selectedCodeWidths.length, useCodeWidths]);

  const largestResult = result?.results.at(-1);
  const comparisonResult = useMemo(() => {
    if (!result || !largestResult) return null;
    return result.results.find((item) => item.width === previewWidth) ?? largestResult;
  }, [largestResult, previewWidth, result]);
  const comparedVariant = useMemo(() => {
    if (!comparisonResult) return null;
    const format = previewFormat ?? comparisonResult.recommended.format;
    const tier = qualitySelection[format];
    return (
      comparisonResult.variants.find(
        (variant) => variant.format === format && variant.tier === tier,
      ) ??
      comparisonResult.variants.find(
        (variant) =>
          variant.format === format && variant.tier === "recommended",
      ) ??
      comparisonResult.recommended
    );
  }, [comparisonResult, previewFormat, qualitySelection]);
  const comparisonFormats = useMemo(() => {
    if (!comparisonResult) return [];
    return (["avif", "webp", "png"] as OutputFormat[]).flatMap((format) => {
      const tier = qualitySelection[format];
      const variant =
        comparisonResult.variants.find(
          (item) => item.format === format && item.tier === tier,
        ) ??
        comparisonResult.variants.find(
          (item) => item.format === format && item.tier === "recommended",
        );
      return variant ? [variant] : [];
    });
  }, [comparisonResult, qualitySelection]);
  const qualityChoices = useMemo(() => {
    if (!comparisonResult || !comparedVariant) return [];
    const order: QualityTier[] = ["lighter", "recommended", "detail"];
    return order.flatMap((tier) => {
      const variant = comparisonResult.variants.find(
        (item) => item.format === comparedVariant.format && item.tier === tier,
      );
      return variant ? [variant] : [];
    });
  }, [comparedVariant, comparisonResult]);
  const activeFormatResults = useMemo(() => {
    if (!result || !comparedVariant) return [];
    return result.results.flatMap((widthResult) => {
      const variant = widthResult.variants.find(
        (item) =>
          item.format === comparedVariant.format &&
          item.tier === qualitySelection[comparedVariant.format],
      );
      return variant ? [{ widthResult, variant }] : [];
    });
  }, [comparedVariant, qualitySelection, result]);
  const packageFileOptions = useMemo(() => {
    if (!result) return [];
    return result.results.flatMap((widthResult) =>
      (["avif", "webp", "png"] as OutputFormat[]).flatMap((format) => {
        const variant = widthResult.variants.find(
          (item) => item.format === format && item.tier === qualitySelection[format],
        ) ?? widthResult.variants.find(
          (item) => item.format === format && item.tier === "recommended",
        );
        return variant ? [{
          key: archiveFileSelectionKey(format, widthResult.width),
          format,
          width: widthResult.width,
          height: widthResult.height,
          variant,
        }] : [];
      }),
    );
  }, [qualitySelection, result]);
  const optimizedPreview = useMemo(() => {
    if (!comparedVariant) return null;
    return URL.createObjectURL(comparedVariant.blob);
  }, [comparedVariant]);

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

  useEffect(() => {
    if (!sizeGuideOpen) return;
    const previousOverflow = document.body.style.overflow;
    const triggerElement = sizeGuideTriggerRef.current;
    document.body.style.overflow = "hidden";
    const focusTimer = window.setTimeout(() => sizeGuideCloseRef.current?.focus(), 0);
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSizeGuideOpen(false);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.clearTimeout(focusTimer);
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", handleKeyDown);
      triggerElement?.focus();
    };
  }, [sizeGuideOpen]);

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
      includeRetina,
      draftCrop: { ...draftCrop },
      appliedCrop: { ...appliedCrop },
      blockCode,
      codeAnalysis,
      selectedCodeWidths: [...selectedCodeWidths],
      useCodeWidths,
      codeError,
      result,
      previewFormat,
      previewWidth,
      qualitySelection: { ...qualitySelection },
      comparePosition,
      ...overrides,
    };
  }

  function hydrateBatchItem(item: BatchItem) {
    const preserveBatchSizeSettings = batchItems.length > 1;
    setActiveItemId(item.id);
    setFile(item.file);
    setSourceInfo(item.sourceInfo);
    if (!preserveBatchSizeSettings) {
      setProfileId(item.profileId);
      setCustomWidth(item.customWidth);
      setIncludeRetina(item.includeRetina);
      setBlockCode(item.blockCode);
      setCodeAnalysis(item.codeAnalysis);
      setSelectedCodeWidths([...item.selectedCodeWidths]);
      setUseCodeWidths(item.useCodeWidths);
      setCodeError(item.codeError);
    }
    setDraftCrop({ ...item.draftCrop });
    setAppliedCrop({ ...item.appliedCrop });
    setResult(item.result);
    setPreviewFormat(item.previewFormat);
    setPreviewWidth(item.previewWidth);
    setQualitySelection({ ...item.qualitySelection });
    setComparePosition(item.comparePosition);
    setError(null);
    setCopied(false);
  }

  function invalidateBatchResults() {
    const currentSnapshot = currentBatchSnapshot({
      result: null,
      previewFormat: null,
      previewWidth: null,
    });
    setBatchItems((items) =>
      items.map((item) => {
        const nextItem =
          currentSnapshot && item.id === currentSnapshot.id
            ? currentSnapshot
            : item;
        return {
          ...nextItem,
          result: null,
          previewFormat: null,
          previewWidth: null,
        };
      }),
    );
    setResult(null);
    setPreviewFormat(null);
    setPreviewWidth(null);
    setExcludedPackageFiles([]);
    setDownloadStatus(null);
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
    const nextItems = currentItems.map((item) =>
      applyCropRatioToBatchItem(item, aspectRatio),
    );
    const nextSizeLimit = Math.min(
      ...nextItems.map((item) => cropAvailableWidth(item)),
    );
    const nextAvailableProfiles = getAvailableImageProfiles(nextSizeLimit);
    const nextProfileId = nextAvailableProfiles.some(
      (item) => item.id === profileId,
    )
      ? profileId
      : (nextAvailableProfiles.find((item) => item.id !== "custom")?.id ??
        "custom");
    const currentCustomWidth = Number(customWidth);
    const nextCustomWidth =
      Number.isFinite(currentCustomWidth) && currentCustomWidth > 0
        ? Math.min(currentCustomWidth, nextSizeLimit)
        : currentCustomWidth;
    const nextCodeWidths = [
      ...new Set(selectedCodeWidths.map((width) => Math.min(width, nextSizeLimit))),
    ];
    const nextCanIncludeRetina = useCodeWidths
      ? nextCodeWidths.some((width) => width * 2 <= nextSizeLimit)
      : Number.isFinite(nextCustomWidth) &&
        nextCustomWidth >= 32 &&
        nextCustomWidth * 2 <= nextSizeLimit;
    setBatchItems(nextItems);
    const nextActiveItem =
      nextItems.find((item) => item.id === activeItemId) ?? nextItems[0];
    if (nextActiveItem) hydrateBatchItem(nextActiveItem);
    setProfileId(nextProfileId);
    if (Number.isFinite(nextCustomWidth) && nextCustomWidth > 0) {
      setCustomWidth(String(nextCustomWidth));
    }
    if (nextCodeWidths.length || selectedCodeWidths.length) {
      setSelectedCodeWidths(nextCodeWidths);
    }
    if (includeRetina && !nextCanIncludeRetina) setIncludeRetina(false);
    setError(null);
  }

  function useIndividualCropRatios() {
    if (working) return;
    setBatchAspectRatio(null);
    setError(null);
  }

  function clearEditor() {
    setActiveItemId(null);
    setFile(null);
    setSourceInfo(null);
    setResult(null);
    setError(null);
    setPreviewFormat(null);
    setPreviewWidth(null);
    setQualitySelection({ ...DEFAULT_QUALITY_SELECTION });
    setComparePosition(52);
    setExcludedPackageFiles([]);
    setDownloadStatus(null);
    setDraftCrop({ ...DEFAULT_CROP });
    setAppliedCrop({ ...DEFAULT_CROP });
    setCodeAnalysis(null);
    setBlockCode("");
    setSelectedCodeWidths([]);
    setUseCodeWidths(false);
    setCodeError(null);
  }

  function removeBatchItem(itemId: string) {
    if (working) return;
    const currentSnapshot = currentBatchSnapshot();
    const currentItems = batchItems.map((item) =>
      currentSnapshot && item.id === currentSnapshot.id ? currentSnapshot : item,
    );
    const removedIndex = currentItems.findIndex((item) => item.id === itemId);
    if (removedIndex < 0) return;
    const removedItem = currentItems[removedIndex];
    URL.revokeObjectURL(removedItem.sourceInfo.previewUrl);
    previewUrlsRef.current.delete(removedItem.sourceInfo.previewUrl);
    const remainingItems = currentItems.filter((item) => item.id !== itemId);
    setBatchItems(remainingItems);

    if (itemId !== activeItemId) return;
    const nextItem =
      remainingItems[Math.min(removedIndex, remainingItems.length - 1)] ?? null;
    if (nextItem) hydrateBatchItem(nextItem);
    else clearEditor();
  }

  function syncOptionsToCrop(
    nextCrop: CropSettings,
    sourceWidth: number,
    sourceHeight: number,
  ) {
    const nextAvailableWidth = Math.max(
      1,
      Math.floor(calculateCropRect(sourceWidth, sourceHeight, nextCrop).width),
    );
    const otherBatchLimit = batchItems
      .filter((item) => item.id !== activeItemId)
      .reduce(
        (limit, item) => Math.min(limit, cropAvailableWidth(item, true)),
        Number.POSITIVE_INFINITY,
      );
    const nextSizeLimit = Number.isFinite(otherBatchLimit)
      ? Math.min(nextAvailableWidth, otherBatchLimit)
      : nextAvailableWidth;
    const nextProfiles = getAvailableImageProfiles(nextSizeLimit);
    const nextProfileId = nextProfiles.some((item) => item.id === profileId)
      ? profileId
      : (nextProfiles.find((item) => item.id !== "custom")?.id ?? "custom");

    if (nextProfileId !== profileId) setProfileId(nextProfileId);

    const currentCustomWidth = Number(customWidth);
    const nextCustomWidth =
      Number.isFinite(currentCustomWidth) && currentCustomWidth > nextSizeLimit
        ? nextSizeLimit
        : currentCustomWidth;
    if (
      Number.isFinite(currentCustomWidth) &&
      nextCustomWidth !== currentCustomWidth
    ) {
      setCustomWidth(String(nextCustomWidth));
    }

    const nextCodeWidths = selectedCodeWidths.map((width) =>
      Math.min(width, nextSizeLimit),
    );
    if (nextCodeWidths.some((width, index) => width !== selectedCodeWidths[index])) {
      setSelectedCodeWidths([...new Set(nextCodeWidths)]);
    }

    const nextCanIncludeRetina = useCodeWidths
      ? nextCodeWidths.some((width) => width * 2 <= nextSizeLimit)
      : Number.isFinite(nextCustomWidth) &&
        nextCustomWidth >= 32 &&
        nextCustomWidth * 2 <= nextSizeLimit;
    if (nextProfileId === "custom" && includeRetina && !nextCanIncludeRetina) {
      setIncludeRetina(false);
    }
  }

  async function acceptFiles(nextFiles: File[]) {
    if (!nextFiles.length || addingFiles) return;
    const currentSnapshot = currentBatchSnapshot();
    const storedItems = batchItems.map((item) =>
      currentSnapshot && item.id === currentSnapshot.id ? currentSnapshot : item,
    );
    const availableSlots = MAX_BATCH_FILES - storedItems.length;
    if (availableSlots <= 0) {
      setError(`В одной очереди можно обработать до ${MAX_BATCH_FILES} фотографий.`);
      return;
    }

    setAddingFiles(true);
    setError(null);
    setExcludedPackageFiles([]);
    setDownloadStatus(null);
    const candidates = nextFiles.slice(0, availableSlots);
    const preparedItems: BatchItem[] = [];
    const skipped: string[] = [];

    for (const nextFile of candidates) {
      if (!isAcceptedFile(nextFile)) {
        skipped.push(`${nextFile.name}: неподдерживаемый формат`);
        continue;
      }
      if (nextFile.size > 40 * 1024 * 1024) {
        skipped.push(`${nextFile.name}: больше 40 МБ`);
        continue;
      }

      try {
        const preparedFile = await prepareInputFile(nextFile);
        const bitmap = await createImageBitmap(preparedFile, {
          imageOrientation: "from-image",
        });
        const previewUrl = URL.createObjectURL(preparedFile);
        previewUrlsRef.current.add(previewUrl);
        const originalItem = createBatchItem(preparedFile, {
          width: bitmap.width,
          height: bitmap.height,
          previewUrl,
        });
        const nextItem = batchAspectRatio
          ? applyCropRatioToBatchItem(originalItem, batchAspectRatio)
          : originalItem;
        bitmap.close();
        preparedItems.push(nextItem);
      } catch (nextError) {
        skipped.push(
          `${nextFile.name}: ${nextError instanceof Error ? nextError.message : "браузер не смог открыть файл"}`,
        );
      }
    }

    const wasTruncated = nextFiles.length > availableSlots;
    const nextItems = [
      ...storedItems.map((item) => ({
        ...item,
        result: null,
        previewFormat: null,
        previewWidth: null,
      })),
      ...preparedItems,
    ];
    const nextSizeLimit = nextItems.length
      ? Math.min(...nextItems.map((item) => cropAvailableWidth(item)))
      : availableCropWidth;
    const nextAvailableProfiles = getAvailableImageProfiles(nextSizeLimit);
    const nextProfileId = nextAvailableProfiles.some(
      (item) => item.id === profileId,
    )
      ? profileId
      : (nextAvailableProfiles.find((item) => item.id !== "custom")?.id ??
        "custom");
    const currentCustomWidth = Number(customWidth);
    const nextCustomWidth =
      Number.isFinite(currentCustomWidth) && currentCustomWidth > 0
        ? Math.min(currentCustomWidth, nextSizeLimit)
        : currentCustomWidth;
    const nextCodeWidths = [
      ...new Set(selectedCodeWidths.map((width) => Math.min(width, nextSizeLimit))),
    ];
    const nextCanIncludeRetina = useCodeWidths
      ? nextCodeWidths.some((width) => width * 2 <= nextSizeLimit)
      : Number.isFinite(nextCustomWidth) &&
        nextCustomWidth >= 32 &&
        nextCustomWidth * 2 <= nextSizeLimit;
    setBatchItems(nextItems);
    if (!activeItemId && preparedItems[0]) {
      hydrateBatchItem(preparedItems[0]);
    }
    setProfileId(nextProfileId);
    if (Number.isFinite(nextCustomWidth) && nextCustomWidth > 0) {
      setCustomWidth(String(nextCustomWidth));
    }
    if (nextCodeWidths.length || selectedCodeWidths.length) {
      setSelectedCodeWidths(nextCodeWidths);
    }
    if (includeRetina && !nextCanIncludeRetina) setIncludeRetina(false);
    setResult(null);
    setPreviewFormat(null);
    setPreviewWidth(null);

    const notices = [...skipped];
    if (wasTruncated) {
      notices.push(`добавлены первые ${availableSlots} файлов из выбранных`);
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
    if (sourceInfo) {
      syncOptionsToCrop(nextCrop, sourceInfo.width, sourceInfo.height);
    }
    setDraftCrop(nextCrop);
    setResult(null);
    setError(null);
  }

  function handleCropPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (!draftCrop.aspectRatio || (!canMoveCropX && !canMoveCropY)) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    cropDragRef.current = {
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startPositionX: draftCrop.positionX,
      startPositionY: draftCrop.positionY,
    };
  }

  function handleCropPointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = cropDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    const deltaX = ((event.clientX - drag.startClientX) / bounds.width) * 100;
    const deltaY = ((event.clientY - drag.startClientY) / bounds.height) * 100;
    updateDraftCrop({
      ...draftCrop,
      positionX: canMoveCropX
        ? clampPercent(drag.startPositionX - deltaX)
        : draftCrop.positionX,
      positionY: canMoveCropY
        ? clampPercent(drag.startPositionY - deltaY)
        : draftCrop.positionY,
    });
  }

  function handleCropPointerEnd(event: ReactPointerEvent<HTMLDivElement>) {
    if (cropDragRef.current?.pointerId !== event.pointerId) return;
    cropDragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  function applyCrop() {
    setAppliedCrop(draftCrop);
    if (batchItems.length > 1) invalidateBatchResults();
    else setResult(null);
    setError(null);
  }

  function analyzeCodeForSizes() {
    if (blockCode.trim().length < 40) {
      setCodeError("Вставьте код всего блока вместе со стилями и медиазапросами.");
      return;
    }
    const nextAnalysis = analyzeBlockCode(blockCode);
    const widths = [...new Set(nextAnalysis.sizes.map((item) => item.width))];
    setCodeAnalysis(nextAnalysis);
    invalidateBatchResults();
    if (!widths.length) {
      setUseCodeWidths(false);
      setSelectedCodeWidths([]);
      setCodeError(
        "Не нашли точных размеров в пикселях. Скопируйте весь внешний блок вместе с <style> и медиазапросами.",
      );
      return;
    }
    const largestWidth = Math.max(...widths);
    const usableWidth = Math.min(largestWidth, sizeLimitWidth);
    setSelectedCodeWidths([usableWidth]);
    setCustomWidth(String(usableWidth));
    setUseCodeWidths(true);
    setIncludeRetina(false);
    setCodeError(null);
  }

  async function runOptimization() {
    if (!file) return;
    if (cropDirty) {
      setError("Сначала сохраните выбранный кадр, затем запускайте оптимизацию.");
      return;
    }
    if (activeProfileId === "custom") {
      if (useCodeWidths && selectedCodeWidths.length === 0) {
        setError("Выберите хотя бы один размер, найденный в коде блока.");
        return;
      }
      if (
        useCodeWidths &&
        selectedCodeWidths.some((width) => width > sizeLimitWidth)
      ) {
        setError(
          `Для этой очереди доступно не больше ${sizeLimitWidth}px. Optima ориентируется на самый маленький кадр.`,
        );
        return;
      }
      const requestedWidth = Number(customWidth);
      if (
        !useCodeWidths &&
        (!Number.isFinite(requestedWidth) ||
          requestedWidth < 32 ||
          requestedWidth > sizeLimitWidth)
      ) {
        setError(
          `Укажите ширину от 32 до ${sizeLimitWidth}px — это общий предел очереди без увеличения.`,
        );
        return;
      }
    }
    setWorking(true);
    setProcessingItemId(activeItemId);
    setError(null);
    setDownloadStatus(null);
    setResult(null);
    setProgress(0);
    try {
      const nextResult = await optimizeImage({
        file,
        profile,
        crop: appliedCrop,
        mode: optimizationMode,
        onProgress: (nextProgress, message) => {
          setProgress(nextProgress);
          setProgressText(message);
        },
      });
      const nextPreviewFormat =
        nextResult.results.at(-1)?.recommended.format ?? null;
      const nextPreviewWidth = nextResult.results.at(-1)?.width ?? null;
      const nextQualitySelection = { ...DEFAULT_QUALITY_SELECTION };
      setQualitySelection(nextQualitySelection);
      setPreviewFormat(nextPreviewFormat);
      setPreviewWidth(nextPreviewWidth);
      setResult(nextResult);
      const nextSnapshot = currentBatchSnapshot({
        result: nextResult,
        previewFormat: nextPreviewFormat,
        previewWidth: nextPreviewWidth,
        qualitySelection: nextQualitySelection,
      });
      if (nextSnapshot) {
        setBatchItems((items) =>
          items.map((item) =>
            item.id === nextSnapshot.id ? nextSnapshot : item,
          ),
        );
      }
      window.setTimeout(() => {
        document.getElementById("results")?.scrollIntoView({
          behavior: "smooth",
          block: "start",
        });
      }, 100);
    } catch (nextError) {
      setError(
        nextError instanceof Error
          ? nextError.message
          : "Не удалось обработать изображение.",
      );
    } finally {
      setProcessingItemId(null);
      setWorking(false);
    }
  }

  async function runBatchOptimization() {
    const currentSnapshot = currentBatchSnapshot();
    let workingItems = batchItems.map((item) =>
      currentSnapshot && item.id === currentSnapshot.id ? currentSnapshot : item,
    );
    if (!workingItems.length) return;

    const invalidItem = workingItems.find(
      (item) => !cropsEqual(item.draftCrop, item.appliedCrop),
    );
    if (invalidItem) {
      setBatchItems(workingItems);
      hydrateBatchItem(invalidItem);
      setError(
        `${invalidItem.file.name}: сохраните композицию этого кадра.`,
      );
      return;
    }

    if (activeProfileId === "custom") {
      if (useCodeWidths && selectedCodeWidths.length === 0) {
        setError("Выберите хотя бы один общий размер для очереди.");
        return;
      }
      const requestedWidth = Number(customWidth);
      if (
        !useCodeWidths &&
        (!Number.isFinite(requestedWidth) ||
          requestedWidth < 32 ||
          requestedWidth > sizeLimitWidth)
      ) {
        setError(
          `Укажите ширину от 32 до ${sizeLimitWidth}px — по самому маленькому кадру в очереди.`,
        );
        return;
      }
    }

    setWorking(true);
    setProcessingAll(true);
    setError(null);
    setDownloadStatus(null);
    setResult(null);
    setProgress(0);

    try {
      for (let index = 0; index < workingItems.length; index += 1) {
        const item = workingItems[index];
        setProcessingItemId(item.id);
        const nextResult = await optimizeImage({
          file: item.file,
          profile,
          crop: item.appliedCrop,
          mode: optimizationMode,
          onProgress: (itemProgress, message) => {
            const overallProgress = Math.round(
              ((index + itemProgress / 100) / workingItems.length) * 100,
            );
            setProgress(overallProgress);
            setProgressText(
              `Фото ${index + 1} из ${workingItems.length}: ${message}`,
            );
          },
        });
        const nextItem: BatchItem = {
          ...item,
          result: nextResult,
          previewFormat:
            nextResult.results.at(-1)?.recommended.format ?? null,
          previewWidth: nextResult.results.at(-1)?.width ?? null,
          qualitySelection: { ...DEFAULT_QUALITY_SELECTION },
          comparePosition: 52,
        };
        workingItems = workingItems.map((current) =>
          current.id === nextItem.id ? nextItem : current,
        );
        setBatchItems(workingItems);
      }

      const nextActiveItem =
        workingItems.find((item) => item.id === activeItemId) ?? workingItems[0];
      if (nextActiveItem) hydrateBatchItem(nextActiveItem);
      window.setTimeout(() => {
        document.getElementById("results")?.scrollIntoView({
          behavior: "smooth",
          block: "start",
        });
      }, 100);
    } catch (nextError) {
      setBatchItems(workingItems);
      const nextActiveItem =
        workingItems.find((item) => item.id === activeItemId) ?? workingItems[0];
      if (nextActiveItem) hydrateBatchItem(nextActiveItem);
      setError(
        nextError instanceof Error
          ? nextError.message
          : "Не удалось обработать всю очередь.",
      );
    } finally {
      setProcessingItemId(null);
      setProcessingAll(false);
      setWorking(false);
    }
  }

  async function downloadSelectedFiles() {
    if (!result) return;
    const packageResult = selectArchiveFiles(
      result,
      selectedPackageFiles,
      qualitySelection,
    );
    if (!packageResult.results.length) {
      setError("Оставьте галочку хотя бы у одного файла для сохранения.");
      return;
    }
    setError(null);
    setDownloadStatus(null);
    setDownloadingFiles(true);
    try {
      let downloaded = 0;
      for (const widthResult of packageResult.results) {
        for (const variant of widthResult.variants) {
          downloadBlob(variant.blob, variant.fileName);
          downloaded += 1;
          await waitForNextDownload();
        }
      }
      setDownloadStatus(
        `Отправлено в «Загрузки»: ${downloaded} файлов. Если браузер спросит, разрешите несколько скачиваний.`,
      );
    } catch {
      setError("Не удалось начать скачивание. Разрешите сайту несколько загрузок и повторите.");
    } finally {
      setDownloadingFiles(false);
    }
  }

  async function downloadBatchFiles() {
    const currentSnapshot = currentBatchSnapshot();
    const items = batchItems.map((item) =>
      currentSnapshot && item.id === currentSnapshot.id ? currentSnapshot : item,
    );
    if (!items.length || items.some((item) => !item.result)) {
      setError("Сначала оптимизируйте все фотографии в очереди.");
      return;
    }
    if (!selectedPackageFiles.length) {
      setError("Оставьте галочку хотя бы у одного файла для сохранения.");
      return;
    }
    setError(null);
    setDownloadStatus(null);
    setDownloadingFiles(true);
    try {
      let downloaded = 0;
      for (let index = 0; index < items.length; index += 1) {
        const item = items[index];
        if (!item.result) continue;
        const packageResult = selectArchiveFiles(
          item.result,
          selectedPackageFiles,
          item.qualitySelection,
        );
        const filePrefix = batchFolderName(item.file.name, index);
        for (const widthResult of packageResult.results) {
          for (const variant of widthResult.variants) {
            downloadBlob(variant.blob, `${filePrefix}-${variant.fileName}`);
            downloaded += 1;
            await waitForNextDownload();
          }
        }
      }
      setDownloadStatus(
        `Отправлено в «Загрузки»: ${downloaded} файлов. Названия сгруппированы номером и именем исходного фото.`,
      );
    } catch {
      setError("Не удалось начать все скачивания. Разрешите сайту несколько загрузок и повторите.");
    } finally {
      setDownloadingFiles(false);
    }
  }

  async function downloadSelectedZip() {
    if (!result) return;
    const packageResult = selectArchiveFiles(
      result,
      selectedPackageFiles,
      qualitySelection,
    );
    const entries = packageResult.results.flatMap((widthResult) =>
      widthResult.variants.map((variant) => ({
        name: variant.fileName,
        blob: variant.blob,
      })),
    );
    if (!entries.length) {
      setError("Оставьте галочку хотя бы у одного файла для ZIP.");
      return;
    }
    setError(null);
    setDownloadStatus(null);
    setDownloadingFiles(true);
    try {
      const archive = await createBrowserZip(entries);
      downloadBlob(archive, zipDownloadName(file?.name ?? result.sourceName));
      setDownloadStatus(`ZIP готов: ${entries.length} файлов собрано прямо в браузере.`);
    } catch {
      setError("Не удалось собрать ZIP в этом браузере. Скачайте файлы по отдельности.");
    } finally {
      setDownloadingFiles(false);
    }
  }

  async function downloadBatchZip() {
    const currentSnapshot = currentBatchSnapshot();
    const items = batchItems.map((item) =>
      currentSnapshot && item.id === currentSnapshot.id ? currentSnapshot : item,
    );
    if (!items.length || items.some((item) => !item.result)) {
      setError("Сначала оптимизируйте все изображения в очереди.");
      return;
    }
    setError(null);
    setDownloadStatus(null);
    setDownloadingFiles(true);
    try {
      const entries = items.flatMap((item, index) => {
        if (!item.result) return [];
        const packageResult = selectArchiveFiles(
          item.result,
          selectedPackageFiles,
          item.qualitySelection,
        );
        const folder = batchFolderName(item.file.name, index);
        return packageResult.results.flatMap((widthResult) =>
          widthResult.variants.map((variant) => ({
            name: `${folder}/${variant.fileName}`,
            blob: variant.blob,
          })),
        );
      });
      if (!entries.length) throw new Error("empty");
      const archive = await createBrowserZip(entries);
      downloadBlob(archive, "optima-images.zip");
      setDownloadStatus(
        `ZIP готов: ${entries.length} файлов разложено по папкам исходных изображений.`,
      );
    } catch {
      setError("Не удалось собрать общий ZIP. Скачайте файлы обычными загрузками.");
    } finally {
      setDownloadingFiles(false);
    }
  }

  async function copyMarkup() {
    if (!result) return;
    const packageResult = selectArchiveFiles(result, selectedPackageFiles, qualitySelection);
    if (!packageResult.results.length) {
      setError("Оставьте галочку хотя бы у одного файла для разметки.");
      return;
    }
    await navigator.clipboard.writeText(createPictureMarkup(packageResult, qualitySelection));
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
  }

  function togglePackageFile(key: ArchiveFileSelection) {
    setExcludedPackageFiles((current) =>
      current.includes(key)
        ? current.filter((item) => item !== key)
        : [...current, key],
    );
  }

  const sizeChange = largestResult
    ? Math.round((largestResult.recommended.size / (file?.size || 1) - 1) * 100)
    : 0;
  const liveSnapshot = currentBatchSnapshot();
  const visibleBatchItems = batchItems.map((item) =>
    liveSnapshot && item.id === liveSnapshot.id ? liveSnapshot : item,
  );
  const completedBatchItems = visibleBatchItems.filter((item) => item.result).length;
  const allBatchItemsCompleted =
    visibleBatchItems.length > 0 &&
    completedBatchItems === visibleBatchItems.length;
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
  const selectedPackageFiles = packageFileOptions
    .filter((option) => !excludedPackageFiles.includes(option.key))
    .map((option) => option.key);
  const selectedPackageFileCount = selectedPackageFiles.length;

  return (
    <>
    <div className={`optimizer-shell ${result ? "has-results" : ""}`}>
      <div className="optimizer-topline">
        <span>
          {batchItems.length
            ? `Очередь · ${batchItems.length} из ${MAX_BATCH_FILES}`
            : `Пакетная загрузка · до ${MAX_BATCH_FILES} фото`}
        </span>
        <span className="local-badge">
          <i aria-hidden="true" /> Обработка в браузере
        </span>
      </div>
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPTED_INPUT}
        onChange={handleInput}
        multiple
        disabled={addingFiles || working || batchItems.length >= MAX_BATCH_FILES}
        hidden
      />

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
              invalidateBatchResults();
            }}
          />
          <span>
            <strong>Фото</strong>
            <small>Минимальный вес с контролем деталей</small>
          </span>
          <i aria-hidden="true">◉</i>
        </label>
        <label className={optimizationMode === "screenshot" ? "is-active" : ""}>
          <input
            type="radio"
            name="optimization-mode"
            value="screenshot"
            checked={optimizationMode === "screenshot"}
            onChange={() => {
              setOptimizationMode("screenshot");
              invalidateBatchResults();
            }}
          />
          <span>
            <strong>Скриншот</strong>
            <small>Строгая проверка текста, линий и интерфейса</small>
          </span>
          <i aria-hidden="true">▤</i>
        </label>
      </fieldset>

      <div className="upload-panel">
          <div
            className={`dropzone ${dragging ? "is-dragging" : ""} ${batchItems.length >= MAX_BATCH_FILES ? "is-disabled" : ""}`}
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
            <div className="upload-icon" aria-hidden="true"><span>↑</span></div>
            <strong>
              {addingFiles
                ? "Добавляем изображения…"
                : batchItems.length
                  ? `Добавить ещё · ${batchItems.length} из ${MAX_BATCH_FILES}`
                  : `Загрузите до ${MAX_BATCH_FILES} изображений`}
            </strong>
            <p>
              Перетащите файлы сюда или нажмите, чтобы выбрать изображения
              на компьютере
            </p>
            <small>
              PNG · JPEG · HEIC / HEIF · WebP · AVIF · до 40 МБ каждый
            </small>
          </div>
      </div>

      {file && sourceInfo ? (
        <div className="optimizer-body">
          <section className="batch-queue" aria-label="Очередь фотографий">
            <header className="batch-queue-header">
              <span>
                <strong>Фотографии в работе</strong>
                <small>
                  Настройки сохраняются отдельно для каждого кадра · готово {completedBatchItems}
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
                    : batchItemError(item);
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
                      ×
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
              ×
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
                const shape = cropShapeDimensions(
                  preset.ratio ?? sourceAspectRatio,
                );
                return (
                  <button
                    className={draftCrop.aspectRatio === preset.ratio ? "is-active" : ""}
                    type="button"
                    onClick={() =>
                      updateDraftCrop({
                        aspectRatio: preset.ratio,
                        positionX: 50,
                        positionY: 50,
                      })
                    }
                    aria-pressed={draftCrop.aspectRatio === preset.ratio}
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

            <div
              className={`crop-stage ${canMoveCropX || canMoveCropY ? "is-movable" : ""}`}
              style={{ aspectRatio: String(draftAspectRatio) }}
              onPointerDown={handleCropPointerDown}
              onPointerMove={handleCropPointerMove}
              onPointerUp={handleCropPointerEnd}
              onPointerCancel={handleCropPointerEnd}
              aria-label="Предпросмотр кадра. Перетаскивайте фотографию для настройки композиции."
            >
              {/* The local Blob URL is rendered directly inside the crop editor. */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={sourceInfo.previewUrl}
                alt="Предпросмотр кадрирования"
                draggable={false}
                style={{
                  objectPosition: `${draftCrop.positionX}% ${draftCrop.positionY}%`,
                }}
              />
              <span className="crop-grid" aria-hidden="true" />
              <span className="crop-drag-hint" aria-hidden="true">
                {canMoveCropX || canMoveCropY ? "↔ Перетаскивайте фото" : "Весь кадр"}
              </span>
            </div>

            <div className="crop-controls">
              {canMoveCropX ? (
                <label>
                  <span>Сюжет по горизонтали</span>
                  <input
                    type="range"
                    min="0"
                    max="100"
                    value={draftCrop.positionX}
                    onChange={(event) =>
                      updateDraftCrop({
                        ...draftCrop,
                        positionX: Number(event.target.value),
                      })
                    }
                  />
                  <small>{draftCrop.positionX}%</small>
                </label>
              ) : null}
              {canMoveCropY ? (
                <label>
                  <span>Сюжет по вертикали</span>
                  <input
                    type="range"
                    min="0"
                    max="100"
                    value={draftCrop.positionY}
                    onChange={(event) =>
                      updateDraftCrop({
                        ...draftCrop,
                        positionY: Number(event.target.value),
                      })
                    }
                  />
                  <small>{draftCrop.positionY}%</small>
                </label>
              ) : null}
            </div>

            <div className="crop-save-row">
              <span>
                <strong>
                  Итоговый кадр: {Math.round(draftCropRect?.width ?? sourceInfo.width)} ×{" "}
                  {Math.round(draftCropRect?.height ?? sourceInfo.height)}px
                </strong>
                <small>Кадрирование выполняется из оригинала перед сжатием</small>
              </span>
              <button type="button" onClick={applyCrop} disabled={!cropDirty}>
                {cropDirty ? "Сохранить кадр" : "Кадр сохранён ✓"}
              </button>
            </div>
          </fieldset>

          <fieldset className="setting-group" disabled={working}>
            <legend>Где будет использоваться фото?</legend>
            <div className="profile-availability" aria-live="polite">
              <span>
                <strong>
                  {batchItems.length > 1
                    ? `Единый предел очереди: ${sizeLimitWidth}px`
                    : `После кадрирования доступно ${availableCropWidth}px`}
                </strong>
                <small>
                  {batchItems.length > 1 && smallestBatchPhoto
                    ? `Определён по самому маленькому кадру — фото ${smallestBatchPhoto.index + 1}, ${smallestBatchPhoto.fileName}`
                    : "Показываем только сценарии, которые можно подготовить без увеличения"}
                </small>
              </span>
              <em>
                {batchItems.length > 1
                  ? "Одинаковые размеры для всех"
                  : hiddenProfilesCount > 0
                  ? `Скрыто неподходящих: ${hiddenProfilesCount}`
                  : "Подходят все сценарии"}
              </em>
            </div>
            <div className="profile-availability no-upscale-note" role="note">
              <span>
                <strong>Optima не растягивает изображения</strong>
                <small>
                  Новые пиксели не добавляют деталей и делают кадр мягче. Для максимальной
                  резкости загружайте исходный JPG или PNG, а не уже уменьшенный WebP или AVIF.
                </small>
              </span>
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
                      onChange={() => {
                        setProfileId(item.id);
                        if (item.id === "custom" && includeRetina && !canIncludeRetina) {
                          setIncludeRetina(false);
                        }
                        invalidateBatchResults();
                      }}
                    />
                    <span className="profile-title-row">
                      <strong>{item.title}</strong>
                      {item.id !== "custom" ? (
                        <b className="profile-size-badge">до {Math.max(...item.widths)}px</b>
                      ) : null}
                    </span>
                    <span>{item.description}</span>
                    <small>
                      {item.id === "custom"
                        ? "Укажите ширину · Retina ×2 — по желанию"
                        : `Файлы: ${item.widths.map((width) => `${width}px`).join(" · ")}`}
                    </small>
                  </label>
                  {item.id === "custom" ? (
                    <div className="custom-profile-actions">
                      <b className="profile-size-badge">свой размер</b>
                      <button
                        ref={sizeGuideTriggerRef}
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
                  ) : null}
                </div>
              ))}
            </div>
            {sizeGuideOpen && typeof document !== "undefined"
              ? createPortal(
                  <div
                    className="size-guide-overlay"
                    onMouseDown={(event) => {
                      if (event.target === event.currentTarget) setSizeGuideOpen(false);
                    }}
                  >
                    <aside
                      className="inline-size-guide size-guide-drawer"
                      id="size-guide-panel"
                      role="dialog"
                      aria-modal="true"
                      aria-labelledby="size-guide-title"
                    >
                      <header>
                        <span>
                          <small>Экран 1920px · схема</small>
                          <strong id="size-guide-title">Как выбрать ширину файла</strong>
                        </span>
                        <button
                          ref={sizeGuideCloseRef}
                          type="button"
                          onClick={() => setSizeGuideOpen(false)}
                          aria-label="Закрыть инструкцию"
                        >
                          ×
                        </button>
                      </header>
                      <p className="size-guide-lead">
                        Смотрите, сколько карточек помещается в один ряд на большом экране.
                        Optima подготовит две разумные ширины — браузер загрузит только одну.
                      </p>
                      <div className="size-guide-list">
                        {SIZE_GUIDE_ITEMS.map((guideItem) => (
                          <article key={guideItem.columns}>
                            <div
                              className="size-guide-grid"
                              style={{ gridTemplateColumns: `repeat(${guideItem.columns}, minmax(0, 1fr))` }}
                              aria-hidden="true"
                            >
                              {Array.from({ length: guideItem.columns }, (_, index) => (
                                <span key={index} />
                              ))}
                            </div>
                            <div className="size-guide-copy">
                              <span>
                                <strong>{guideItem.title}</strong>
                                <small>{guideItem.note}</small>
                              </span>
                              <b>{guideItem.sizes}</b>
                            </div>
                          </article>
                        ))}
                      </div>
                      <div className="size-guide-note">
                        <strong>Когда выбрать больший файл?</strong>
                        <p>
                          Если карточка занимает почти всю колонку, фотография содержит лица,
                          текст или важные мелкие детали. Для нестандартной сетки используйте
                          «Свой размер» или анализ кода блока.
                        </p>
                      </div>
                    </aside>
                  </div>,
                  document.body,
                )
              : null}
            {activeProfileId === "custom" ? (
              <div className="custom-size-panel">
                <label>
                  <span>Нужная ширина файла</span>
                  <span className="number-input">
                    <input
                      type="number"
                      min="32"
                      max={sizeLimitWidth}
                      step="1"
                      inputMode="numeric"
                      value={customWidth}
                      onChange={(event) => {
                        const nextValue = event.target.value;
                        const nextWidth = Number(nextValue);
                        setCustomWidth(nextValue);
                        setSelectedCodeWidths([]);
                        setUseCodeWidths(false);
                        if (
                          includeRetina &&
                          Number.isFinite(nextWidth) &&
                          nextWidth * 2 > sizeLimitWidth
                        ) {
                          setIncludeRetina(false);
                        }
                        invalidateBatchResults();
                      }}
                      aria-label="Нужная ширина файла в пикселях"
                    />
                    <i>px</i>
                  </span>
                </label>
                <label className="retina-option">
                  <input
                    type="checkbox"
                    checked={includeRetina}
                    disabled={!canIncludeRetina}
                    onChange={(event) => {
                      setIncludeRetina(event.target.checked);
                      invalidateBatchResults();
                    }}
                  />
                  <span>
                    <strong>
                      {useCodeWidths
                        ? "Дополнительно создать Retina 2×"
                        : "Добавить Retina 2×"}
                    </strong>
                    <small>
                      {useCodeWidths
                        ? includeRetina
                          ? "К отмеченным размерам добавятся отдельные файлы в два раза шире"
                          : canIncludeRetina
                            ? "Выключено — подготовим только отмеченные размеры"
                            : `Retina 2× не помещается в доступные ${sizeLimitWidth}px`
                        : canIncludeRetina && Number(customWidth) > 0
                        ? `Подготовим ${customWidth}px и ${Math.round(Number(customWidth) * 2)}px для чётких экранов`
                        : Number(customWidth) > 0
                          ? `Для Retina нужно ${Math.round(Number(customWidth) * 2)}px, а для очереди доступно ${sizeLimitWidth}px`
                          : "Укажите ширину, чтобы проверить доступность Retina"}
                    </small>
                  </span>
                </label>
                <p className="custom-size-help">
                  {batchItems.length > 1
                    ? `Максимум для всей очереди — ${sizeLimitWidth}px по самому маленькому кадру.`
                    : `Максимум для выбранного кадра — ${availableCropWidth}px.`}{" "}
                  Нужен только один файл? Укажите его ширину и отключите Retina 2×.
                </p>
                <div className={`code-size-helper ${codeHelperOpen ? "is-open" : ""}`}>
                  <button
                    className="code-size-toggle"
                    type="button"
                    onClick={() => setCodeHelperOpen((current) => !current)}
                    aria-expanded={codeHelperOpen}
                  >
                    <span>
                      <strong>Не знаете размер блока?</strong>
                      <small>Вставьте код — сервис найдёт ширину на разных экранах</small>
                    </span>
                    <i aria-hidden="true">{codeHelperOpen ? "−" : "+"}</i>
                  </button>
                  {codeHelperOpen ? (
                    <div className="code-size-content">
                      <label htmlFor="block-code">
                        <strong>Код всего блока</strong>
                        <span>
                          Нужен весь HTML блока вместе с тегом &lt;style&gt; и медиазапросами,
                          а не только строка с фотографией.
                        </span>
                      </label>
                      <textarea
                        id="block-code"
                        value={blockCode}
                        onChange={(event) => {
                          setBlockCode(event.target.value);
                          setCodeAnalysis(null);
                          setSelectedCodeWidths([]);
                          setUseCodeWidths(false);
                          setCodeError(null);
                          invalidateBatchResults();
                        }}
                        placeholder={'<div class="photo-card">…</div>\n<style>…</style>'}
                        spellCheck={false}
                      />
                      <button
                        className="analyze-code-button"
                        type="button"
                        onClick={analyzeCodeForSizes}
                      >
                        Найти размеры в коде
                      </button>
                      <small className="code-local-note">
                        Анализ выполняется локально. Код не отправляется и не сохраняется.
                      </small>
                      {codeError ? <p className="code-error">{codeError}</p> : null}
                      {largestDetectedSize ? (
                        <div className="detected-sizes">
                          <div className="detected-sizes-title">
                            <span>
                              <strong>Самая большая карточка</strong>
                              <small>Этот файл подойдёт и для всех меньших карточек</small>
                            </span>
                            <em>{useCodeWidths ? "Используем" : "Ручной размер"}</em>
                          </div>
                          <div className="largest-size-editor">
                            <span>
                              <strong>Найдено в коде: {largestDetectedSize.width}px</strong>
                              <small>{largestDetectedSize.screens.join(" · ")}</small>
                            </span>
                            <label>
                              <span>Итоговая ширина</span>
                              <span className="number-input">
                                <input
                                  type="number"
                                  min="32"
                                  max={sizeLimitWidth}
                                  step="1"
                                  inputMode="numeric"
                                  value={selectedCodeWidths[0] ?? ""}
                                  onChange={(event) => {
                                    const width = Number(event.target.value);
                                    const nextWidths =
                                      Number.isFinite(width) && width > 0
                                        ? [Math.min(sizeLimitWidth, Math.round(width))]
                                        : [];
                                    setSelectedCodeWidths(nextWidths);
                                    setUseCodeWidths(true);
                                    if (
                                      includeRetina &&
                                      !nextWidths.some(
                                        (nextWidth) => nextWidth * 2 <= sizeLimitWidth,
                                      )
                                    ) {
                                      setIncludeRetina(false);
                                    }
                                    invalidateBatchResults();
                                  }}
                                  aria-label="Итоговая ширина самой большой карточки"
                                />
                                <i>px</i>
                              </span>
                            </label>
                          </div>
                          <p className="largest-size-help">
                            Можно округлить найденное значение вверх: например, 567px до 600px.
                            Это даст небольшой запас без создания лишних версий, но не выше
                            доступных для очереди {sizeLimitWidth}px.
                          </p>
                          <p className={`code-output-summary ${includeRetina ? "has-retina" : ""}`}>
                            <strong>В итоговой таблице:</strong>{" "}
                            {plannedCodeWidths.map((width) => `${width}px`).join(", ")}
                            {includeRetina
                              ? " — включены дополнительные Retina-файлы"
                              : plannedCodeWidths.length === selectedCodeWidths.length &&
                                  plannedCodeWidths.every((width) => selectedCodeWidths.includes(width))
                                ? " — только отмеченные размеры"
                                : " — с учётом ограничения по ширине исходника"}
                          </p>
                          {codeAnalysis?.warnings.map((warning) => (
                            <p className="code-warning" key={warning}>{warning}</p>
                          ))}
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              </div>
            ) : null}
          </fieldset>

          {working ? (
            <div className="progress-panel" aria-live="polite">
              <div>
                <span>{progressText}</span>
                <strong>{progress}%</strong>
              </div>
              <div className="progress-track"><span style={{ width: `${progress}%` }} /></div>
              <small>
                {processingAll
                  ? "Фотографии обрабатываются по очереди, настройки каждого кадра сохраняются."
                  : "Большие фотографии и AVIF могут обрабатываться дольше."}
              </small>
            </div>
          ) : (
            <div className={`batch-action-grid ${batchItems.length === 1 ? "is-single" : ""}`}>
              <button className="primary-button" type="button" onClick={runOptimization}>
                <span>Оптимизировать фото {activeItemNumber}</span>
                <i aria-hidden="true">↗</i>
              </button>
              {batchItems.length > 1 ? (
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
      ) : null}

      {error ? <p className="error-message">{error}</p> : null}

      {result && largestResult && comparisonResult && sourceInfo && comparedVariant && optimizedPreview ? (
        <section className="results" id="results">
          {visibleBatchItems.length > 1 ? (
            <div className="result-photo-switcher">
              <header>
                <span>
                  <strong>Готовые фотографии</strong>
                  <small>Переключайте кадры прямо возле итогового просмотра</small>
                </span>
                <em>{completedBatchItems} из {visibleBatchItems.length}</em>
              </header>
              <div>
                {visibleBatchItems.map((item, index) => (
                  <button
                    className={item.id === activeItemId ? "is-active" : ""}
                    type="button"
                    onClick={() => switchBatchItem(item.id)}
                    disabled={working || !item.result}
                    aria-pressed={item.id === activeItemId}
                    aria-label={
                      item.result
                        ? `Показать результат фото ${index + 1}: ${item.file.name}`
                        : `Фото ${index + 1} ещё не обработано`
                    }
                    key={item.id}
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
                ))}
              </div>
            </div>
          ) : null}
          <div className="results-summary">
            <div>
              <span>Результат для самого большого экрана</span>
              <strong>
                {sizeChange > 0
                  ? `+${sizeChange}%`
                  : sizeChange < 0
                    ? `−${Math.abs(sizeChange)}%`
                    : "0%"}
              </strong>
              <small>
                {formatBytes(file?.size ?? 0)} → {formatBytes(largestResult.recommended.size)}
              </small>
            </div>
            <div className="winner-format">
              <span>Лучший формат</span>
              <strong>{largestResult.recommended.format.toUpperCase()}</strong>
              <small>{similarityLabel(largestResult.recommended)}</small>
            </div>
          </div>

          <div className="result-stage">
            <div className="comparison-preview">
              <div className="preview-size-bar">
                <span>
                  <strong>Размер для просмотра</strong>
                  <small>Переключайте файлы и сравнивайте резкость</small>
                </span>
                <div>
                  {result.results.map((widthResult) => (
                    <button
                      className={comparisonResult.width === widthResult.width ? "is-active" : ""}
                      type="button"
                      onClick={() => setPreviewWidth(widthResult.width)}
                      aria-pressed={comparisonResult.width === widthResult.width}
                      key={widthResult.width}
                    >
                      {widthResult.width}px
                    </button>
                  ))}
                </div>
              </div>
              <div
                className="compare"
                style={{ aspectRatio: `${result.originalWidth} / ${result.originalHeight}` }}
              >
                {/* Blob URLs are intentionally rendered directly for local comparison. */}
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={sourceInfo.previewUrl}
                  alt="Подготовленный кадр до оптимизации"
                  style={{
                    objectPosition: `${appliedCrop.positionX}% ${appliedCrop.positionY}%`,
                  }}
                />
                <div className="compare-after" style={{ width: `${comparePosition}%` }}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={optimizedPreview}
                    alt={`Оптимизированное изображение ${comparisonResult.width}px`}
                    style={{ width: `${10000 / Math.max(comparePosition, 1)}%` }}
                  />
                </div>
                <span className="compare-label before">Оригинал</span>
                <span className="compare-label after">
                  {comparedVariant.format.toUpperCase()} · {comparisonResult.width}px ·{" "}
                  {comparedVariant.format === "png" ? "без потерь" : `Q${comparedVariant.quality}`} · {formatBytes(comparedVariant.size)}
                </span>
                <input
                  type="range"
                  min="1"
                  max="99"
                  value={comparePosition}
                  onChange={(event) => setComparePosition(Number(event.target.value))}
                  aria-label="Сравнение оригинала и оптимизированного изображения"
                />
                <i className="compare-handle" style={{ left: `${comparePosition}%` }}>↔</i>
              </div>
            </div>

            <div className="format-comparison">
            <div className="format-comparison-title">
              <div>
                <span>Сравнение форматов</span>
                <strong>
                  Один кадр · {comparisonResult.width}px · {comparisonFormats.length === 1
                    ? "один формат"
                    : "два формата"}
                </strong>
              </div>
              <small>Сначала выберите формат, затем уровень качества</small>
            </div>
            <div className="format-comparison-head" aria-hidden="true">
              <span>Формат</span>
              <span>Вес</span>
              <span>Качество</span>
              <span>Итог</span>
              <span />
            </div>
            <div className="format-comparison-list">
              {comparisonFormats.map((variant) => (
                <div
                  className={`${comparedVariant.format === variant.format ? "is-active" : ""} ${comparisonResult.recommended.format === variant.format ? "is-winner" : ""}`}
                  key={variant.format}
                >
                  <button
                    type="button"
                    className="format-select"
                    onClick={() => setPreviewFormat(variant.format)}
                    aria-pressed={comparedVariant.format === variant.format}
                  >
                    <span>
                      <strong>{variant.format.toUpperCase()}</strong>
                      <small>{variant.format === "png" ? "lossless" : `Q${variant.quality}`}</small>
                    </span>
                    <span>
                      <strong>{formatExactBytes(variant.size)}</strong>
                      <small title={`${variant.size.toLocaleString("ru-RU")} байт`}>
                        {variant.size.toLocaleString("ru-RU")} Б
                      </small>
                    </span>
                    <span>
                      <strong>
                        {variant.similarity === null ? "—" : variant.similarity.toFixed(3)}
                      </strong>
                      <small>
                        {variant.similarityMethod === "ssim"
                          ? "SSIM"
                          : variant.similarityMethod === "pixel"
                            ? "пиксельная"
                            : "проверить"}
                      </small>
                    </span>
                    <span className="format-verdict">
                      {comparisonResult.recommended.format === variant.format
                        ? "Лучший формат"
                        : formatDifference(
                            variant,
                            comparisonResult.variants.find(
                              (item) =>
                                item.format === comparisonResult.recommended.format &&
                                item.tier === qualitySelection[comparisonResult.recommended.format],
                            ) ?? comparisonResult.recommended,
                            result.threshold,
                          )}
                    </span>
                  </button>
                  <button
                    type="button"
                    className="format-download"
                    onClick={() => downloadBlob(variant.blob, variant.fileName)}
                    aria-label={`Скачать ${variant.format.toUpperCase()} ${comparisonResult.width}px, ${formatExactBytes(variant.size)}`}
                    title={`Скачать ${variant.fileName}`}
                  >
                    ↓
                  </button>
                </div>
              ))}
            </div>
            <div className="quality-comparison">
              <div className="quality-comparison-heading">
                <span>
                  <small>Качество {comparedVariant.format.toUpperCase()}</small>
                  <strong>
                    {comparedVariant.format === "png"
                      ? "PNG без потерь"
                      : `Optima выбрала Q${
                          qualityChoices.find((item) => item.tier === "recommended")?.quality ??
                          comparedVariant.quality
                        }`}
                  </strong>
                </span>
                <em>
                  {comparedVariant.format === "png"
                    ? "Точное сохранение пикселей после изменения размера"
                    : optimizationMode === "screenshot"
                    ? comparedVariant.format === "webp"
                      ? `Для текста Q82–100 · SSIM ≥ ${result.threshold.toFixed(3)}`
                      : `Для текста Q70–95 · SSIM ≥ ${result.threshold.toFixed(3)}`
                    : comparedVariant.format === "webp"
                      ? `Безопасный диапазон Q60–85 · SSIM ≥ ${result.threshold.toFixed(2)}`
                      : `Безопасный диапазон Q45–80 · SSIM ≥ ${result.threshold.toFixed(2)}`}
                </em>
              </div>
              <div className="quality-comparison-options">
                {qualityChoices.map((variant) => {
                  const label = QUALITY_TIER_LABELS[variant.tier];
                  return (
                    <button
                      className={`${comparedVariant.tier === variant.tier ? "is-active" : ""} ${variant.tier === "recommended" ? "is-recommended" : ""}`}
                      type="button"
                      onClick={() =>
                        setQualitySelection((current) => ({
                          ...current,
                          [variant.format]: variant.tier,
                        }))
                      }
                      aria-pressed={comparedVariant.tier === variant.tier}
                      key={variant.tier}
                    >
                      <span>
                        <strong>{label.title}</strong>
                        <b>{variant.format === "png" ? "Lossless" : `Q${variant.quality}`}</b>
                      </span>
                      <em>{formatExactBytes(variant.size)}</em>
                      <small>
                        {variant.similarity === null
                          ? "проверить вручную"
                          : `SSIM ${variant.similarity.toFixed(3)}`}
                      </small>
                      <i>{label.description}</i>
                    </button>
                  );
                })}
              </div>
            </div>
            <p>
              Выбранный уровень применяется ко всем размерам этого формата и попадёт в обычные загрузки браузера.
              {comparedVariant.format === "png"
                ? " PNG сохраняется без потерь и служит самым безопасным вариантом для текста, схем и интерфейса."
                : optimizationMode === "screenshot"
                ? " В режиме «Скриншот» сервис держит повышенный запас качества, чтобы сохранить текст и тонкие линии."
                : comparedVariant.format === "webp"
                ? " WebP: Q60 — компактнее, авто — Q68–82, Q85 — максимум деталей."
                : " AVIF: Q45 — компактнее, авто — Q50–70, Q80 — максимум деталей. Q разных форматов напрямую не сравнивается."}
            </p>
            </div>
          </div>

          <div className="result-list">
            <div className="result-list-title">
              <div>
                <span>Все подготовленные размеры</span>
                <strong>
                  {comparedVariant.format.toUpperCase()} · {QUALITY_TIER_LABELS[comparedVariant.tier].title}
                </strong>
              </div>
              <small>{activeFormatResults.length} файл(а) · скачиваются по отдельности</small>
            </div>
            <div className="result-list-head">
              <span>Ширина</span>
              <span>Формат и качество</span>
              <span>Точный вес</span>
              <span />
            </div>
            {activeFormatResults.map(({ widthResult, variant }) => (
              <div
                className={`result-row ${comparisonResult.width === widthResult.width ? "is-active" : ""}`}
                key={widthResult.width}
              >
                <button
                  className="result-row-select"
                  type="button"
                  onClick={() => setPreviewWidth(widthResult.width)}
                  aria-pressed={comparisonResult.width === widthResult.width}
                >
                  <span>
                    <strong>{widthResult.width}px</strong>
                    <small>{widthResult.width} × {widthResult.height}</small>
                  </span>
                  <span>
                    <strong>{variant.format.toUpperCase()}</strong>
                    <small>
                      {similarityLabel(variant)} · {variant.format === "png" ? "без потерь" : `Q${variant.quality}`}
                    </small>
                  </span>
                  <span>
                    <strong>{formatExactBytes(variant.size)}</strong>
                    <small title={`${variant.size.toLocaleString("ru-RU")} байт`}>
                      {variant.size.toLocaleString("ru-RU")} Б
                    </small>
                  </span>
                </button>
                <button
                  className="result-download"
                  type="button"
                  onClick={() => downloadBlob(variant.blob, variant.fileName)}
                  aria-label={`Скачать ${variant.format.toUpperCase()} ${widthResult.width}px, ${formatExactBytes(variant.size)}`}
                >
                  ↓
                </button>
              </div>
            ))}
          </div>

          {result.warnings.length ? (
            <div className="warnings">
              {result.warnings.map((warning) => <p key={warning}>{warning}</p>)}
            </div>
          ) : null}

          <div className="package-download-panel">
            <header>
              <span>
                <small>Скачивание</small>
                <strong>Что подготовить?</strong>
              </span>
              <em>
                Выбрано {selectedPackageFileCount} из {packageFileOptions.length}
              </em>
            </header>

            <fieldset className="package-file-selector">
              <legend>Файлы для сохранения</legend>
              <p>Все варианты отмечены изначально. Снимите галочку с тех, которые не нужны.</p>
              <div className="package-file-list">
                {packageFileOptions.map((option) => (
                  <label key={option.key}>
                    <input
                      type="checkbox"
                      checked={selectedPackageFiles.includes(option.key)}
                      onChange={() => togglePackageFile(option.key)}
                    />
                    <i aria-hidden="true">✓</i>
                    <span>
                      <strong>{option.format.toUpperCase()}</strong>
                      <small>{option.width} × {option.height}px</small>
                    </span>
                    <em>{formatExactBytes(option.variant.size)}</em>
                  </label>
                ))}
              </div>
            </fieldset>

            <div className="package-scope-grid">
              <button
                className="package-scope-button"
                type="button"
                onClick={downloadSelectedFiles}
                disabled={selectedPackageFileCount === 0 || downloadingFiles}
              >
                <small>Обычные загрузки браузера</small>
                <strong>{downloadingFiles ? "Отправляем файлы…" : `Скачать файлы фото ${activeItemNumber}`}</strong>
                <span>
                  Без ZIP и выбора папки · файлов: {selectedPackageFileCount}
                </span>
                <i aria-hidden="true">↓</i>
              </button>
              <button
                className="package-scope-button is-zip"
                type="button"
                onClick={downloadSelectedZip}
                disabled={selectedPackageFileCount === 0 || downloadingFiles}
              >
                <small>Один аккуратный архив</small>
                <strong>{downloadingFiles ? "Подготавливаем…" : `Скачать ZIP фото ${activeItemNumber}`}</strong>
                <span>ZIP собирается локально · файлов: {selectedPackageFileCount}</span>
                <i aria-hidden="true">ZIP</i>
              </button>
              {visibleBatchItems.length > 1 ? (
                <>
                  <button
                    className="package-scope-button is-all"
                    type="button"
                    onClick={downloadBatchFiles}
                    disabled={!allBatchItemsCompleted || working || downloadingFiles || selectedPackageFileCount === 0}
                  >
                    <small>Вся очередь · отдельно</small>
                    <strong>{downloadingFiles ? "Подготавливаем…" : `Скачать файлы ${visibleBatchItems.length} фото`}</strong>
                    <span>
                      С группировкой по имени каждого кадра
                      {!allBatchItemsCompleted
                        ? ` · готово ${completedBatchItems} из ${visibleBatchItems.length}`
                        : ` · по ${selectedPackageFileCount} файлов`}
                    </span>
                    <i aria-hidden="true">↓</i>
                  </button>
                  <button
                    className="package-scope-button is-all is-zip"
                    type="button"
                    onClick={downloadBatchZip}
                    disabled={!allBatchItemsCompleted || working || downloadingFiles || selectedPackageFileCount === 0}
                  >
                    <small>Вся очередь · один архив</small>
                    <strong>{downloadingFiles ? "Подготавливаем…" : "Скачать общий ZIP"}</strong>
                    <span>Внутри — отдельная папка для каждого исходника</span>
                    <i aria-hidden="true">ZIP</i>
                  </button>
                </>
              ) : null}
            </div>

            {downloadStatus ? <p className="folder-save-status">{downloadStatus}</p> : null}

            <button className="package-copy-button" type="button" onClick={copyMarkup}>
              {copied ? "Код <picture> скопирован" : "Скопировать <picture> для активного фото"}
            </button>
          </div>
          <p className="results-note">
            Обычная загрузка отправляет отмеченные файлы по отдельности. ZIP собирается
            прямо в браузере и не передаёт изображения на сервер.
          </p>
        </section>
      ) : null}
    </div>
    </>
  );
}
