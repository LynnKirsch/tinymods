export type ReconstructionOptions = {
  tolerance: number;
  tension: number;
  sampleSpacing: number;
};

export type ReconstructionResult = {
  svg: string;
  nodeCount: number;
  draftNodeCount: number;
  primitiveCount: number;
  contourCount: number;
  geometryScore: number;
};

export type GeometryPoint = { x: number; y: number };

type CircleFit = { center: GeometryPoint; radius: number; error: number };

function clamp(value: number, minimum = 0, maximum = 1) {
  return Math.max(minimum, Math.min(maximum, value));
}

function distance(first: GeometryPoint, second: GeometryPoint) {
  return Math.hypot(first.x - second.x, first.y - second.y);
}

function rounded(value: number) {
  return Number(value.toFixed(2)).toString();
}

function normalize(vector: GeometryPoint) {
  const length = Math.hypot(vector.x, vector.y) || 1;
  return { x: vector.x / length, y: vector.y / length };
}

function angleAt(previous: GeometryPoint, point: GeometryPoint, next: GeometryPoint) {
  const first = normalize({ x: previous.x - point.x, y: previous.y - point.y });
  const second = normalize({ x: next.x - point.x, y: next.y - point.y });
  return Math.acos(clamp(first.x * second.x + first.y * second.y, -1, 1)) * 180 / Math.PI;
}

function perpendicularDistance(point: GeometryPoint, start: GeometryPoint, end: GeometryPoint) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  if (!dx && !dy) return distance(point, start);
  const position = clamp(((point.x - start.x) * dx + (point.y - start.y) * dy) / (dx * dx + dy * dy));
  return distance(point, { x: start.x + position * dx, y: start.y + position * dy });
}

export function simplifyGeometryPoints(points: GeometryPoint[], tolerance: number): GeometryPoint[] {
  if (points.length <= 2) return points;
  let farthestIndex = 0;
  let farthestDistance = 0;
  for (let index = 1; index < points.length - 1; index += 1) {
    const currentDistance = perpendicularDistance(points[index], points[0], points[points.length - 1]);
    if (currentDistance > farthestDistance) {
      farthestDistance = currentDistance;
      farthestIndex = index;
    }
  }
  if (farthestDistance <= tolerance) return [points[0], points[points.length - 1]];
  const left = simplifyGeometryPoints(points.slice(0, farthestIndex + 1), tolerance);
  const right = simplifyGeometryPoints(points.slice(farthestIndex), tolerance);
  return [...left.slice(0, -1), ...right];
}

function simplifyClosedGeometry(points: GeometryPoint[], tolerance: number) {
  if (points.length <= 4) return points;
  let opposite = 1;
  let longest = 0;
  for (let index = 1; index < points.length; index += 1) {
    const currentDistance = distance(points[0], points[index]);
    if (currentDistance > longest) {
      longest = currentDistance;
      opposite = index;
    }
  }
  const firstHalf = simplifyGeometryPoints(points.slice(0, opposite + 1), tolerance);
  const secondHalf = simplifyGeometryPoints([...points.slice(opposite), points[0]], tolerance);
  return [...firstHalf.slice(0, -1), ...secondHalf.slice(0, -1)];
}

function nearestPointIndex(points: GeometryPoint[], target: GeometryPoint) {
  let nearest = 0;
  let nearestDistance = Infinity;
  for (let index = 0; index < points.length; index += 1) {
    const currentDistance = distance(points[index], target);
    if (currentDistance < nearestDistance) {
      nearest = index;
      nearestDistance = currentDistance;
    }
  }
  return nearest;
}

function pointAt(points: GeometryPoint[], index: number, closed: boolean) {
  if (closed) return points[(index + points.length) % points.length];
  return points[Math.max(0, Math.min(points.length - 1, index))];
}

function detectTrueCorner(
  source: GeometryPoint[],
  sourceIndex: number,
  closed: boolean,
) {
  if (!closed && (sourceIndex === 0 || sourceIndex === source.length - 1)) return true;
  let sharpestAngle = 180;
  for (let offset = -2; offset <= 2; offset += 1) {
    const index = sourceIndex + offset;
    if (!closed && (index < 2 || index > source.length - 3)) continue;
    const previous = pointAt(source, index - 2, closed);
    const current = pointAt(source, index, closed);
    const next = pointAt(source, index + 2, closed);
    sharpestAngle = Math.min(sharpestAngle, angleAt(previous, current, next));
  }
  // A real corner turns abruptly in the dense source contour. A rounded cap
  // only becomes sharp after simplification and must remain a smooth curve.
  return sharpestAngle < 124;
}

