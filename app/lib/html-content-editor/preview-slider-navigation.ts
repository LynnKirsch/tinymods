import type { SliderGroup } from "./slider-groups";

/** Self-contained factory: serialized into the opaque-origin iframe, never user source. */
export function createLiveSliderNavigation(document: Document, groups: SliderGroup[]) {
  const indices = new Map<string, number>();
  const owner = (attribute: string, id: string) => Array.from(document.querySelectorAll<HTMLElement>(`[${attribute}]`))
    .find(element => element.getAttribute(attribute) === id);
  function rootFor(group: SliderGroup) { return owner("data-tinymods-slider-root", group.id); }
  function ownControl(root: HTMLElement, selector: string) {
    return Array.from(root.querySelectorAll<HTMLElement>(selector)).find(element => element.closest("[data-tinymods-slider-root]") === root);
  }
  function viewportFor(group: SliderGroup) {
    return (group.viewportRange ? owner("data-tinymods-slider-viewport", group.id) : undefined)
      ?? owner("data-tinymods-slider-track", group.id) ?? rootFor(group);
  }
  function scrollGeometry(group: SliderGroup) {
    const viewport = viewportFor(group);
    if (!viewport || viewport.scrollWidth <= viewport.clientWidth + 2) return null;
    const left = viewport.getBoundingClientRect().left + (viewport.clientLeft || 0);
    const maxOffset = Math.max(viewport.scrollWidth - viewport.clientWidth, 0);
    const stops = group.slides.map(slide => {
      const element = owner("data-tinymods-slider-slide", slide.id);
      return element ? Math.min(Math.max(element.getBoundingClientRect().left - left + viewport.scrollLeft, 0), maxOffset) : NaN;
    });
    if (stops.some(stop => !Number.isFinite(stop))) return null;
    let maxIndex = stops.findIndex(stop => stop >= maxOffset - 2);
    if (maxIndex < 0) maxIndex = stops.length - 1;
    let index = 0;
    for (let i = 1; i <= maxIndex; i++) if (Math.abs(stops[i] - viewport.scrollLeft) < Math.abs(stops[index] - viewport.scrollLeft)) index = i;
    return { viewport, stops, maxIndex, index, canPrev: viewport.scrollLeft > 2, canNext: viewport.scrollLeft < maxOffset - 2 };
  }
  function activeIndex(group: SliderGroup) {
    const root = rootFor(group) as (HTMLElement & { swiper?: { activeIndex: number } }) | undefined;
    if (root?.swiper && Number.isInteger(root.swiper.activeIndex)) return Math.min(group.slides.length - 1, Math.max(0, root.swiper.activeIndex));
    const geometry = scrollGeometry(group);
    if (geometry) return geometry.index;
    const marked = group.slides.findIndex(slide => {
      const element = owner("data-tinymods-slider-slide", slide.id);
      return element?.matches('.active, .is-active, .current, .is-current, .swiper-slide-active, [aria-hidden="false"]');
    });
    return marked >= 0 ? marked : indices.get(group.id) ?? 0;
  }
  function navigationState(group: SliderGroup) {
    const root = rootFor(group) as (HTMLElement & { swiper?: { isBeginning?: boolean; isEnd?: boolean } }) | undefined;
    const index = activeIndex(group);
    if (root?.swiper) return { index, canPrev: root.swiper.isBeginning === false, canNext: root.swiper.isEnd === false };
    const geometry = scrollGeometry(group);
    if (geometry) return geometry;
    const prev = root && ownControl(root, '[data-prev], [data-slider-prev], .swiper-button-prev, .slider-prev, .carousel-prev');
    const next = root && ownControl(root, '[data-next], [data-slider-next], .swiper-button-next, .slider-next, .carousel-next');
    const enabled = (element: HTMLElement | undefined) => Boolean(element && !element.matches(":disabled, [aria-disabled=true], .swiper-button-disabled"));
    if (prev || next) return { index, canPrev: enabled(prev), canNext: enabled(next) };
    const staticSlides = !document.querySelector("script:not([data-tinymods-runtime])") && group.slides.some(slide => owner("data-tinymods-slider-slide", slide.id)?.matches(".active, .is-active, .current, .is-current"));
    return { index, canPrev: staticSlides && index > 0, canNext: staticSlides && index < group.slides.length - 1 };
  }
  function goToSlide(id: string, index: number) {
    const group = groups.find(candidate => candidate.id === id);
    if (!group || !Number.isInteger(index) || index < 0 || index >= group.slides.length) return;
    const root = rootFor(group) as (HTMLElement & { swiper?: { slideTo(index: number): void } }) | undefined;
    if (!root) return;
    if (root.swiper) { root.swiper.slideTo(index); return; }
    const geometry = scrollGeometry(group);
    if (geometry) index = Math.min(index, geometry.maxIndex);
    if (geometry && Math.abs(geometry.stops[index] - geometry.viewport.scrollLeft) <= 2) return;
    // Prefer the user's own controls; this avoids a second slider state machine.
    const direct = ownControl(root, `[data-go-to="${index}"], [data-slide-to="${index}"], [data-slide="${index}"]`);
    if (direct) { direct.click(); indices.set(id, index); return; }
    const forward = geometry ? geometry.stops[index] > geometry.viewport.scrollLeft : index > activeIndex(group);
    const button = ownControl(root, forward
      ? '[data-next], [data-slider-next], .swiper-button-next, [aria-label*="Следующ"], [aria-label*="Next"], .slider-next, .carousel-next'
      : '[data-prev], [data-slider-prev], .swiper-button-prev, [aria-label*="Предыдущ"], [aria-label*="Previous"], .slider-prev, .carousel-prev');
    if (button) { if (!button.matches(":disabled, [aria-disabled=true]")) { button.click(); indices.set(id, index); } return; }
    const viewport = group.viewportRange ? owner("data-tinymods-slider-viewport", id) : undefined;
    const slide = owner("data-tinymods-slider-slide", group.slides[index].id);
    if (viewport && slide && viewport.scrollWidth > viewport.clientWidth) {
      viewport.scrollTo({ left: viewport.scrollLeft + slide.getBoundingClientRect().left - viewport.getBoundingClientRect().left, behavior: "smooth" });
      indices.set(id, index);
      return;
    }
    // Static stacked markup has no JS owner. Transfer only an existing active class,
    // and only on an explicit editor action; never rewrite the initial layout.
    if (!document.querySelector("script:not([data-tinymods-runtime])")) {
      const slides = group.slides.map(slide => owner("data-tinymods-slider-slide", slide.id));
      const activeClass = ["active", "is-active", "current", "is-current"].find(name => slides.some(slide => slide?.classList.contains(name)));
      if (activeClass) {
        slides.forEach((slide, slideIndex) => slide?.classList.toggle(activeClass, slideIndex === index));
        indices.set(id, index);
      }
    }
  }
  function positions() {
    return groups.flatMap(group => {
      const root = rootFor(group);
      if (!root || !root.getClientRects().length) return [];
      for (let parent: HTMLElement | null = root; parent; parent = parent.parentElement) {
        const style = document.defaultView?.getComputedStyle(parent);
        if (style && (style.display === "none" || style.visibility === "hidden" || style.opacity === "0")) return [];
      }
      const bounds = (viewportFor(group) ?? root).getBoundingClientRect();
      if (bounds.bottom < 0 || bounds.top > (document.defaultView?.innerHeight ?? 0)) return [];
      const state = navigationState(group);
      return [{ widgetGroupId: group.id, top: (bounds.top + bounds.bottom) / 2, index: state.index, count: group.slides.length, canPrev: state.canPrev, canNext: state.canNext }];
    });
  }
  return { goToSlide, positions };
}

