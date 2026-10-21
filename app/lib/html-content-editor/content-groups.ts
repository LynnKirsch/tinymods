import type { EditableEntity } from "./types";
import type { AccordionGroup } from "./accordion-groups";

type ElementNode = {
  id: string;
  tagName: string;
  className: string;
  start: number;
  openEnd: number;
  end: number;
  parentId: string;
};

type OpenNode = Omit<ElementNode, "end">;

export type TextContentGroup = {
  id: string;
  kind: "text";
  label: string;
  entities: EditableEntity[];
};

export type LinkContentGroup = {
  id: string;
  kind: "link";
  label: string;
  entities: EditableEntity[];
  textEntities: EditableEntity[];
  hrefEntity: EditableEntity;
};

export type ContentGroup = TextContentGroup | LinkContentGroup;

export type AccordionContentItem = {
  id: string;
  kind: "custom" | "details";
  itemRange: { start: number; end: number };
  sourceStart: number;
  questionEntityIds: string[];
  answerEntityIds: string[];
  ownedEntityIds: string[];
  questionGroups: ContentGroup[];
  answerGroups: ContentGroup[];
};

const TEXT_OWNER_TAGS = new Set([
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "p",
  "a",
  "button",
  "li",
  "span",
]);
const INLINE_TEXT_TAGS = new Set(["span"]);
const VOID_ELEMENTS = /^(area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr)$/i;
const PHRASE_CONTAINER_CLASS =
  /(?:^|[-_:])(text|copy|message|title|headline|heading|caption|label)(?:$|[-_:])/i;

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
  const nodes: ElementNode[] = [];
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
        nodes.push({ ...closed, end: tagEnd + 1 });
      }
      cursor = tagEnd + 1;
      continue;
    }

    const node: OpenNode = {
      id: `${tagName}:${tagStart}`,
      tagName,
      className: firstAttributeValue(tag, "class"),
      start: tagStart,
      openEnd: tagEnd + 1,
      parentId: stack.at(-1)?.id ?? "root",
    };

    if (isSelfClosingTag(tag, tagName)) {
      nodes.push({ ...node, end: tagEnd + 1 });
    } else {
      stack.push(node);
    }

    cursor = tagEnd + 1;
  }

  return nodes;
}

function nodesContainingEntity(nodes: ElementNode[], entity: EditableEntity) {
  return nodes
    .filter((node) => node.start <= entity.range.start && node.end >= entity.range.end)
    .sort((left, right) => left.start - right.start);
}

function ownerNodeForText(nodes: ElementNode[], entity: EditableEntity) {
  const containing = nodesContainingEntity(nodes, entity);
  const phraseContainer = containing.findLast((node) =>
    node.className
      .trim()
      .split(/\s+/)
      .some((className) => PHRASE_CONTAINER_CLASS.test(className)),
  );
  if (phraseContainer) return phraseContainer;

  const eligible = containing.filter((node) => TEXT_OWNER_TAGS.has(node.tagName));
  const blockOwner = eligible.findLast((node) => !INLINE_TEXT_TAGS.has(node.tagName));
  return blockOwner ?? eligible.at(-1) ?? null;
}

function anchorNodeForHref(nodes: ElementNode[], entity: EditableEntity) {
  return nodes.find(
    (node) =>
      node.tagName === "a" &&
      node.start <= entity.range.start &&
      node.openEnd >= entity.range.end,
  );
}

function anchorNodeForText(nodes: ElementNode[], entity: EditableEntity) {
  return nodesContainingEntity(nodes, entity).findLast((node) => node.tagName === "a") ?? null;
}

function textLabel(tagName: string) {
  if (/^h[1-6]$/.test(tagName)) return "Заголовок";
  if (tagName === "li") return "Пункт";
  if (tagName === "button") return "Кнопка";
  if (tagName === "a") return "Текст ссылки";
  return "Текст";
}

function linkLabel(entity: EditableEntity) {
  if (entity.context.type === "attribute" && entity.context.linkRole === "button") {
    return "Кнопка";
  }
  if (entity.context.type === "attribute" && entity.context.linkRole === "card") {
    return "Ссылка карточки";
  }
  return "Ссылка";
}

function groupStart(group: ContentGroup) {
  return Math.min(...group.entities.map((entity) => entity.range.start));
}