function sourceSegment(
  source: GeometryPoint[],
  startIndex: number,
  endIndex: number,
  closed: boolean,
) {
  if (!closed || endIndex >= startIndex) return source.slice(startIndex, endIndex + 1);
  return [...source.slice(startIndex), ...source.slice(0, endIndex + 1)];
}

function segmentIsStraight(
  source: GeometryPoint[],
  startIndex: number,
  endIndex: number,
  closed: boolean,
  tolerance: number,
) {
  const segment = sourceSegment(source, startIndex, endIndex, closed);
  if (segment.length <= 2) return true;
  const start = segment[0];
  const end = segment[segment.length - 1];
  const maximumDeviation = segment.reduce(
    (maximum, point) => Math.max(maximum, perpendicularDistance(point, start, end)),
    0,
  );
  return maximumDeviation <= Math.max(0.08, tolerance * 0.14);
}

export function fitCirclePrimitive(points: GeometryPoint[]): CircleFit | null {
  if (points.length < 8) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const point of points) {
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  }
  const width = maxX - minX;
  const height = maxY - minY;
  if (!width || !height || Math.max(width, height) / Math.min(width, height) > 1.08) return null;
  const center = { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
  const radii = points.map((point) => distance(point, center));
  const radius = radii.reduce((sum, value) => sum + value, 0) / radii.length;
  const rootMeanSquareError = Math.sqrt(
    radii.reduce((sum, value) => sum + (value - radius) ** 2, 0) / radii.length,
  );
  const error = rootMeanSquareError / radius;
  return error <= 0.035 ? { center, radius, error } : null;
}

function circlePath(circle: CircleFit) {
  const { center, radius } = circle;
  return `M${rounded(center.x + radius)} ${rounded(center.y)}A${rounded(radius)} ${rounded(radius)} 0 1 0 ${rounded(center.x - radius)} ${rounded(center.y)}A${rounded(radius)} ${rounded(radius)} 0 1 0 ${rounded(center.x + radius)} ${rounded(center.y)}Z`;
}

function semanticPath(
  points: GeometryPoint[],
  closed: boolean,
  tolerance: number,
  tension: number,
  nodeBudget: number,
) {
  const circle = closed ? fitCirclePrimitive(points) : null;
  if (circle) return { path: circlePath(circle), nodes: 3, primitives: 1 };

  let effectiveTolerance = tolerance;
  let simplified = closed
    ? simplifyClosedGeometry(points, effectiveTolerance)
    : simplifyGeometryPoints(points, effectiveTolerance);
  for (let attempt = 0; simplified.length > nodeBudget && attempt < 6; attempt += 1) {
    effectiveTolerance *= 1.22;
    simplified = closed
      ? simplifyClosedGeometry(points, effectiveTolerance)
      : simplifyGeometryPoints(points, effectiveTolerance);
  }
  if (simplified.length < 2) return null;
  const pointCount = simplified.length;
  const sourceIndexes = simplified.map((point) => nearestPointIndex(points, point));
  const corners = sourceIndexes.map((sourceIndex) => detectTrueCorner(points, sourceIndex, closed));

  const commands = [`M${rounded(simplified[0].x)} ${rounded(simplified[0].y)}`];
  let linePrimitives = 0;
  const segmentCount = closed ? pointCount : pointCount - 1;
  for (let index = 0; index < segmentCount; index += 1) {
    const nextIndex = (index + 1) % pointCount;
    const current = simplified[index];
    const next = simplified[nextIndex];
    const previous = simplified[(index - 1 + pointCount) % pointCount] ?? current;
    const afterNext = simplified[(nextIndex + 1) % pointCount] ?? next;
    const straight = segmentIsStraight(
      points,
      sourceIndexes[index],
      sourceIndexes[nextIndex],
      closed,
      effectiveTolerance,
    );
    if (straight) {
      commands.push(`L${rounded(next.x)} ${rounded(next.y)}`);
      linePrimitives += 1;
      continue;
    }
    const startTangent = corners[index]
      ? { x: next.x - current.x, y: next.y - current.y }
      : { x: next.x - previous.x, y: next.y - previous.y };
    const endTangent = corners[nextIndex]
      ? { x: next.x - current.x, y: next.y - current.y }
      : { x: afterNext.x - current.x, y: afterNext.y - current.y };
    const startHandle = corners[index] ? tension : Math.min(0.24, tension);
    const endHandle = corners[nextIndex] ? tension : Math.min(0.24, tension);
    const controlOne = {
      x: current.x + startTangent.x * startHandle,
      y: current.y + startTangent.y * startHandle,
    };
    const controlTwo = {
      x: next.x - endTangent.x * endHandle,
      y: next.y - endTangent.y * endHandle,
    };
    commands.push(`C${rounded(controlOne.x)} ${rounded(controlOne.y)} ${rounded(controlTwo.x)} ${rounded(controlTwo.y)} ${rounded(next.x)} ${rounded(next.y)}`);
  }
  if (closed) commands.push("Z");
  return {
    path: commands.join(""),
    nodes: pointCount,
    primitives: linePrimitives + Math.max(1, pointCount - linePrimitives),
  };
}

