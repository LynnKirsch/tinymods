import type { EditableEntity } from "./types";

export type TextLengthWarning = {
  currentLength: number;
  originalLength: number;
  overflow: number;
  currentLines: number;
  originalLines: number;
  overLimit: boolean;
  hasExtraLineBreaks: boolean;
  message: string;
  lineBreakMessage: string;
};

function fallbackGraphemeLength(value: string) {
  return Array.from(value).length;
}

export function userTextLength(value: string) {
  if (typeof Intl !== "undefined" && "Segmenter" in Intl) {
    const segmenter = new Intl.Segmenter("ru", { granularity: "grapheme" });
    return [...segmenter.segment(value)].length;
  }

  return fallbackGraphemeLength(value);
}

export function explicitLineCount(value: string) {
  return value.split("\n").length;
}

function warningMessage(entity: EditableEntity) {
  if (entity.context.type !== "text") {
    return "";
  }

  const tagName = entity.context.tagName;
  if (/^h[1-6]$/.test(tagName)) {
    return "Заголовок может занять дополнительную строку и изменить высоту блока.";
  }
  if (tagName === "button") {
    return "Более длинный текст может увеличить кнопку или перенестись на новую строку.";
  }
  if (tagName === "a") {
    return "Более длинный текст ссылки или кнопки может изменить её размер или перенос строк.";
  }
  if (tagName === "p") {
    return "Более длинный текст может увеличить высоту текстового блока.";
  }
  if (tagName === "li") {
    return "Пункт может занять дополнительные строки.";
  }
  return "Более длинный текст может изменить размер или переносы элемента.";
}

export function textLengthWarning(
  entity: EditableEntity,
  currentValue: string,
): TextLengthWarning | null {
  if (entity.kind !== "text") return null;

  const originalLength = userTextLength(entity.displayValue);
  const currentLength = userTextLength(currentValue);
  const originalLines = explicitLineCount(entity.displayValue);
  const currentLines = explicitLineCount(currentValue);
  const overflow = currentLength - originalLength;
  const overLimit = overflow > 0;
  const hasExtraLineBreaks = currentLines > originalLines;

  return {
    currentLength,
    originalLength,
    overflow,
    currentLines,
    originalLines,
    overLimit,
    hasExtraLineBreaks,
    message: warningMessage(entity),
    lineBreakMessage: `Исходник: ${originalLines} ${originalLines === 1 ? "строка" : "строки"}. Сейчас: ${currentLines} ${currentLines === 1 ? "строка" : "строки"}.`,
  };
}
