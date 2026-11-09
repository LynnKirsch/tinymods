import type { EditableEntity, SourcePatch, SourceRange } from "./types";

export type RepeatingItem = SourceRange & {
  id: string;
  tagName: RepeatingTagName;
  rawSource: string;
  separatorBefore: string;
  entityIds: string[];
  canDelete: boolean;
};

export type RepeatingGroup = {
  id: string;
  tagName: RepeatingTagName;
  groupKind: "text" | "image";
  title: string;
  addLabel: string;
  canDelete: boolean;
  canAdd: boolean;
  addBlockedReason: string;
  deleteBlockedReason: string;
  items: RepeatingItem[];
};

type ElementNode = SourceRange & {
  id: string;
  tagName: string;
  parentId: string;
  openTag: string;
  rawSource: string;
  childIds: string[];
};

type OpenNode = Omit<ElementNode, "end" | "rawSource">;

type RepeatingTagName = "p" | "li" | "figure" | "div";

const TEXT_REPEATING_TAGS = new Set(["p", "li"]);
const IMAGE_WRAPPER_TAGS = new Set(["figure", "div"]);
const VOID_ELEMENTS = /^(area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr)$/i;
const DANGEROUS_REFERENCE_ATTRIBUTES =
  /\s(?:id|for|aria-labelledby|aria-controls|name|data-[\w:-]+|on[a-z]+)\s*=/i;
const IMAGE_ENTITY_KINDS = new Set(["src", "srcset"]);
const PROTECTED_COMMENT = /<!--[\s\S]*?-->/;

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

function isSelfClosingTag(tag: string, name: string) {
  return /\/\s*>$/.test(tag) || VOID_ELEMENTS.test(name);
}

function classSignature(openTag: string) {
  const match = openTag.match(/\sclass\s*=\s*("([^"]*)"|'([^']*)')/i);
  const classValue = match?.[2] ?? match?.[3] ?? "";
  return classValue
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .sort()
    .join(".");
}

export function structuralSignature(node: ElementNode, nodes: Map<string, ElementNode>) {
  return [
    node.tagName,
    classSignature(node.openTag),
    node.childIds.map((childId) => nodeShapeSignature(childId, nodes)).join(">"),
  ].join("|");
}

function nodeShapeSignature(nodeId: string, nodes: Map<string, ElementNode>): string {
  const node = nodes.get(nodeId);
  if (!node) return "";

  const childShape = node.childIds
    .map((childId) => nodeShapeSignature(childId, nodes))
    .join(">");
  return `${node.tagName}[${classSignature(node.openTag)}](${childShape})`;
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
          rawSource: source.slice(closed.start, tagEnd + 1),
        });
      }
      cursor = tagEnd + 1;
      continue;
    }

    const parentId = stack.at(-1)?.id ?? "root";
    const id = `${tagName}:${tagStart}`;
    childrenByParent.set(parentId, [...(childrenByParent.get(parentId) ?? []), id]);

    if (isSelfClosingTag(tag, tagName)) {
      nodes.set(id, {
        id,
        tagName,
        parentId,
        start: tagStart,
        end: tagEnd + 1,
        openTag: tag,
        rawSource: source.slice(tagStart, tagEnd + 1),
        childIds: [],
      });
    } else {
      stack.push({
        id,
        tagName,
        parentId,
        start: tagStart,
        openTag: tag,
        childIds: childrenByParent.get(id) ?? [],
      });
    }

    cursor = tagEnd + 1;
  }

  for (const node of nodes.values()) {
    node.childIds = childrenByParent.get(node.id) ?? [];
  }

  return { nodes, childrenByParent };
}

function entityIdsInside(item: SourceRange, entities: EditableEntity[]) {
  return entities
    .filter((entity) => entity.range.start >= item.start && entity.range.end <= item.end)
    .map((entity) => entity.id);
}

function imageEntityIdsInside(item: SourceRange, entities: EditableEntity[]) {
  return entities
    .filter(
      (entity) =>
        entity.range.start >= item.start &&
        entity.range.end <= item.end &&
        IMAGE_ENTITY_KINDS.has(entity.kind),
    )
    .map((entity) => entity.id);
}

function groupKind(tagName: RepeatingTagName) {
  return tagName === "p" || tagName === "li" ? "text" : "image";
}

function canBeRepeatingCandidate(
  node: ElementNode | undefined,
  entities: EditableEntity[],
  nodes: Map<string, ElementNode>,
): node is ElementNode & { tagName: RepeatingTagName } {
  if (!node) return false;
  if (TEXT_REPEATING_TAGS.has(node.tagName)) return true;
  if (!IMAGE_WRAPPER_TAGS.has(node.tagName)) return false;
  if (node.tagName === "figure") return imageEntityIdsInside(node, entities).length > 0;

  return node.childIds.some((childId) => {
    const child = nodes.get(childId);
    return child?.tagName === "img" || child?.tagName === "picture" || child?.tagName === "source";
  });
}

