export type FragmentType = "auto" | "html" | "css" | "js";

export type SourceFragment = {
  id: string;
  type: FragmentType;
  draft: string;
  source: string;
  originalSource: string;
  loaded: boolean;
};

export type BlockSource = {
  id: string;
  fragments: SourceFragment[];
  values: Record<string, string>;
};

export type SiteContext = { css: string; js: string };

export function createSourceFragment(id: string): SourceFragment {
  return { id, type: "auto", draft: "", source: "", originalSource: "", loaded: false };
}

export function createBlockSource(id: string): BlockSource {
  return { id, fragments: [createSourceFragment(`${id}-fragment-1`)], values: {} };
}

export function editorEntityKey(blockId: string, entityId: string) {
  return `${blockId}::${entityId}`;
}

export function reorderFragments(block: BlockSource, fragmentId: string, direction: -1 | 1): BlockSource {
  const index = block.fragments.findIndex(fragment => fragment.id === fragmentId);
  const target = index + direction;
  if (index < 0 || target < 0 || target >= block.fragments.length) return block;
  const fragments = [...block.fragments];
  [fragments[index], fragments[target]] = [fragments[target], fragments[index]];
  // Entity offsets belong to the old order. Commit edits before reordering in the UI.
  return { ...block, fragments, values: {} };
}
