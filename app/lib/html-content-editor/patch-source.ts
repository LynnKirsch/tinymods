import type { SourcePatch } from "./types";

type IndexedPatch = SourcePatch & {
  index: number;
};

function validatePatch(source: string, patch: SourcePatch) {
  if (!Number.isInteger(patch.start) || !Number.isInteger(patch.end)) {
    throw new Error("Source patch offsets must be integers.");
  }
  if (patch.start < 0 || patch.end < 0) {
    throw new Error("Source patch offsets cannot be negative.");
  }
  if (patch.start > patch.end) {
    throw new Error("Source patch start cannot be greater than end.");
  }
  if (patch.end > source.length) {
    throw new Error("Source patch range is outside the source.");
  }
}

function comparePatches(first: IndexedPatch, second: IndexedPatch) {
  if (first.start !== second.start) return second.start - first.start;

  const firstIsInsert = first.start === first.end;
  const secondIsInsert = second.start === second.end;
  if (firstIsInsert && secondIsInsert) {
    return second.index - first.index;
  }

  if (first.end !== second.end) return second.end - first.end;
  return first.index - second.index;
}

function patchesOverlap(current: SourcePatch, previousStart: number) {
  return current.start < current.end && current.end > previousStart;
}

export function applySourcePatches(source: string, patches: SourcePatch[]) {
  const sortedPatches = patches
    .map((patch, index) => ({ ...patch, index }))
    .sort(comparePatches);

  let previousStart = source.length + 1;
  for (const patch of sortedPatches) {
    validatePatch(source, patch);
    if (patchesOverlap(patch, previousStart)) {
      throw new Error("Source patches cannot overlap.");
    }
    previousStart = patch.start;
  }

  let patchedSource = source;
  for (const patch of sortedPatches) {
    patchedSource =
      patchedSource.slice(0, patch.start) +
      patch.replacement +
      patchedSource.slice(patch.end);
  }

  return patchedSource;
}