function groupTitle(tagName: RepeatingTagName) {
  if (tagName === "figure" || tagName === "div") return "Галерея";
  return tagName === "li" ? "Список" : "Описание";
}

function addLabel(tagName: RepeatingTagName) {
  if (tagName === "figure" || tagName === "div") return "+ Добавить фотографию";
  return tagName === "li" ? "+ Добавить пункт" : "+ Добавить абзац";
}

function hasProtectedComment(sourcePart: string) {
  return PROTECTED_COMMENT.test(sourcePart);
}

function toRepeatingGroup(
  source: string,
  run: ElementNode[],
  entities: EditableEntity[],
  signature: string,
) {
  const tagName = run[0].tagName as RepeatingTagName;
  const items = run.map((item, index) => {
    const previous = run[index - 1];
    return {
      id: item.id,
      tagName,
      start: item.start,
      end: item.end,
      rawSource: source.slice(item.start, item.end),
      separatorBefore: previous ? source.slice(previous.end, item.start) : "",
      entityIds: entityIdsInside(item, entities),
      canDelete: true,
    };
  });
  const hasUnsafeCloneAttribute = run.some((item) =>
    DANGEROUS_REFERENCE_ATTRIBUTES.test(item.rawSource),
  );
  const hasProtectedComments = items.some(
    (item) => hasProtectedComment(item.rawSource) || hasProtectedComment(item.separatorBefore),
  );
  const canDelete = !hasProtectedComments;
  const canAdd = !hasUnsafeCloneAttribute && !hasProtectedComments;
  const addBlockedReason = hasProtectedComments
    ? "Группа содержит защищённые комментарии. Добавление отключено, чтобы не изменить исходный код вокруг них."
    : hasUnsafeCloneAttribute
      ? "Этот элемент содержит служебные атрибуты. Его можно удалить, но безопасное клонирование отключено."
      : "";
  const deleteBlockedReason = hasProtectedComments
    ? "Группа содержит защищённые комментарии. Удаление отключено, чтобы не изменить source-комментарии."
    : "";

  return {
    id: `repeat:${run[0].parentId}:${signature}:${run[0].start}`,
    tagName,
    groupKind: groupKind(tagName),
    title: groupTitle(tagName),
    addLabel: addLabel(tagName),
    canDelete,
    canAdd,
    addBlockedReason,
    deleteBlockedReason,
    items: items.map((item) => ({ ...item, canDelete })),
  } satisfies RepeatingGroup;
}

export function detectRepeatingGroups(source: string, entities: EditableEntity[]) {
  const { nodes, childrenByParent } = collectElementNodes(source);
  const groups: RepeatingGroup[] = [];

  for (const childIds of childrenByParent.values()) {
    let run: ElementNode[] = [];
    let currentSignature = "";

    for (const childId of childIds) {
      const node = nodes.get(childId);
      const signature =
        canBeRepeatingCandidate(node, entities, nodes)
          ? structuralSignature(node, nodes)
          : "";

      if (node && signature && signature === currentSignature) {
        run.push(node);
      } else {
        if (run.length >= 2) {
          groups.push(toRepeatingGroup(source, run, entities, currentSignature));
        }
        run = node && signature ? [node] : [];
        currentSignature = signature;
      }
    }

    if (run.length >= 2) {
      groups.push(toRepeatingGroup(source, run, entities, currentSignature));
    }
  }

  return groups;
}

export function itemDeletePatch(group: RepeatingGroup, item: RepeatingItem): SourcePatch | null {
  if (!group.canDelete || !item.canDelete) return null;

  const index = group.items.findIndex((candidate) => candidate.id === item.id);
  const previous = group.items[index - 1];
  const next = group.items[index + 1];

  if (!previous && next) {
    return { start: item.start, end: next.start, replacement: "" };
  }
  if (previous) {
    return { start: previous.end, end: item.end, replacement: "" };
  }
  return { start: item.start, end: item.end, replacement: "" };
}

export function itemAddPatch(group: RepeatingGroup): SourcePatch | null {
  if (!group.canAdd) return null;

  const template = group.items.at(-1);
  const previous = group.items.at(-2);
  if (!template) return null;

  const separator = previous ? template.separatorBefore : "";
  return {
    start: template.end,
    end: template.end,
    replacement: separator + template.rawSource,
  };
}
