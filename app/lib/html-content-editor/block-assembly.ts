import type { BlockSource, FragmentType, SiteContext, SourceFragment } from "./block-source";
import { editorEntityKey } from "./block-source";
import { extractEditableEntities } from "./extract-editable-entities";
import { compositeEditError, createEditableEntityPatches } from "./encode-source-value";
import { applySourcePatches } from "./patch-source";
import type { SourcePatch } from "./types";

export function detectFragmentType(source: string): Exclude<FragmentType, "auto"> | null {
  const value = source.replace(/^\s*(?:\/\*[\s\S]*?\*\/\s*)*/, "").trim();
  if (!value) return "html";
  if (/^(?:<!doctype\b|<!--|<[a-z][\w:-]*(?:\s|>|\/))/i.test(value)) return "html";
  if (/^(?:@(?:charset|import|media|supports|layer|font-face|keyframes|container)\b|[^{};=]+\{\s*(?:--[\w-]+|[a-z-]+)\s*:)/i.test(value)) return "css";
  if (/^(?:\/\/|(?:const|let|var|function|class|import|export|if|for|while|try)\b|(?:document|window|console|[A-Za-z_$][\w$]*)\s*(?:\.|\(|=>))/.test(value)) return "js";
  return null;
}

export function resolvedFragmentType(fragment: SourceFragment) {
  return fragment.type === "auto" ? detectFragmentType(fragment.source) ?? "html" : fragment.type;
}

export function fragmentExecutableSource(source: string, type: "html" | "css" | "js") {
  if (type === "html") return source;
  // Tagged input remains in its exact original order, even when a role is explicit.
  if (type === "css" && /^\s*<style\b/i.test(source)) return source;
  if (type === "js" && /^\s*<script\b/i.test(source)) return source;
  return type === "css" ? `<style>\n${source}\n</style>` : `<script>\n${source}\n</script>`;
}

export function assembleBlock(block: BlockSource) {
  let source = "";
  const ranges: Array<{ fragmentId: string; start: number; end: number }> = [];
  for (const fragment of block.fragments) {
    if (!fragment.loaded) continue;
    const type = resolvedFragmentType(fragment);
    if (source) source += "\n";
    const executable = fragmentExecutableSource(fragment.source, type);
    const prefix = executable === fragment.source ? 0 : type === "css" ? 8 : 9;
    const start = source.length + prefix;
    source += executable;
    ranges.push({ fragmentId: fragment.id, start, end: start + fragment.source.length });
  }
  return { source, ranges };
}

export function routeBlockPatches(block: BlockSource, patches: SourcePatch[]) {
  const assembly = assembleBlock(block);
  const byFragment = new Map<string, SourcePatch[]>();
  for (const patch of patches) {
    const owner = assembly.ranges.find(range => patch.start >= range.start && patch.end <= range.end);
    if (!owner) throw new Error("Content patch crosses a fragment boundary.");
    const list = byFragment.get(owner.fragmentId) ?? [];
    list.push({ ...patch, start: patch.start - owner.start, end: patch.end - owner.start });
    byFragment.set(owner.fragmentId, list);
  }
  return block.fragments.map(fragment => ({
    ...fragment,
    source: applySourcePatches(fragment.source, byFragment.get(fragment.id) ?? []),
  }));
}

export function editedBlockFragments(block: BlockSource) {
  const { source } = assembleBlock(block);
  const patches = extractEditableEntities(source).flatMap(entity => {
    const key = editorEntityKey(block.id, entity.id);
    const draft = block.values[key];
    const value = draft !== undefined && compositeEditError(entity, draft) ? block.values[`${key}::valid`] : draft;
    return value === undefined || compositeEditError(entity, value) ? [] : createEditableEntityPatches(entity, value);
  });
  return routeBlockPatches(block, patches);
}

export function editedBlockAnalysis(block: BlockSource) {
  const original = assembleBlock(block);
  const entities = extractEditableEntities(original.source);
  const patches = entities.flatMap(entity => {
    const key = editorEntityKey(block.id, entity.id);
    const draft = block.values[key];
    const value = draft !== undefined && compositeEditError(entity, draft) ? block.values[`${key}::valid`] : draft;
    return value === undefined || compositeEditError(entity, value) ? [] : createEditableEntityPatches(entity, value);
  });
  const edited = assembleBlock({ ...block, fragments: routeBlockPatches(block, patches), values: {} });
  const remap = (range: { start: number; end: number }) => {
    const offset = patches.filter(patch => patch.end <= range.start && patch.start < range.start)
      .reduce((sum, patch) => sum + patch.replacement.length - (patch.end - patch.start), 0);
    const delta = patches.filter(patch => patch.start >= range.start && patch.end <= range.end)
      .reduce((sum, patch) => sum + patch.replacement.length - (patch.end - patch.start), 0);
    return { start: range.start + offset, end: range.end + offset + delta };
  };
  return { ...edited, entities: entities.map(entity => {
    const range = remap(entity.range);
    const composite = entity.composite ? {
      ownerTag: remap(entity.composite.ownerTag),
      segments: entity.composite.segments.map(segment => ({ ...segment, range: remap(segment.range) })),
    } : undefined;
    return { ...entity, composite, range, rawValue: edited.source.slice(range.start, range.end) };
  }) };
}

export function blockHasInvalidContent(block: BlockSource) {
  return extractEditableEntities(assembleBlock(block).source).some(entity => {
    const value = block.values[editorEntityKey(block.id, entity.id)];
    return value !== undefined && compositeEditError(entity, value) !== null;
  });
}

export function isBlockContentDirty(block: BlockSource) {
  return editedBlockFragments(block).some(fragment => {
    if (!fragment.loaded || fragment.source === fragment.originalSource) return false;
    // Compare actual editable values as well as structure, so equivalent HTML
    // entity spellings do not leave a reverted field falsely dirty after commit.
    const before = extractEditableEntities(fragmentExecutableSource(fragment.originalSource, resolvedFragmentType(fragment)));
    const after = extractEditableEntities(fragmentExecutableSource(fragment.source, resolvedFragmentType(fragment)));
    if (before.length !== after.length) return true;
    return before.some((entity, index) => entity.kind !== after[index].kind || entity.displayValue !== after[index].displayValue);
  });
}

export function commitBlockEdits(block: BlockSource): BlockSource {
  if (blockHasInvalidContent(block)) return block;
  return {
    ...block,
    fragments: editedBlockFragments(block).map(fragment => ({
      ...fragment,
      // Unloaded fragments only have a draft; committing other edits must preserve it.
      draft: fragment.loaded ? fragment.source : fragment.draft,
    })),
    values: {},
  };
}

export function exportBlock(block: BlockSource) {
  if (blockHasInvalidContent(block)) throw new Error("Исправьте неподдержанное изменение форматирования перед копированием.");
  return editedBlockFragments(block).filter(fragment => fragment.loaded).map(fragment => fragment.source).join("\n");
}

export function exportPage(blocks: BlockSource[], context: SiteContext) {
  const css = context.css ? fragmentExecutableSource(context.css, "css") : "";
  const js = context.js ? fragmentExecutableSource(context.js, "js") : "";
  const content = blocks.map(block => {
    const edited = { ...block, fragments: editedBlockFragments(block), values: {} };
    const assembly = assembleBlock(edited);
    return assembly.source;
  });
  return [css, ...content, js].filter(Boolean).join("\n");
}
