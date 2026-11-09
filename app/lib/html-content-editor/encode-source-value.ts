import type { EditableEntity, SourcePatch } from "./types";

function encodeTextNodeValue(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function encodeAttributeValue(value: string, quote: '"' | "'") {
  const encoded = encodeTextNodeValue(value);
  return quote === '"'
    ? encoded.replace(/"/g, "&quot;")
    : encoded.replace(/'/g, "&#39;");
}

function encodeCssUrlValue(value: string, quote: '"' | "'" | "") {
  const escaped = value
    .replace(/\\/g, "\\\\")
    .replace(/\)/g, "\\)");

  if (quote === '"') return escaped.replace(/"/g, '\\"');
  if (quote === "'") return escaped.replace(/'/g, "\\'");
  return escaped.replace(/\s/g, "\\ ");
}

function encodeJsTemplateValue(value: string) {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/`/g, "\\`")
    .replace(/\$\{/g, "\\${");
}

function encodeJsStringValue(value: string, quote: '"' | "'") {
  const escaped = value
    .replace(/\\/g, "\\\\")
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n")
    .replace(/\t/g, "\\t");

  return quote === '"'
    ? escaped.replace(/"/g, '\\"')
    : escaped.replace(/'/g, "\\'");
}

export function encodeEditableEntityValue(
  entity: EditableEntity,
  displayValue: string,
) {
  if (entity.context.type === "text") {
    const encoded = encodeTextNodeValue(displayValue);
    return entity.context.source === "js-template"
      ? encodeJsTemplateValue(encoded)
      : encoded;
  }

  if (entity.context.type === "css-url") {
    const cssValue = encodeCssUrlValue(displayValue, entity.context.quote);
    return entity.context.container === "style-attribute"
      ? encodeAttributeValue(cssValue, entity.context.attributeQuote ?? '"')
      : cssValue;
  }

  if (entity.context.type === "attribute" && entity.context.source === "js-constant") {
    return encodeJsStringValue(displayValue, entity.context.quote);
  }

  return encodeAttributeValue(displayValue, entity.context.quote);
}

export function createEditableEntityPatch(
  entity: EditableEntity,
  displayValue: string,
): SourcePatch {
  if (entity.composite) throw new Error("Composite text requires segment patches.");
  if (
    entity.kind === "alt" &&
    entity.context.type === "attribute" &&
    entity.context.missing
  ) {
    return {
      ...entity.range,
      replacement: displayValue
        ? ` alt=${entity.context.quote}${encodeEditableEntityValue(entity, displayValue)}${entity.context.quote}`
        : "",
    };
  }

  return {
    ...entity.range,
    replacement: encodeEditableEntityValue(entity, displayValue),
  };
}

export const COMPOSITE_EDIT_MESSAGE = "Изменение затрагивает форматирование внутри фразы. Измените эту часть текста отдельно.";

// A conservative diff: keep sufficiently long unchanged anchors, and never guess
// how a replacement crossing a formatting boundary should be distributed.
function textEdits(before: string, after: string, offset = 0): Array<{ start: number; end: number; value: string }> {
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix++;
  let suffix = 0;
  while (suffix < before.length - prefix && suffix < after.length - prefix && before[before.length - suffix - 1] === after[after.length - suffix - 1]) suffix++;
  const a = before.slice(prefix, before.length - suffix);
  const b = after.slice(prefix, after.length - suffix);
  if (!a && !b) return [];
  // Bound the working memory/time for large pasted text. A single replacement
  // remains safe: it is accepted only if it belongs to one original segment.
  if (a.length * b.length <= 250000) {
    let row = new Uint32Array(b.length + 1);
    let best = 0, ai = 0, bi = 0;
    for (let i = 1; i <= a.length; i++) {
      const next = new Uint32Array(b.length + 1);
      for (let j = 1; j <= b.length; j++) if (a[i - 1] === b[j - 1]) {
        next[j] = row[j - 1] + 1;
        if (next[j] > best) { best = next[j]; ai = i; bi = j; }
      }
      row = next;
    }
    if (best >= 3) return [
      ...textEdits(a.slice(0, ai - best), b.slice(0, bi - best), offset + prefix),
      ...textEdits(a.slice(ai), b.slice(bi), offset + prefix + ai),
    ];
  }
  return [{ start: offset + prefix, end: offset + before.length - suffix, value: b }];
}

export function compositeEditError(entity: EditableEntity, value: string): string | null {
  try { createEditableEntityPatches(entity, value); return null; }
  catch { return COMPOSITE_EDIT_MESSAGE; }
}

export function createEditableEntityPatches(entity: EditableEntity, value: string): SourcePatch[] {
  if (value === entity.displayValue) return [];
  if (!entity.composite) return [createEditableEntityPatch(entity, value)];
  if (value.split("\n").length !== entity.displayValue.split("\n").length) throw new Error(COMPOSITE_EDIT_MESSAGE);
  let offset = 0;
  const segments = entity.composite.segments.map(segment => {
    const start = offset;
    offset += segment.displayValue.length;
    return { ...segment, start, end: offset, edits: [] as Array<{ start: number; end: number; value: string }> };
  });
  for (const edit of textEdits(entity.displayValue, value)) {
    let candidates = segments.filter(segment => !segment.break && edit.start >= segment.start && edit.end <= segment.end);
    if (edit.start === edit.end && candidates.length === 2) {
      const [left, right] = candidates;
      // A word inserted next to a separating space belongs to the word's side.
      // A boundary between two touching formatted words stays ambiguous.
      if (/\s$/.test(left.displayValue) && !/^\s/.test(right.displayValue)) candidates = [right];
      else if (/^\s/.test(right.displayValue) && !/\s$/.test(left.displayValue)) candidates = [left];
    }
    // Insertions exactly between two formatting segments are ambiguous.
    if (candidates.length !== 1 || edit.value.includes("\n")) throw new Error(COMPOSITE_EDIT_MESSAGE);
    candidates[0].edits.push(edit);
  }
  return segments.flatMap(segment => {
    if (!segment.edits.length) return [];
    let next = segment.displayValue;
    for (const edit of segment.edits.sort((a, b) => b.start - a.start)) next = next.slice(0, edit.start - segment.start) + edit.value + next.slice(edit.end - segment.start);
    // Whitespace around formatted, indented source is kept verbatim.
    const raw = entity.rawValue.slice(segment.range.start - entity.range.start, segment.range.end - entity.range.start);
    const leading = /^\s/.test(segment.displayValue) ? "" : raw.match(/^\s*/)?.[0] ?? "";
    const trailing = /\s$/.test(segment.displayValue) || !raw.trim() ? "" : raw.match(/\s*$/)?.[0] ?? "";
    return [{ ...segment.range, replacement: leading + encodeEditableEntityValue(entity, next) + trailing }];
  });
}
