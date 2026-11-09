const CONTENT_VISIBLE_CLASS = "tinymods-preview-content-visible";

type StyleDeclarationLike = {
  getPropertyValue?(property: string): string;
  opacity?: string;
  visibility?: string;
  display?: string;
};

type ClassListLike = {
  add(className: string): void;
  contains?(className: string): boolean;
};

export type PreviewContentVisibilityElementLike = {
  classList: ClassListLike;
  getAttribute?(name: string): string | null;
  parentElement?: PreviewContentVisibilityElementLike | null;
  tagName?: string;
};

type PreviewContentVisibilityWindowLike = {
  getComputedStyle(element: unknown): StyleDeclarationLike;
};

export type PreviewContentVisibilityDocumentLike = {
  body?: PreviewContentVisibilityElementLike | null;
  defaultView?: PreviewContentVisibilityWindowLike | null;
  documentElement?: PreviewContentVisibilityElementLike | null;
};

export type PreviewContentVisibilityResult = {
  recovered: boolean;
  reason: "opacity" | "visibility";
};

export { CONTENT_VISIBLE_CLASS };

function declarationValue(style: StyleDeclarationLike | undefined, property: string) {
  return (
    style?.getPropertyValue?.(property) ??
    style?.[property as keyof StyleDeclarationLike] ??
    ""
  )
    .toString()
    .trim()
    .toLowerCase();
}

function isDocumentBoundary(
  element: PreviewContentVisibilityElementLike,
  documentLike: PreviewContentVisibilityDocumentLike,
) {
  if (element === documentLike.body || element === documentLike.documentElement) return true;
  const tagName = element.tagName?.toLowerCase();
  return tagName === "body" || tagName === "html";
}

function editableElementChain(
  element: PreviewContentVisibilityElementLike,
  documentLike: PreviewContentVisibilityDocumentLike,
) {
  const chain: PreviewContentVisibilityElementLike[] = [];
  let current: PreviewContentVisibilityElementLike | null | undefined = element;

  while (current && !isDocumentBoundary(current, documentLike)) {
    chain.push(current);
    current = current.parentElement;
  }

  return chain;
}

export function ensureEditableContentVisible(
  documentLike: PreviewContentVisibilityDocumentLike,
  editableElements: Iterable<PreviewContentVisibilityElementLike>,
) {
  const windowLike = documentLike.defaultView;
  if (!windowLike) return [];

  const recoveredElements = new Set<PreviewContentVisibilityElementLike>();
  const results: PreviewContentVisibilityResult[] = [];

  for (const editableElement of editableElements) {
    const chain = editableElementChain(editableElement, documentLike);
    const managedSlide = chain.findLastIndex(element => element.getAttribute?.("data-tinymods-slider-state"));
    // Confirmed stacked slides own their subtree visibility; outer ancestors retain normal recovery.
    for (const element of chain.slice(managedSlide + 1)) {
      if (recoveredElements.has(element)) continue;

      const style = windowLike.getComputedStyle(element);
      const display = declarationValue(style, "display");
      if (display === "none") continue;

      const opacity = declarationValue(style, "opacity").replace(/\s+/g, "");
      const visibility = declarationValue(style, "visibility");
      const hiddenByOpacity = opacity === "0" || opacity === "0.0";
      const hiddenByVisibility = visibility === "hidden";

      if (!hiddenByOpacity && !hiddenByVisibility) continue;

      element.classList.add(CONTENT_VISIBLE_CLASS);
      recoveredElements.add(element);
      results.push({
        recovered: true,
        reason: hiddenByOpacity ? "opacity" : "visibility",
      });
    }
  }

  return results;
}
