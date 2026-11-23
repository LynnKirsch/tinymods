export type ImageMetadataStatus = "loading" | "ready" | "unavailable";

export type ImageMetadata = {
  status: ImageMetadataStatus;
  format: string;
  width?: number;
  height?: number;
  bytes?: number;
};

const FORMAT_BY_MIME: Record<string, string> = {
  "image/avif": "AVIF",
  "image/gif": "GIF",
  "image/jpeg": "JPEG",
  "image/jpg": "JPEG",
  "image/png": "PNG",
  "image/svg+xml": "SVG",
  "image/webp": "WebP",
};

const FORMAT_BY_EXTENSION: Record<string, string> = {
  avif: "AVIF",
  gif: "GIF",
  jpeg: "JPEG",
  jpg: "JPEG",
  png: "PNG",
  svg: "SVG",
  webp: "WebP",
};

export function imageFormatFromSource(source: string, mimeType = "") {
  const normalizedMime = mimeType.split(";")[0].trim().toLowerCase();
  if (FORMAT_BY_MIME[normalizedMime]) return FORMAT_BY_MIME[normalizedMime];

  const dataMime = source.match(/^data:([^;,]+)/i)?.[1]?.toLowerCase() ?? "";
  if (FORMAT_BY_MIME[dataMime]) return FORMAT_BY_MIME[dataMime];

  const pathname = source.split(/[?#]/)[0];
  const extension = pathname.match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase() ?? "";
  return FORMAT_BY_EXTENSION[extension] ?? "формат неизвестен";
}

export function byteSizeFromDataUrl(source: string) {
  const match = source.match(/^data:[^,]*,(.*)$/i);
  if (!match) return undefined;

  const payload = match[1];
  if (/^data:[^,]*;base64,/i.test(source)) {
    const padding = payload.endsWith("==") ? 2 : payload.endsWith("=") ? 1 : 0;
    return Math.max(0, Math.floor((payload.length * 3) / 4) - padding);
  }

  try {
    return new TextEncoder().encode(decodeURIComponent(payload)).length;
  } catch {
    return undefined;
  }
}

export function imageTimingBytes(timing?: Pick<PerformanceResourceTiming, "decodedBodySize" | "encodedBodySize">) {
  return [timing?.decodedBodySize, timing?.encodedBodySize].find(bytes =>
    typeof bytes === "number" && Number.isSafeInteger(bytes) && bytes > 0);
}

const imageSizeCache = new Map<string, { bytes: Promise<number | undefined>; expires: number }>();

export function requestImageFileBytes(source: string): Promise<number | undefined> {
  let url: URL;
  try { url = new URL(source); } catch { return Promise.resolve(undefined); }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password) {
    return Promise.resolve(undefined);
  }
  url.hash = "";
  const key = url.href;
  const cached = imageSizeCache.get(key);
  if (cached && cached.expires > Date.now()) return cached.bytes;
  imageSizeCache.delete(key);
  if (imageSizeCache.size >= 128) {
    const oldest = imageSizeCache.keys().next().value;
    if (oldest !== undefined) imageSizeCache.delete(oldest);
  }

  const bytes = (async () => {
    try {
      const response = await fetch(key, {
        method: "HEAD",
        credentials: "omit",
        referrerPolicy: "no-referrer",
        signal: AbortSignal.timeout(5000),
      });
      if (response.status !== 200) return undefined;
      const length = response.headers.get("content-length");
      if (!length || !/^\d+$/.test(length)) return undefined;
      const value = Number(length);
      return Number.isSafeInteger(value) && value > 0 ? value : undefined;
    } catch {
      return undefined;
    }
  })();
  const entry = { bytes, expires: Date.now() + 30_000 };
  imageSizeCache.set(key, entry);
  void bytes.then(value => { if (value !== undefined) entry.expires = Date.now() + 300_000; });
  return bytes;
}

export function formatByteSize(bytes?: number) {
  if (!Number.isFinite(bytes)) return "вес недоступен";
  if (bytes! < 1024) return `${bytes} B`;
  if (bytes! < 1024 * 1024) return `${Math.round(bytes! / 1024)} KB`;
  return `${(bytes! / 1024 / 1024).toFixed(bytes! < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

export function imageOrientation(width?: number, height?: number) {
  if (!width || !height || width < 1 || height < 1) return "Размер неизвестен";
  if (width === height) return "Квадратное";
  return width > height ? "Горизонтальное" : "Вертикальное";
}

export function imageMetadataLine(source: string, metadata?: ImageMetadata) {
  if (!source.trim()) return "URL не указан";
  if (!metadata || metadata.status === "loading") {
    return `${imageFormatFromSource(source)} · параметры загружаются`;
  }

  const dimensions =
    metadata.width && metadata.height ? `${metadata.width} × ${metadata.height} px` : "размер неизвестен";

  return `${metadata.format} · ${dimensions} · ${formatByteSize(metadata.bytes)}`;
}
