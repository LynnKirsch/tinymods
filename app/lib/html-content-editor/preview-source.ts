import type { EditableEntity } from "./types";
import type { SliderGroup } from "./slider-groups";
import {
  addStaticWidgetPreviewState,
  buildStaticJsPreviewSource,
  renderStaticJsWidgets,
} from "./js-static-widgets.js";

export type PreviewEntityMarker = {
  entityId: string;
  previewId: string;
};

export type PreviewSource = {
  source: string;
  markers: PreviewEntityMarker[];
};

export type PreviewSourceOptions = {
  appearanceCss?: string;
  sliderGroups?: SliderGroup[];
  live?: boolean;
  namespace?: string;
};

const DATA_ATTRIBUTE = "data-tinymods-preview-ids";
const PREVIEW_STYLE = `<style data-tinymods-preview-style>
[data-tinymods-preview-ids] {
  cursor: pointer;
}
.tinymods-preview-active {
  outline: 3px solid #238fbc !important;
  outline-offset: 4px !important;
  box-shadow: 0 0 0 7px rgba(35, 143, 188, .16) !important;
}
.tinymods-preview-content-visible {
  opacity: 1 !important;
  visibility: visible !important;
  transform: none !important;
  animation: none !important;
  transition: none !important;
}
</style>`;

function appearanceStyle(css?: string) {
  const trimmed = css?.trim();
  if (!trimmed) return "";
  return `<style data-tinymods-appearance-style>\n${trimmed}\n</style>`;
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

function markerIdForIndex(index: number) {
  return `tm-${index + 1}`;
}

function attributeOwnerInsertionPoint(
  source: string,
  range: { start: number; end: number },
) {
  const tagStart = source.lastIndexOf("<", range.start);
  if (tagStart === -1) return null;
  const tagEnd = findTagEnd(source, tagStart);
  if (tagEnd === -1 || tagEnd < range.end) return null;
  if (source[tagStart + 1] === "/") return null;
  return tagEnd;
}

export function buildPreviewSource(
  source: string,
  entities: EditableEntity[],
  options: PreviewSourceOptions = {},
): PreviewSource {
  const textOwners = entities.filter(entity => entity.composite).map(entity => ({ id: `text-owner:${entity.id}`, range: entity.composite!.ownerTag }));
  const sliderOwners = (options.sliderGroups ?? []).flatMap((group) => [
    { attribute: "data-tinymods-slider-root", value: group.id, range: group.rootRange },
    ...(group.parentSlideId ? [{ attribute: "data-tinymods-slider-parent-slide", value: group.parentSlideId, range: group.rootRange }] : []),
    { attribute: "data-tinymods-slider-track", value: group.id, range: group.trackRange },
    ...(group.viewportRange ? [{ attribute: "data-tinymods-slider-viewport", value: group.id, range: group.viewportRange }] : []),
    ...group.slides.map((slide) => ({ attribute: "data-tinymods-slider-slide", value: slide.id, range: slide })),
  ]).map((owner, index) => ({
    ...owner,
    id: `slider-owner-${index}`,
    range: { start: owner.range.start, end: findTagEnd(source, owner.range.start) + 1 },
  }));
  // Map opening tags through static-widget rendering just like content ranges.
  const previewBase = options.live ? {
    source,
    hasStaticWidget: false,
    rangesBySourceRange: new Map([...entities, ...sliderOwners, ...textOwners].map(entity => [entity.id, entity.range])),
  } : buildStaticJsPreviewSource(source, [...entities, ...sliderOwners, ...textOwners]);
  const markers = entities.map((entity, index) => ({
    entityId: entity.id,
    previewId: `${options.namespace ? `${options.namespace}-` : ""}${markerIdForIndex(index)}`,
  }));
  const markerByEntityId = new Map(markers.map((marker) => [marker.entityId, marker.previewId]));
  const insertions: Array<{ index: number; value: string }> = [];
  const attributeMarkers = new Map<number, string[]>();
  const liveTemplates = options.live ? renderStaticJsWidgets(source) : [];

  for (const owner of sliderOwners) {
    const range = previewBase.rangesBySourceRange.get(owner.id);
    if (!range) continue;
    insertions.push({ index: range.end - 1, value: ` ${owner.attribute}="${owner.value}"` });
  }

  for (const entity of entities) {
    const previewId = markerByEntityId.get(entity.id);
    if (!previewId) continue;
    const range = previewBase.rangesBySourceRange.get(entity.id) ?? entity.range;

    // Constants live outside HTML. Map the generated image's opening tag back to its
    // literal template location; never insert HTML attributes into the JS constant.
    if (options.live && entity.context.type === "attribute" && entity.context.source === "js-constant") {
      for (const template of liveTemplates) {
        const valueStart = template.map.indexOf(entity.range.start);
        if (valueStart < 0) continue;
        const tagStart = template.html.lastIndexOf("<", valueStart);
        const tagEnd = tagStart >= 0 ? findTagEnd(template.html, tagStart) : -1;
        const mappedEnd = tagEnd >= 0 ? template.map[tagEnd] : null;
        if (mappedEnd === null || mappedEnd === undefined) continue;
        const list = attributeMarkers.get(mappedEnd) ?? [];
        list.push(previewId);
        attributeMarkers.set(mappedEnd, list);
      }
      continue;
    }

    if (entity.kind === "text") {
      if (entity.composite) {
        const owner = previewBase.rangesBySourceRange.get(`text-owner:${entity.id}`);
        if (owner) {
          const point = owner.end - 1;
          attributeMarkers.set(point, [...(attributeMarkers.get(point) ?? []), previewId]);
        }
        continue;
      }
      if (range.start === range.end) {
        insertions.push({ index: range.start, value: `<!--tinymods-preview-start:${previewId}--><!--tinymods-preview-end:${previewId}-->` });
        continue;
      }
      insertions.push({
        index: range.start,
        value: `<!--tinymods-preview-start:${previewId}-->`,
      });
      insertions.push({
        index: range.end,
        value: `<!--tinymods-preview-end:${previewId}-->`,
      });
      continue;
    }

    const insertionPoint = attributeOwnerInsertionPoint(previewBase.source, range);
    if (insertionPoint === null) continue;
    const markerList = attributeMarkers.get(insertionPoint) ?? [];
    markerList.push(previewId);
    attributeMarkers.set(insertionPoint, markerList);
  }

  for (const [index, markerIds] of attributeMarkers.entries()) {
    insertions.push({
      index,
      value: ` ${DATA_ATTRIBUTE}="${markerIds.join(" ")}"`,
    });
  }

  let previewSource = previewBase.source;
  for (const insertion of insertions.sort((left, right) => right.index - left.index)) {
    previewSource =
      previewSource.slice(0, insertion.index) +
      insertion.value +
      previewSource.slice(insertion.index);
  }

  const sourceWithStaticWidgetState = previewBase.hasStaticWidget
    ? addStaticWidgetPreviewState(previewSource)
    : previewSource;

  return {
    source: options.live ? sourceWithStaticWidgetState : `${PREVIEW_STYLE}${appearanceStyle(options.appearanceCss)}${sourceWithStaticWidgetState}`,
    markers,
  };
}
