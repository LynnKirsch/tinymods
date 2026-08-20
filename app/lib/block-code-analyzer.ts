export interface DetectedBlockSize {
  width: number;
  screen: string;
  source: "tilda" | "css" | "inline" | "calculated";
}

export interface BlockCodeAnalysis {
  sizes: DetectedBlockSize[];
  warnings: string[];
}

const MIN_USEFUL_WIDTH = 120;
const MAX_USEFUL_WIDTH = 2560;
const IMAGE_WORDS =
  /(?:^|[-_])(img|image|photo|picture|pic|thumb|cover|hero|card|media|banner|bgimg)(?:$|[-_])/i;

function numberFrom(value: string) {
  const width = Math.round(Number(value.replace(",", ".")));
  return Number.isFinite(width) ? width : null;
}

function screenFromMedia(query: string) {
  const min = query.match(/min-width\s*:\s*(\d+(?:\.\d+)?)px/i);
  const max = query.match(/max-width\s*:\s*(\d+(?:\.\d+)?)px/i);
  if (min && max) return `${Math.round(Number(min[1]))}–${Math.round(Number(max[1]))}px`;
  if (min) return `от ${Math.round(Number(min[1]))}px`;
  if (max) return `до ${Math.round(Number(max[1]))}px`;
  return "Адаптивный экран";
}

function readAttribute(tag: string, name: string) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = tag.match(
    new RegExp(`${escaped}\\s*=\\s*(?:["']([^"']*)["']|([^\\s>]+))`, "i"),
  );
  return match?.[1] ?? match?.[2] ?? null;
}

function pushSize(
  target: DetectedBlockSize[],
  width: number | null,
  screen: string,
  source: DetectedBlockSize["source"],
) {
  if (width === null || width < MIN_USEFUL_WIDTH || width > MAX_USEFUL_WIDTH) return;
  target.push({ width, screen, source });
}