type PreviewSliderNavigationOptions = {
  previewScale?: number;
  previewMarkers?: Record<string, string>;
  activeSlideBySliderId?: Record<string, number>;
  onSlideChange?: (sliderId: string, slideIndex: number) => void;
};

export type PreviewSliderNavigationController = {
  setPreviewScale: (scale: number) => void;
  goToSlide: (sliderId: string, slideIndex: number) => void;
  cleanup: () => void;
};

type RuntimeMode = "scroll-viewport" | "stacked-single" | "offset";
type AttributeSnapshot = Map<string, string | null>;
const STATE_ATTRIBUTE = "data-tinymods-slider-state";
const EPSILON = 2;
const STYLE_ID = "tinymods-preview-slider-navigation-style";
const CONTROL_CLASS = "tinymods-preview-slider-controls";
const ACTIVE_SLIDE_CLASS = "tinymods-preview-slider-active";


const SOURCE_ACTIVE_CLASS = /^(?:active|is-active|current|is-current|selected|is-selected)$/i;

function ensureStyle(document: Document) {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
.${CONTROL_CLASS} {
  position: absolute;
  z-index: 2147483000;
  pointer-events: none;
  display: grid;
  grid-template-columns: 44px minmax(0, auto) 44px;
  align-items: center;
  gap: 8px;
  box-sizing: border-box;
  width: max-content;
  padding: 6px;
  border: 1px solid #9ab4bd;
  border-radius: 8px;
  background: #fff;
  box-shadow: 0 3px 12px rgba(15, 40, 50, .24);
  transform-origin: top left;
  font-family: Inter, Manrope, "Segoe UI", Arial, sans-serif;
  letter-spacing: 0;
}
.${CONTROL_CLASS} button {
  box-sizing: border-box;
  width: 44px;
  height: 44px;
  min-width: 0;
  margin: 0;
  padding: 0;
  border: 1px solid rgba(20, 105, 135, .34);
  border-radius: 6px;
  background: #146987;
  color: #fff;
  cursor: pointer;
  pointer-events: auto;
  font-family: inherit;
  font-size: 28px;
  font-weight: 900;
  line-height: 1;
  letter-spacing: 0;
}
.${CONTROL_CLASS}[hidden] {
  display: none;
}
.${CONTROL_CLASS} button:hover:not(:disabled) {
  background: #0f5b76;
}
.${CONTROL_CLASS} button:focus-visible {
  outline: 3px solid #146987;
  outline-offset: 2px;
}
.${CONTROL_CLASS} button:disabled {
  cursor: default;
  background: #e3ebee;
  border-color: #c2d1d7;
  color: #647d87;
}
.${CONTROL_CLASS} span {
  min-width: 0;
  margin: 0;
  padding: 0 4px;
  color: #183b49;
  font-size: 14px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  line-height: 1.3;
  text-align: center;
}
.${ACTIVE_SLIDE_CLASS} {
  outline: 2px solid #238fbc !important;
  outline-offset: 3px !important;
}


`;
  document.head.append(style);
}


function markedOwner(document: Document, attribute: string, id: string) {
  const escaped = id.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return document.querySelector<HTMLElement>(`[${attribute}="${escaped}"]`);
}

function clamp(index: number, max: number) {
  return Math.min(Math.max(Math.trunc(index), 0), max);
}

function activeClasses(slides: HTMLElement[]) {
  const active = slides.filter(slide => [...slide.classList].some(name => SOURCE_ACTIVE_CLASS.test(name)));
  return active.length === 1 ? [...active[0].classList].filter(name => SOURCE_ACTIVE_CLASS.test(name)) : [];
}

function isStacked(slides: HTMLElement[], window: Window) {
  const styles = slides.map(slide => window.getComputedStyle(slide));
  const shown = styles.filter(style => style.display !== "none");
  if (shown.length === 1) return true;
  const first = slides[0].getBoundingClientRect();
  const overlap = first.width > 0 && slides.every(slide => {
    const rect = slide.getBoundingClientRect();
    return Math.abs(rect.left - first.left) <= EPSILON &&
      Math.abs(rect.top - first.top) <= EPSILON &&
      Math.abs(rect.width - first.width) <= EPSILON;
  });
  const positionedOverlap = first.width > 0 && first.height > 0 && styles.every(style => style.position === "absolute") &&
    slides.every(slide => {
      const rect = slide.getBoundingClientRect();
      const intersection = Math.max(0, Math.min(rect.right, first.right) - Math.max(rect.left, first.left)) *
        Math.max(0, Math.min(rect.bottom, first.bottom) - Math.max(rect.top, first.top));
      return intersection / Math.max(rect.width * rect.height, first.width * first.height) > 0.85;
    });
  return (overlap || positionedOverlap) && (activeClasses(slides).length > 0 ||
    styles.filter(style => style.visibility !== "hidden" && Number(style.opacity) > 0).length === 1);
}

function resolveLayout(root: HTMLElement, track: HTMLElement, modelViewport: HTMLElement | null, slides: HTMLElement[], window: Window) {
  if (isStacked(slides, window)) {
    return { mode: "stacked-single" as const, viewport: modelViewport ?? track };
  }
  const candidates = new Set<HTMLElement>();
  if (modelViewport && root.contains(modelViewport)) candidates.add(modelViewport);
  let ancestor: HTMLElement | null = track;
  while (ancestor && root.contains(ancestor)) {
    candidates.add(ancestor);
    if (ancestor === root) break;
    ancestor = ancestor.parentElement;
  }
  for (const element of candidates) {
    if (slides.every(slide => element.contains(slide)) &&
      /^(auto|scroll|overlay)$/.test(window.getComputedStyle(element).overflowX) &&
      element.scrollWidth > element.clientWidth + EPSILON) {
      return { mode: "scroll-viewport" as const, viewport: element };
    }
  }
  const first = slides[0].getBoundingClientRect();
  const horizontal = first.width > 0 && slides.every((slide, index) => {
    const rect = slide.getBoundingClientRect();
    return Math.abs(rect.top - first.top) <= EPSILON &&
      (index === 0 || rect.left > slides[index - 1].getBoundingClientRect().left + EPSILON);
  });
  if (!horizontal) return null;
  const viewport = [...candidates].find(element =>
    slides.every(slide => element.contains(slide)) &&
    /^(hidden|clip|auto|scroll|overlay)$/.test(window.getComputedStyle(element).overflowX));
  return viewport ? { mode: "offset" as const, viewport } : null;
}

export function installPreviewSliderNavigation(
  document: Document,
  groups: SliderGroup[],
  options: PreviewSliderNavigationOptions = {},
): PreviewSliderNavigationController {
  const window = document.defaultView;
  if (!window) return { goToSlide() {}, setPreviewScale() {}, cleanup() {} };
  const hadStyle = Boolean(document.getElementById(STYLE_ID));
  ensureStyle(document);
  const snapshots = new Map<HTMLElement, AttributeSnapshot>();
  const scrollPositions = new Map<HTMLElement, number>();
  const disposers: Array<() => void> = [];
  const navigators = new Map<string, (index: number) => void>();
  const runtimes = new Map<string, { refresh: () => void; active: () => number; available: () => boolean }>();
  const controlPositioners: Array<() => void> = [];
  const validScale = (scale: number) => Number.isFinite(scale) && scale > 0 ? scale : 1;
  let previewScale = validScale(options.previewScale ?? 1);
  let disposed = false;

  function remember(element: HTMLElement) {
    if (!snapshots.has(element)) {
      snapshots.set(element, new Map(
        ["style", "class", "aria-hidden", STATE_ATTRIBUTE].map(name => [name, element.getAttribute(name)]),
      ));
    }
  }
  function restore(element: HTMLElement) {
    const highlighted = element.classList.contains("tinymods-preview-active");
    for (const [name, value] of snapshots.get(element) ?? []) {
      if (value === null) element.removeAttribute(name);
      else element.setAttribute(name, value);
    }
    // Content mapping owns this class independently of slider navigation.
    if (highlighted || element.classList.contains("tinymods-preview-active")) {
      element.classList.toggle("tinymods-preview-active", highlighted);
    }
  }

  for (const group of groups) {
    const root = markedOwner(document, "data-tinymods-slider-root", group.id);
    const track = markedOwner(document, "data-tinymods-slider-track", group.id);
    const modelViewport = markedOwner(document, "data-tinymods-slider-viewport", group.id);
    const slides = group.slides.map(slide => markedOwner(document, "data-tinymods-slider-slide", slide.id));
    if (!root || !track || slides.some(slide => !slide) || slides.length < 2) continue;
    const owners = slides as HTMLElement[];
    if (new Set(owners).size !== owners.length || !owners.every(slide => track.contains(slide))) continue;
    for (const slide of owners) remember(slide);
    const sourceClasses = activeClasses(owners);
    const swiper = (root.classList.contains("swiper-container") || root.classList.contains("swiper")) &&
      track.classList.contains("swiper-wrapper") &&
      owners.every(slide => slide.parentElement === track && slide.classList.contains("swiper-slide"));
    const geometryElements = new Map<HTMLElement, Record<string, string>>();
    function restoreSwiperGeometry() {
      if (!swiper) return;
      for (const element of geometryElements.keys()) restore(element);
      geometryElements.clear();
      const container = modelViewport ?? root!;
      const bounds = container.getBoundingClientRect();
      const broken = track!.getBoundingClientRect().height <= EPSILON ||
        owners.some(slide => slide.getBoundingClientRect().height <= EPSILON);
      if (!broken || bounds.width <= EPSILON || bounds.height <= EPSILON ||
        [container, track!, ...owners].some(element => window!.getComputedStyle(element).display === "none")) return;
      const set = (element: HTMLElement, properties: Record<string, string>) => {
        remember(element);
        geometryElements.set(element, properties);
        for (const [name, value] of Object.entries(properties)) element.style.setProperty(name, value, "important");
      };
      // Only repair missing library layout, using the source viewport as the containing block.
      set(track!, { display: "flex", position: "relative", width: "100%", height: `${container.clientHeight}px`,
        "flex-direction": "row", "flex-wrap": "nowrap", gap: "0", "box-sizing": "border-box" });
      for (const slide of owners) set(slide, { position: "relative", flex: "0 0 100%", width: "100%",
        height: "100%", "box-sizing": "border-box" });
      if (!/^(hidden|clip|auto|scroll|overlay)$/.test(window!.getComputedStyle(container).overflowX)) {
        set(container, { overflow: "hidden" });
      }
    }
    let displayHidden = false;
    const childRoots = groups.filter(child => child.parentSliderId === group.id)
      .map(child => markedOwner(document, "data-tinymods-slider-root", child.id))
      .filter((element): element is HTMLElement => Boolean(element));
    const owns = (element: HTMLElement) => !childRoots.some(child => child === element || child.contains(element));
    function available(): boolean {
      if (!group.parentSliderId) return true;
      const parent = runtimes.get(group.parentSliderId);
      const parentModel = groups.find(candidate => candidate.id === group.parentSliderId);
      return Boolean(parent?.available() && parentModel?.slides[parent.active()]?.id === group.parentSlideId);
    }
    function refreshChildren() {
      for (const child of groups.filter(candidate => candidate.parentSliderId === group.id)) runtimes.get(child.id)?.refresh();
    }
    const initialIndex = Math.max(owners.findIndex(slide =>
      sourceClasses.some(name => slide.classList.contains(name))), 0);
    let index = options.activeSlideBySliderId?.[group.id] ?? initialIndex;
    let mode: RuntimeMode | null = null;
    let viewport = modelViewport ?? track;
    let positions: number[] = [];
    let maxIndex = 0;
    let fullCount = 1;
    let observedViewport: HTMLElement | null = null;
    const stackedElements = new Set<HTMLElement>();

    const controls = document.createElement("div");
    controls.className = CONTROL_CLASS;
    controls.setAttribute("data-tinymods-slider-controls", group.id);
    const previous = document.createElement("button");
    previous.type = "button";
    previous.textContent = "‹";
    previous.setAttribute("aria-label", "Предыдущий слайд");
    previous.setAttribute("title", "Предыдущий слайд");
    const counter = document.createElement("span");
    counter.setAttribute("aria-live", "polite");
    const next = document.createElement("button");
    next.type = "button";
    next.textContent = "›";
    next.setAttribute("aria-label", "Следующий слайд");
    next.setAttribute("title", "Следующий слайд");
    controls.append(previous, counter, next);
    document.body.append(controls);

    function positionControls() {
      const bounds = viewport.getBoundingClientRect();
      // Cancel only the iframe's visual scale; slide geometry and movement stay untouched.
      controls.style.transform = `scale(${1 / previewScale})`;
      controls.style.maxWidth = `${Math.max(window!.innerWidth * previewScale - 24, 0)}px`;
      const width = controls.offsetWidth / previewScale;
      const height = controls.offsetHeight / previewScale;
      const inset = 12 / previewScale;
      const left = Math.max(inset, Math.min(bounds.left + (bounds.width - width) / 2, window!.innerWidth - inset - width));
      const bottom = bounds.top + bounds.height;
      const preferredTop = childRoots.length > 0
        ? track!.getBoundingClientRect().top - height - inset
        : group.parentSliderId ? bounds.top + inset : bottom - height - inset;
      let top = bottom > 0 && bounds.top < window!.innerHeight
        ? Math.max(inset, Math.min(preferredTop, window!.innerHeight - inset - height))
        : preferredTop;
      // At small iframe scales, keep the child surface clear of its ancestors' controls.
      let parentId = group.parentSliderId;
      while (parentId) {
        const parentControls = markedOwner(document, "data-tinymods-slider-controls", parentId);
        if (parentControls && !parentControls.hidden) {
          const parentBounds = parentControls.getBoundingClientRect();
          if (left < parentBounds.right && left + width > parentBounds.left &&
            top < parentBounds.bottom + inset && top + height > parentBounds.top - inset) {
            top = parentBounds.bottom + inset;
          }
        }
        parentId = groups.find(candidate => candidate.id === parentId)?.parentSliderId;
      }
      controls.style.left = `${window!.scrollX + left}px`;
      controls.style.top = `${window!.scrollY + top}px`;
    }
    controlPositioners.push(positionControls);
    function updateControls() {
      controls.hidden = mode === null || !available();
      controls.setAttribute("data-mode", mode ?? "unsupported");
      controls.setAttribute("data-visible-count", String(fullCount));
      controls.setAttribute("data-max-index", String(maxIndex));
      const label = childRoots.length > 0 ? group.slides[index]?.label : undefined;
      counter.textContent = label ? `${label} · ${index + 1} из ${owners.length}` :
        `${group.parentSliderId && group.mediaOnly ? "Фото" : "Слайд"} ${index + 1} из ${owners.length}`;
      previous.disabled = index === 0;
      next.disabled = index >= maxIndex;
      owners.forEach((slide, i) => slide.classList.toggle(ACTIVE_SLIDE_CLASS, i === index));
      positionControls();
    }
    function applyStacked() {
      // Class-driven descendants must reach their final visual state, without source choreography.
      for (const element of stackedElements) restore(element);
      for (const [element, properties] of geometryElements) {
        for (const [name, value] of Object.entries(properties)) element.style.setProperty(name, value, "important");
      }
      const display = owners.map(slide => window!.getComputedStyle(slide).display).find(value => value !== "none") ?? "block";
      owners.forEach((slide, i) => {
        const active = i === index;
        for (const element of [slide, ...slide.querySelectorAll<HTMLElement>("*")]) {
          if (!owns(element)) continue;
          remember(element);
          stackedElements.add(element);
          element.style.setProperty("transition", "none", "important");
          element.style.setProperty("animation", "none", "important");
        }
        for (const name of sourceClasses) slide.classList.toggle(name, active);
        if (swiper) slide.classList.toggle("swiper-slide-active", active);
        slide.setAttribute(STATE_ATTRIBUTE, active ? "active" : "inactive");
        slide.setAttribute("aria-hidden", active ? "false" : "true");
        if (displayHidden && mode === "stacked-single") slide.style.setProperty("display", active ? display : "none", "important");
        slide.style.setProperty("visibility", active ? "visible" : "hidden", "important");
        slide.style.setProperty("opacity", active ? "1" : "0", "important");
        slide.style.setProperty("pointer-events", active ? "auto" : "none", "important");
        slide.style.setProperty("z-index", active ? "1" : "0", "important");
        if (!active) return;
        // Recovery stays inside editable ancestors of this confirmed active slide.
        for (const owner of slide.querySelectorAll<HTMLElement>("[data-tinymods-preview-ids]")) {
          if (!owns(owner)) continue;
          let element: HTMLElement | null = owner;
          while (element && element !== slide) {
            const style = window!.getComputedStyle(element);
            if (style.display !== "none") {
              if (Number(style.opacity) === 0) element.style.setProperty("opacity", "1", "important");
              if (style.visibility === "hidden") element.style.setProperty("visibility", "visible", "important");
            }
            element = element.parentElement;
          }
        }
      });
    }
    function move(nextIndex: number) {
      if (disposed || !mode) return;
      index = clamp(nextIndex, maxIndex);
      if (mode === "stacked-single" || swiper) applyStacked();
      if (mode === "scroll-viewport") viewport.scrollTo({ left: positions[index], behavior: "instant" });
      else if (mode === "offset") {
        const offset = positions[index];
        for (const slide of owners) {
          slide.style.setProperty("transition", "none", "important");
          slide.style.setProperty("translate", `${-offset}px 0`, "important");
        }
      }
      updateControls();
      refreshChildren();
    }
    function observeScroll() {
      if (disposed || mode !== "scroll-viewport") return;
      let nearest = 0;
      for (let i = 1; i <= maxIndex; i++) {
        if (Math.abs(positions[i] - viewport.scrollLeft) < Math.abs(positions[nearest] - viewport.scrollLeft)) nearest = i;
      }
      const changed = index !== nearest;
      index = nearest;
      if (changed && swiper) applyStacked();
      // Observation never calls move()/scrollTo() or a callback that can reposition the slider.
      updateControls();
      if (changed) refreshChildren();
    }
    function refresh() {
      if (disposed) return;
      if (!available()) {
        controls.hidden = true;
        refreshChildren();
        return;
      }
      for (const element of stackedElements) restore(element);
      stackedElements.clear();
      for (const slide of owners) restore(slide);
      restoreSwiperGeometry();
      displayHidden = owners.some(slide => window!.getComputedStyle(slide).display === "none");
      const layout = resolveLayout(root!, track!, modelViewport, owners, window!);
      mode = layout?.mode ?? null;
      viewport = layout?.viewport ?? modelViewport ?? track!;
      if (observedViewport !== viewport) {
        observedViewport?.removeEventListener("scroll", observeScroll);
        observedViewport = viewport;
        observedViewport.addEventListener("scroll", observeScroll);
      }
      if (mode === "scroll-viewport" && !scrollPositions.has(viewport)) scrollPositions.set(viewport, viewport.scrollLeft);
      if (mode === "stacked-single") {
        fullCount = 1;
        maxIndex = owners.length - 1;
      } else if (mode) {
        const bounds = viewport.getBoundingClientRect();
        const left = bounds.left + viewport.clientLeft;
        const scroll = mode === "scroll-viewport" ? viewport.scrollLeft : 0;
        const rects = owners.map(slide => slide.getBoundingClientRect());
        const starts = rects.map(rect => rect.left - left + scroll);
        const first = starts[0];
        // Count complete cards in an aligned layout window, independent of intermediate scroll frames.
        fullCount = rects.filter((rect, i) => starts[i] >= first - EPSILON &&
          starts[i] + rect.width <= first + viewport.clientWidth + EPSILON).length;
        const maxOffset = mode === "scroll-viewport"
          ? Math.max(viewport.scrollWidth - viewport.clientWidth, 0)
          : Math.max(starts.at(-1)! + rects.at(-1)!.width - viewport.clientWidth, 0);
        positions = starts.map(start => Math.min(Math.max(start, 0), maxOffset));
        // Several tail cards can map to the same final viewport. Keep a single stop.
        maxIndex = positions.findIndex(position => position >= maxOffset - EPSILON);
        if (maxIndex < 0) maxIndex = owners.length - 1;
      }
      move(index);
      updateControls();
    }
    function previousClick(event: Event) {
      event.preventDefault();
      event.stopPropagation();
      move(index - 1);
      options.onSlideChange?.(group.id, index);
    }
    function nextClick(event: Event) {
      event.preventDefault();
      event.stopPropagation();
      move(index + 1);
      options.onSlideChange?.(group.id, index);
    }
    previous.addEventListener("click", previousClick);
    next.addEventListener("click", nextClick);
    window.addEventListener("resize", refresh);
    window.addEventListener("scroll", positionControls, true);
    const Observer = (window as Window & { ResizeObserver?: typeof ResizeObserver }).ResizeObserver;
    const observer = Observer ? new Observer(refresh) : null;
    for (const element of new Set([root, track, modelViewport, ...owners])) {
      if (element) observer?.observe(element);
    }
    runtimes.set(group.id, { refresh, active: () => index, available });
    refresh();
    navigators.set(group.id, move);
    disposers.push(() => {
      observer?.disconnect();
      observedViewport?.removeEventListener("scroll", observeScroll);
      window.removeEventListener("resize", refresh);
      window.removeEventListener("scroll", positionControls, true);
      previous.removeEventListener("click", previousClick);
      next.removeEventListener("click", nextClick);
      controls.remove();
    });
  }

  return {
    setPreviewScale(scale) {
      if (disposed) return;
      previewScale = validScale(scale);
      for (const positionControls of controlPositioners) positionControls();
    },
    goToSlide(sliderId, slideIndex) {
      const path: Array<[string, number]> = [[sliderId, slideIndex]];
      const visited = new Set([sliderId]);
      let group = groups.find(candidate => candidate.id === sliderId);
      while (group?.parentSliderId && !visited.has(group.parentSliderId)) {
        const parent = groups.find(candidate => candidate.id === group!.parentSliderId);
        const index = parent?.slides.findIndex(slide => slide.id === group!.parentSlideId) ?? -1;
        if (!parent || index < 0) break;
        path.unshift([parent.id, index]);
        visited.add(parent.id);
        group = parent;
      }
      for (const [id, index] of path) navigators.get(id)?.(index);
    },
    cleanup() {
      if (disposed) return;
      disposed = true;
      for (const dispose of disposers) dispose();
      for (const element of snapshots.keys()) restore(element);
      for (const [element, left] of scrollPositions) element.scrollTo({ left, behavior: "instant" });
      if (!hadStyle) document.getElementById(STYLE_ID)?.remove();
      navigators.clear();
      controlPositioners.length = 0;
    },
  };
}
