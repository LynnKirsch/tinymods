import type {
  EditableEntity,
  EditableEntityContext,
  EditableEntityKind,
  LinkRole,
} from "./types";
import { renderStaticJsWidgets } from "./js-static-widgets.js";

const SKIPPED_RAW_TEXT_ELEMENTS = new Set(["script", "style", "svg"]);
const PHRASE_CONTAINER_CLASS =
  /(?:^|[-_:])(text|copy|message|title|headline|heading|caption|label)(?:$|[-_:])/i;
const EDITABLE_ATTRIBUTES: Record<string, "href" | "src"> = {
  href: "href",
  src: "src",
};
const ALT_SUPPORTED_IMAGE_EXTENSION = /\.(?:jpe?g|webp|avif|gif|bmp|tiff?)(?:[?#].*)?$/i;
const ALT_EXCLUDED_IMAGE_EXTENSION = /\.(?:png|svg)(?:[?#].*)?$/i;
const ALT_SUPPORTED_DATA_IMAGE = /^data:image\/(?:jpeg|jpg|webp|avif|gif|bmp|tiff?)[;,]/i;
const ALT_EXCLUDED_DATA_IMAGE = /^data:image\/(?:png|svg\+xml)[;,]/i;
const VIDEO_SOURCE_EXTENSION = /\.(?:mp4|webm|ogv|ogg)(?:[?#].*)?$/i;
const DATA_URL = /^data:/i;

type OpenElement = {
  name: string;
  editable: boolean;
  skipped: boolean;
  sourceStart?: number;
  tagStart?: number;
  className?: string;
  pictureId?: string;
  videoId?: string;
  hidden?: boolean;
  linkRole?: LinkRole;
  videoStoryTrigger?: boolean;
};

type ImageTagContext = {
  elementName?: "img" | "source" | "video";
  pictureId?: string;
  mediaGroupId?: string;
  mediaRole?: "image" | "video" | "video-poster";
  fallback?: boolean;
  media?: string;
  sourceType?: string;
};

function classAttributeValue(tag: string, tagStart: number) {
  return firstAttributeValue(tag, tagStart, "class")?.rawValue ?? "";
}

function linkRoleForAnchor(tag: string, tagStart: number): LinkRole {
  const classNames = classAttributeValue(tag, tagStart)
    .trim()
    .split(/\s+/)
    .filter(Boolean);

  if (classNames.some((className) => /(?:^|[-_:])(button|btn|cta)(?:$|[-_:])/i.test(className))) {
    return "button";
  }
  if (classNames.some((className) => /(?:^|[-_:])card(?:$|[-_:])/i.test(className))) {
    return "card";
  }
  return "link";
}

function findTagEnd(source: string, start: number) {
  let quote = "";
  for (let index = start + 1; index < source.length; index += 1) {
    const char = source[index];
    if (quote) {
      if (char === quote) quote = "";
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === ">") return index;
  }
  return -1;
}

function readTagName(tag: string) {
  return tag.match(/^<\/?\s*([a-zA-Z][\w:-]*)/)?.[1]?.toLowerCase() ?? null;
}

function decodeBasicEntities(value: string) {
  const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0" };
  // Decode once, so &#38;lt; stays the visible text &lt; rather than becoming <.
  return value.replace(/&(amp|lt|gt|quot|apos|nbsp|#(?:x[\da-f]+|\d+));/gi, (raw, token: string) => {
    if (token[0] !== "#") return named[token.toLowerCase()] ?? raw;
    const number = token.slice(1);
    const code = number[0].toLowerCase() === "x" ? Number.parseInt(number.slice(1), 16) : Number(number);
    return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : "\ufffd";
  });
}

// Only semantic text owners with formatting-only descendants are composite.
// In particular, an anchor or a nested block is a boundary, never swallowed.
function mergeCompositeText(source: string, entities: EditableEntity[], owner: OpenElement, end: number) {
  if (!/^(h[1-6]|p|li|figcaption|blockquote|a)$/.test(owner.name)) return;
  const start = owner.sourceStart!;
  const inner = source.slice(start, end);
  const segments: NonNullable<EditableEntity["composite"]>["segments"] = [];
  let cursor = start;
  while (cursor < end) {
    const tagStart = source.indexOf("<", cursor);
    if (tagStart < 0 || tagStart >= end) break;
    if (tagStart > cursor) segments.push({ range: { start: cursor, end: tagStart }, displayValue: decodeBasicEntities(source.slice(cursor, tagStart)).replace(/\s+/g, " ") });
    const comment = source.startsWith("<!--", tagStart);
    const tagEnd = comment ? source.indexOf("-->", tagStart + 4) + 2 : findTagEnd(source, tagStart);
    if (tagEnd < tagStart || tagEnd >= end) return;
    const tag = source.slice(tagStart, tagEnd + 1);
    const name = readTagName(tag);
    if (!comment && (!name || !/^(span|strong|em|b|i|u|mark|small|br)$/.test(name))) return;
    if (!comment && !/^<\//.test(tag)) {
      const role = firstAttributeValue(tag, tagStart, "role")?.rawValue;
      if (/\s(?:on\w+|tabindex|contenteditable)(?:\s|=|>)/i.test(tag) || (role && /^(button|link|checkbox|radio|switch|slider|textbox|combobox|menuitem|tab)$/i.test(role))) return;
    }
    if (name === "br") segments.push({ range: { start: tagStart, end: tagEnd + 1 }, displayValue: "\n", break: true });
    cursor = tagEnd + 1;
  }
  if (cursor < end) segments.push({ range: { start: cursor, end }, displayValue: decodeBasicEntities(source.slice(cursor, end)).replace(/\s+/g, " ") });
  if (!segments.some(segment => segment.break) && !/<(?:span|strong|em|b|i|u|mark|small)\b/i.test(inner)) return;
  for (let i = 0; i < segments.length; i++) {
    if (segments[i].break) continue;
    if (i === 0 || segments[i - 1].break) segments[i].displayValue = segments[i].displayValue.trimStart();
    if (i === segments.length - 1 || segments[i + 1].break) segments[i].displayValue = segments[i].displayValue.trimEnd();
  }
  const children = entities.filter(entity => entity.kind === "text" && entity.range.start >= start && entity.range.end <= end);
  if (!children.length) return;
  const first = children[0];
  if (first.context.type !== "text") return;
  const entity: EditableEntity = {
    ...first, id: `text:${start}:${end}`, range: { start, end }, rawValue: inner,
    displayValue: segments.map(segment => segment.displayValue).join(""),
    context: { ...first.context, type: "text", tagName: owner.name, presentationGroupId: `${owner.name}:${start}` },
    composite: { ownerTag: { start: owner.tagStart!, end: start }, segments },
  };
  for (let i = entities.length - 1; i >= 0; i--) if (children.includes(entities[i])) entities.splice(i, 1);
  entities.push(entity);
}

function attributeValueRanges(
  tag: string,
  tagStart: number,
  attributeName: string,
) {
  const ranges: Array<{
    rawValue: string;
    start: number;
    end: number;
    quote: '"' | "'";
  }> = [];
  const pattern = /([^\s"'<>/=]+)\s*=\s*("([^"]*)"|'([^']*)'|[^\s"'=<>`]+)/g;

  for (const match of tag.matchAll(pattern)) {
    if (match[1].toLowerCase() !== attributeName) continue;
    const fullValue = match[2];
    const quotedValue = match[3] ?? match[4];
    if (quotedValue === undefined) continue;
    const rawValue = quotedValue ?? fullValue;
    const valueOffset = match.index + match[0].lastIndexOf(fullValue);
    const start = tagStart + valueOffset + 1;
    ranges.push({
      rawValue,
      start,
      end: start + rawValue.length,
      quote: fullValue[0] as '"' | "'",
    });
  }

  return ranges;
}

function firstAttributeValue(
  tag: string,
  tagStart: number,
  attributeName: string,
) {
  return attributeValueRanges(tag, tagStart, attributeName)[0] ?? null;
}

function pushEntity(
  entities: EditableEntity[],
  kind: EditableEntityKind,
  rawValue: string,
  start: number,
  end: number,
  context: EditableEntityContext,
) {
  if (!rawValue.trim()) return;
  entities.push({
    id: `${kind}:${start}:${end}`,
    kind,
    rawValue,
    displayValue: decodeBasicEntities(rawValue),
    range: { start, end },
    context,
  });
}

function pushEditableEntity(
  entities: EditableEntity[],
  kind: EditableEntityKind,
  rawValue: string,
  start: number,
  end: number,
  context: EditableEntityContext,
) {
  entities.push({
    id: `${kind}:${start}:${end}`,
    kind,
    rawValue,
    displayValue: decodeBasicEntities(rawValue),
    range: { start, end },
    context,
  });
}

function isMediaElementName(name: string): name is "img" | "source" | "video" {
  return name === "img" || name === "source" || name === "video";
}

function isSrcsetElementName(name: ImageTagContext["elementName"]): name is "img" | "source" {
  return name === "img" || name === "source";
}

function pictureIdForStack(stack: OpenElement[]) {
  return stack.findLast((element) => element.name === "picture")?.pictureId;
}

function videoIdForStack(stack: OpenElement[]) {
  return stack.findLast((element) => element.name === "video")?.videoId;
}

function linkRoleForStack(stack: OpenElement[]) {
  return stack.findLast((element) => element.name === "a" && element.linkRole)?.linkRole;
}

function presentationGroupForStack(stack: OpenElement[]) {
  const phraseContainer = stack.findLast((element) =>
    (element.className ?? "")
      .trim()
      .split(/\s+/)
      .some((className) => PHRASE_CONTAINER_CLASS.test(className)),
  );

  if (!phraseContainer || phraseContainer.sourceStart === undefined) return undefined;
  return `${phraseContainer.name}:${phraseContainer.sourceStart}`;
}

function srcsetCandidates(rawValue: string, valueStart: number) {
  const candidates: Array<{
    rawValue: string;
    start: number;
    end: number;
    descriptor: string;
  }> = [];
  let cursor = 0;

  while (cursor < rawValue.length) {
    const comma = rawValue.indexOf(",", cursor);
    const end = comma === -1 ? rawValue.length : comma;
    const candidate = rawValue.slice(cursor, end);
    const leadingWhitespace = candidate.match(/^\s*/)?.[0].length ?? 0;
    const trimmed = candidate.trim();

    if (!trimmed) return [];

    const parts = trimmed.split(/\s+/);
    if (parts.length > 2) return [];

    const url = parts[0];
    const descriptor = parts[1] ?? "";
    if (!url || url.includes(",") || /["'()]/.test(url)) return [];
    if (descriptor && !/^(?:\d+(?:\.\d+)?x|\d+w)$/.test(descriptor)) return [];

    const start = valueStart + cursor + leadingWhitespace;
    candidates.push({
      rawValue: url,
      start,
      end: start + url.length,
      descriptor,
    });

    if (comma === -1) break;
    cursor = comma + 1;
  }

  return candidates;
}

function scanSrcsetAttribute(
  tag: string,
  tagStart: number,
  entities: EditableEntity[],
  imageContext: ImageTagContext,
) {
  const range = firstAttributeValue(tag, tagStart, "srcset");
  if (!range || !isSrcsetElementName(imageContext.elementName)) return;
  const mediaRole =
    imageContext.mediaRole === "video" || imageContext.mediaRole === "image" || imageContext.mediaRole === "video-poster"
      ? imageContext.mediaRole
      : undefined;

  for (const candidate of srcsetCandidates(range.rawValue, range.start)) {
    pushEntity(
      entities,
      "srcset",
      candidate.rawValue,
      candidate.start,
      candidate.end,
      {
        type: "srcset-url",
        descriptor: candidate.descriptor,
        quote: range.quote,
        elementName: imageContext.elementName,
        pictureId: imageContext.pictureId,
        ...(imageContext.mediaGroupId ? { mediaGroupId: imageContext.mediaGroupId } : {}),
        ...(mediaRole ? { mediaRole } : {}),
        media: imageContext.media,
        sourceType: imageContext.sourceType,
      },
    );
  }
}

function isVideoUrl(value: string, sourceType?: string) {
  const trimmed = value.trim();
  if (!trimmed || DATA_URL.test(trimmed)) return false;
  if (sourceType?.split(";")[0].trim().toLowerCase().startsWith("video/")) return true;
  return VIDEO_SOURCE_EXTENSION.test(trimmed);
}

function isVideoSourceContext(imageContext: ImageTagContext) {
  return (
    imageContext.mediaRole === "video" &&
    (imageContext.elementName === "video" || imageContext.elementName === "source")
  );
}

function scanVideoDataSrcAttribute(
  tag: string,
  tagStart: number,
  entities: EditableEntity[],
  imageContext: ImageTagContext,
) {
  if (!isVideoSourceContext(imageContext)) return;

  for (const range of attributeValueRanges(tag, tagStart, "data-src")) {
    if (!isVideoUrl(range.rawValue, imageContext.sourceType)) continue;

    pushEntity(entities, "src", range.rawValue, range.start, range.end, {
      type: "attribute",
      name: "data-src",
      quote: range.quote,
      elementName: imageContext.elementName,
      ...(imageContext.mediaGroupId ? { mediaGroupId: imageContext.mediaGroupId } : {}),
      mediaRole: "video",
      media: imageContext.media,
      sourceType: imageContext.sourceType,
    });
  }
}

function firstSrcsetUrl(rawValue: string) {
  return srcsetCandidates(rawValue, 0)[0]?.rawValue ?? "";
}

function supportsAltEditorForUrl(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (ALT_EXCLUDED_DATA_IMAGE.test(trimmed) || ALT_EXCLUDED_IMAGE_EXTENSION.test(trimmed)) {
    return false;
  }
  return ALT_SUPPORTED_DATA_IMAGE.test(trimmed) || ALT_SUPPORTED_IMAGE_EXTENSION.test(trimmed);
}

function supportsAltEditorForImageTag(tag: string, tagStart: number) {
  const src = firstAttributeValue(tag, tagStart, "src")?.rawValue ?? "";
  if (supportsAltEditorForUrl(src)) return true;
  if (src && !supportsAltEditorForUrl(src)) return false;

  const srcset = firstAttributeValue(tag, tagStart, "srcset")?.rawValue ?? "";
  return supportsAltEditorForUrl(firstSrcsetUrl(srcset));
}

function missingAttributeInsertPoint(tag: string, tagStart: number) {
  const selfClosingMatch = /\/\s*>$/.exec(tag);
  if (selfClosingMatch?.index !== undefined) return tagStart + selfClosingMatch.index;
  return tagStart + tag.length - 1;
}

function scanAltAttribute(
  tag: string,
  tagStart: number,
  entities: EditableEntity[],
  imageContext: ImageTagContext,
) {
  if (imageContext.elementName !== "img") return;
  if (!supportsAltEditorForImageTag(tag, tagStart)) return;

  const alt = firstAttributeValue(tag, tagStart, "alt");
  const context: Extract<EditableEntityContext, { type: "attribute" }> = {
    type: "attribute",
    name: "alt",
    quote: alt?.quote ?? '"',
    elementName: "img",
    pictureId: imageContext.pictureId,
    mediaGroupId: imageContext.mediaGroupId,
    mediaRole: imageContext.mediaRole === "video-poster" ? "video-poster" : "image",
    fallback: imageContext.fallback,
    missing: !alt,
  };

  if (alt) {
    pushEditableEntity(entities, "alt", alt.rawValue, alt.start, alt.end, context);
    return;
  }

  const insertPoint = missingAttributeInsertPoint(tag, tagStart);
  pushEditableEntity(entities, "alt", "", insertPoint, insertPoint, context);
}

function scanBackgroundImageUrls(
  source: string,
  start: number,
  end: number,
  entities: EditableEntity[],
  context: Omit<Extract<EditableEntityContext, { type: "css-url" }>, "quote">,
) {
  const content = source.slice(start, end);
  const pattern =
    /background-image\s*:\s*url\(\s*(?:"([^"]*)"|'([^']*)'|([^)"'\s][^)]*?))\s*\)/gi;

  for (const match of content.matchAll(pattern)) {
    const quotedValue = match[1] ?? match[2];
    const quote = match[1] !== undefined ? '"' : match[2] !== undefined ? "'" : "";
    const rawCandidate = quotedValue ?? match[3];
    if (rawCandidate === undefined) continue;

    const trimmedCandidate = quote ? rawCandidate : rawCandidate.trimEnd();
    if (!trimmedCandidate.trim()) continue;

    const valueOffset = match[0].indexOf(rawCandidate);
    const rangeStart = start + (match.index ?? 0) + valueOffset;
    pushEntity(
      entities,
      "background-image",
      trimmedCandidate,
      rangeStart,
      rangeStart + trimmedCandidate.length,
      {
        ...context,
        quote,
      },
    );
  }
}

function currentEditableElement(stack: OpenElement[]) {
  const element = stack.findLast((item) => !item.skipped);
  if (!element) return null;
  return element;
}

function pushTextBetweenTags(
  source: string,
  start: number,
  end: number,
  stack: OpenElement[],
  entities: EditableEntity[],
) {
  const element = currentEditableElement(stack);
  if (end <= start || !element) return;
  pushEntity(entities, "text", source.slice(start, end), start, end, {
    type: "text",
    tagName: element.name,
    linkRole: linkRoleForStack(stack),
    presentationGroupId: presentationGroupForStack(stack),
  });
}

function closeElement(stack: OpenElement[], name: string) {
  const index = stack.findLastIndex((element) => element.name === name);
  if (index === -1) return;
  stack.splice(index);
}

function isSelfClosingTag(tag: string, name: string) {
  return /\/\s*>$/.test(tag) || /^(area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr)$/i.test(name);
}

function scanEditableAttributes(
  source: string,
  tag: string,
  tagStart: number,
  entities: EditableEntity[],
  imageContext: ImageTagContext,
  linkRole?: LinkRole,
) {
  for (const [attributeName, kind] of Object.entries(EDITABLE_ATTRIBUTES)) {
    for (const range of attributeValueRanges(tag, tagStart, attributeName)) {
      const context: Extract<EditableEntityContext, { type: "attribute" }> = {
        type: "attribute",
        name: kind,
        quote: range.quote,
      };
      if (kind === "src") {
        const dataSrc = firstAttributeValue(tag, tagStart, "data-src");
        if (
          isVideoSourceContext(imageContext) &&
          DATA_URL.test(range.rawValue.trim()) &&
          dataSrc &&
          isVideoUrl(dataSrc.rawValue, imageContext.sourceType)
        ) {
          continue;
        }
        context.elementName = imageContext.elementName;
        context.pictureId = imageContext.pictureId;
        if (imageContext.mediaGroupId) context.mediaGroupId = imageContext.mediaGroupId;
        if (imageContext.mediaRole) context.mediaRole = imageContext.mediaRole;
        context.fallback = imageContext.fallback;
        context.media = imageContext.media;
        context.sourceType = imageContext.sourceType;
      }
      if (kind === "href") {
        context.linkRole = linkRole;
      }
      pushEntity(entities, kind, range.rawValue, range.start, range.end, context);
    }
  }

  scanVideoDataSrcAttribute(tag, tagStart, entities, imageContext);

  if (imageContext.elementName === "video") {
    for (const range of attributeValueRanges(tag, tagStart, "poster")) {
      pushEntity(entities, "poster", range.rawValue, range.start, range.end, {
        type: "attribute",
        name: "poster",
        quote: range.quote,
        elementName: "video",
        mediaGroupId: imageContext.mediaGroupId,
        mediaRole: "video-poster",
      });
    }
  }

  const style = firstAttributeValue(tag, tagStart, "style");
  if (style) {
    scanBackgroundImageUrls(source, style.start, style.end, entities, {
      type: "css-url",
      property: "background-image",
      container: "style-attribute",
      attributeQuote: style.quote,
    });
  }

  scanSrcsetAttribute(tag, tagStart, entities, imageContext);
  scanAltAttribute(tag, tagStart, entities, imageContext);
}

function sourceRangeKey(start: number, end: number) {
  return `${start}:${end}`;
}

type CustomVideoOccurrence = {
  entity: EditableEntity;
  poster?: EditableEntity;
  ancestors: number[];
  boundary: number | undefined;
  trigger: boolean;
  hidden: boolean;
  hiddenOwner: number | undefined;
  elementStart: number;
};

function linkCustomVideoOccurrences(occurrences: CustomVideoOccurrence[]) {
  // A URL alone is not a relationship. Require one visible trigger and one hidden
  // source list directly inside their nearest shared collection. Do not cross
  // independent widget wrappers or section boundaries to find a matching URL.
  for (const source of occurrences.filter(item => item.hidden && !item.trigger)) {
    for (const ancestor of source.ancestors.toReversed()) {
      const local = occurrences.filter(item => item.boundary === source.boundary &&
        item.ancestors.includes(ancestor) && item.entity.displayValue === source.entity.displayValue);
      const triggers = local.filter(item => item.trigger && !item.hidden);
      if (!triggers.length) continue;
      const sourceBranch = source.ancestors[source.ancestors.indexOf(ancestor) + 1] ?? source.elementStart;
      if (sourceBranch !== source.hiddenOwner) break;
      const sources = local.filter(item => item.hidden && !item.trigger);
      if (triggers.length === 1 && sources.length === 1) {
        const trigger = triggers[0].entity;
        if (trigger.context.type === "attribute" && source.entity.context.type === "attribute") {
          source.entity.context.mediaGroupId = trigger.context.mediaGroupId;
          // Only explicit posters on these proven video occurrences share the story.
          if (source.poster?.context.type === "attribute") {
            source.poster.context.mediaGroupId = trigger.context.mediaGroupId;
          }
        }
      }
      break; // Multiple candidates are ambiguous; never search a broader scope.
    }
  }
}

function extractHtmlEditableEntities(source: string) {
  const entities: EditableEntity[] = [];
  const customVideos: CustomVideoOccurrence[] = [];
  const pendingVideoStoryImages: Array<{ imageEntityId: string; triggerTagStart: number }> = [];
  const stack: OpenElement[] = [];
  let cursor = 0;

  while (cursor < source.length) {
    const currentElement = stack.at(-1);
    if (currentElement?.skipped) {
      const closingPattern = new RegExp(`</\\s*${currentElement.name}\\s*>`, "i");
      const closingMatch = closingPattern.exec(source.slice(cursor));
      if (!closingMatch) break;
      const closingStart = cursor + closingMatch.index;
      const closingEnd = closingStart + closingMatch[0].length;
      if (currentElement.name === "style") {
        scanBackgroundImageUrls(
          source,
          currentElement.sourceStart ?? cursor,
          closingStart,
          entities,
          {
            type: "css-url",
            property: "background-image",
            container: "style-block",
          },
        );
      }
      closeElement(stack, currentElement.name);
      cursor = closingEnd;
      continue;
    }

    const tagStart = source.indexOf("<", cursor);
    if (tagStart === -1) {
      pushTextBetweenTags(source, cursor, source.length, stack, entities);
      break;
    }

    pushTextBetweenTags(source, cursor, tagStart, stack, entities);

    if (source.startsWith("<!--", tagStart)) {
      const commentEnd = source.indexOf("-->", tagStart + 4);
      cursor = commentEnd === -1 ? source.length : commentEnd + 3;
      continue;
    }

    const tagEnd = findTagEnd(source, tagStart);
    if (tagEnd === -1) break;

    const tag = source.slice(tagStart, tagEnd + 1);
    const name = readTagName(tag);
    if (!name) {
      cursor = tagEnd + 1;
      continue;
    }

    if (/^<\//.test(tag)) {
      const owner = stack.findLast(element => element.name === name);
      if (owner) mergeCompositeText(source, entities, owner, tagStart);
      closeElement(stack, name);
      cursor = tagEnd + 1;
      continue;
    }

    const pictureId = pictureIdForStack(stack);
    const parentVideoId = videoIdForStack(stack);
    const elementName = isMediaElementName(name) ? name : undefined;
    const videoGroupId = name === "video" ? `video:${tagStart}` : parentVideoId;
    const imgGroupId = name === "img" && !pictureId ? `img:${tagStart}` : undefined;
    const dataVideo = firstAttributeValue(tag, tagStart, "data-video");
    const dataPoster = firstAttributeValue(tag, tagStart, "data-poster");
    const hidden = stack.some(element => element.hidden) || /\shidden(?:\s|=|\/?>)/i.test(tag) ||
      firstAttributeValue(tag, tagStart, "aria-hidden")?.rawValue.toLowerCase() === "true";
    const dataVideoTrigger = dataVideo?.rawValue.trim() &&
      (name === "button" || name === "a" || firstAttributeValue(tag, tagStart, "role")?.rawValue === "button");
    const storyTriggerAncestors = stack.filter(element => element.videoStoryTrigger);
    const imageContext: ImageTagContext = {
      elementName,
      pictureId,
      mediaGroupId: name === "img" || (name === "source" && pictureId)
        ? pictureId ?? imgGroupId
        : videoGroupId,
      mediaRole: name === "img" || (name === "source" && pictureId)
        ? "image"
        : name === "video" || parentVideoId ? "video" : undefined,
      fallback: elementName === "img" ? Boolean(pictureId) : undefined,
      media: firstAttributeValue(tag, tagStart, "media")?.rawValue,
      sourceType: firstAttributeValue(tag, tagStart, "type")?.rawValue,
    };
    const linkRole = name === "a" ? linkRoleForAnchor(tag, tagStart) : undefined;

    if (name !== "svg") {
      scanEditableAttributes(source, tag, tagStart, entities, imageContext, linkRole);
      if (name === "img" && !hidden && storyTriggerAncestors.length === 1) {
        const triggerTagStart = stack.findLast(element => element.videoStoryTrigger)?.tagStart;
        if (triggerTagStart !== undefined) {
          for (const image of entities.slice().reverse()) {
            if (image.range.start < tagStart) break;
            if (image.context.type === "attribute" && image.context.name === "src" && image.context.mediaRole === "image") {
              pendingVideoStoryImages.push({ imageEntityId: image.id, triggerTagStart });
            }
          }
        }
      }
      if (dataVideo?.rawValue.trim()) {
        pushEntity(entities, "src", dataVideo.rawValue, dataVideo.start, dataVideo.end, {
          type: "attribute", name: "data-video", quote: dataVideo.quote,
          mediaRole: "video", mediaGroupId: `custom-video:${tagStart}`,
        });
        customVideos.push({
          entity: entities.at(-1)!,
          ancestors: [-1, ...stack.map(element => element.tagStart!)],
          boundary: stack.findLast(element => /^(section|article|dialog)$/.test(element.name))?.tagStart,
          trigger: name === "button" || name === "a" || firstAttributeValue(tag, tagStart, "role")?.rawValue === "button",
          hidden,
          hiddenOwner: stack.find(element => element.hidden)?.tagStart ?? (hidden ? tagStart : undefined),
          elementStart: tagStart,
        });
      }
      if (dataPoster?.rawValue.trim()) {
        pushEntity(entities, "poster", dataPoster.rawValue, dataPoster.start, dataPoster.end, {
          type: "attribute", name: "data-poster", quote: dataPoster.quote, mediaRole: "video-poster",
          mediaGroupId: dataVideo?.rawValue.trim() ? `custom-video:${tagStart}` : undefined,
        });
        const occurrence = customVideos.at(-1);
        if (occurrence?.elementStart === tagStart) occurrence.poster = entities.at(-1);
      }
    }

    if (!isSelfClosingTag(tag, name)) {
      stack.push({
        name,
        editable: !SKIPPED_RAW_TEXT_ELEMENTS.has(name),
        skipped: SKIPPED_RAW_TEXT_ELEMENTS.has(name),
        sourceStart: tagEnd + 1,
        tagStart,
        className: classAttributeValue(tag, tagStart),
        pictureId: name === "picture" ? `picture:${tagStart}` : undefined,
        videoId: name === "video" ? videoGroupId : undefined,
        hidden,
        linkRole,
        videoStoryTrigger: Boolean(dataVideoTrigger && !hidden),
      });
    }

    cursor = tagEnd + 1;
  }

  linkCustomVideoOccurrences(customVideos);
  const triggerByTagStart = new Map(customVideos.filter(item => item.trigger && !item.hidden)
    .map(item => [item.elementStart, item.entity]));
  const videoStoryByImageEntityId = new Map<string, string>();
  for (const relation of pendingVideoStoryImages) {
    const videoEntity = triggerByTagStart.get(relation.triggerTagStart);
    if (videoEntity) videoStoryByImageEntityId.set(relation.imageEntityId, videoEntity.id);
  }
  return { entities, videoStoryByImageEntityId };
}

export function extractEditableEntitiesWithVideoStories(source: string) {
  const { entities, videoStoryByImageEntityId } = extractHtmlEditableEntities(source);
  const allEntities = [...entities, ...extractStaticJsWidgetEntities(source)]
    .sort((left, right) => left.range.start - right.range.start);
  return { entities: allEntities, videoStoryByImageEntityId };
}

function mappedSourceRange(
  map: Array<number | null>,
  start: number,
  end: number,
) {
  const mappedPositions = map.slice(start, end);
  if (mappedPositions.some((position) => position === null)) return null;

  const sourcePositions = mappedPositions as number[];
  const sourceStart = sourcePositions[0];
  const sourceEnd = sourcePositions.at(-1)! + 1;
  if (sourceEnd - sourceStart !== sourcePositions.length) return null;
  return { start: sourceStart, end: sourceEnd };
}

function jsContextForEntity(
  source: string,
  entity: EditableEntity,
  mappedRange: { start: number; end: number },
  presentationGroupId?: string,
): EditableEntityContext | null {
  if (entity.context.type === "text") {
    return {
      ...entity.context,
      source: "js-template",
      presentationGroupId,
    };
  }

  if (entity.context.type === "attribute" && entity.kind === "src") {
    const jsQuote = source[mappedRange.start - 1];
    if (jsQuote !== '"' && jsQuote !== "'") return null;

    return {
      ...entity.context,
      quote: jsQuote,
      source: "js-constant",
    };
  }

  return null;
}

function extractStaticJsWidgetEntities(source: string) {
  const entities: EditableEntity[] = [];

  for (const widget of renderStaticJsWidgets(source)) {
    const widgetSourceStart = widget.map.find((position) => position !== null) ?? 0;
    const htmlEntities = extractHtmlEditableEntities(widget.html).entities;

    for (const entity of htmlEntities) {
      const mappedRange = mappedSourceRange(widget.map, entity.range.start, entity.range.end);
      const presentationGroupId =
        entity.context.type === "text" && entity.context.presentationGroupId
          ? `js-template:${widgetSourceStart}:${entity.context.presentationGroupId}`
          : undefined;
      const context = mappedRange
        ? jsContextForEntity(source, entity, mappedRange, presentationGroupId)
        : null;
      if (!mappedRange || !context) continue;

      let composite: EditableEntity["composite"];
      if (entity.composite) {
        const ownerTag = mappedSourceRange(widget.map, entity.composite.ownerTag.start, entity.composite.ownerTag.end);
        const segments = entity.composite.segments.map(segment => ({ ...segment, range: mappedSourceRange(widget.map, segment.range.start, segment.range.end) }));
        if (!ownerTag || segments.some(segment => !segment.range)) continue;
        composite = { ownerTag, segments: segments.map(segment => ({ ...segment, range: segment.range! })) };
      }

      entities.push({
        ...entity,
        id: `${entity.kind}:${sourceRangeKey(mappedRange.start, mappedRange.end)}`,
        rawValue: source.slice(mappedRange.start, mappedRange.end),
        displayValue: entity.displayValue,
        range: mappedRange,
        context,
        composite,
      });
    }
  }

  return entities;
}

export function extractEditableEntities(source: string) {
  return extractEditableEntitiesWithVideoStories(source).entities;
}
