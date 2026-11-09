export const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH || "";
export const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || "https://tinymods.ru";

/** Prefix files served from public; Next Link prefixes application routes itself. */
export function withBasePath(path: string) {
  return `${BASE_PATH}${path}`;
}
