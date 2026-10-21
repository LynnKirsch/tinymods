const STYLE_TAG_PATTERN = /<style\b[^>]*>([\s\S]*?)<\/style>/gi;
const STYLE_ATTRIBUTE_PATTERN = /\sstyle\s*=\s*("([^"]*)"|'([^']*)')/gi;
const VARIABLE_DEFINITION_PATTERN = /(--[A-Za-z0-9_-]+)\s*:/g;
const VARIABLE_REFERENCE_PATTERN = /var\(\s*(--[A-Za-z0-9_-]+)/g;

export type PreviewAppearanceInput = {
  siteCss?: string;
  pageCss?: string;
  blockSource: string;
};

export type PreviewAppearance = {
  css: string;
  unresolvedVariables: string[];
  needsAppearance: boolean;
};

function collectMatches(pattern: RegExp, source: string) {
  return [...source.matchAll(pattern)].map((match) => match[1]).filter(Boolean);
}

function blockCssFromSource(source: string) {
  const styleTags = collectMatches(STYLE_TAG_PATTERN, source);
  const inlineStyles = [...source.matchAll(STYLE_ATTRIBUTE_PATTERN)]
    .map((match) => match[2] ?? match[3] ?? "")
    .filter(Boolean);
  return [...styleTags, ...inlineStyles].join("\n");
}

function definedVariables(css: string) {
  return new Set(collectMatches(VARIABLE_DEFINITION_PATTERN, css));
}

function referencedVariables(css: string) {
  return new Set(collectMatches(VARIABLE_REFERENCE_PATTERN, css));
}

export function buildPreviewAppearance(input: PreviewAppearanceInput): PreviewAppearance {
  const siteCss = input.siteCss?.trim() ?? "";
  const pageCss = input.pageCss?.trim() ?? "";
  const blockCss = blockCssFromSource(input.blockSource);
  const cascadeCss = [siteCss, pageCss].filter(Boolean).join("\n\n");
  const allCss = [cascadeCss, blockCss].filter(Boolean).join("\n\n");
  const defined = definedVariables(allCss);
  const unresolvedVariables = [...referencedVariables(blockCss)]
    .filter((name) => !defined.has(name))
    .sort();

  return {
    css: cascadeCss,
    unresolvedVariables,
    needsAppearance: unresolvedVariables.length > 0,
  };
}