function imageLikeTag(tag: string) {
  if (/<(?:img|picture|source)\b/i.test(tag)) return true;
  if (/data-elem-type\s*=\s*["']image["']/i.test(tag)) return true;
  if (/background-image\s*:/i.test(tag) || /\bt-bgimg\b/i.test(tag)) return true;
  const className = readAttribute(tag, "class") ?? "";
  const id = readAttribute(tag, "id") ?? "";
  return [...className.split(/\s+/), id].some((token) => IMAGE_WORDS.test(token));
}

function addTagTokens(tag: string, tokens: Set<string>) {
  const className = readAttribute(tag, "class") ?? "";
  for (const token of className.split(/\s+/)) {
    if (token) tokens.add(token);
  }
  const id = readAttribute(tag, "id");
  if (id) tokens.add(id);
}

function collectRelevantTokens(code: string) {
  const tokens = new Set<string>();
  const ancestors: string[] = [];
  for (const match of code.matchAll(/<\/?[^>]+>/g)) {
    const tag = match[0];
    if (/^<\//.test(tag)) {
      ancestors.pop();
      continue;
    }

    if (imageLikeTag(tag)) {
      addTagTokens(tag, tokens);
      for (const ancestor of ancestors) addTagTokens(ancestor, tokens);
    }

    if (!/\/>$/.test(tag) && !/^<(?:img|source|meta|link|input|br|hr)\b/i.test(tag)) {
      ancestors.push(tag);
    }
  }
  return tokens;
}

function selectorLooksRelevant(selector: string, tokens: Set<string>) {
  if (/(?:^|[\s>+~,.#:\[])(?:img|picture|source)(?:\b|[.#:\[])/i.test(selector)) return true;
  if (IMAGE_WORDS.test(selector.replace(/[.#:\[\]="']/g, "-"))) return true;
  for (const token of tokens) {
    const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`(?:\\.|#)${escaped}(?![\\w-])`).test(selector)) return true;
  }
  return false;
}

function selectorMatchesTokens(selector: string, tokens: Set<string>) {
  for (const token of tokens) {
    const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`(?:\\.|#)${escaped}(?![\\w-])`).test(selector)) return true;
  }
  return false;
}

function matchingBrace(css: string, openIndex: number) {
  let depth = 0;
  let quote = "";
  for (let index = openIndex; index < css.length; index += 1) {
    const char = css[index];
    const previous = css[index - 1];
    if (quote) {
      if (char === quote && previous !== "\\") quote = "";
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === "{") depth += 1;
    if (char === "}") depth -= 1;
    if (depth === 0) return index;
  }
  return -1;
}

type MediaRange = {
  key: string;
  label: string;
  min: number | null;
  max: number | null;
};

type ParsedCssRule = {
  selector: string;
  body: string;
  media: MediaRange | null;
  order: number;
};

type LayoutState = {
  paddingLeft?: number;
  paddingRight?: number;
  columns?: number;
  gap?: number;
  maxWidth?: number;
};

function mediaRange(query: string): MediaRange {
  const minMatch = query.match(/min-width\s*:\s*(\d+(?:\.\d+)?)px/i);
  const maxMatch = query.match(/max-width\s*:\s*(\d+(?:\.\d+)?)px/i);
  const min = minMatch ? Math.round(Number(minMatch[1])) : null;
  const max = maxMatch ? Math.round(Number(maxMatch[1])) : null;
  return {
    key: `${min ?? ""}:${max ?? ""}`,
    label: screenFromMedia(query),
    min,
    max,
  };
}

function collectCssRules(
  css: string,
  rules: ParsedCssRule[],
  media: MediaRange | null = null,
) {
  let cursor = 0;
  while (cursor < css.length) {
    const openIndex = css.indexOf("{", cursor);
    if (openIndex === -1) return;
    const closeIndex = matchingBrace(css, openIndex);
    if (closeIndex === -1) return;

    const header = css.slice(cursor, openIndex).trim().replace(/^;+/, "").trim();
    const body = css.slice(openIndex + 1, closeIndex);
    if (/^@media\b/i.test(header)) {
      collectCssRules(body, rules, mediaRange(header));
    } else if (/^@(supports|layer|container)\b/i.test(header)) {
      collectCssRules(body, rules, media);
    } else if (header && !header.startsWith("@")) {
      rules.push({ selector: header, body, media, order: rules.length });
    }
    cursor = closeIndex + 1;
  }
}

function lastPxDeclaration(body: string, property: string) {
  const escaped = property.replace("-", "\\-");
  const pattern = new RegExp(
    `(?:^|;)\\s*${escaped}\\s*:\\s*(\\d+(?:[.,]\\d+)?)px\\b`,
    "gi",
  );
  let value: number | undefined;
  for (const match of body.matchAll(pattern)) {
    value = numberFrom(match[1]) ?? undefined;
  }
  return value;
}

function horizontalPadding(body: string) {
  const patch: LayoutState = {};
  const shorthand = /(?:^|;)\s*padding\s*:\s*([^;]+)/gi;
  for (const match of body.matchAll(shorthand)) {
    const values = match[1].trim().split(/\s+/);
    const parsed = values.map((value) => {
      if (value === "0") return 0;
      const px = value.match(/^(\d+(?:[.,]\d+)?)px$/i);
      return px ? numberFrom(px[1]) : null;
    });
    if (parsed.some((value) => value === null)) continue;
    if (parsed.length === 1) {
      patch.paddingLeft = parsed[0] ?? undefined;
      patch.paddingRight = parsed[0] ?? undefined;
    } else if (parsed.length === 2 || parsed.length === 3) {
      patch.paddingLeft = parsed[1] ?? undefined;
      patch.paddingRight = parsed[1] ?? undefined;
    } else if (parsed.length >= 4) {
      patch.paddingRight = parsed[1] ?? undefined;
      patch.paddingLeft = parsed[3] ?? undefined;
    }
  }
  const paddingLeft = lastPxDeclaration(body, "padding-left");
  const paddingRight = lastPxDeclaration(body, "padding-right");
  if (paddingLeft !== undefined) patch.paddingLeft = paddingLeft;
  if (paddingRight !== undefined) patch.paddingRight = paddingRight;
  return patch;
}

function layoutPatch(body: string) {
  const patch = horizontalPadding(body);
  const columnsMatches = [
    ...body.matchAll(/grid-template-columns\s*:\s*repeat\(\s*(\d+)\s*,/gi),
  ];
  if (columnsMatches.length) {
    patch.columns = Math.max(1, Number(columnsMatches.at(-1)?.[1]));
  }
  const gap = lastPxDeclaration(body, "gap") ?? lastPxDeclaration(body, "column-gap");
  if (gap !== undefined) patch.gap = gap;
  const maxWidth = lastPxDeclaration(body, "max-width");
  if (maxWidth !== undefined) patch.maxWidth = maxWidth;
  return patch;
}

function mergeLayout(current: LayoutState, patch: LayoutState) {
  return { ...current, ...patch };
}

function calculateFluidGridSizes(
  rules: ParsedCssRule[],
  tokens: Set<string>,
  sizes: DetectedBlockSize[],
) {
  const relevantRules = rules.filter((rule) => selectorMatchesTokens(rule.selector, tokens));
  const layoutRules = relevantRules.filter((rule) => {
    const patch = layoutPatch(rule.body);
    return Object.keys(patch).length > 0;
  });
  const ranges = [
    ...new Map(
      layoutRules
        .filter((rule) => rule.media && (rule.media.min !== null || rule.media.max !== null))
        .map((rule) => [rule.media!.key, rule.media!]),
    ).values(),
  ];
  if (!ranges.length) return { calculated: false, openEnded: false };

  const hasLowerRange = ranges.some((range) => range.min === null);
  const lowestMin = Math.min(
    ...ranges.flatMap((range) => (range.min === null ? [] : [range.min])),
  );
  if (!hasLowerRange && Number.isFinite(lowestMin) && lowestMin > 320) {
    ranges.push({
      key: `:${lowestMin - 1}`,
      label: `до ${lowestMin - 1}px`,
      min: null,
      max: lowestMin - 1,
    });
  }

  let calculated = false;
  let openEnded = false;
  for (const range of ranges) {
    const viewport = range.max ?? range.min;
    if (!viewport) continue;
    const stateBySelector = new Map<string, LayoutState>();
    for (const rule of layoutRules.sort((a, b) => a.order - b.order)) {
      const applies =
        !rule.media ||
        ((rule.media.min === null || viewport >= rule.media.min) &&
          (rule.media.max === null || viewport <= rule.media.max));
      if (!applies) continue;
      const current = stateBySelector.get(rule.selector) ?? {};
      stateBySelector.set(rule.selector, mergeLayout(current, layoutPatch(rule.body)));
    }

    const states = [...stateBySelector.values()];
    const gridState = states.findLast((state) => state.columns !== undefined);
    const columns = gridState?.columns;
    if (!columns) continue;
    const gap = gridState.gap ?? 0;
    const paddingLeft = states.reduce((sum, state) => sum + (state.paddingLeft ?? 0), 0);
    const paddingRight = states.reduce((sum, state) => sum + (state.paddingRight ?? 0), 0);
    const fixedLimits = states.flatMap((state) =>
      state.maxWidth === undefined ? [] : [state.maxWidth],
    );
    const availableWidth = Math.min(
      viewport - paddingLeft - paddingRight,
      fixedLimits.length ? Math.min(...fixedLimits) : Number.POSITIVE_INFINITY,
    );
    const cardWidth = Math.ceil((availableWidth - gap * (columns - 1)) / columns);
    const isOpenEnded = range.max === null && range.min !== null;
    pushSize(
      sizes,
      cardWidth,
      isOpenEnded
        ? `${range.label} · расчёт при ${viewport}px`
        : `${range.label} · максимальная карточка`,
      "calculated",
    );
    calculated = true;
    openEnded ||= isOpenEnded;
  }
  return { calculated, openEnded };
}

function scanCssRules(
  rules: ParsedCssRule[],
  sizes: DetectedBlockSize[],
  tokens: Set<string>,
) {
  for (const rule of rules) {
    if (!selectorLooksRelevant(rule.selector, tokens)) continue;
    const screen = rule.media?.label ?? "Основной экран";
    const widthPattern = /(?:^|;)\s*(?:width|max-width|flex-basis)\s*:\s*(\d+(?:[.,]\d+)?)px\b/gi;
    for (const match of rule.body.matchAll(widthPattern)) {
      pushSize(sizes, numberFrom(match[1]), screen, "css");
    }
    const columnPattern = /grid-template-columns\s*:[^;}]*?\b(\d+(?:[.,]\d+)?)px\b/gi;
    for (const match of rule.body.matchAll(columnPattern)) {
      pushSize(sizes, numberFrom(match[1]), screen, "css");
    }
  }
}

function scanTagSizes(tag: string, sizes: DetectedBlockSize[]) {
    const style = readAttribute(tag, "style") ?? "";
    const styleWidth = style.match(/(?:^|;)\s*(?:width|max-width)\s*:\s*(\d+(?:[.,]\d+)?)px\b/i);
    if (styleWidth) pushSize(sizes, numberFrom(styleWidth[1]), "Основной экран", "inline");

    const baseWidth = readAttribute(tag, "data-field-width-value");
    const baseUnits = readAttribute(tag, "data-field-widthunits-value") ?? "px";
    if (baseWidth && baseUnits.toLowerCase() === "px") {
      pushSize(sizes, numberFrom(baseWidth), "Основной экран", "tilda");
    }

    const responsivePattern = /data-field-width-res-(\d+)-value\s*=\s*(?:["']([^"']+)["']|([^\s>]+))/gi;
    for (const match of tag.matchAll(responsivePattern)) {
      const breakpoint = match[1];
      const value = match[2] ?? match[3];
      const units =
        readAttribute(tag, `data-field-widthunits-res-${breakpoint}-value`) ?? baseUnits;
      if (units.toLowerCase() === "px") {
        pushSize(sizes, numberFrom(value), `Брейкпоинт ${breakpoint}px`, "tilda");
      }
    }
}

function scanImageTags(code: string, sizes: DetectedBlockSize[]) {
  const ancestors: string[] = [];
  for (const match of code.matchAll(/<\/?[^>]+>/g)) {
    const tag = match[0];
    if (/^<\//.test(tag)) {
      ancestors.pop();
      continue;
    }

    if (imageLikeTag(tag)) {
      scanTagSizes(tag, sizes);
      for (const ancestor of ancestors.slice(-3)) {
        if (/data-field-width|style\s*=/i.test(ancestor)) {
          scanTagSizes(ancestor, sizes);
        }
      }
    }

    if (!/\/>$/.test(tag) && !/^<(?:img|source|meta|link|input|br|hr)\b/i.test(tag)) {
      ancestors.push(tag);
    }
  }
}

export function analyzeBlockCode(code: string): BlockCodeAnalysis {
  const cleanCode = code
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ");
  const sizes: DetectedBlockSize[] = [];
  const warnings: string[] = [];
  const tokens = collectRelevantTokens(cleanCode);

  scanImageTags(cleanCode, sizes);
  const styleBlocks = [...cleanCode.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map(
    (match) => match[1],
  );
  const cssRules: ParsedCssRule[] = [];
  for (const css of styleBlocks.length ? styleBlocks : [cleanCode]) {
    collectCssRules(css, cssRules);
  }
  scanCssRules(cssRules, sizes, tokens);
  const fluidGrid = calculateFluidGridSizes(cssRules, tokens, sizes);

  if (fluidGrid.calculated) {
    warnings.push(
      "Ширина карточки меняется вместе с экраном. Рассчитан максимальный размер внутри каждого CSS-диапазона.",
    );
  } else if (/\b(?:width|max-width)\s*:\s*(?:100%|\d+(?:\.\d+)?(?:vw|%))/i.test(cleanCode)) {
    warnings.push(
      "В коде есть относительные размеры. Для файлов используем найденные фиксированные размеры внешнего контейнера.",
    );
  }
  if (fluidGrid.openEnded) {
    warnings.push(
      "Последний диапазон не имеет верхней границы. Его размер рассчитан для указанной начальной ширины экрана.",
    );
  }
  if (/\b(?:width|max-width)\s*:\s*(?:calc|clamp|min|max)\(/i.test(cleanCode)) {
    warnings.push(
      "Часть размеров вычисляется браузером через calc() или clamp(); используем найденные фиксированные значения.",
    );
  }

  const uniqueSizes = sizes
    .filter(
      (item, index, all) =>
        all.findIndex(
          (candidate) =>
            candidate.width === item.width && candidate.screen === item.screen,
        ) === index,
    )
    .sort((a, b) => a.width - b.width || a.screen.localeCompare(b.screen, "ru"));

  return { sizes: uniqueSizes, warnings };
}
