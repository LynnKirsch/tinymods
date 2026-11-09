export function isHeicFile(file: File) {
  return file.type === "image/heic" ||
    file.type === "image/heif" ||
    /\.(heic|heif)$/i.test(file.name);
}

export async function decodeHeicImageData(file: File) {
  const buffer = await file.arrayBuffer();
  const { decode } = await import("@discourse/heic");
  return decode(buffer);
}

export async function decodeHeicBitmap(file: File) {
  const imageData = await decodeHeicImageData(file);
  return createImageBitmap(imageData);
}
