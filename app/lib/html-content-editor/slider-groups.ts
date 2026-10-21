import type { EditableEntity, SourceRange } from "./types";

export type SlideGroup = SourceRange & {
  id: string;
  index: number;
  entityIds: string[];
  label?: string;
};

export type SliderGroup = SourceRange & {
  id: string;
  title: string;
  pattern: string;
  rootRange: SourceRange;
  viewportRange: SourceRange | null;
  trackRange: SourceRange;
  slideEntityIds: string[];
  controlEntityIds: string[];
  slides: SlideGroup[];
  parentSliderId?: string;
  parentSlideId?: string;
  mediaOnly?: boolean;
};

type ElementNode = SourceRange & {
  id: string;
  tagName: string;
  parentId: string;
  openTag: string;
  className: string;
  dataSlide?: string;
  hasDataGoTo: boolean;
  ariaHidden?: string;
  ariaLabel?: string;
  childIds: string[];
};

type OpenNode = Omit<ElementNode, "end">;

const VOID_ELEMENTS = /^(area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr)$/i;
const KNOWN_SLIDE_CLASS =
  /(?:^|\s)(?:swiper-slide|slick-slide|splide__slide|carousel-cell|carousel-slide|slider-slide|carousel-item)(?:\s|$)/i;
const TRACK_CLASS = /(?:^|[-_:])(track|slides|wrapper|list)(?:$|[-_:])/i;
const VIEWPORT_CLASS = /(?:^|[-_:])(viewport|window|mask)(?:$|[-_:])/i;
const SLIDES_CONTAINER_CLASS = /(?:^|[-_:])(slides|slider|carousel|swiper|slick|splide)(?:$|[-_:])/i;
const ACTIVE_STATE_CLASS = /^(?:active|is-active|current|is-current|selected|is-selected)$/i;
const CONTROL_CLASS =
  /(?:^|[-_:])(nav|navigation|pagination|pager|dot|dots|bullet|arrow|prev|previous|next|control|controls|counter|number|progress)(?:$|[-_:])/i;
const TECHNICAL_ARIA_LABEL =
  /(?:^|\s)(?:prev|previous|next|slide|pagination|go to|предыдущий|следующий|впер[её]д|назад|слайд)(?:\s|$)/i;

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

