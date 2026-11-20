export type PreviewTypographyController = {
  applyTextNode: (node: Text) => void;
  cleanup: () => void;
};

// Serialized into the sandboxed Preview. All runtime dependencies are local to this function.
export function createPreviewTypography() {
  const SHORT_WORDS = [
    "в", "во", "на", "с", "со", "у", "к", "ко",
    "о", "об", "обо", "от", "ото", "до", "по",
    "под", "подо", "над", "надо", "за",
    "для", "ради", "без", "безо", "через", "чрез",
    "и", "а", "но", "да", "или", "либо",
    "ни", "не", "то", "как", "так", "же", "бы", "ли",
  ];
  const words = "(?<![^\\s(«„“])(" + SHORT_WORDS.join("|") + ")";
  const followingWord = "(?:[«„“(]*)(?![a-z][a-z\\d+.-]*://|www\\.)[\\p{L}\\p{N}]";
  const internal = new RegExp(words + "[ \\t]+(?=" + followingWord + ")", "giu");
  const ending = new RegExp(words + "([ \\t]*)$", "iu");
  const startsWithWord = new RegExp("^" + followingWord, "iu");
  const leading = new RegExp("^[ \\t]+(?=" + followingWord + ")", "iu");
  const excluded = new Set([
    "SCRIPT", "STYLE", "NOSCRIPT", "TEXTAREA", "OPTION", "SELECT", "INPUT", "BUTTON",
    "CODE", "PRE", "KBD", "SAMP", "SVG", "MATH", "TEMPLATE",
  ]);
  const inlineTags = new Set([
    "A", "ABBR", "B", "BDI", "BDO", "CITE", "DEL", "EM", "I", "INS", "MARK", "Q",
    "S", "SMALL", "SPAN", "STRONG", "SUB", "SUP", "TIME", "U", "VAR",
  ]);

  function applyPreviewTypographyText(value: string) {
    return value.replace(internal, "$1\u00a0");
  }

  function isPreviewTypographySkippedTag(tagName: string) {
    return excluded.has(tagName.toUpperCase());
  }

  function excludedElement(element: Element) {
    const editable = element.getAttribute("contenteditable")?.toLowerCase();
    return isPreviewTypographySkippedTag(element.tagName) ||
      editable === "" || editable === "true" || editable === "plaintext-only" ||
      element.hasAttribute("hidden");
  }

  function inline(element: Element) {
    if (!inlineTags.has(element.tagName.toUpperCase()) || excludedElement(element)) return false;
    const display = element.ownerDocument.defaultView?.getComputedStyle(element).display;
    return !display || display === "inline" || display === "contents";
  }

  function excludedAncestor(node: Text) {
    const parent = node.parentElement;
    for (let ancestor = parent; ancestor; ancestor = ancestor.parentElement) {
      if (excludedElement(ancestor)) return true;
    }
    const whiteSpace = parent?.ownerDocument.defaultView?.getComputedStyle(parent).whiteSpace;
    return whiteSpace === "pre" || whiteSpace === "pre-wrap" || whiteSpace === "break-spaces";
  }

  function nextInlineText(node: Text) {
    let current: Node | null = node;
    while (current) {
      if (current.nextSibling) {
        current = current.nextSibling;
        while (current?.nodeType === 1) {
          if (!inline(current as Element) || !current.firstChild) return null;
          current = current.firstChild;
        }
        if (current?.nodeType === 3 && current.nodeValue) return current as Text;
        if (current?.nodeType !== 8 && current?.nodeType !== 3) return null;
      } else {
        const parent: Element | null = current.parentElement;
        current = parent && inline(parent) ? parent : null;
      }
    }
    return null;
  }

  function installPreviewTypography(
    document: Document,
    options: { enabled?: boolean } = {},
  ): PreviewTypographyController {
    if (!options.enabled || !document.body) return { applyTextNode() {}, cleanup() {} };
    const body = document.body;
    const roots = new Set<Node>();
    const selfWrites = new WeakMap<Text, string>();
    let stopped = false;
    let scheduled = false;

    function write(node: Text, next: string) {
      if (node.data === next) return;
      selfWrites.set(node, next);
      node.data = next;
    }

    function applyTextNode(node: Text) {
      if (!body.contains(node) || excludedAncestor(node)) return;
      write(node, applyPreviewTypographyText(node.data));
      const match = ending.exec(node.data);
      if (!match) return;
      const next = nextInlineText(node);
      if (!next || excludedAncestor(next)) return;
      const gap = match[2];
      if (gap) {
        if (startsWithWord.test(next.data)) write(node, node.data.slice(0, -gap.length) + "\u00a0");
      } else if (leading.test(next.data)) {
        write(next, next.data.replace(leading, "\u00a0"));
      } else if (/^[ \t]+$/.test(next.data)) {
        const wordNode = nextInlineText(next);
        if (wordNode && !excludedAncestor(wordNode) && startsWithWord.test(wordNode.data)) write(next, "\u00a0");
      }
    }

    function process(root: Node, seen: WeakSet<Text>) {
      if (!body.contains(root)) return;
      const walker = document.createTreeWalker(root, 4); // NodeFilter.SHOW_TEXT
      for (let text = walker.nextNode(); text; text = walker.nextNode()) {
        const node = text as Text;
        if (seen.has(node)) continue;
        seen.add(node);
        applyTextNode(node);
      }
    }

    function flowRoot(node: Node) {
      let element = node.nodeType === 1 ? node as Element : node.parentElement;
      while (element?.parentElement && inline(element)) element = element.parentElement;
      return element ?? body;
    }

    function flush() {
      if (stopped) return;
      scheduled = false;
      const seen = new WeakSet<Text>();
      for (const root of roots) process(root, seen);
      roots.clear();
    }

    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.type === "characterData") {
          const node = mutation.target as Text;
          if (selfWrites.get(node) === node.data) continue;
          selfWrites.delete(node);
        }
        roots.add(flowRoot(mutation.target));
      }
      if (!roots.size || scheduled) return;
      scheduled = true;
      queueMicrotask(flush);
    });
    process(body, new WeakSet<Text>());
    observer.observe(body, { childList: true, characterData: true, subtree: true });

    return {
      applyTextNode,
      cleanup() {
        stopped = true;
        observer.disconnect();
        roots.clear();
      },
    };
  }

  return { applyPreviewTypographyText, isPreviewTypographySkippedTag, installPreviewTypography };
}

export const { applyPreviewTypographyText, isPreviewTypographySkippedTag, installPreviewTypography } =
  createPreviewTypography();
