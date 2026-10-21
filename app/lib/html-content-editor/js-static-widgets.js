const STATIC_STATE_CLASSES = ["is-mounted", "is-shifted", "is-expanded"];

function findTagEnd(source, start) {
  let quote = "";
  for (let index = start + 1; index < source.length; index += 1) {
    const char = source[index];
    if (quote) {
      if (char === quote) quote = "";
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === ">") return index;
  }
  return -1;
}

function findStringEnd(source, valueStart, quote) {
  for (let index = valueStart; index < source.length; index += 1) {
    const char = source[index];
    if (char === "\\") {
      index += 1;
      continue;
    }
    if (char === quote) return index;
  }
  return -1;
}

function decodeStaticStringLiteral(rawValue) {
  return rawValue.replace(/\\([\\'"`$nrt])/g, (_match, escaped) => {
    if (escaped === "n") return "\n";
    if (escaped === "r") return "\r";
    if (escaped === "t") return "\t";
    return escaped;
  });
}

function scanStaticConstants(script, scriptStart) {
  const constants = new Map();
  const declarationPattern = /\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*(["'`])/g;

  for (const match of script.matchAll(declarationPattern)) {
    const name = match[1];
    const quote = match[2];
    const valueStart = (match.index ?? 0) + match[0].length;
    const valueEnd = findStringEnd(script, valueStart, quote);
    if (valueEnd === -1) continue;

    const rawValue = script.slice(valueStart, valueEnd);
    if (quote === "`" && rawValue.includes("${")) continue;
    if ((quote === '"' || quote === "'") && /[\r\n]/.test(rawValue)) continue;

    constants.set(name, {
      value: decodeStaticStringLiteral(rawValue),
      range: {
        start: scriptStart + valueStart,
        end: scriptStart + valueEnd,
      },
      quote,
    });
  }

  return constants;
}

function appendMappedText(target, value, sourceStart) {
  target.html += value;
  for (let index = 0; index < value.length; index += 1) {
    target.map.push(sourceStart + index);
  }
}

function appendMappedConstant(target, constant) {
  target.html += constant.value;
  for (let index = 0; index < constant.value.length; index += 1) {
    target.map.push(constant.range.start + Math.min(index, constant.range.end - constant.range.start - 1));
  }
}

function findTemplateEnd(script, valueStart) {
  let expressionDepth = 0;

  for (let index = valueStart; index < script.length; index += 1) {
    const char = script[index];
    if (char === "\\") {
      index += 1;
      continue;
    }
    if (expressionDepth === 0 && char === "`") return index;
    if (script.startsWith("${", index)) {
      expressionDepth += 1;
      index += 1;
      continue;
    }
    if (expressionDepth > 0 && char === "}") {
      expressionDepth -= 1;
    }
  }

  return -1;
}

function renderTemplate(script, templateStart, templateEnd, scriptStart, constants) {
  const rendered = { html: "", map: [] };
  let cursor = templateStart;

  while (cursor < templateEnd) {
    if (script.startsWith("${", cursor)) {
      const expressionEnd = script.indexOf("}", cursor + 2);
      if (expressionEnd === -1 || expressionEnd > templateEnd) return null;

      const expression = script.slice(cursor + 2, expressionEnd).trim();
      if (!/^[A-Za-z_$][\w$]*$/.test(expression)) return null;

      const constant = constants.get(expression);
      if (!constant) return null;

      appendMappedConstant(rendered, constant);
      cursor = expressionEnd + 1;
      continue;
    }

    appendMappedText(rendered, script[cursor], scriptStart + cursor);
    cursor += 1;
  }

  return rendered;
}

export function renderStaticJsWidgets(source) {
  const widgets = [];
  let cursor = 0;

  while (cursor < source.length) {
    const scriptStart = source.slice(cursor).search(/<script\b/i);
    const absoluteScriptStart = scriptStart === -1 ? -1 : scriptStart + cursor;
    if (absoluteScriptStart === -1) break;

    const openEnd = findTagEnd(source, absoluteScriptStart);
    if (openEnd === -1) break;
    const closeMatch = /<\/script\s*>/i.exec(source.slice(openEnd + 1));
    if (!closeMatch) break;

    const scriptContentStart = openEnd + 1;
    const scriptContentEnd = scriptContentStart + closeMatch.index;
    const script = source.slice(scriptContentStart, scriptContentEnd);
    const constants = scanStaticConstants(script, scriptContentStart);
    const assignmentPattern = /\binnerHTML\s*=\s*`/g;

    for (const match of script.matchAll(assignmentPattern)) {
      const templateStart = (match.index ?? 0) + match[0].length;
      const templateEnd = findTemplateEnd(script, templateStart);
      if (templateEnd === -1) continue;

      const rendered = renderTemplate(
        script,
        templateStart,
        templateEnd,
        scriptContentStart,
        constants,
      );
      if (rendered) widgets.push(rendered);
    }

    cursor = scriptContentEnd + closeMatch[0].length;
  }

  return widgets;
}

export function buildStaticJsPreviewSource(source, entities) {
  const chunks = [];
  const sourceMap = [];
  let cursor = 0;
  let hasStaticWidget = false;

  while (cursor < source.length) {
    const relativeScriptStart = source.slice(cursor).search(/<script\b/i);
    const scriptStart = relativeScriptStart === -1 ? -1 : cursor + relativeScriptStart;
    if (scriptStart === -1) break;

    const openEnd = findTagEnd(source, scriptStart);
    if (openEnd === -1) break;
    const closeMatch = /<\/script\s*>/i.exec(source.slice(openEnd + 1));
    if (!closeMatch) break;

    const scriptEnd = openEnd + 1 + closeMatch.index + closeMatch[0].length;
    const widgets = renderStaticJsWidgets(source.slice(scriptStart, scriptEnd));

    chunks.push(source.slice(cursor, scriptStart));
    for (let index = cursor; index < scriptStart; index += 1) sourceMap.push(index);

    if (widgets.length > 0) {
      hasStaticWidget = true;
      const scriptOffset = scriptStart;
      widgets.forEach((widget, index) => {
        if (index > 0) {
          chunks.push("\n");
          sourceMap.push(null);
        }
        chunks.push(widget.html);
        for (const mapped of widget.map) {
          sourceMap.push(mapped === null ? null : mapped + scriptOffset);
        }
      });
    } else {
      chunks.push(source.slice(scriptStart, scriptEnd));
      for (let index = scriptStart; index < scriptEnd; index += 1) sourceMap.push(index);
    }

    cursor = scriptEnd;
  }

  chunks.push(source.slice(cursor));
  for (let index = cursor; index < source.length; index += 1) sourceMap.push(index);

  const previewSource = chunks.join("");
  const outputPositionsBySourcePosition = new Map();
  sourceMap.forEach((sourcePosition, outputPosition) => {
    if (sourcePosition === null) return;
    const positions = outputPositionsBySourcePosition.get(sourcePosition) ?? [];
    positions.push(outputPosition);
    outputPositionsBySourcePosition.set(sourcePosition, positions);
  });

  const rangesBySourceRange = new Map();
  for (const entity of entities) {
    const outputPositions = [];
    for (let sourcePosition = entity.range.start; sourcePosition < entity.range.end; sourcePosition += 1) {
      outputPositions.push(...(outputPositionsBySourcePosition.get(sourcePosition) ?? []));
    }
    if (outputPositions.length === 0) continue;

    outputPositions.sort((left, right) => left - right);
    const start = outputPositions[0];
    const end = outputPositions.at(-1) + 1;
    if (end - start !== outputPositions.length) continue;

    rangesBySourceRange.set(`${entity.range.start}:${entity.range.end}`, { start, end });
    rangesBySourceRange.set(entity.id, { start, end });
  }

  return {
    source: previewSource,
    rangesBySourceRange,
    hasStaticWidget,
  };
}

export function addStaticWidgetPreviewState(source) {
  return source.replace(/\bclass=(["'])([^"']*)\1/, (match, quote, classes) => {
    const classSet = new Set(classes.split(/\s+/).filter(Boolean));
    for (const stateClass of STATIC_STATE_CLASSES) classSet.add(stateClass);
    return `class=${quote}${[...classSet].join(" ")}${quote}`;
  });
}
