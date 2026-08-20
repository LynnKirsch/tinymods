"use client";

import {
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
  WheelEvent as ReactWheelEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  cloneCurveDocument,
  countCurveNodes,
  cubicPoint,
  CurveDocument,
  CurveNode,
  CurvePoint,
  CurveSubpath,
  parseEditableSvg,
  serializeCurveDocument,
  serializeSubpath,
  splitCubicSegment,
} from "../lib/svg-curve-editor";

type EditorTool = "select" | "nodes" | "add" | "pan";
type PreviewMode = "svg" | "overlay" | "difference" | "contour";
type PointDisplay = "key" | "all";
type SnapOption = "points" | "axes" | "center" | "guides";
type Guide = { axis: "x" | "y"; value: number; label: string };

type NodeLocation = {
  pathIndex: number;
  subpathIndex: number;
  nodeIndex: number;
  subpath: CurveSubpath;
  node: CurveNode;
};

type SelectionRect = { start: CurvePoint; current: CurvePoint; additive: boolean };

type DragState =
  | {
      kind: "nodes" | "handle-in" | "handle-out";
      pointerId: number;
      startPoint: CurvePoint;
      baseDocument: CurveDocument;
      nodeIds: string[];
      nodeId: string;
    }
  | {
      kind: "pan";
      pointerId: number;
      startPoint: CurvePoint;
      basePan: CurvePoint;
    }
  | {
      kind: "selection";
      pointerId: number;
      startPoint: CurvePoint;
      additive: boolean;
    };

type SimplifyPreview = {
  document: CurveDocument;
  before: number;
  after: number;
  deviation: number;
};

type Props = {
  svg: string;
  sourceUrl: string;
  fileName: string;
  onClose(): void;
};

const ZOOM_LEVELS = [25, 50, 100, 200, 400, 800];

