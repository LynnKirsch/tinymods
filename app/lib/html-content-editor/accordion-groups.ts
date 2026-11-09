import type { EditableEntity, SourceRange } from "./types";

export type AccordionItem = {
  id: string;
  itemRange: SourceRange;
  triggerRange: SourceRange;
  answerRange: SourceRange;
  answerId: string | null;
  initiallyOpen: boolean;
  questionEntityIds: string[];
  answerEntityIds: string[];
  controlEntityIds: string[];
};

export type AccordionGroup = {
  id: string;
  path: "explicit" | "structural";
  singleOpen: boolean;
  items: AccordionItem[];
  controlEntityIds: string[];
};

type Node = SourceRange & {
  tag: string;
  attributes: Map<string, string>;
  parent: Node | null;
  children: Node[];
};

const VOID_TAG = /^(?:area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr)$/i;

function tagEnd(source: string, start: number) {
  let quote = "";
  for (let i = start + 1; i < source.length; i += 1) {
    const char = source[i];
    if (quote) {
      if (char === quote) quote = "";
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === ">") {
      return i;
    }
  }
  return -1;
}

function attributes(openTag: string) {
  const found = new Map<string, string>();
  const body = openTag.replace(/^<\s*[^\s/>]+/, "").replace(/\/?\s*>$/, "");
  for (const match of body.matchAll(/([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g)) {
    found.set(match[1].toLowerCase(), match[2] ?? match[3] ?? match[4] ?? "");
  }
  return found;
}

function sourceNodes(source: string) {
  const roots: Node[] = [];
  const nodes: Node[] = [];
  const stack: Node[] = [];
  let cursor = 0;
  while (cursor < source.length) {
    const start = source.indexOf("<", cursor);
    if (start < 0) break;
    if (source.startsWith("<!--", start)) {
      const end = source.indexOf("-->", start + 4);
      cursor = end < 0 ? source.length : end + 3;
      continue;
    }
    const end = tagEnd(source, start);
    if (end < 0) break;
    const openTag = source.slice(start, end + 1);
    const match = /^<\s*(\/?)\s*([a-z][\w:-]*)/i.exec(openTag);
    cursor = end + 1;
    if (!match) continue;
    const tag = match[2].toLowerCase();
    if (match[1]) {
      const index = stack.findLastIndex(node => node.tag === tag);
      if (index >= 0) {
        stack[index].end = cursor;
        stack.length = index;
      }
      continue;
    }
    const parent = stack.at(-1) ?? null;
    const node: Node = { start, end: cursor, tag, attributes: attributes(openTag), parent, children: [] };
    (parent?.children ?? roots).push(node);
    nodes.push(node);
    if (!VOID_TAG.test(tag) && !/\/\s*>$/.test(openTag)) stack.push(node);
    if (/^(script|style|textarea|title)$/.test(tag)) {
      const close = new RegExp(`</${tag}\\s*>`, "ig");
      close.lastIndex = cursor;
      const closing = close.exec(source);
      cursor = closing?.index ?? source.length;
    }
  }
  return nodes;
}

function inside(parent: SourceRange, child: SourceRange) {
  return parent.start <= child.start && child.end <= parent.end;
}

function descendants(node: Node): Node[] {
  return node.children.flatMap(child => [child, ...descendants(child)]);
}

function groupOwner(item: Node) {
  let ancestor = item.parent;
  let related: Node | null = null;
  while (ancestor) {
    const names = (ancestor.attributes.get("class") ?? "").split(/\s+/);
    if (names.some(name => /(?:^|[-_:])(?:faq|accordion)$/i.test(name))) return ancestor;
    if (!related && names.some(name => /(?:^|[-_:])(?:faq|accordion)(?:$|[-_:])/i.test(name))) {
      related = ancestor;
    }
    ancestor = ancestor.parent;
  }
  return related ?? item.parent;
}

function classTokens(node: Node) {
  return (node.attributes.get("class") ?? "").split(/\s+/).filter(Boolean);
}

function selectorHasClass(selector: string, name: string) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\.${escaped}(?![\\w-])`).test(selector);
}

function structuralStyleEvidence(source: string, panelClass: string, stateToken: string | null) {
  const styles = [...source.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].map(match => match[1]).join("\n");
  const rules = [...styles.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .map(([, selector, declarations]) => ({ selector, declarations: declarations.toLowerCase() }));
  const closed = rules.some(rule => selectorHasClass(rule.selector, panelClass) &&
    /grid-template-rows\s*:\s*0(?:fr|px)\b/.test(rule.declarations));
  const open = rules.some(rule => selectorHasClass(rule.selector, panelClass) &&
    /grid-template-rows\s*:\s*1fr\b/.test(rule.declarations) &&
    (stateToken ? selectorHasClass(rule.selector, stateToken) : /aria-expanded\s*=\s*["']?true/i.test(rule.selector)));
  return closed && open;
}

function structuralCandidates(source: string, nodes: Node[]) {
  const result: Array<{ parent: Node; entries: Array<{ item: Node; trigger: Node; answer: Node }> }> = [];
  for (const parent of nodes) {
    if (parent.tag === "details" || parent.children.length < 2) continue;
    const entries = parent.children.map(item => {
      if (item.tag === "details" || item.children.length !== 2) return null;
      const [trigger, answer] = item.children;
      if (trigger.tag !== "button" || answer.tag !== "div" ||
        trigger.attributes.has("aria-controls") ||
        trigger.attributes.has("aria-haspopup") ||
        answer.attributes.get("role") === "menu" ||
        !/^(true|false)$/.test(trigger.attributes.get("aria-expanded") ?? "") ||
        descendants(item).filter(node => node.tag === "button").length !== 1 ||
        descendants(answer).some(node => node.tag === "button" || node.tag === "nav" || node.tag === "menu") ||
        !descendants(answer).some(node => node.tag === "p" || node.tag === "li")) return null;
      return { item, trigger, answer };
    });
    if (entries.some(entry => !entry)) continue;
    const siblings = entries as Array<{ item: Node; trigger: Node; answer: Node }>;
    const opened = siblings.filter(entry => entry.trigger.attributes.get("aria-expanded") === "true");
    if (opened.length !== 1) continue;
    const panelClasses = classTokens(siblings[0].answer);
    const sharedPanel = panelClasses.find(name => siblings.every(entry => classTokens(entry.answer).includes(name)));
    const sharedItem = classTokens(siblings[0].item).some(name => siblings.every(entry => classTokens(entry.item).includes(name)));
    if (!sharedPanel || !sharedItem) continue;
    const openItem = opened[0].item;
    const closedClasses = new Set(siblings.filter(entry => entry.item !== openItem).flatMap(entry => classTokens(entry.item)));
    const extra = classTokens(openItem).filter(name => !closedClasses.has(name));
    const stateToken = extra.length === 1 ? extra[0] : null;
    if (!structuralStyleEvidence(source, sharedPanel, stateToken)) continue;
    result.push({ parent, entries: siblings });
  }
  return result;
}

export function detectAccordionGroups(source: string, entities: EditableEntity[]): AccordionGroup[] {
  const nodes = sourceNodes(source);
  const byId = new Map<string, Node[]>();
  for (const node of nodes) {
    const id = node.attributes.get("id");
    if (id) byId.set(id, [...(byId.get(id) ?? []), node]);
  }
  const candidates: Array<{ item: Node; trigger: Node; answer: Node }> = [];
  for (const trigger of nodes.filter(node => node.tag === "button" && node.attributes.has("aria-expanded"))) {
    const control = trigger.attributes.get("aria-controls");
    const targets = control ? byId.get(control) : null;
    if (!targets || targets.length !== 1 || !/^(true|false)$/.test(trigger.attributes.get("aria-expanded") ?? "")) continue;
    const answer = targets[0];
    let item = trigger.parent;
    while (item && (!inside(item, answer) || inside(trigger, answer))) item = item.parent;
    if (!item || item === trigger || !item.parent || item === answer) continue;
    candidates.push({ item, trigger, answer });
  }
  const parents = new Map<Node, typeof candidates>();
  for (const candidate of candidates) {
    const parent = groupOwner(candidate.item)!;
    parents.set(parent, [...(parents.get(parent) ?? []), candidate]);
  }
  const groups: AccordionGroup[] = [];
  const explicitOwners = new Set(candidates.map(candidate => candidate.item));
  const sets = [
    ...[...parents].map(([parent, entries]) => ({ parent, entries, path: "explicit" as const })),
    ...structuralCandidates(source, nodes).filter(group => !group.entries.some(entry => explicitOwners.has(entry.item)))
      .map(group => ({ ...group, path: "structural" as const })),
  ];
  for (const { parent, entries, path } of sets) {
    if (entries.length < 2 || new Set(entries.map(entry => entry.item)).size !== entries.length ||
      new Set(entries.map(entry => entry.answer)).size !== entries.length ||
      !entries.every(entry => entry.item.tag === entries[0].item.tag)) continue;
    const items = entries.sort((a, b) => a.item.start - b.item.start).map(({ item, trigger, answer }) => {
      const controlRanges = descendants(trigger).filter(node => node.attributes.get("aria-hidden") === "true");
      return {
        id: `accordion-item:${item.start}`,
        itemRange: { start: item.start, end: item.end },
        triggerRange: { start: trigger.start, end: trigger.end },
        answerRange: { start: answer.start, end: answer.end },
        answerId: answer.attributes.get("id") ?? null,
        initiallyOpen: trigger.attributes.get("aria-expanded") === "true",
        questionEntityIds: entities.filter(entity => inside(trigger, entity.range) && !controlRanges.some(range => inside(range, entity.range))).map(entity => entity.id),
        answerEntityIds: entities.filter(entity => inside(answer, entity.range)).map(entity => entity.id),
        controlEntityIds: entities.filter(entity => controlRanges.some(range => inside(range, entity.range))).map(entity => entity.id),
      };
    });
    groups.push({ id: `accordion:${parent.start}`, path, singleOpen: true, items,
      controlEntityIds: items.flatMap(item => item.controlEntityIds) });
  }
  return groups;
}