export function buildContentGroups(
  source: string,
  entities: EditableEntity[],
  excludedEntityIds = new Set<string>(),
) {
  const nodes = collectElementNodes(source);
  const groups: ContentGroup[] = [];
  const consumed = new Set<string>(excludedEntityIds);
  const hrefEntities = entities.filter(
    (entity) => entity.kind === "href" && !consumed.has(entity.id),
  );

  for (const hrefEntity of hrefEntities) {
    const anchor = anchorNodeForHref(nodes, hrefEntity);
    if (!anchor) continue;

    const textEntities = entities.filter((entity) => {
      if (entity.kind !== "text" || consumed.has(entity.id)) return false;
      const textAnchor = anchorNodeForText(nodes, entity);
      return textAnchor?.id === anchor.id;
    });

    const groupEntities = [...textEntities, hrefEntity].sort(
      (left, right) => left.range.start - right.range.start,
    );
    for (const entity of groupEntities) consumed.add(entity.id);

    groups.push({
      id: `content:${anchor.id}`,
      kind: "link",
      label: linkLabel(hrefEntity),
      entities: groupEntities,
      textEntities,
      hrefEntity,
    });
  }

  const textBuckets = new Map<string, { node: ElementNode; entities: EditableEntity[] }>();
  for (const entity of entities) {
    if (entity.kind !== "text" || consumed.has(entity.id)) continue;
    const presentationGroupId =
      entity.context.type === "text" ? entity.context.presentationGroupId : undefined;
    const owner = presentationGroupId ? null : ownerNodeForText(nodes, entity);
    const fallbackNode = {
      id: presentationGroupId ?? entity.id,
      tagName: entity.context.type === "text" ? entity.context.tagName : "text",
      className: "",
      start: entity.range.start,
      openEnd: entity.range.start,
      end: entity.range.end,
      parentId: "source",
    };
    const bucketId = presentationGroupId ? `presentation:${presentationGroupId}` : owner?.id ?? entity.id;
    const bucket = textBuckets.get(bucketId) ?? {
      node: owner ?? fallbackNode,
      entities: [],
    };
    bucket.entities.push(entity);
    textBuckets.set(bucketId, bucket);
    consumed.add(entity.id);
  }

  for (const bucket of textBuckets.values()) {
    bucket.entities.sort((left, right) => left.range.start - right.range.start);
    groups.push({
      id: `content:${bucket.node.id}`,
      kind: "text",
      label: textLabel(bucket.node.tagName),
      entities: bucket.entities,
    });
  }

  return groups.sort((left, right) => groupStart(left) - groupStart(right));
}

function entitiesByIds(entities: EditableEntity[], ids: string[]) {
  const wanted = new Set(ids);
  return entities
    .filter(entity => wanted.has(entity.id))
    .sort((left, right) => left.range.start - right.range.start);
}

function accordionContentItem(
  source: string,
  kind: AccordionContentItem["kind"],
  id: string,
  itemRange: AccordionContentItem["itemRange"],
  questionEntities: EditableEntity[],
  answerEntities: EditableEntity[],
): AccordionContentItem {
  const questionEntityIds = questionEntities.map(entity => entity.id);
  const answerEntityIds = answerEntities.map(entity => entity.id);
  return {
    id,
    kind,
    itemRange,
    sourceStart: itemRange.start,
    questionEntityIds,
    answerEntityIds,
    ownedEntityIds: [...questionEntityIds, ...answerEntityIds],
    questionGroups: buildContentGroups(source, questionEntities),
    answerGroups: buildContentGroups(source, answerEntities),
  };
}

export function buildAccordionContentItems(
  source: string,
  entities: EditableEntity[],
  accordionGroups: AccordionGroup[],
) {
  const customItems = accordionGroups.flatMap(group => group.items).map(item =>
    accordionContentItem(
      source,
      "custom",
      `accordion-content:${item.id}`,
      item.itemRange,
      entitiesByIds(entities, item.questionEntityIds),
      entitiesByIds(entities, item.answerEntityIds),
    ),
  );
  const customOwnedIds = new Set(customItems.flatMap(item => item.ownedEntityIds));
  const nodes = collectElementNodes(source);
  const details = nodes.filter(node => node.tagName === "details");
  const summaryByDetailsId = new Map(
    details.map(detail => [
      detail.id,
      nodes.find(node => node.parentId === detail.id && node.tagName === "summary") ?? null,
    ]),
  );
  const nativeOwnership = new Map<string, { detail: ElementNode; summary: ElementNode; question: EditableEntity[]; answer: EditableEntity[] }>();

  for (const entity of entities) {
    if (customOwnedIds.has(entity.id)) continue;
    const detail = details
      .filter(candidate => candidate.start <= entity.range.start && candidate.end >= entity.range.end)
      .sort((left, right) => (left.end - left.start) - (right.end - right.start))[0];
    const summary = detail ? summaryByDetailsId.get(detail.id) : null;
    if (!detail || !summary) continue;
    const owner = nativeOwnership.get(detail.id) ?? { detail, summary, question: [], answer: [] };
    if (summary.start <= entity.range.start && summary.end >= entity.range.end) owner.question.push(entity);
    else owner.answer.push(entity);
    nativeOwnership.set(detail.id, owner);
  }

  const nativeItems = [...nativeOwnership.values()]
    .filter(owner => owner.question.length > 0 && owner.answer.length > 0)
    .map(owner => accordionContentItem(
      source,
      "details",
      `details-content:${owner.detail.id}`,
      { start: owner.detail.start, end: owner.detail.end },
      owner.question.sort((left, right) => left.range.start - right.range.start),
      owner.answer.sort((left, right) => left.range.start - right.range.start),
    ));

  return [...customItems, ...nativeItems]
    .filter(item => item.ownedEntityIds.length > 0)
    .sort((left, right) => left.sourceStart - right.sourceStart);
}