function downloadSvg(svg: string, fileName: string) {
  const blob = new Blob([svg], { type: "image/svg+xml;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function findNode(document: CurveDocument, nodeId: string): NodeLocation | null {
  for (let pathIndex = 0; pathIndex < document.paths.length; pathIndex += 1) {
    const path = document.paths[pathIndex];
    for (let subpathIndex = 0; subpathIndex < path.subpaths.length; subpathIndex += 1) {
      const subpath = path.subpaths[subpathIndex];
      const nodeIndex = subpath.nodes.findIndex((node) => node.id === nodeId);
      if (nodeIndex >= 0) return { pathIndex, subpathIndex, nodeIndex, subpath, node: subpath.nodes[nodeIndex] };
    }
  }
  return null;
}

function pointDistance(first: CurvePoint, second: CurvePoint) {
  return Math.hypot(first.x - second.x, first.y - second.y);
}

function pointLineDistance(target: CurvePoint, start: CurvePoint, end: CurvePoint) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  if (!dx && !dy) return pointDistance(target, start);
  const position = Math.max(0, Math.min(1,
    ((target.x - start.x) * dx + (target.y - start.y) * dy) / (dx * dx + dy * dy),
  ));
  return pointDistance(target, { x: start.x + dx * position, y: start.y + dy * position });
}

function applySmoothHandles(subpath: CurveSubpath, nodeIndex: number, strength = 1) {
  const node = subpath.nodes[nodeIndex];
  if (!node) return;
  const previous = nodeIndex > 0 ? subpath.nodes[nodeIndex - 1] : subpath.closed ? subpath.nodes.at(-1) : null;
  const next = nodeIndex < subpath.nodes.length - 1 ? subpath.nodes[nodeIndex + 1] : subpath.closed ? subpath.nodes[0] : null;
  if (!previous && !next) return;
  const direction = previous && next
    ? { x: next.x - previous.x, y: next.y - previous.y }
    : next
      ? { x: next.x - node.x, y: next.y - node.y }
      : { x: node.x - (previous?.x ?? node.x), y: node.y - (previous?.y ?? node.y) };
  const directionLength = Math.hypot(direction.x, direction.y) || 1;
  const unit = { x: direction.x / directionLength, y: direction.y / directionLength };
  const handleFactor = 0.34 * strength;
  const incomingLength = previous ? pointDistance(previous, node) * handleFactor : 0;
  const outgoingLength = next ? pointDistance(node, next) * handleFactor : 0;
  node.handleIn = { x: node.x - unit.x * incomingLength, y: node.y - unit.y * incomingLength };
  node.handleOut = { x: node.x + unit.x * outgoingLength, y: node.y + unit.y * outgoingLength };
  node.type = "smooth";
}

function pathPaintProps(path: CurveDocument["paths"][number]) {
  return {
    fill: path.paint.fill,
    stroke: path.paint.stroke,
    strokeWidth: path.paint.strokeWidth,
    strokeLinecap: path.paint.strokeLinecap,
    strokeLinejoin: path.paint.strokeLinejoin,
    fillRule: path.paint.fillRule,
    opacity: path.paint.opacity,
  };
}

function angleDegrees(start: CurvePoint, end: CurvePoint) {
  const degrees = Math.atan2(end.y - start.y, end.x - start.x) * 180 / Math.PI;
  return (degrees + 360) % 360;
}

function constrainTo45(start: CurvePoint, target: CurvePoint) {
  const distance = pointDistance(start, target);
  if (!distance) return target;
  const angle = Math.atan2(target.y - start.y, target.x - start.x);
  const constrained = Math.round(angle / (Math.PI / 4)) * Math.PI / 4;
  return { x: start.x + Math.cos(constrained) * distance, y: start.y + Math.sin(constrained) * distance };
}

function isKeyNode(subpath: CurveSubpath, index: number) {
  const node = subpath.nodes[index];
  if (node.type === "corner" || subpath.nodes.length <= 10) return true;
  if (!subpath.closed && (index === 0 || index === subpath.nodes.length - 1)) return true;
  const previous = subpath.nodes[(index - 1 + subpath.nodes.length) % subpath.nodes.length];
  const next = subpath.nodes[(index + 1) % subpath.nodes.length];
  const first = { x: previous.x - node.x, y: previous.y - node.y };
  const second = { x: next.x - node.x, y: next.y - node.y };
  const firstLength = Math.hypot(first.x, first.y) || 1;
  const secondLength = Math.hypot(second.x, second.y) || 1;
  const cosine = Math.max(-1, Math.min(1, (first.x * second.x + first.y * second.y) / (firstLength * secondLength)));
  const angle = Math.acos(cosine) * 180 / Math.PI;
  const extremum = (node.x <= previous.x && node.x <= next.x) || (node.x >= previous.x && node.x >= next.x) ||
    (node.y <= previous.y && node.y <= next.y) || (node.y >= previous.y && node.y >= next.y);
  return angle < 158 || extremum || index % 5 === 0;
}

function fitMergedSegment(previous: CurveNode, removed: CurveNode, next: CurveNode) {
  const startVector = { x: previous.handleOut.x - previous.x, y: previous.handleOut.y - previous.y };
  const endVector = { x: next.x - next.handleIn.x, y: next.y - next.handleIn.y };
  const startLength = Math.hypot(startVector.x, startVector.y) || pointDistance(previous, removed) * 0.5 || 1;
  const endLength = Math.hypot(endVector.x, endVector.y) || pointDistance(removed, next) * 0.5 || 1;
  const startUnit = { x: startVector.x / startLength, y: startVector.y / startLength };
  const endUnit = { x: endVector.x / endLength, y: endVector.y / endLength };
  let aa = 0;
  let ab = 0;
  let bb = 0;
  let ar = 0;
  let br = 0;
  for (let sample = 1; sample < 12; sample += 1) {
    const t = sample / 12;
    const oldPoint = t <= 0.5
      ? cubicPoint(previous, previous.handleOut, removed.handleIn, removed, t * 2)
      : cubicPoint(removed, removed.handleOut, next.handleIn, next, (t - 0.5) * 2);
    const oneMinus = 1 - t;
    const b0 = oneMinus ** 3;
    const b1 = 3 * oneMinus ** 2 * t;
    const b2 = 3 * oneMinus * t ** 2;
    const b3 = t ** 3;
    const base = { x: previous.x * (b0 + b1) + next.x * (b2 + b3), y: previous.y * (b0 + b1) + next.y * (b2 + b3) };
    const columnA = { x: startUnit.x * b1, y: startUnit.y * b1 };
    const columnB = { x: -endUnit.x * b2, y: -endUnit.y * b2 };
    const residual = { x: oldPoint.x - base.x, y: oldPoint.y - base.y };
    aa += columnA.x ** 2 + columnA.y ** 2;
    ab += columnA.x * columnB.x + columnA.y * columnB.y;
    bb += columnB.x ** 2 + columnB.y ** 2;
    ar += columnA.x * residual.x + columnA.y * residual.y;
    br += columnB.x * residual.x + columnB.y * residual.y;
  }
  const determinant = aa * bb - ab * ab;
  const maximum = pointDistance(previous, next) * 2.2;
  const incoming = Math.max(0, Math.min(maximum, Math.abs(determinant) > 1e-8 ? (ar * bb - br * ab) / determinant : startLength));
  const outgoing = Math.max(0, Math.min(maximum, Math.abs(determinant) > 1e-8 ? (br * aa - ar * ab) / determinant : endLength));
  previous.handleOut = { x: previous.x + startUnit.x * incoming, y: previous.y + startUnit.y * incoming };
  next.handleIn = { x: next.x - endUnit.x * outgoing, y: next.y - endUnit.y * outgoing };
}

export default function SvgCurveEditor({ svg, sourceUrl, fileName, onClose }: Props) {
  const initialDocument = useMemo(() => parseEditableSvg(svg), [svg]);
  const [curveDocument, setCurveDocument] = useState(() => cloneCurveDocument(initialDocument));
  const documentRef = useRef(curveDocument);
  const [history, setHistory] = useState(() => [cloneCurveDocument(initialDocument)]);
  const [historyIndex, setHistoryIndex] = useState(0);
  const historyRef = useRef(history);
  const historyIndexRef = useRef(historyIndex);
  const [tool, setTool] = useState<EditorTool>("nodes");
  const [selectedNodeIds, setSelectedNodeIds] = useState<string[]>([]);
  const [pngOpacity, setPngOpacity] = useState(55);
  const [differenceIntensity, setDifferenceIntensity] = useState(78);
  const [overlayColor, setOverlayColor] = useState("#00aeea");
  const [contourColor, setContourColor] = useState("#d7f247");
  const [differenceColor, setDifferenceColor] = useState("#ff4d6d");
  const [pointDisplay, setPointDisplay] = useState<PointDisplay>("key");
  const [previewMode, setPreviewMode] = useState<PreviewMode>("overlay");
  const [zoom, setZoom] = useState(100);
  const [pan, setPan] = useState<CurvePoint>({ x: 0, y: 0 });
  const [smoothStrength, setSmoothStrength] = useState(55);
  const [snapping, setSnapping] = useState(true);
  const [snapMenuOpen, setSnapMenuOpen] = useState(false);
  const [snapOptions, setSnapOptions] = useState<Record<SnapOption, boolean>>({ points: true, axes: true, center: true, guides: true });
  const [activeGuides, setActiveGuides] = useState<Guide[]>([]);
  const [selectionRect, setSelectionRect] = useState<SelectionRect | null>(null);
  const [magnifierZoom, setMagnifierZoom] = useState<0 | 4 | 8>(0);
  const [magnifierPoint, setMagnifierPoint] = useState<CurvePoint | null>(null);
  const [canvasSize, setCanvasSize] = useState({ width: 600, height: 600 });
  const [simplifyPreview, setSimplifyPreview] = useState<SimplifyPreview | null>(null);
  const [status, setStatus] = useState("Выберите точку — её координаты и ручки появятся справа.");
  const [spacePressed, setSpacePressed] = useState(false);
  const canvasRef = useRef<SVGSVGElement>(null);
  const dragRef = useRef<DragState | null>(null);
  const spacePressedRef = useRef(false);

  const scale = zoom / 100;
  const center = { x: initialDocument.viewBox.x + initialDocument.viewBox.width / 2, y: initialDocument.viewBox.y + initialDocument.viewBox.height / 2 };
  const selectedNode = selectedNodeIds.length === 1 ? findNode(curveDocument, selectedNodeIds[0])?.node ?? null : null;
  const selectedCount = selectedNodeIds.length;
  const nodeCount = countCurveNodes(curveDocument);
  const pixelsPerDocumentUnit = Math.max(0.001, Math.min(canvasSize.width / initialDocument.viewBox.width, canvasSize.height / initialDocument.viewBox.height) * scale);
  const screenUnit = 1 / pixelsPerDocumentUnit;
  const marker = { anchor: 2.8 * screenUnit, selected: 4 * screenUnit, handle: 2.5 * screenUnit, hit: 7 * screenUnit };
  const handleAngle = selectedNode ? angleDegrees(selectedNode, selectedNode.handleOut) : null;

  useEffect(() => { documentRef.current = curveDocument; }, [curveDocument]);
  useEffect(() => { historyRef.current = history; }, [history]);
  useEffect(() => { historyIndexRef.current = historyIndex; }, [historyIndex]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const update = () => {
      const rect = canvas.getBoundingClientRect();
      setCanvasSize({ width: Math.max(1, rect.width), height: Math.max(1, rect.height) });
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, []);

  function rootPoint(clientX: number, clientY: number) {
    const canvas = canvasRef.current;
    if (!canvas) return { x: clientX, y: clientY };
    const matrix = canvas.getScreenCTM();
    if (!matrix) return { x: clientX, y: clientY };
    const point = new DOMPoint(clientX, clientY).matrixTransform(matrix.inverse());
    return { x: point.x, y: point.y };
  }

  function documentPoint(clientX: number, clientY: number) {
    const root = rootPoint(clientX, clientY);
    return { x: (root.x - center.x - pan.x) / scale + center.x, y: (root.y - center.y - pan.y) / scale + center.y };
  }

  function pushHistory(nextDocument: CurveDocument) {
    const nextHistory = historyRef.current.slice(0, historyIndexRef.current + 1);
    nextHistory.push(cloneCurveDocument(nextDocument));
    const trimmed = nextHistory.slice(-80);
    historyRef.current = trimmed;
    historyIndexRef.current = trimmed.length - 1;
    setHistory(trimmed);
    setHistoryIndex(trimmed.length - 1);
  }

  function applyDocumentChange(update: (nextDocument: CurveDocument) => void, nextStatus?: string | (() => string)) {
    const nextDocument = cloneCurveDocument(documentRef.current);
    update(nextDocument);
    documentRef.current = nextDocument;
    setCurveDocument(nextDocument);
    pushHistory(nextDocument);
    setSimplifyPreview(null);
    if (nextStatus) setStatus(typeof nextStatus === "function" ? nextStatus() : nextStatus);
  }

  function undo() {
    if (historyIndexRef.current <= 0) return;
    const nextIndex = historyIndexRef.current - 1;
    const nextDocument = cloneCurveDocument(historyRef.current[nextIndex]);
    documentRef.current = nextDocument;
    historyIndexRef.current = nextIndex;
    setCurveDocument(nextDocument);
    setHistoryIndex(nextIndex);
    setSelectedNodeIds([]);
    setSimplifyPreview(null);
    setStatus("Последнее действие отменено.");
  }

  function redo() {
    if (historyIndexRef.current >= historyRef.current.length - 1) return;
    const nextIndex = historyIndexRef.current + 1;
    const nextDocument = cloneCurveDocument(historyRef.current[nextIndex]);
    documentRef.current = nextDocument;
    historyIndexRef.current = nextIndex;
    setCurveDocument(nextDocument);
    setHistoryIndex(nextIndex);
    setSelectedNodeIds([]);
    setSimplifyPreview(null);
    setStatus("Действие возвращено.");
  }

  function beginNodeDrag(event: ReactPointerEvent<SVGCircleElement>, nodeId: string, kind: "nodes" | "handle-in" | "handle-out") {
    event.stopPropagation();
    if (tool === "pan" || tool === "add" || tool === "select") return;
    let nextSelection = selectedNodeIds;
    if (kind === "nodes") {
      if (event.shiftKey) {
        if (selectedNodeIds.includes(nodeId)) {
          setSelectedNodeIds(selectedNodeIds.filter((id) => id !== nodeId));
          return;
        }
        nextSelection = [...selectedNodeIds, nodeId];
      } else if (!selectedNodeIds.includes(nodeId)) nextSelection = [nodeId];
      setSelectedNodeIds(nextSelection);
    } else if (!selectedNodeIds.includes(nodeId)) {
      nextSelection = [nodeId];
      setSelectedNodeIds(nextSelection);
    }
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = {
      kind,
      pointerId: event.pointerId,
      startPoint: documentPoint(event.clientX, event.clientY),
      baseDocument: cloneCurveDocument(documentRef.current),
      nodeIds: kind === "nodes" ? nextSelection : [nodeId],
      nodeId,
    };
  }

  function beginCanvasDrag(event: ReactPointerEvent<SVGSVGElement>) {
    const shouldPan = tool === "pan" || event.button === 1 || event.altKey || spacePressedRef.current;
    if (shouldPan) {
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      dragRef.current = { kind: "pan", pointerId: event.pointerId, startPoint: rootPoint(event.clientX, event.clientY), basePan: { ...pan } };
      return;
    }
    if (event.target !== event.currentTarget || (tool !== "select" && tool !== "nodes")) return;
    const start = documentPoint(event.clientX, event.clientY);
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { kind: "selection", pointerId: event.pointerId, startPoint: start, additive: event.shiftKey };
    setSelectionRect({ start, current: start, additive: event.shiftKey });
    if (!event.shiftKey) setSelectedNodeIds([]);
  }

  function snappedNodeTarget(target: CurvePoint, baseDocument: CurveDocument, movingNodeIds: string[]) {
    if (!snapping) return { point: target, guides: [] as Guide[] };
    const threshold = 7 * screenUnit;
    const viewBox = initialDocument.viewBox;
    const candidatesX: Array<{ value: number; label: string }> = [];
    const candidatesY: Array<{ value: number; label: string }> = [];
    if (snapOptions.center) {
      candidatesX.push({ value: center.x, label: "центр" });
      candidatesY.push({ value: center.y, label: "центр" });
    }
    if (snapOptions.axes) {
      candidatesX.push({ value: viewBox.x, label: "левая ось" }, { value: viewBox.x + viewBox.width, label: "правая ось" });
      candidatesY.push({ value: viewBox.y, label: "верхняя ось" }, { value: viewBox.y + viewBox.height, label: "нижняя ось" });
    }
    if (snapOptions.points) {
      for (const path of baseDocument.paths) for (const subpath of path.subpaths) for (const node of subpath.nodes) {
        if (movingNodeIds.includes(node.id)) continue;
        candidatesX.push({ value: node.x, label: "точка" });
        candidatesY.push({ value: node.y, label: "точка" });
        if (snapOptions.guides) {
          candidatesX.push({ value: center.x * 2 - node.x, label: "симметрия" });
          candidatesY.push({ value: center.y * 2 - node.y, label: "симметрия" });
        }
      }
    }
    const closest = (value: number, candidates: Array<{ value: number; label: string }>) =>
      candidates.reduce<{ value: number; label: string; distance: number } | null>((best, candidate) => {
        const distance = Math.abs(candidate.value - value);
        if (distance > threshold || (best && best.distance <= distance)) return best;
        return { ...candidate, distance };
      }, null);
    const closestX = closest(target.x, candidatesX);
    const closestY = closest(target.y, candidatesY);
    const guides: Guide[] = [];
    if (closestX) guides.push({ axis: "x", value: closestX.value, label: closestX.label });
    if (closestY) guides.push({ axis: "y", value: closestY.value, label: closestY.label });
    return { point: { x: closestX?.value ?? target.x, y: closestY?.value ?? target.y }, guides };
  }

  function moveDrag(event: ReactPointerEvent<SVGSVGElement>) {
    const pointer = documentPoint(event.clientX, event.clientY);
    setMagnifierPoint(pointer);
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (drag.kind === "pan") {
      const current = rootPoint(event.clientX, event.clientY);
      setPan({ x: drag.basePan.x + current.x - drag.startPoint.x, y: drag.basePan.y + current.y - drag.startPoint.y });
      return;
    }
    if (drag.kind === "selection") {
      setSelectionRect({ start: drag.startPoint, current: pointer, additive: drag.additive });
      return;
    }

    const nextDocument = cloneCurveDocument(drag.baseDocument);
    if (drag.kind === "nodes") {
      const primary = findNode(drag.baseDocument, drag.nodeId)?.node;
      if (!primary) return;
      let target = event.shiftKey ? constrainTo45(primary, pointer) : pointer;
      const snapped = snappedNodeTarget(target, drag.baseDocument, drag.nodeIds);
      target = snapped.point;
      setActiveGuides(snapped.guides);
      const delta = { x: target.x - primary.x, y: target.y - primary.y };
      for (const nodeId of drag.nodeIds) {
        const location = findNode(nextDocument, nodeId);
        if (!location) continue;
        location.node.x += delta.x;
        location.node.y += delta.y;
        location.node.handleIn.x += delta.x;
        location.node.handleIn.y += delta.y;
        location.node.handleOut.x += delta.x;
        location.node.handleOut.y += delta.y;
      }
    } else {
      const location = findNode(nextDocument, drag.nodeId);
      const baseLocation = findNode(drag.baseDocument, drag.nodeId);
      if (!location || !baseLocation) return;
      const node = location.node;
      const baseNode = baseLocation.node;
      let targetPoint = {
        x: (drag.kind === "handle-in" ? baseNode.handleIn.x : baseNode.handleOut.x) + pointer.x - drag.startPoint.x,
        y: (drag.kind === "handle-in" ? baseNode.handleIn.y : baseNode.handleOut.y) + pointer.y - drag.startPoint.y,
      };
      if (event.shiftKey) targetPoint = constrainTo45(node, targetPoint);
      const target = drag.kind === "handle-in" ? node.handleIn : node.handleOut;
      target.x = targetPoint.x;
      target.y = targetPoint.y;
      if (node.type === "smooth") {
        const opposite = drag.kind === "handle-in" ? node.handleOut : node.handleIn;
        const baseOpposite = drag.kind === "handle-in" ? baseNode.handleOut : baseNode.handleIn;
        const oppositeLength = pointDistance(baseOpposite, baseNode);
        const direction = { x: target.x - node.x, y: target.y - node.y };
        const length = Math.hypot(direction.x, direction.y) || 1;
        opposite.x = node.x - direction.x / length * oppositeLength;
        opposite.y = node.y - direction.y / length * oppositeLength;
      }
    }
    documentRef.current = nextDocument;
    setCurveDocument(nextDocument);
  }

  function endDrag(event: ReactPointerEvent<SVGSVGElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    setActiveGuides([]);
    if (drag.kind === "selection") {
      const rectangle = selectionRect;
      setSelectionRect(null);
      if (!rectangle) return;
      const left = Math.min(rectangle.start.x, rectangle.current.x);
      const right = Math.max(rectangle.start.x, rectangle.current.x);
      const top = Math.min(rectangle.start.y, rectangle.current.y);
      const bottom = Math.max(rectangle.start.y, rectangle.current.y);
      const selected = curveDocument.paths.flatMap((path) => path.subpaths.flatMap((subpath) =>
        subpath.nodes.filter((node) => node.x >= left && node.x <= right && node.y >= top && node.y <= bottom).map((node) => node.id),
      ));
      setSelectedNodeIds((current) => rectangle.additive ? Array.from(new Set([...current, ...selected])) : selected);
      setStatus(`Рамкой выбрано точек: ${selected.length}.`);
      return;
    }
    if (drag.kind !== "pan") {
      const changed = serializeCurveDocument(drag.baseDocument) !== serializeCurveDocument(documentRef.current);
      if (changed) {
        pushHistory(documentRef.current);
        setStatus(drag.kind === "nodes" ? "Положение точки изменено." : "Кривизна Bézier-сегмента изменена.");
      }
    }
  }

  function setPointType(type: "smooth" | "corner") {
    if (!selectedNodeIds.length) return;
    applyDocumentChange((nextDocument) => {
      for (const nodeId of selectedNodeIds) {
        const location = findNode(nextDocument, nodeId);
        if (!location) continue;
        if (type === "smooth") applySmoothHandles(location.subpath, location.nodeIndex);
        else location.node.type = "corner";
      }
    }, type === "smooth" ? "Выбранные точки сделаны плавными." : "Ручки выбранных точек теперь независимы.");
  }

  function smoothSelection() {
    if (!selectedNodeIds.length) {
      setStatus("Сначала выделите точки, которые нужно сгладить.");
      return;
    }
    const strength = smoothStrength / 100;
    applyDocumentChange((nextDocument) => {
      for (const path of nextDocument.paths) for (const subpath of path.subpaths) {
        const selectedIndexes = subpath.nodes.map((node, index) => selectedNodeIds.includes(node.id) ? index : -1).filter((index) => index >= 0);
        if (!selectedIndexes.length) continue;
        const firstSelected = selectedIndexes[0];
        const lastSelected = selectedIndexes.at(-1)!;
        const original = subpath.nodes.map((node) => ({ x: node.x, y: node.y }));
        for (const nodeIndex of selectedIndexes) {
          const previousIndex = nodeIndex > 0 ? nodeIndex - 1 : subpath.closed ? subpath.nodes.length - 1 : -1;
          const nextIndex = nodeIndex < subpath.nodes.length - 1 ? nodeIndex + 1 : subpath.closed ? 0 : -1;
          if (nodeIndex !== firstSelected && nodeIndex !== lastSelected && previousIndex >= 0 && nextIndex >= 0) {
            const target = { x: (original[previousIndex].x + original[nextIndex].x) / 2, y: (original[previousIndex].y + original[nextIndex].y) / 2 };
            const node = subpath.nodes[nodeIndex];
            const factor = strength * 0.38;
            const dx = (target.x - node.x) * factor;
            const dy = (target.y - node.y) * factor;
            node.x += dx;
            node.y += dy;
            node.handleIn.x += dx;
            node.handleIn.y += dy;
            node.handleOut.x += dx;
            node.handleOut.y += dy;
          }
        }
        for (const nodeIndex of selectedIndexes) applySmoothHandles(subpath, nodeIndex, 0.72 + strength * 0.4);
      }
    }, `Сглаживание ${smoothStrength}% применено. Крайние точки выделения сохранены.`);
  }

  function deleteSelection() {
    if (!selectedNodeIds.length) return;
    const deleted = selectedNodeIds.length;
    applyDocumentChange((nextDocument) => {
      for (const path of nextDocument.paths) for (const subpath of path.subpaths) {
        const minimumNodes = subpath.closed ? 3 : 2;
        for (let index = subpath.nodes.length - 1; index >= 0; index -= 1) {
          if (!selectedNodeIds.includes(subpath.nodes[index].id) || subpath.nodes.length <= minimumNodes) continue;
          const removed = subpath.nodes[index];
          const hasPrevious = subpath.closed || index > 0;
          const hasNext = subpath.closed || index < subpath.nodes.length - 1;
          if (hasPrevious && hasNext) {
            const previous = subpath.nodes[(index - 1 + subpath.nodes.length) % subpath.nodes.length];
            const next = subpath.nodes[(index + 1) % subpath.nodes.length];
            fitMergedSegment(previous, removed, next);
          }
          subpath.nodes.splice(index, 1);
        }
      }
    }, `Удалено точек: ${deleted}. Соседняя кривая подогнана по прежнему силуэту.`);
    setSelectedNodeIds([]);
  }

  function makeSimplifyPreview() {
    const before = nodeCount;
    let removed = 0;
    let maximumDeviation = 0;
    const tolerance = Math.max(initialDocument.viewBox.width, initialDocument.viewBox.height) * (0.0012 + smoothStrength / 100 * 0.006);
    const nextDocument = cloneCurveDocument(documentRef.current);
    for (const path of nextDocument.paths) for (const subpath of path.subpaths) {
      const selectedIndexes = subpath.nodes.map((node, index) => selectedNodeIds.includes(node.id) ? index : -1).filter((index) => index >= 0);
      const onlySelection = selectedIndexes.length >= 3;
      const protectedIds = onlySelection ? new Set([subpath.nodes[selectedIndexes[0]].id, subpath.nodes[selectedIndexes.at(-1)!].id]) : new Set<string>();
      const minimumNodes = subpath.closed ? 4 : 2;
      let changed = true;
      while (changed && subpath.nodes.length > minimumNodes) {
        changed = false;
        for (let index = 0; index < subpath.nodes.length; index += 1) {
          const node = subpath.nodes[index];
          if (onlySelection && !selectedNodeIds.includes(node.id)) continue;
          if (protectedIds.has(node.id)) continue;
          if (!subpath.closed && (index === 0 || index === subpath.nodes.length - 1)) continue;
          const previous = subpath.nodes[(index - 1 + subpath.nodes.length) % subpath.nodes.length];
          const next = subpath.nodes[(index + 1) % subpath.nodes.length];
          const deviation = Math.max(pointLineDistance(node, previous, next), pointLineDistance(node.handleIn, previous, next) * 0.65, pointLineDistance(node.handleOut, previous, next) * 0.65);
          if (deviation > tolerance) continue;
          maximumDeviation = Math.max(maximumDeviation, deviation);
          fitMergedSegment(previous, node, next);
          subpath.nodes.splice(index, 1);
          removed += 1;
          changed = true;
          break;
        }
      }
    }
    if (!removed) {
      setStatus("Упрощение не нашло лишних точек в пределах безопасного отклонения.");
      setSimplifyPreview(null);
      return;
    }
    setSimplifyPreview({ document: nextDocument, before, after: before - removed, deviation: maximumDeviation });
    setStatus("Проверьте предварительный результат и подтвердите упрощение.");
  }

  function applySimplifyPreview() {
    if (!simplifyPreview) return;
    documentRef.current = cloneCurveDocument(simplifyPreview.document);
    setCurveDocument(documentRef.current);
    pushHistory(documentRef.current);
    setSelectedNodeIds((current) => current.filter((nodeId) => findNode(documentRef.current, nodeId)));
    setStatus(`${simplifyPreview.before} → ${simplifyPreview.after} точек. Упрощение применено.`);
    setSimplifyPreview(null);
  }

  function addPoint(event: ReactMouseEvent<SVGPathElement>, pathId: string, subpathId: string) {
    if (tool !== "add" && event.detail < 2) return;
    event.stopPropagation();
    const target = documentPoint(event.clientX, event.clientY);
    let bestSegment = -1;
    let bestPosition = 0.5;
    let bestDistance = Infinity;
    const path = documentRef.current.paths.find((item) => item.id === pathId);
    const subpath = path?.subpaths.find((item) => item.id === subpathId);
    if (!subpath || subpath.nodes.length < 2) return;
    const segmentCount = subpath.closed ? subpath.nodes.length : subpath.nodes.length - 1;
    for (let segment = 0; segment < segmentCount; segment += 1) {
      const start = subpath.nodes[segment];
      const end = subpath.nodes[(segment + 1) % subpath.nodes.length];
      for (let sample = 1; sample < 40; sample += 1) {
        const position = sample / 40;
        const candidate = cubicPoint(start, start.handleOut, end.handleIn, end, position);
        const candidateDistance = pointDistance(candidate, target);
        if (candidateDistance < bestDistance) {
          bestDistance = candidateDistance;
          bestSegment = segment;
          bestPosition = position;
        }
      }
    }
    if (bestSegment < 0) return;
    let addedNodeId = "";
    applyDocumentChange((nextDocument) => {
      const nextPath = nextDocument.paths.find((item) => item.id === pathId);
      const nextSubpath = nextPath?.subpaths.find((item) => item.id === subpathId);
      if (!nextSubpath) return;
      const start = nextSubpath.nodes[bestSegment];
      const end = nextSubpath.nodes[(bestSegment + 1) % nextSubpath.nodes.length];
      const inserted = splitCubicSegment(start, end, bestPosition);
      addedNodeId = inserted.id;
      nextSubpath.nodes.splice(bestSegment + 1, 0, inserted);
    }, "Точка добавлена методом De Casteljau — форма контура не изменилась.");
    if (addedNodeId) setSelectedNodeIds([addedNodeId]);
    setTool("nodes");
  }

  function changeSelectedCoordinate(axis: "x" | "y", value: string) {
    if (!selectedNode) return;
    const number = Number(value);
    if (!Number.isFinite(number)) return;
    const delta = number - selectedNode[axis];
    applyDocumentChange((nextDocument) => {
      const location = findNode(nextDocument, selectedNode.id);
      if (!location) return;
      location.node[axis] = number;
      location.node.handleIn[axis] += delta;
      location.node.handleOut[axis] += delta;
    }, `Координата ${axis.toUpperCase()} изменена.`);
  }

  function alignSelection(axis: "x" | "y") {
    if (selectedNodeIds.length < 2) return;
    const locations = selectedNodeIds.flatMap((id) => {
      const location = findNode(documentRef.current, id);
      return location ? [location.node] : [];
    });
    const value = locations.reduce((sum, node) => sum + node[axis], 0) / locations.length;
    applyDocumentChange((nextDocument) => {
      for (const nodeId of selectedNodeIds) {
        const location = findNode(nextDocument, nodeId);
        if (!location) continue;
        const delta = value - location.node[axis];
        location.node[axis] = value;
        location.node.handleIn[axis] += delta;
        location.node.handleOut[axis] += delta;
      }
    }, axis === "y" ? "Точки выровнены по горизонтали." : "Точки выровнены по вертикали.");
  }

  function straightenSelection() {
    if (selectedNodeIds.length < 3) return;
    const nodes = selectedNodeIds.flatMap((id) => {
      const location = findNode(documentRef.current, id);
      return location ? [location.node] : [];
    });
    const mean = { x: nodes.reduce((sum, node) => sum + node.x, 0) / nodes.length, y: nodes.reduce((sum, node) => sum + node.y, 0) / nodes.length };
    let xx = 0;
    let xy = 0;
    let yy = 0;
    for (const node of nodes) {
      const dx = node.x - mean.x;
      const dy = node.y - mean.y;
      xx += dx * dx;
      xy += dx * dy;
      yy += dy * dy;
    }
    const angle = 0.5 * Math.atan2(2 * xy, xx - yy);
    const unit = { x: Math.cos(angle), y: Math.sin(angle) };
    applyDocumentChange((nextDocument) => {
      for (const nodeId of selectedNodeIds) {
        const location = findNode(nextDocument, nodeId);
        if (!location) continue;
        const node = location.node;
        const projection = (node.x - mean.x) * unit.x + (node.y - mean.y) * unit.y;
        const target = { x: mean.x + projection * unit.x, y: mean.y + projection * unit.y };
        const dx = target.x - node.x;
        const dy = target.y - node.y;
        node.x = target.x;
        node.y = target.y;
        node.handleIn.x += dx;
        node.handleIn.y += dy;
        node.handleOut.x += dx;
        node.handleOut.y += dy;
      }
    }, "Выбранный участок выпрямлен по общей оси.");
  }

  function handleWheel(event: ReactWheelEvent<SVGSVGElement>) {
    if (!event.ctrlKey) return;
    event.preventDefault();
    const root = rootPoint(event.clientX, event.clientY);
    const documentPosition = documentPoint(event.clientX, event.clientY);
    const nextZoom = Math.max(25, Math.min(800, Math.round((zoom * Math.exp(-event.deltaY * 0.002)) / 5) * 5));
    const nextScale = nextZoom / 100;
    setZoom(nextZoom);
    setPan({ x: root.x - center.x - nextScale * (documentPosition.x - center.x), y: root.y - center.y - nextScale * (documentPosition.y - center.y) });
  }

  function resetView() {
    setZoom(100);
    setPan({ x: 0, y: 0 });
  }

  function stepZoom(direction: 1 | -1) {
    const currentIndex = ZOOM_LEVELS.findIndex((level) => level >= zoom);
    const safeIndex = currentIndex < 0 ? ZOOM_LEVELS.length - 1 : currentIndex;
    const nextIndex = Math.max(0, Math.min(ZOOM_LEVELS.length - 1, safeIndex + direction));
    setZoom(ZOOM_LEVELS[nextIndex]);
  }

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.matches("input, textarea, select")) return;
      if (event.code === "Space") {
        event.preventDefault();
        spacePressedRef.current = true;
        setSpacePressed(true);
      } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
        event.preventDefault();
        if (event.shiftKey) redo(); else undo();
      } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "y") {
        event.preventDefault();
        redo();
      } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a") {
        event.preventDefault();
        const selectedLocation = selectedNodeIds[0] ? findNode(documentRef.current, selectedNodeIds[0]) : null;
        const subpath = selectedLocation?.subpath ?? documentRef.current.paths[0]?.subpaths[0];
        setSelectedNodeIds(subpath?.nodes.map((node) => node.id) ?? []);
        setStatus("Выбран текущий контур целиком.");
      } else if (event.key === "Escape") {
        setSelectedNodeIds([]);
        setSelectionRect(null);
        setSimplifyPreview(null);
        setStatus("Выделение снято.");
      } else if (event.key === "Delete" || event.key === "Backspace") {
        event.preventDefault();
        deleteSelection();
      } else if (event.key === "0") {
        event.preventDefault();
        resetView();
      } else if (event.key === "1") {
        event.preventDefault();
        setZoom(100);
      } else if (event.key === "+" || event.key === "=") {
        event.preventDefault();
        stepZoom(1);
      } else if (event.key === "-" || event.key === "_") {
        event.preventDefault();
        stepZoom(-1);
      }
    };
    const releaseSpace = () => {
      spacePressedRef.current = false;
      setSpacePressed(false);
    };
    const handleKeyUp = (event: KeyboardEvent) => { if (event.code === "Space") releaseSpace(); };
    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);
    window.addEventListener("blur", releaseSpace);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
      window.removeEventListener("blur", releaseSpace);
    };
  });

  const transform = `translate(${center.x + pan.x} ${center.y + pan.y}) scale(${scale}) translate(${-center.x} ${-center.y})`;
  const visibleDocument = simplifyPreview?.document ?? curveDocument;
  const cleanSvg = serializeCurveDocument(curveDocument);
  const viewBox = initialDocument.viewBox;
  const selectionBounds = selectionRect ? {
    x: Math.min(selectionRect.start.x, selectionRect.current.x),
    y: Math.min(selectionRect.start.y, selectionRect.current.y),
    width: Math.abs(selectionRect.current.x - selectionRect.start.x),
    height: Math.abs(selectionRect.current.y - selectionRect.start.y),
  } : null;

  function vectorPaths(document: CurveDocument, interactive: boolean, showArtwork = true) {
    return document.paths.flatMap((path) => path.subpaths.map((subpath) => (
      <g key={subpath.id}>
        {showArtwork ? <path d={serializeSubpath(subpath)} {...pathPaintProps(path)} pointerEvents="none" /> : null}
        {interactive ? <path
          className="curve-hit-path"
          d={serializeSubpath(subpath)}
          fill={path.paint.fill === "none" ? "none" : "transparent"}
          stroke="transparent"
          strokeWidth={Math.max(path.paint.strokeWidth, 14 * screenUnit)}
          onPointerDown={(event) => {
            if (tool === "select") {
              event.stopPropagation();
              setSelectedNodeIds(subpath.nodes.map((node) => node.id));
              setStatus(`Выбран контур: ${subpath.nodes.length} точек.`);
            }
          }}
          onClick={(event) => addPoint(event, path.id, subpath.id)}
        /> : null}
      </g>
    )));
  }

  function alphaMaskPaths(document: CurveDocument) {
    return document.paths.flatMap((path) => path.subpaths.map((subpath) => (
      <path
        key={`mask-${subpath.id}`}
        d={serializeSubpath(subpath)}
        fill={path.paint.fill === "none" ? "none" : "#fff"}
        stroke={path.paint.stroke === "none" ? "none" : "#fff"}
        strokeWidth={path.paint.strokeWidth}
        strokeLinecap={path.paint.strokeLinecap}
        strokeLinejoin={path.paint.strokeLinejoin}
        fillRule={path.paint.fillRule}
        opacity={path.paint.opacity}
      />
    )));
  }

  function compareDefinitions(document: CurveDocument, suffix: string) {
    const sourceMask = `source-alpha-${suffix}`;
    const vectorMask = `vector-alpha-${suffix}`;
    return (
      <defs>
        <filter id={`source-overlay-${suffix}`} x="-5%" y="-5%" width="110%" height="110%" colorInterpolationFilters="sRGB">
          <feFlood floodColor={overlayColor} result="paint" />
          <feComposite in="paint" in2="SourceAlpha" operator="in" />
        </filter>
        <filter id={`source-contour-${suffix}`} x="-10%" y="-10%" width="120%" height="120%" colorInterpolationFilters="sRGB">
          <feMorphology in="SourceAlpha" operator="dilate" radius="0.8" result="dilated" />
          <feMorphology in="SourceAlpha" operator="erode" radius="0.8" result="eroded" />
          <feComposite in="dilated" in2="eroded" operator="out" result="edge" />
          <feFlood floodColor={contourColor} result="paint" />
          <feComposite in="paint" in2="edge" operator="in" />
        </filter>
        <mask id={sourceMask} x={viewBox.x} y={viewBox.y} width={viewBox.width} height={viewBox.height} maskUnits="userSpaceOnUse" maskContentUnits="userSpaceOnUse" style={{ maskType: "alpha" }}>
          <image href={sourceUrl} x={viewBox.x} y={viewBox.y} width={viewBox.width} height={viewBox.height} preserveAspectRatio="none" />
        </mask>
        <mask id={vectorMask} x={viewBox.x} y={viewBox.y} width={viewBox.width} height={viewBox.height} maskUnits="userSpaceOnUse" maskContentUnits="userSpaceOnUse" style={{ maskType: "alpha" }}>
          {alphaMaskPaths(document)}
        </mask>
        <mask id={`svg-only-${suffix}`} x={viewBox.x} y={viewBox.y} width={viewBox.width} height={viewBox.height} maskUnits="userSpaceOnUse" maskContentUnits="userSpaceOnUse">
          <rect x={viewBox.x} y={viewBox.y} width={viewBox.width} height={viewBox.height} fill="#fff" mask={`url(#${vectorMask})`} />
          <rect x={viewBox.x} y={viewBox.y} width={viewBox.width} height={viewBox.height} fill="#000" mask={`url(#${sourceMask})`} />
        </mask>
        <mask id={`png-only-${suffix}`} x={viewBox.x} y={viewBox.y} width={viewBox.width} height={viewBox.height} maskUnits="userSpaceOnUse" maskContentUnits="userSpaceOnUse">
          <rect x={viewBox.x} y={viewBox.y} width={viewBox.width} height={viewBox.height} fill="#fff" mask={`url(#${sourceMask})`} />
          <rect x={viewBox.x} y={viewBox.y} width={viewBox.width} height={viewBox.height} fill="#000" mask={`url(#${vectorMask})`} />
        </mask>
      </defs>
    );
  }

  function previewArtwork(document: CurveDocument, interactive: boolean, suffix: string) {
    const sourceImage = (
      <image
        href={sourceUrl}
        x={viewBox.x}
        y={viewBox.y}
        width={viewBox.width}
        height={viewBox.height}
        preserveAspectRatio="none"
        pointerEvents="none"
      />
    );
    return (
      <>
        {previewMode === "overlay" ? (
          <g opacity={pngOpacity / 100} filter={`url(#source-overlay-${suffix})`}>{sourceImage}</g>
        ) : null}
        {previewMode === "contour" ? (
          <g filter={`url(#source-contour-${suffix})`}>{sourceImage}</g>
        ) : null}
        {previewMode === "difference" ? (
          <g className="curve-diagnostic-mask" opacity={differenceIntensity / 100} pointerEvents="none">
            <rect x={viewBox.x} y={viewBox.y} width={viewBox.width} height={viewBox.height} fill={differenceColor} mask={`url(#svg-only-${suffix})`} />
            <rect x={viewBox.x} y={viewBox.y} width={viewBox.width} height={viewBox.height} fill={contourColor} mask={`url(#png-only-${suffix})`} />
          </g>
        ) : null}
        {vectorPaths(document, interactive, previewMode !== "difference")}
      </>
    );
  }

  return (
    <section className="curve-editor-shell" aria-label="Редактор SVG-кривых">
      <header className="curve-editor-topbar">
        <button type="button" onClick={onClose}>← Назад к результату</button>
        <span className="curve-editor-file"><small>SVG Curve Editor 1.4.1</small><strong>{fileName}</strong></span>
        <div className="curve-editor-history">
          <button type="button" onClick={undo} disabled={historyIndex <= 0} aria-label="Отменить">↶ <span>Undo</span></button>
          <button type="button" onClick={redo} disabled={historyIndex >= history.length - 1} aria-label="Вернуть">↷ <span>Redo</span></button>
        </div>
        <div className="curve-snap-control">
          <button type="button" className={snapping ? "is-active" : ""} onClick={() => setSnapping((value) => !value)} aria-pressed={snapping}>⌁ Магнит</button>
          <button type="button" aria-label="Настройки привязки" onClick={() => setSnapMenuOpen((value) => !value)}>▾</button>
          {snapMenuOpen ? <div className="curve-snap-menu">
            {([ ["points", "Точки"], ["axes", "Края"], ["center", "Центр"], ["guides", "Симметрия"] ] as Array<[SnapOption, string]>).map(([option, label]) => (
              <label key={option}><input type="checkbox" checked={snapOptions[option]} onChange={(event) => setSnapOptions((current) => ({ ...current, [option]: event.target.checked }))} /> {label}</label>
            ))}
          </div> : null}
        </div>
        <label className="curve-editor-zoom"><span>Масштаб</span><select value={zoom} onChange={(event) => { setZoom(Number(event.target.value)); setPan({ x: 0, y: 0 }); }}>{ZOOM_LEVELS.map((level) => <option key={level} value={level}>{level}%</option>)}</select></label>
        <button className="curve-download-button" type="button" onClick={() => downloadSvg(cleanSvg, fileName)}>Скачать SVG <span>↓</span></button>
      </header>

      <div className="curve-editor-layout">
        <nav className="curve-editor-tools" aria-label="Инструменты">
          {([ ["select", "↖", "Выбор"], ["nodes", "●", "Точки"], ["add", "+", "Добавить точку"], ["pan", "✋", "Перемещение"] ] as Array<[EditorTool, string, string]>).map(([toolId, icon, label]) => (
            <button key={toolId} type="button" className={tool === toolId ? "is-active" : ""} onClick={() => setTool(toolId)} title={label} aria-label={label} aria-pressed={tool === toolId}><i aria-hidden="true">{icon}</i><span>{label}</span></button>
          ))}
        </nav>

        <div className="curve-canvas-wrap">
          <svg
            ref={canvasRef}
            className={`curve-canvas is-${tool} preview-${previewMode} ${spacePressed ? "is-space-pan" : ""}`}
            viewBox={`${viewBox.x} ${viewBox.y} ${viewBox.width} ${viewBox.height}`}
            onPointerDown={beginCanvasDrag}
            onPointerMove={moveDrag}
            onPointerLeave={() => { if (!dragRef.current) setMagnifierPoint(null); }}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
            onWheel={handleWheel}
            role="img"
            aria-label="PNG-подложка с редактируемым SVG"
          >
            {compareDefinitions(visibleDocument, "main")}
            <g transform={transform}>
              {previewArtwork(visibleDocument, !simplifyPreview, "main")}

              {activeGuides.map((guide, index) => guide.axis === "x" ? (
                <g key={`${guide.axis}-${guide.value}-${index}`} className="curve-smart-guide"><line x1={guide.value} y1={viewBox.y} x2={guide.value} y2={viewBox.y + viewBox.height} /><text x={guide.value + 5 * screenUnit} y={viewBox.y + 14 * screenUnit} fontSize={12 * screenUnit}>{guide.label}</text></g>
              ) : (
                <g key={`${guide.axis}-${guide.value}-${index}`} className="curve-smart-guide"><line x1={viewBox.x} y1={guide.value} x2={viewBox.x + viewBox.width} y2={guide.value} /><text x={viewBox.x + 7 * screenUnit} y={guide.value - 5 * screenUnit} fontSize={12 * screenUnit}>{guide.label}</text></g>
              ))}
              {selectionBounds ? <rect className="curve-selection-rect" {...selectionBounds} /> : null}

              {!simplifyPreview && tool !== "pan" ? curveDocument.paths.flatMap((path) => path.subpaths.flatMap((subpath) => subpath.nodes.flatMap((node, nodeIndex) => {
                const selected = selectedNodeIds.includes(node.id);
                const visible = pointDisplay === "all" || selected || isKeyNode(subpath, nodeIndex);
                if (!visible) return [];
                const showHandles = selectedNodeIds.length === 1 && selected;
                return [
                  ...(showHandles ? [
                    <line key={`${node.id}-in-line`} className="curve-handle-line" x1={node.x} y1={node.y} x2={node.handleIn.x} y2={node.handleIn.y} />,
                    <line key={`${node.id}-out-line`} className="curve-handle-line" x1={node.x} y1={node.y} x2={node.handleOut.x} y2={node.handleOut.y} />,
                    <circle key={`${node.id}-in-hit`} className="curve-marker-hit" cx={node.handleIn.x} cy={node.handleIn.y} r={marker.hit} onPointerDown={(event) => beginNodeDrag(event, node.id, "handle-in")} />,
                    <circle key={`${node.id}-in`} className="curve-handle" cx={node.handleIn.x} cy={node.handleIn.y} r={marker.handle} pointerEvents="none" />,
                    <circle key={`${node.id}-out-hit`} className="curve-marker-hit" cx={node.handleOut.x} cy={node.handleOut.y} r={marker.hit} onPointerDown={(event) => beginNodeDrag(event, node.id, "handle-out")} />,
                    <circle key={`${node.id}-out`} className="curve-handle" cx={node.handleOut.x} cy={node.handleOut.y} r={marker.handle} pointerEvents="none" />,
                  ] : []),
                  <g key={node.id} className={`curve-anchor-group ${selected ? "is-selected" : ""}`}>
                    <circle className="curve-marker-hit" cx={node.x} cy={node.y} r={marker.hit} onPointerDown={(event) => beginNodeDrag(event, node.id, "nodes")} />
                    <circle className={`curve-anchor ${selected ? "is-selected" : ""} ${node.type === "smooth" ? "is-smooth" : "is-corner"}`} cx={node.x} cy={node.y} r={selected ? marker.selected : marker.anchor} pointerEvents="none" />
                  </g>,
                ];
              }))) : null}
            </g>
          </svg>

          {magnifierZoom && magnifierPoint ? <div className="curve-magnifier" aria-hidden="true">
            <b>{magnifierZoom}×</b>
            <svg viewBox={`${magnifierPoint.x - viewBox.width / magnifierZoom / 2} ${magnifierPoint.y - viewBox.height / magnifierZoom / 2} ${viewBox.width / magnifierZoom} ${viewBox.height / magnifierZoom}`}>
              {compareDefinitions(visibleDocument, "magnifier")}
              {previewArtwork(visibleDocument, false, "magnifier")}
              <circle cx={magnifierPoint.x} cy={magnifierPoint.y} r={1.2 * screenUnit} />
            </svg>
          </div> : null}

          <div className="curve-canvas-status"><span>{status}</span><em>{nodeCount} точек · {zoom}%</em></div>
        </div>

        <aside className="curve-editor-inspector">
          <small>Выбрано точек: {selectedCount}</small>
          <h3>{selectedNode ? "Точка" : selectedCount > 1 ? "Группа точек" : "Редактор кривой"}</h3>

          <fieldset>
            <legend>Сравнение</legend>
            <div className="curve-segmented curve-compare-modes">
              {(["svg", "overlay", "difference", "contour"] as PreviewMode[]).map((mode) => (
                <button key={mode} type="button" className={previewMode === mode ? "is-active" : ""} onClick={() => setPreviewMode(mode)}>
                  {mode === "svg" ? "SVG" : mode === "overlay" ? "Наложение" : mode === "difference" ? "Разница" : "Контур PNG"}
                </button>
              ))}
            </div>
            {previewMode === "difference" ? (
              <p className="curve-diagnostic-note"><strong>Диагностический режим.</strong> Цвета служебные и не влияют на SVG.</p>
            ) : null}
          </fieldset>

          <fieldset className="curve-compare-controls">
            <legend>Служебные цвета</legend>
            <div className="curve-color-controls">
              <label><span>PNG-подложка</span><input type="color" value={overlayColor} onChange={(event) => setOverlayColor(event.target.value)} /></label>
              <label><span>Контур / не хватает SVG</span><input type="color" value={contourColor} onChange={(event) => setContourColor(event.target.value)} /></label>
              <label><span>SVG выходит за PNG</span><input type="color" value={differenceColor} onChange={(event) => setDifferenceColor(event.target.value)} /></label>
            </div>
            <label className="curve-compare-range"><span>Прозрачность PNG <b>{pngOpacity}%</b></span><input type="range" min="0" max="100" value={pngOpacity} onChange={(event) => setPngOpacity(Number(event.target.value))} /></label>
            <label className="curve-compare-range"><span>Яркость различий <b>{differenceIntensity}%</b></span><input type="range" min="10" max="100" value={differenceIntensity} onChange={(event) => setDifferenceIntensity(Number(event.target.value))} /></label>
          </fieldset>

          <fieldset>
            <legend>Точки на холсте</legend>
            <div className="curve-segmented"><button type="button" className={pointDisplay === "key" ? "is-active" : ""} onClick={() => setPointDisplay("key")}>Ключевые</button><button type="button" className={pointDisplay === "all" ? "is-active" : ""} onClick={() => setPointDisplay("all")}>Все</button></div>
          </fieldset>

          <fieldset>
            <legend>Тип точки {handleAngle !== null ? `· касательная ${handleAngle.toFixed(0)}°` : ""}</legend>
            <div className="curve-point-types"><button type="button" className={selectedNode?.type === "smooth" ? "is-active" : ""} onClick={() => setPointType("smooth")} disabled={!selectedCount}>● Плавная</button><button type="button" className={selectedNode?.type === "corner" ? "is-active" : ""} onClick={() => setPointType("corner")} disabled={!selectedCount}>◆ Угловая</button></div>
          </fieldset>

          {selectedNode ? <div className="curve-coordinate-grid"><label>X <input type="number" step="0.1" value={Number(selectedNode.x.toFixed(2))} onChange={(event) => changeSelectedCoordinate("x", event.target.value)} /></label><label>Y <input type="number" step="0.1" value={Number(selectedNode.y.toFixed(2))} onChange={(event) => changeSelectedCoordinate("y", event.target.value)} /></label></div> : null}

          <button className="curve-primary-action" type="button" onClick={() => setPointType("smooth")} disabled={!selectedCount}>Сделать плавнее</button>

          <div className="curve-geometry-actions"><button type="button" onClick={() => alignSelection("y")} disabled={selectedCount < 2}>В одну строку</button><button type="button" onClick={() => alignSelection("x")} disabled={selectedCount < 2}>В одну колонку</button><button type="button" onClick={straightenSelection} disabled={selectedCount < 3}>Выпрямить</button></div>

          <div className="curve-smoothing-controls">
            <label><span>Сила сглаживания <b>{smoothStrength}%</b></span><input type="range" min="10" max="100" step="5" value={smoothStrength} onChange={(event) => setSmoothStrength(Number(event.target.value))} /></label>
            <button type="button" onClick={smoothSelection} disabled={!selectedCount}>Сгладить</button>
            <button type="button" onClick={makeSimplifyPreview}>Упростить · {nodeCount} точек</button>
          </div>

          {simplifyPreview ? <div className="curve-simplify-preview"><strong>{simplifyPreview.before} → {simplifyPreview.after} точек</strong><small>Отклонение до {simplifyPreview.deviation.toFixed(2)} px</small><div><button type="button" onClick={applySimplifyPreview}>Применить</button><button type="button" onClick={() => setSimplifyPreview(null)}>Отмена</button></div></div> : null}

          <button className="curve-delete-button" type="button" onClick={deleteSelection} disabled={!selectedCount}>Удалить {selectedCount > 1 ? "точки" : "точку"}</button>
          <p>Shift — 0/45/90° или несколько точек. Space — холст. Ctrl+A — текущий контур. Esc — снять выделение.</p>
        </aside>
      </div>

      <footer className="curve-editor-bottom">
        <label><span>PNG-подложка</span><input type="range" min="0" max="100" value={pngOpacity} onChange={(event) => setPngOpacity(Number(event.target.value))} /><b>{pngOpacity}%</b></label>
        <label className="curve-magnifier-select"><span>Лупа</span><select value={magnifierZoom} onChange={(event) => setMagnifierZoom(Number(event.target.value) as 0 | 4 | 8)}><option value="0">Выкл.</option><option value="4">4×</option><option value="8">8×</option></select></label>
        <button type="button" onClick={resetView}>По размеру</button>
        <span>Ctrl + колесо — масштаб · Space + перетаскивание — холст</span>
      </footer>
    </section>
  );
}