function firstAttributeValue(tag: string, attributeName: string) {
  const pattern = /([^\s"'<>/=]+)\s*=\s*("([^"]*)"|'([^']*)'|[^\s"'=<>`]+)/g;

  for (const match of tag.matchAll(pattern)) {
    if (match[1].toLowerCase() !== attributeName) continue;
    return match[3] ?? match[4] ?? match[2] ?? "";
  }

  return "";
}

function isSelfClosingTag(tag: string, name: string) {
  return /\/\s*>$/.test(tag) || VOID_ELEMENTS.test(name);
}

function collectElementNodes(source: string) {
  const nodes = new Map<string, ElementNode>();
  const childrenByParent = new Map<string, string[]>();
  const stack: OpenNode[] = [];
  let cursor = 0;

  while (cursor < source.length) {
    const tagStart = source.indexOf("<", cursor);
    if (tagStart === -1) break;

    if (source.startsWith("<!--", tagStart)) {
      const commentEnd = source.indexOf("-->", tagStart + 4);
      cursor = commentEnd === -1 ? source.length : commentEnd + 3;
      continue;
    }

    const tagEnd = findTagEnd(source, tagStart);
    if (tagEnd === -1) break;

    const tag = source.slice(tagStart, tagEnd + 1);
    const tagName = readTagName(tag);
    if (!tagName) {
      cursor = tagEnd + 1;
      continue;
    }

    if (/^<\//.test(tag)) {
      const stackIndex = stack.findLastIndex((node) => node.tagName === tagName);
      if (stackIndex !== -1) {
        const closed = stack.splice(stackIndex)[0];
        nodes.set(closed.id, {
          ...closed,
          end: tagEnd + 1,
          childIds: childrenByParent.get(closed.id) ?? [],
        });
      }
      cursor = tagEnd + 1;
      continue;
    }

    const parentId = stack.at(-1)?.id ?? "root";
    const id = `${tagName}:${tagStart}`;
    childrenByParent.set(parentId, [...(childrenByParent.get(parentId) ?? []), id]);

    const node: OpenNode = {
      id,
      tagName,
      parentId,
      start: tagStart,
      openTag: tag,
      className: firstAttributeValue(tag, "class"),
      dataSlide: firstAttributeValue(tag, "data-slide") || undefined,
      hasDataGoTo: /(?:^|\s)data-go-to(?:\s|=|>)/i.test(tag),
      ariaHidden: firstAttributeValue(tag, "aria-hidden") || undefined,
      ariaLabel: firstAttributeValue(tag, "aria-label") || undefined,
      childIds: childrenByParent.get(id) ?? [],
    };

    if (isSelfClosingTag(tag, tagName)) {
      nodes.set(id, {
        ...node,
        end: tagEnd + 1,
        childIds: [],
      });
    } else {
      stack.push(node);
    }

    cursor = tagEnd + 1;
    // Raw text can contain HTML-looking strings; it is not slider structure.
    if (/^(script|style|textarea|title)$/i.test(tagName)) {
      const close = new RegExp(`</${tagName}\\s*>`, "ig");
      close.lastIndex = cursor;
      const match = close.exec(source);
      cursor = match?.index ?? source.length;
    }
  }

  return { nodes, childrenByParent };
}

function hasKnownSlideSignal(node: ElementNode) {
  return KNOWN_SLIDE_CLASS.test(node.className);
}

function hasTrackSignal(node?: ElementNode) {
  return Boolean(node && classList(node).some((name) => TRACK_CLASS.test(name)));
}

function hasSlidesContainerSignal(node?: ElementNode) {
  return Boolean(
    node &&
      node.className
        .trim()
        .split(/\s+/)
        .some((className) => SLIDES_CONTAINER_CLASS.test(className)),
  );
}

function hasRepeatedSiblingStructure(run: ElementNode[], nodes: Map<string, ElementNode>) {
  const first = run[0];
  if (!first || !run.every((node) => node.tagName === first.tagName)) return false;
  const sharedClass = classList(first).some(
    (name) => !ACTIVE_STATE_CLASS.test(name) && run.every((node) => classList(node).includes(name)),
  );
  const childRoles = (node: ElementNode) => node.childIds
    .map((id) => nodes.get(id)?.tagName ?? "")
    .filter((name) => name && !/^(style|script)$/.test(name))
    .map((name) => /^h[1-6]$/.test(name) ? "heading" : name)
    .join(",");
  const signature = childRoles(first);
  return sharedClass || Boolean(signature && run.every((node) => childRoles(node) === signature));
}

function hasActiveStateSignal(node: ElementNode) {
  return (
    node.ariaHidden !== undefined ||
    node.className
      .trim()
      .split(/\s+/)
      .some((className) => ACTIVE_STATE_CLASS.test(className))
  );
}

function hasDistinctDataSlideValues(run: ElementNode[]) {
  const values = run.map((node) => node.dataSlide).filter((value): value is string => value !== undefined);
  return values.length === run.length && new Set(values).size === values.length;
}

function sliderPattern(slide: ElementNode, track?: ElementNode, container?: ElementNode) {
  const className = `${slide.className} ${track?.className ?? ""} ${container?.className ?? ""}`;
  if (/swiper/i.test(className)) return "Swiper";
  if (/slick/i.test(className)) return "Slick";
  if (/splide/i.test(className)) return "Splide";
  if (/carousel/i.test(className)) return "Carousel";
  return "Slider";
}

function entityIdsInside(range: SourceRange, entities: EditableEntity[]) {
  return entities
    .filter((entity) => entity.range.start >= range.start && entity.range.end <= range.end)
    .map((entity) => entity.id);
}

function classList(node: ElementNode) {
  return node.className.trim().split(/\s+/).filter(Boolean);
}

function hasControlClassSignal(node: ElementNode) {
  return classList(node).some((className) => CONTROL_CLASS.test(className));
}

function hasControlAttributeSignal(node: ElementNode) {
  return (
    node.hasDataGoTo ||
    Boolean(node.ariaLabel && TECHNICAL_ARIA_LABEL.test(node.ariaLabel))
  );
}

function isSliderControlNode(node: ElementNode) {
  return hasControlClassSignal(node) || hasControlAttributeSignal(node);
}

function rangeContains(container: SourceRange, child: SourceRange) {
  return container.start <= child.start && container.end >= child.end;
}

function isInsideAnyRange(range: SourceRange, candidates: SourceRange[]) {
  return candidates.some((candidate) => rangeContains(candidate, range));
}

function controlEntityIdsInside(
  container: SourceRange,
  slides: SourceRange[],
  nodes: Map<string, ElementNode>,
  entities: EditableEntity[],
) {
  const controlNodes = [...nodes.values()].filter(
    (node) =>
      rangeContains(container, node) &&
      !slides.some(slide => rangeContains(node, slide)) &&
      (!isInsideAnyRange(node, slides) || hasControlAttributeSignal(node)) &&
      isSliderControlNode(node),
  );

  if (controlNodes.length === 0) return [];

  return entities
    .filter(
      (entity) =>
        rangeContains(container, entity.range) &&
        isInsideAnyRange(entity.range, controlNodes),
    )
    .map((entity) => entity.id);
}

function ancestorsThroughBoundary(track: ElementNode, nodes: Map<string, ElementNode>) {
  const ancestors: ElementNode[] = [];
  let current: ElementNode | undefined = track;
  while (current && !/^(body|html|main)$/.test(current.tagName)) {
    ancestors.push(current);
    if (/^(section|article)$/.test(current.tagName)) break;
    current = nodes.get(current.parentId);
  }
  return ancestors;
}

function resolveStructure(run: ElementNode[], track: ElementNode, nodes: Map<string, ElementNode>) {
  if (run.length < 2 || !hasRepeatedSiblingStructure(run, nodes)) return null;
  const ancestors = ancestorsThroughBoundary(track, nodes);
  const controls = [...nodes.values()].filter((node) =>
    isSliderControlNode(node) && !isInsideAnyRange(node, run) &&
    !run.some((slide) => rangeContains(node, slide)),
  );
  const controlRoot = ancestors.find((ancestor) => controls.some((node) => rangeContains(ancestor, node)));
  const namedRoot = ancestors.find((ancestor) => ancestor !== track && hasSlidesContainerSignal(ancestor));
  const container = controlRoot ?? namedRoot ?? track;
  const viewport = ancestors.find((node) =>
    classList(node).some((name) => VIEWPORT_CLASS.test(name)) ||
    /overflow(?:-x)?\s*:\s*(auto|scroll)\b/i.test(firstAttributeValue(node.openTag, "style")),
  );
  const knownSlides = run.every(hasKnownSlideSignal);
  const indexedSlides = hasDistinctDataSlideValues(run);
  const namedTrack = hasSlidesContainerSignal(track);
  const activeSignal = run.some(hasActiveStateSignal);
  const singleActive = run.filter(node => classList(node).some(name => ACTIVE_STATE_CLASS.test(name))).length === 1 ||
    (run.filter(node => node.ariaHidden === "false").length === 1 && run.some(node => node.ariaHidden === "true"));
  const supported = knownSlides ||
    (singleActive && Boolean(controlRoot)) ||
    (indexedSlides && (activeSignal || namedTrack || Boolean(namedRoot))) ||
    (namedTrack && (hasTrackSignal(track) || Boolean(controlRoot))) ||
    (hasTrackSignal(track) && (Boolean(namedRoot) || (Boolean(viewport) && Boolean(controlRoot))));
  if (!supported) return null;
  return {
    container,
    viewport: viewport ?? (indexedSlides && activeSignal ? null : namedTrack && !hasTrackSignal(track) ? track : container),
  };
}

function toSliderGroup(
  run: ElementNode[],
  track: ElementNode,
  nodes: Map<string, ElementNode>,
  entities: EditableEntity[],
  structure: NonNullable<ReturnType<typeof resolveStructure>>,
) {
  const { container, viewport } = structure;
  const pattern = sliderPattern(run[0], track, container);
  const controlEntityIds = controlEntityIdsInside(container, run, nodes, entities);
  const controls = new Set(controlEntityIds);
  const slides = run.map((slide, index) => ({
    id: `slide:${slide.id}`,
    index,
    start: slide.start,
    end: slide.end,
    entityIds: entityIdsInside(slide, entities).filter(id => !controls.has(id)),
  }));
  const slideEntityIds = slides.flatMap((slide) => slide.entityIds);

  return {
    id: `slider:${track.id}:${run[0].start}`,
    title: pattern,
    pattern,
    start: container.start,
    end: container.end,
    rootRange: { start: container.start, end: container.end },
    viewportRange: viewport ? { start: viewport.start, end: viewport.end } : null,
    trackRange: {
      start: track.start,
      end: track.end,
    },
    slideEntityIds,
    controlEntityIds,
    slides,
  } satisfies SliderGroup;
}

export function detectSliderGroups(source: string, entities: EditableEntity[]) {
  const { nodes, childrenByParent } = collectElementNodes(source);
  const groups: SliderGroup[] = [];

  for (const [parentId, childIds] of childrenByParent.entries()) {
    const track = nodes.get(parentId);
    if (!track) continue;

    let run: ElementNode[] = [];
    const flush = () => {
      const structure = resolveStructure(run, track, nodes);
      if (structure && run.some((slide) => entityIdsInside(slide, entities).length > 0)) {
        groups.push(toSliderGroup(run, track, nodes, entities, structure));
      }
      run = [];
    };
    for (const childId of childIds) {
      const node = nodes.get(childId);
      const isSlide = Boolean(node && !isSliderControlNode(node) &&
        !/^(script|style|nav|button|header|footer)$/.test(node.tagName) &&
        (node.childIds.length > 0 || /^(img|video)$/.test(node.tagName)));

      if (node && isSlide) {
        if (run.length && node.tagName !== run[0].tagName) flush();
        run.push(node);
        continue;
      }

      flush();
    }

    flush();
  }

  groups.sort((left, right) => left.start - right.start || right.end - left.end);
  const controls = new Set(groups.flatMap(group => group.controlEntityIds));
  for (const group of groups) {
    const parent = groups.flatMap(candidate => candidate === group ? [] : candidate.slides
      .filter(slide => rangeContains(slide, group.rootRange))
      .map(slide => ({ group: candidate, slide })))
      .sort((a, b) => (a.slide.end - a.slide.start) - (b.slide.end - b.slide.start))[0];
    if (parent) {
      group.parentSliderId = parent.group.id;
      group.parentSlideId = parent.slide.id;
    }
    for (const slide of group.slides) {
      slide.entityIds = slide.entityIds.filter(id => !controls.has(id) && !groups.some(child =>
        child !== group && rangeContains(slide, child.rootRange) && child.slideEntityIds.includes(id)));
      const heading = entities.find(entity => slide.entityIds.includes(entity.id) &&
        entity.context.type === "text" && /^h[1-6]$/.test(entity.context.tagName));
      slide.label = heading?.displayValue.trim().replace(/\s+/g, " ") || undefined;
    }
    group.slideEntityIds = group.slides.flatMap(slide => slide.entityIds);
    group.mediaOnly = group.slides.every(slide => /^(img|picture|video)$/.test(
      source.slice(slide.start).match(/^<([\w-]+)/)?.[1] ?? ""));
  }
  return groups;
}

export function sliderActivationPath(groups: SliderGroup[], sliderId: string, slideIndex: number) {
  const path: Array<{ sliderId: string; slide: SlideGroup }> = [];
  const visited = new Set<string>();
  let group = groups.find(candidate => candidate.id === sliderId);
  let slide = group?.slides[slideIndex];
  while (group && slide && !visited.has(group.id)) {
    visited.add(group.id);
    path.unshift({ sliderId: group.id, slide });
    const parentSlideId = group.parentSlideId;
    group = groups.find(candidate => candidate.id === group?.parentSliderId);
    slide = group?.slides.find(candidate => candidate.id === parentSlideId);
  }
  return path;
}
