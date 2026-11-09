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

export function formatByteSize(bytes?: number) {
  if (!Number.isFinite(bytes)) return "вес недоступен";
  if (bytes! < 1024) return `${bytes} B`;
  if (bytes! < 1024 * 1024) return `${Math.round(bytes! / 1024)} KB`;
  return `${(bytes! / 1024 / 1024).toFixed(bytes! < 10 * 1024 * 1024 ? 1 : 0)} MB`;
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
