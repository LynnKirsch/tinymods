export type AppearanceInputSourceKind = "raw-css" | "style-tags";

export type AppearanceInputResult =
  | {
      ok: true;
      css: string;
      sourceKind: AppearanceInputSourceKind;
    }
  | {
      ok: false;
      message: string;
    };

const STYLE_TAG_PATTERN = /<style\b[^>]*>([\s\S]*?)<\/style>/gi;
const EMPTY_STYLE_INPUT = "<style>\n\n</style>";

function stripCssComments(value: string) {
  return value.replace(/\/\*[\s\S]*?\*\//g, "");
}

function looksLikeCss(value: string) {
  const withoutComments = stripCssComments(value).trim();
  if (!withoutComments) return false;
  if (/[{}]/.test(withoutComments) && /[{][\s\S]*?:[\s\S]*?[}]/.test(withoutComments)) {
    return true;
  }
  return /^@(?:media|supports|layer|container|font-face|keyframes)\b/i.test(withoutComments);
}

export function parseAppearanceInput(input: string): AppearanceInputResult {
  const trimmed = input.trim();
  if (!trimmed) {
    return { ok: false, message: "Введите код оформления." };
  }

  const styleBlocks = [...trimmed.matchAll(STYLE_TAG_PATTERN)]
    .map((match) => match[1].trim())
    .filter(Boolean);

  if (styleBlocks.length > 0) {
    const css = styleBlocks.join("\n\n").trim();
    if (looksLikeCss(css)) return { ok: true, css, sourceKind: "style-tags" };
  }

  if (looksLikeCss(trimmed) && !/<[a-z][\s\S]*>/i.test(trimmed)) {
    return { ok: true, css: trimmed, sourceKind: "raw-css" };
  }

  return {
    ok: false,
    message: "Не удалось найти оформление. Вставьте стили или код со стилями, который вам передали.",
  };
}

export function formatAppearanceTextareaValue(css?: string | null) {
  const trimmed = css?.trim();
  if (!trimmed) return EMPTY_STYLE_INPUT;
  return `<style>\n${trimmed}\n</style>`;
}
