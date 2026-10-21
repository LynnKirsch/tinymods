const SHORT_WORDS = [
  "в", "во", "на", "с", "со", "у", "к", "ко",
  "о", "об", "обо", "от", "ото", "до", "по",
  "под", "подо", "над", "надо", "за",
  "для", "ради", "без", "безо", "через", "чрез",
  "и", "а", "но", "да", "или", "либо",
  "ни", "не", "то", "как", "так", "же", "бы", "ли",
];

const SHORT_WORD_PATTERN = new RegExp(
  `(^|\\s)(${SHORT_WORDS.join("|")})\\s+`,
  "giu",
);
const SKIPPED_TAGS = new Set([
  "SCRIPT", "STYLE", "NOSCRIPT", "TEXTAREA", "OPTION", "SELECT",
  "INPUT", "BUTTON", "CODE", "PRE",
]);
const MARKER_START = "tinymods-preview-start:";
const MARKER_END = "tinymods-preview-end:";

export type PreviewTypographyController = {
  applyTextNode: (node: Text) => void;
  cleanup: () => void;
};

export function applyPreviewTypographyText(value: string) {
  return value.replace(SHORT_WORD_PATTERN, "$1$2\u00a0");
}

export function isPreviewTypographySkippedTag(tagName: string) {
  return SKIPPED_TAGS.has(tagName.toUpperCase());
}

function skippedAncestor(node: Text) {
  let parent = node.parentElement;
  while (parent) {
    if (isPreviewTypographySkippedTag(parent.tagName) || parent.getAttribute("contenteditable") === "true") {
      return true;
    }
    parent = parent.parentElement;
  }
  return false;
}

function isInsideMarkerRange(document: Document, target: Text) {
  const walker = document.createTreeWalker(
    document.body,
    NodeFilter.SHOW_COMMENT | NodeFilter.SHOW_TEXT,
  );
  let active = false;
  let current = walker.nextNode();
  while (current) {
    if (current.nodeType === Node.COMMENT_NODE) {
      const value = current.nodeValue ?? "";
      if (value.startsWith(MARKER_START)) active = true;
      if (value.startsWith(MARKER_END)) active = false;
    } else if (current === target) {
      return active;
    }
    current = walker.nextNode();
  }
  return false;
}

function isSourceDerivedTextNode(document: Document, node: Text) {
  if (skippedAncestor(node)) return false;
  return Boolean(node.parentElement?.closest("[data-tinymods-preview-ids]")) ||
    isInsideMarkerRange(document, node);
}

function applyToTextNode(document: Document, node: Text) {
  if (!isSourceDerivedTextNode(document, node)) return;
  const current = node.nodeValue ?? "";
  const next = applyPreviewTypographyText(current);
  if (next !== current) node.nodeValue = next;
}

function processAddedNode(document: Document, node: Node) {
  if (node.nodeType === Node.TEXT_NODE) {
    applyToTextNode(document, node as Text);
    return;
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return;
  const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
  let current = walker.nextNode();
  while (current) {
    applyToTextNode(document, current as Text);
    current = walker.nextNode();
  }
}

export function installPreviewTypography(document: Document, options: { enabled?: boolean } = {}): PreviewTypographyController {
  // Faithful Preview preserves the user's whitespace. This transformation is opt-in only.
  if (!options.enabled) return { applyTextNode() {}, cleanup() {} };
  const initialWalker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let current = initialWalker.nextNode();
  while (current) {
    applyToTextNode(document, current as Text);
    current = initialWalker.nextNode();
  }

  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (mutation.type === "characterData" && mutation.target.nodeType === Node.TEXT_NODE) {
        applyToTextNode(document, mutation.target as Text);
      }
      if (mutation.type === "childList") {
        for (const node of mutation.addedNodes) processAddedNode(document, node);
      }
    }
  });
  observer.observe(document.body, { childList: true, characterData: true, subtree: true });

  return {
    applyTextNode(node) {
      applyToTextNode(document, node);
    },
    cleanup() {
      observer.disconnect();
    },
  };
}
