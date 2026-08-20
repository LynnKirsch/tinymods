export type CurvePoint = { x: number; y: number };

export type CurveNodeType = "smooth" | "corner";

export type CurveNode = {
  id: string;
  x: number;
  y: number;
  handleIn: CurvePoint;
  handleOut: CurvePoint;
  type: CurveNodeType;
};

export type CurveSubpath = {
  id: string;
  nodes: CurveNode[];
  closed: boolean;
};

export type CurvePaint = {
  fill: string;
  stroke: string;
  strokeWidth: number;
  strokeLinecap: "butt" | "round" | "square";
  strokeLinejoin: "miter" | "round" | "bevel";
  fillRule: "nonzero" | "evenodd";
  opacity: number;
};

export type CurvePath = {
  id: string;
  paint: CurvePaint;
  subpaths: CurveSubpath[];
};

export type CurveDocument = {
  width: number;
  height: number;
  viewBox: { x: number; y: number; width: number; height: number };
  paths: CurvePath[];
};

type PathToken = { kind: "command"; value: string } | { kind: "number"; value: number };

let nextId = 0;

function id(prefix: string) {
  nextId += 1;
  return `${prefix}-${nextId}`;
}

function point(x: number, y: number): CurvePoint {
  return { x, y };
}

function distance(first: CurvePoint, second: CurvePoint) {
  return Math.hypot(first.x - second.x, first.y - second.y);
}

