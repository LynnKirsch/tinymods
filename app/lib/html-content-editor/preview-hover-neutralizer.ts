type MutableCssRule = {
  cssRules?: CSSRuleList;
  cssText?: string;
  selectorText?: string;
  style?: CSSStyleDeclaration;
};

type MutableCssRuleContainer = {
  cssRules?: CSSRuleList;
  deleteRule?: (index: number) => void;
  insertRule?: (rule: string, index?: number) => number | void;
  ownerNode?: Element | null;
};

const TINYMODS_PREVIEW_STYLE_ATTRIBUTE = "data-tinymods-preview-style";
const TINYMODS_SLIDER_STYLE_ID = "tinymods-preview-slider-navigation-style";

function readableCssRules(container: MutableCssRuleContainer | MutableCssRule) {
  try {
    return container.cssRules ?? null;
  } catch {
    return null;
  }
}

function isEscaped(value: string, index: number) {
  let slashCount = 0;
  for (let cursor = index - 1; cursor >= 0 && value[cursor] === "\\"; cursor -= 1) {
    slashCount += 1;
  }
  return slashCount % 2 === 1;
}

export function splitSelectorList(selectorText: string) {
  const selectors: string[] = [];
  let start = 0;
  let parenthesesDepth = 0;
  let bracketDepth = 0;
  let quote = "";

  for (let index = 0; index < selectorText.length; index += 1) {
    const char = selectorText[index];

    if (quote) {
      if (char === quote && !isEscaped(selectorText, index)) quote = "";
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }

    if (char === "[") {
      bracketDepth += 1;
      continue;
    }

    if (char === "]" && bracketDepth > 0) {
      bracketDepth -= 1;
      continue;
    }

    if (bracketDepth > 0) continue;

    if (char === "(") {
      parenthesesDepth += 1;
      continue;
    }

    if (char === ")" && parenthesesDepth > 0) {
      parenthesesDepth -= 1;
      continue;
    }

    if (char === "," && parenthesesDepth === 0) {
      selectors.push(selectorText.slice(start, index).trim());
      start = index + 1;
    }
  }

  selectors.push(selectorText.slice(start).trim());
  return selectors.filter(Boolean);
}

function selectorContainsHover(selector: string) {
  let bracketDepth = 0;
  let quote = "";

  for (let index = 0; index < selector.length; index += 1) {
    const char = selector[index];

    if (quote) {
      if (char === quote && !isEscaped(selector, index)) quote = "";
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }

    if (char === "[") {
      bracketDepth += 1;
      continue;
    }

    if (char === "]" && bracketDepth > 0) {
      bracketDepth -= 1;
      continue;
    }

    if (bracketDepth > 0) continue;

    if (selector.slice(index).match(/^:hover(?:\b|\()/i)) return true;
  }

  return false;
}

export function selectorListWithoutHover(selectorText: string) {
  return splitSelectorList(selectorText)
    .filter((selector) => !selectorContainsHover(selector))
    .join(", ");
}

function styleRuleText(selectorText: string, rule: MutableCssRule) {
  const declarationText = rule.style?.cssText;
  if (declarationText) return `${selectorText} { ${declarationText} }`;

  const cssText = rule.cssText ?? "";
  const blockStart = cssText.indexOf("{");
  const blockEnd = cssText.lastIndexOf("}");
  if (blockStart === -1 || blockEnd === -1 || blockEnd <= blockStart) return "";
  return `${selectorText} ${cssText.slice(blockStart, blockEnd + 1)}`;
}

function replaceRuleSelector(
  container: MutableCssRuleContainer,
  rule: MutableCssRule,
  index: number,
  selectorText: string,
) {
  try {
    rule.selectorText = selectorText;
    return true;
  } catch {
    // Some CSSOM implementations expose selectorText as read-only for particular rules.
  }

  if (!container.insertRule || !container.deleteRule) return false;

  const replacement = styleRuleText(selectorText, rule);
  if (!replacement) return false;

  try {
    container.insertRule(replacement, index);
    container.deleteRule(index + 1);
    return true;
  } catch {
    return false;
  }
}

export function neutralizeHoverRulesInContainer(container: MutableCssRuleContainer) {
  const rules = readableCssRules(container);
  if (!rules) return 0;

  let changed = 0;

  for (let index = rules.length - 1; index >= 0; index -= 1) {
    const rule = rules[index] as MutableCssRule;
    const nestedRules = readableCssRules(rule);
    if (nestedRules) {
      changed += neutralizeHoverRulesInContainer(rule as MutableCssRuleContainer);
    }

    const selectorText = rule.selectorText;
    if (!selectorText || !selectorContainsHover(selectorText)) continue;

    const nextSelectorText = selectorListWithoutHover(selectorText);
    if (!nextSelectorText) {
      try {
        container.deleteRule?.(index);
        changed += 1;
      } catch {
        // A locked stylesheet should not break the rest of the preview.
      }
      continue;
    }

    if (nextSelectorText !== selectorText && replaceRuleSelector(container, rule, index, nextSelectorText)) {
      changed += 1;
    }
  }

  return changed;
}

function isTinymodsRuntimeStyle(styleSheet: StyleSheet) {
  const ownerNode = styleSheet.ownerNode;
  if (!(ownerNode instanceof Element)) return false;

  if (ownerNode.id === TINYMODS_SLIDER_STYLE_ID) return true;
  return ownerNode.hasAttribute(TINYMODS_PREVIEW_STYLE_ATTRIBUTE);
}

export function installPreviewHoverNeutralizer(document: Document) {
  let changed = 0;

  for (const styleSheet of Array.from(document.styleSheets)) {
    if (isTinymodsRuntimeStyle(styleSheet)) continue;
    changed += neutralizeHoverRulesInContainer(styleSheet as MutableCssRuleContainer);
  }

  return { changed };
}