export function countSvgNodes(svg: string) {
  const pathData = [...svg.matchAll(/\bd="([^"]+)"/g)].map((match) => match[1]).join("");
  return (pathData.match(/[MLCQASTHV]/gi) ?? []).length;
}

export function calculateGeometryCleanliness(
  nodeCount: number,
  draftNodeCount: number,
  primitiveCount: number,
  contourCount: number,
  maxDimension: number,
) {
  const reduction = draftNodeCount > nodeCount ? 1 - nodeCount / draftNodeCount : 0;
  const efficiency = clamp(1 - nodeCount / Math.max(20, maxDimension * 0.65));
  const primitiveShare = clamp(primitiveCount / Math.max(1, contourCount * 3));
  return clamp(0.62 + reduction * 0.2 + efficiency * 0.12 + primitiveShare * 0.06);
}

function attribute(attributes: string, name: string) {
  return attributes.match(new RegExp(`\\b${name}="([^"]*)"`, "i"))?.[1] ?? null;
}

function splitSubpaths(pathData: string) {
  return pathData.match(/[Mm][^Mm]*/g) ?? [];
}

function samplePath(
  svgHost: SVGSVGElement,
  pathData: string,
  sampleSpacing: number,
) {
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", pathData);
  svgHost.append(path);
  try {
    const totalLength = path.getTotalLength();
    if (!Number.isFinite(totalLength) || totalLength <= 0) return null;
    const closed = /[zZ]\s*$/.test(pathData.trim());
    const sampleCount = Math.max(closed ? 8 : 2, Math.ceil(totalLength / sampleSpacing));
    const points: GeometryPoint[] = [];
    const limit = closed ? sampleCount : sampleCount + 1;
    for (let index = 0; index < limit; index += 1) {
      const position = totalLength * index / sampleCount;
      const point = path.getPointAtLength(position);
      points.push({ x: point.x, y: point.y });
    }
    return { points, closed };
  } finally {
    path.remove();
  }
}

export function reconstructSvgGeometry(
  draftSvg: string,
  width: number,
  height: number,
  options: ReconstructionOptions,
): ReconstructionResult {
  const draftNodeCount = countSvgNodes(draftSvg);
  const host = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  host.setAttribute("viewBox", `0 0 ${width} ${height}`);
  host.style.position = "fixed";
  host.style.left = "-10000px";
  host.style.width = `${width}px`;
  host.style.height = `${height}px`;
  document.body.append(host);
  const rebuiltPaths: string[] = [];
  let nodeCount = 0;
  let primitiveCount = 0;
  let contourCount = 0;
  try {
    const pathMatches = [...draftSvg.matchAll(/<path\s+([^>]*?)\/?\s*>/g)];
    for (const match of pathMatches) {
      const pathData = attribute(match[1], "d");
      if (!pathData) continue;
      const fill = attribute(match[1], "fill") ?? "#000";
      const opacity = attribute(match[1], "opacity");
      const rebuiltSubpaths: string[] = [];
      for (const subpath of splitSubpaths(pathData)) {
        const sampled = samplePath(host, subpath, options.sampleSpacing);
        if (!sampled) continue;
        const subpathNodeCount = Math.max(
          4,
          (subpath.match(/[MLCQASTHV]/gi) ?? []).length,
        );
        const semantic = semanticPath(
          sampled.points,
          sampled.closed,
          options.tolerance,
          options.tension,
          subpathNodeCount,
        );
        if (!semantic) continue;
        rebuiltSubpaths.push(semantic.path);
        nodeCount += semantic.nodes;
        primitiveCount += semantic.primitives;
        contourCount += 1;
      }
      if (rebuiltSubpaths.length) {
        rebuiltPaths.push(`<path fill="${fill}" fill-rule="evenodd"${opacity ? ` opacity="${opacity}"` : ""} d="${rebuiltSubpaths.join("")}"/>`);
      }
    }
  } finally {
    host.remove();
  }
  if (!rebuiltPaths.length) throw new Error("Не удалось распознать геометрию чернового контура.");
  const geometryScore = calculateGeometryCleanliness(
    nodeCount,
    draftNodeCount,
    primitiveCount,
    contourCount,
    Math.max(width, height),
  );
  return {
    svg: `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${rebuiltPaths.join("")}</svg>`,
    nodeCount,
    draftNodeCount,
    primitiveCount,
    contourCount,
    geometryScore,
  };
}