function tokenizePathData(pathData: string) {
  const tokens: PathToken[] = [];
  const matcher = /([AaCcHhLlMmQqSsTtVvZz])|([-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?)/g;
  for (const match of pathData.matchAll(matcher)) {
    if (match[1]) tokens.push({ kind: "command", value: match[1] });
    else tokens.push({ kind: "number", value: Number(match[2]) });
  }
  return tokens;
}

function vectorAngle(first: CurvePoint, second: CurvePoint) {
  const dot = first.x * second.x + first.y * second.y;
  const determinant = first.x * second.y - first.y * second.x;
  return Math.atan2(determinant, dot);
}

function arcToCubics(
  start: CurvePoint,
  radiusX: number,
  radiusY: number,
  rotationDegrees: number,
  largeArc: boolean,
  sweep: boolean,
  end: CurvePoint,
) {
  let rx = Math.abs(radiusX);
  let ry = Math.abs(radiusY);
  if (!rx || !ry || distance(start, end) < 1e-9) return [];

  const rotation = rotationDegrees * Math.PI / 180;
  const cosRotation = Math.cos(rotation);
  const sinRotation = Math.sin(rotation);
  const halfX = (start.x - end.x) / 2;
  const halfY = (start.y - end.y) / 2;
  const transformedX = cosRotation * halfX + sinRotation * halfY;
  const transformedY = -sinRotation * halfX + cosRotation * halfY;
  const radiiScale = transformedX ** 2 / rx ** 2 + transformedY ** 2 / ry ** 2;
  if (radiiScale > 1) {
    const scale = Math.sqrt(radiiScale);
    rx *= scale;
    ry *= scale;
  }

  const numerator = Math.max(
    0,
    rx ** 2 * ry ** 2 - rx ** 2 * transformedY ** 2 - ry ** 2 * transformedX ** 2,
  );
  const denominator = Math.max(
    1e-12,
    rx ** 2 * transformedY ** 2 + ry ** 2 * transformedX ** 2,
  );
  const sign = largeArc === sweep ? -1 : 1;
  const factor = sign * Math.sqrt(numerator / denominator);
  const centerPrimeX = factor * rx * transformedY / ry;
  const centerPrimeY = factor * -ry * transformedX / rx;
  const centerX = cosRotation * centerPrimeX - sinRotation * centerPrimeY + (start.x + end.x) / 2;
  const centerY = sinRotation * centerPrimeX + cosRotation * centerPrimeY + (start.y + end.y) / 2;

  const startVector = {
    x: (transformedX - centerPrimeX) / rx,
    y: (transformedY - centerPrimeY) / ry,
  };
  const endVector = {
    x: (-transformedX - centerPrimeX) / rx,
    y: (-transformedY - centerPrimeY) / ry,
  };
  let startAngle = vectorAngle({ x: 1, y: 0 }, startVector);
  let sweepAngle = vectorAngle(startVector, endVector);
  if (!sweep && sweepAngle > 0) sweepAngle -= Math.PI * 2;
  if (sweep && sweepAngle < 0) sweepAngle += Math.PI * 2;
  const segmentCount = Math.max(1, Math.ceil(Math.abs(sweepAngle) / (Math.PI / 2)));
  const segmentAngle = sweepAngle / segmentCount;

  const positionAt = (angle: number) => ({
    x: centerX + cosRotation * rx * Math.cos(angle) - sinRotation * ry * Math.sin(angle),
    y: centerY + sinRotation * rx * Math.cos(angle) + cosRotation * ry * Math.sin(angle),
  });
  const derivativeAt = (angle: number) => ({
    x: -cosRotation * rx * Math.sin(angle) - sinRotation * ry * Math.cos(angle),
    y: -sinRotation * rx * Math.sin(angle) + cosRotation * ry * Math.cos(angle),
  });

  const segments: Array<{ controlOne: CurvePoint; controlTwo: CurvePoint; end: CurvePoint }> = [];
  for (let segment = 0; segment < segmentCount; segment += 1) {
    const endAngle = startAngle + segmentAngle;
    const startPoint = positionAt(startAngle);
    const endPoint = segment === segmentCount - 1 ? end : positionAt(endAngle);
    const scale = 4 / 3 * Math.tan(segmentAngle / 4);
    const startDerivative = derivativeAt(startAngle);
    const endDerivative = derivativeAt(endAngle);
    segments.push({
      controlOne: {
        x: startPoint.x + startDerivative.x * scale,
        y: startPoint.y + startDerivative.y * scale,
      },
      controlTwo: {
        x: endPoint.x - endDerivative.x * scale,
        y: endPoint.y - endDerivative.y * scale,
      },
      end: endPoint,
    });
    startAngle = endAngle;
  }
  return segments;
}

function curveNode(x: number, y: number, handleIn = point(x, y)): CurveNode {
  return {
    id: id("node"),
    x,
    y,
    handleIn,
    handleOut: point(x, y),
    type: "corner",
  };
}

function inferNodeTypes(subpath: CurveSubpath) {
  for (const node of subpath.nodes) {
    const incoming = { x: node.handleIn.x - node.x, y: node.handleIn.y - node.y };
    const outgoing = { x: node.handleOut.x - node.x, y: node.handleOut.y - node.y };
    const incomingLength = Math.hypot(incoming.x, incoming.y);
    const outgoingLength = Math.hypot(outgoing.x, outgoing.y);
    if (incomingLength < 1e-4 || outgoingLength < 1e-4) {
      node.type = "corner";
      continue;
    }
    const cosine = (incoming.x * outgoing.x + incoming.y * outgoing.y) /
      (incomingLength * outgoingLength);
    node.type = cosine < -0.985 ? "smooth" : "corner";
  }
}

export function parsePathData(pathData: string): CurveSubpath[] {
  const tokens = tokenizePathData(pathData);
  const subpaths: CurveSubpath[] = [];
  let tokenIndex = 0;
  let command = "";
  let lastCommand = "";
  let currentX = 0;
  let currentY = 0;
  let lastCubicControl: CurvePoint | null = null;
  let lastQuadraticControl: CurvePoint | null = null;
  let active: CurveSubpath | null = null;

  const hasNumber = () => tokens[tokenIndex]?.kind === "number";
  const readNumber = () => {
    const token = tokens[tokenIndex];
    if (!token || token.kind !== "number") throw new Error("Некорректная команда SVG-path.");
    tokenIndex += 1;
    return token.value;
  };
  const absolute = (x: number, y: number, relative: boolean) =>
    relative ? point(currentX + x, currentY + y) : point(x, y);
  const ensureActive = () => {
    if (!active || !active.nodes.length) throw new Error("SVG-path начинается без точки M.");
    return active;
  };
  const addSegment = (end: CurvePoint, controlOne: CurvePoint, controlTwo: CurvePoint) => {
    const target = ensureActive();
    const previous = target.nodes[target.nodes.length - 1];
    previous.handleOut = controlOne;
    target.nodes.push(curveNode(end.x, end.y, controlTwo));
    currentX = end.x;
    currentY = end.y;
  };

  while (tokenIndex < tokens.length) {
    const token = tokens[tokenIndex];
    if (token.kind === "command") {
      command = token.value;
      tokenIndex += 1;
    } else if (!command) {
      throw new Error("В SVG-path пропущена команда.");
    }

    const upper = command.toUpperCase();
    const relative = command !== upper;
    if (upper === "Z") {
      const target = ensureActive();
      const firstNode = target.nodes[0];
      const lastNode = target.nodes.at(-1);
      if (lastNode && lastNode !== firstNode && distance(lastNode, firstNode) < 0.0005) {
        firstNode.handleIn = { ...lastNode.handleIn };
        target.nodes.pop();
      }
      target.closed = true;
      currentX = firstNode.x;
      currentY = firstNode.y;
      lastCubicControl = null;
      lastQuadraticControl = null;
      lastCommand = "Z";
      command = "";
      continue;
    }

    if (!hasNumber()) {
      command = "";
      continue;
    }

    if (upper === "M") {
      const destination = absolute(readNumber(), readNumber(), relative);
      active = { id: id("subpath"), nodes: [curveNode(destination.x, destination.y)], closed: false };
      subpaths.push(active);
      currentX = destination.x;
      currentY = destination.y;
      lastCubicControl = null;
      lastQuadraticControl = null;
      lastCommand = "M";
      command = relative ? "l" : "L";
      continue;
    }

    if (upper === "L") {
      const destination = absolute(readNumber(), readNumber(), relative);
      addSegment(destination, point(currentX, currentY), destination);
      lastCubicControl = null;
      lastQuadraticControl = null;
    } else if (upper === "H") {
      const destination = point(relative ? currentX + readNumber() : readNumber(), currentY);
      addSegment(destination, point(currentX, currentY), destination);
      lastCubicControl = null;
      lastQuadraticControl = null;
    } else if (upper === "V") {
      const destination = point(currentX, relative ? currentY + readNumber() : readNumber());
      addSegment(destination, point(currentX, currentY), destination);
      lastCubicControl = null;
      lastQuadraticControl = null;
    } else if (upper === "C") {
      const controlOne = absolute(readNumber(), readNumber(), relative);
      const controlTwo = absolute(readNumber(), readNumber(), relative);
      const destination = absolute(readNumber(), readNumber(), relative);
      addSegment(destination, controlOne, controlTwo);
      lastCubicControl = controlTwo;
      lastQuadraticControl = null;
    } else if (upper === "S") {
      const controlOne = lastCommand === "C" || lastCommand === "S"
        ? point(currentX * 2 - (lastCubicControl?.x ?? currentX), currentY * 2 - (lastCubicControl?.y ?? currentY))
        : point(currentX, currentY);
      const controlTwo = absolute(readNumber(), readNumber(), relative);
      const destination = absolute(readNumber(), readNumber(), relative);
      addSegment(destination, controlOne, controlTwo);
      lastCubicControl = controlTwo;
      lastQuadraticControl = null;
    } else if (upper === "Q") {
      const quadratic = absolute(readNumber(), readNumber(), relative);
      const destination = absolute(readNumber(), readNumber(), relative);
      const start = point(currentX, currentY);
      const controlOne = point(
        start.x + (quadratic.x - start.x) * 2 / 3,
        start.y + (quadratic.y - start.y) * 2 / 3,
      );
      const controlTwo = point(
        destination.x + (quadratic.x - destination.x) * 2 / 3,
        destination.y + (quadratic.y - destination.y) * 2 / 3,
      );
      addSegment(destination, controlOne, controlTwo);
      lastQuadraticControl = quadratic;
      lastCubicControl = null;
    } else if (upper === "T") {
      const quadratic: CurvePoint = lastCommand === "Q" || lastCommand === "T"
        ? point(currentX * 2 - (lastQuadraticControl?.x ?? currentX), currentY * 2 - (lastQuadraticControl?.y ?? currentY))
        : point(currentX, currentY);
      const destination = absolute(readNumber(), readNumber(), relative);
      const start = point(currentX, currentY);
      addSegment(
        destination,
        point(start.x + (quadratic.x - start.x) * 2 / 3, start.y + (quadratic.y - start.y) * 2 / 3),
        point(destination.x + (quadratic.x - destination.x) * 2 / 3, destination.y + (quadratic.y - destination.y) * 2 / 3),
      );
      lastQuadraticControl = quadratic;
      lastCubicControl = null;
    } else if (upper === "A") {
      const radiusX = readNumber();
      const radiusY = readNumber();
      const rotation = readNumber();
      const largeArc = Boolean(readNumber());
      const sweep = Boolean(readNumber());
      const destination = absolute(readNumber(), readNumber(), relative);
      const start = point(currentX, currentY);
      const cubics = arcToCubics(start, radiusX, radiusY, rotation, largeArc, sweep, destination);
      if (!cubics.length) {
        addSegment(destination, start, destination);
      } else {
        for (const cubic of cubics) {
          addSegment(cubic.end, cubic.controlOne, cubic.controlTwo);
        }
      }
      lastCubicControl = cubics.at(-1)?.controlTwo ?? null;
      lastQuadraticControl = null;
    } else {
      throw new Error(`Команда ${command} пока не поддерживается редактором.`);
    }
    lastCommand = upper;
  }

  for (const subpath of subpaths) inferNodeTypes(subpath);
  return subpaths.filter((subpath) => subpath.nodes.length > 0);
}

function numericAttribute(element: Element, name: string, fallback: number) {
  const parsed = Number.parseFloat(element.getAttribute(name) ?? "");
  return Number.isFinite(parsed) ? parsed : fallback;
}

function safeLinecap(value: string | null): CurvePaint["strokeLinecap"] {
  return value === "round" || value === "square" ? value : "butt";
}

function safeLinejoin(value: string | null): CurvePaint["strokeLinejoin"] {
  return value === "round" || value === "bevel" ? value : "miter";
}

export function parseEditableSvg(svgMarkup: string): CurveDocument {
  const parsed = new DOMParser().parseFromString(svgMarkup, "image/svg+xml");
  if (parsed.querySelector("parsererror")) throw new Error("SVG не удалось открыть в редакторе.");
  const svg = parsed.documentElement;
  const viewBoxValues = (svg.getAttribute("viewBox") ?? "")
    .trim()
    .split(/[\s,]+/)
    .map(Number);
  const width = numericAttribute(svg, "width", viewBoxValues[2] || 512);
  const height = numericAttribute(svg, "height", viewBoxValues[3] || 512);
  const viewBox = viewBoxValues.length === 4 && viewBoxValues.every(Number.isFinite)
    ? { x: viewBoxValues[0], y: viewBoxValues[1], width: viewBoxValues[2], height: viewBoxValues[3] }
    : { x: 0, y: 0, width, height };

  let pathElements = [...svg.querySelectorAll(":scope > path")];
  let maskInk = "#000";
  if (!pathElements.length) {
    pathElements = [...svg.querySelectorAll("path")];
    maskInk = svg.querySelector(":scope > rect[mask]")?.getAttribute("fill") ?? "#000";
  }
  const paths = pathElements.flatMap((element) => {
    const pathData = element.getAttribute("d");
    if (!pathData) return [];
    const subpaths = parsePathData(pathData);
    if (!subpaths.length) return [];
    const insideMask = Boolean(element.closest("mask"));
    return [{
      id: id("path"),
      paint: {
        fill: insideMask ? maskInk : (element.getAttribute("fill") ?? "#000"),
        stroke: element.getAttribute("stroke") ?? "none",
        strokeWidth: numericAttribute(element, "stroke-width", 1),
        strokeLinecap: safeLinecap(element.getAttribute("stroke-linecap")),
        strokeLinejoin: safeLinejoin(element.getAttribute("stroke-linejoin")),
        fillRule: element.getAttribute("fill-rule") === "evenodd" ? "evenodd" as const : "nonzero" as const,
        opacity: Math.max(0, Math.min(1, numericAttribute(element, "opacity", 1))),
      },
      subpaths,
    }];
  });
  if (!paths.length) throw new Error("В SVG не найдено редактируемых контуров.");
  return { width, height, viewBox, paths };
}

function rounded(value: number) {
  const normalized = Math.abs(value) < 0.0005 ? 0 : value;
  return Number(normalized.toFixed(2)).toString();
}

function samePoint(first: CurvePoint, second: CurvePoint) {
  return distance(first, second) < 0.0005;
}

export function serializeSubpath(subpath: CurveSubpath) {
  const first = subpath.nodes[0];
  if (!first) return "";
  const commands = [`M${rounded(first.x)} ${rounded(first.y)}`];
  const segmentCount = subpath.closed ? subpath.nodes.length : subpath.nodes.length - 1;
  for (let index = 0; index < segmentCount; index += 1) {
    const start = subpath.nodes[index];
    const end = subpath.nodes[(index + 1) % subpath.nodes.length];
    if (samePoint(start.handleOut, start) && samePoint(end.handleIn, end)) {
      commands.push(`L${rounded(end.x)} ${rounded(end.y)}`);
    } else {
      commands.push(
        `C${rounded(start.handleOut.x)} ${rounded(start.handleOut.y)} ` +
        `${rounded(end.handleIn.x)} ${rounded(end.handleIn.y)} ` +
        `${rounded(end.x)} ${rounded(end.y)}`,
      );
    }
  }
  if (subpath.closed) commands.push("Z");
  return commands.join("");
}

function paintAttributes(paint: CurvePaint) {
  const attributes = [
    `fill="${paint.fill}"`,
    `stroke="${paint.stroke}"`,
  ];
  if (paint.stroke !== "none") {
    attributes.push(`stroke-width="${rounded(paint.strokeWidth)}"`);
    attributes.push(`stroke-linecap="${paint.strokeLinecap}"`);
    attributes.push(`stroke-linejoin="${paint.strokeLinejoin}"`);
  }
  if (paint.fillRule === "evenodd") attributes.push('fill-rule="evenodd"');
  if (paint.opacity < 0.999) attributes.push(`opacity="${rounded(paint.opacity)}"`);
  return attributes.join(" ");
}

export function serializeCurveDocument(document: CurveDocument) {
  const paths = document.paths.map((path) => {
    const data = path.subpaths.map(serializeSubpath).join("");
    return `<path ${paintAttributes(path.paint)} d="${data}"/>`;
  }).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${rounded(document.width)}" height="${rounded(document.height)}" viewBox="${rounded(document.viewBox.x)} ${rounded(document.viewBox.y)} ${rounded(document.viewBox.width)} ${rounded(document.viewBox.height)}">${paths}</svg>`;
}

export function cloneCurveDocument(document: CurveDocument): CurveDocument {
  return {
    ...document,
    viewBox: { ...document.viewBox },
    paths: document.paths.map((path) => ({
      ...path,
      paint: { ...path.paint },
      subpaths: path.subpaths.map((subpath) => ({
        ...subpath,
        nodes: subpath.nodes.map((node) => ({
          ...node,
          handleIn: { ...node.handleIn },
          handleOut: { ...node.handleOut },
        })),
      })),
    })),
  };
}

export function countCurveNodes(document: CurveDocument) {
  return document.paths.reduce(
    (pathTotal, path) => pathTotal + path.subpaths.reduce(
      (subpathTotal, subpath) => subpathTotal + subpath.nodes.length,
      0,
    ),
    0,
  );
}

export function cubicPoint(
  start: CurvePoint,
  controlOne: CurvePoint,
  controlTwo: CurvePoint,
  end: CurvePoint,
  position: number,
) {
  const inverse = 1 - position;
  return {
    x: inverse ** 3 * start.x + 3 * inverse ** 2 * position * controlOne.x + 3 * inverse * position ** 2 * controlTwo.x + position ** 3 * end.x,
    y: inverse ** 3 * start.y + 3 * inverse ** 2 * position * controlOne.y + 3 * inverse * position ** 2 * controlTwo.y + position ** 3 * end.y,
  };
}

export function splitCubicSegment(
  start: CurveNode,
  end: CurveNode,
  position: number,
) {
  const mix = (first: CurvePoint, second: CurvePoint) => ({
    x: first.x + (second.x - first.x) * position,
    y: first.y + (second.y - first.y) * position,
  });
  const first = point(start.x, start.y);
  const fourth = point(end.x, end.y);
  const a = mix(first, start.handleOut);
  const b = mix(start.handleOut, end.handleIn);
  const c = mix(end.handleIn, fourth);
  const d = mix(a, b);
  const e = mix(b, c);
  const anchor = mix(d, e);
  start.handleOut = a;
  end.handleIn = c;
  return {
    id: id("node"),
    x: anchor.x,
    y: anchor.y,
    handleIn: d,
    handleOut: e,
    type: "smooth" as const,
  };
}
