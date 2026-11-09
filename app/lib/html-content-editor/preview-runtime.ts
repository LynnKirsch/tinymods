import type { BlockSource, SiteContext } from "./block-source";
import { editorEntityKey } from "./block-source";
import { assembleBlock, editedBlockAnalysis, fragmentExecutableSource } from "./block-assembly";
import { extractEditableEntities } from "./extract-editable-entities";
import { detectSliderGroups, type SliderGroup } from "./slider-groups";
import { buildPreviewSource } from "./preview-source";
import { createLiveSliderNavigation } from "./preview-slider-navigation";
import { detectAccordionGroups, type AccordionGroup } from "./accordion-groups";
import type { PreviewRegistry } from "./preview-bridge";

type RuntimeBlock = {
  blockId: string;
  markers: Array<{ entityId: string; previewId: string }>;
  sliders: SliderGroup[];
  accordions: AccordionGroup[];
};

// Install immediately, before any user script can register its drag listeners.
// No click interception or pointerdown preventDefault: selection/focus survives.
export function installPreviewMouseDragGuard() {
  const viewport = (event: Event) => event.target instanceof Element && event.target.closest("[data-tinymods-slider-viewport]");
  let mousePointer: number | null = null;
  let mouseDown = false;
  function guard(event: Event) {
    const pointer = event as PointerEvent;
    if (event.type.startsWith("pointer") && pointer.pointerType !== "mouse") return;
    if (event.type === "pointerdown" || event.type === "mousedown") {
      if ((event as MouseEvent).button !== 0 || !viewport(event)) return;
      if (event.type === "pointerdown") mousePointer = pointer.pointerId;
      mouseDown = true;
    } else if (event.type === "dragstart") {
      if (!viewport(event)) return;
      event.preventDefault();
    } else if (!mouseDown || (event.type.startsWith("pointer") && pointer.pointerId !== mousePointer)) return;
    event.stopImmediatePropagation();
    if (event.type === "pointerup" || event.type === "pointercancel" || event.type === "mouseup") {
      mousePointer = null;
      mouseDown = false;
    }
  }
  const types = ["pointerdown", "pointermove", "pointerup", "pointercancel", "mousedown", "mousemove", "mouseup", "dragstart"];
  const reset = () => { mouseDown = false; mousePointer = null; };
  for (const type of types) window.addEventListener(type, guard, true);
  window.addEventListener("blur", reset);
  window.addEventListener("pagehide", () => {
    for (const type of types) window.removeEventListener(type, guard, true);
    window.removeEventListener("blur", reset);
  }, { once: true });
}

// Everything this function references is passed explicitly or belongs to the iframe.
// Keep it self-contained: the existing app bundler removes TypeScript before serialization.
export function installPreviewRuntime(
  instanceId: string,
  blocks: RuntimeBlock[],
  sliderFactory: typeof createLiveSliderNavigation,
) {
  const document = window.document;
  const controllers = blocks.map(block => ({ block, controller: sliderFactory(document, block.sliders) }));
  const owners = new Map<string, { blockId: string; entityId: string; element: Element }>();
  function refreshOwners() {
  owners.clear();
  const textOwners = new Map<string, Element>();
  const walker = document.createTreeWalker(document, NodeFilter.SHOW_COMMENT);
  let comment = walker.nextNode();
  while (comment) {
    const value = comment.nodeValue ?? "";
    if (value.startsWith("tinymods-preview-start:") && comment.parentElement) textOwners.set(value.slice(23), comment.parentElement);
    comment = walker.nextNode();
  }
  for (const block of blocks) for (const marker of block.markers) {
    const element = document.querySelector(`[data-tinymods-preview-ids~="${marker.previewId}"]`) ?? textOwners.get(marker.previewId);
    if (element) owners.set(marker.previewId, { blockId: block.blockId, entityId: marker.entityId, element });
  }
  }
  refreshOwners();
  const send = (payload: unknown) => window.parent.postMessage({ channel: "tinymods-preview", instanceId, payload }, "*");
  function report() {
    send({ type: "sliders", sliders: controllers.flatMap(({ block, controller }) => controller.positions().map(position => ({ ...position, blockId: block.blockId }))) });
  }
  function select(event: MouseEvent) {
    if (!(event.target instanceof Element)) return;
    const candidates = [...owners.values()].filter(owner => owner.element.contains(event.target as Node));
    const owner = candidates.find(candidate => !candidates.some(other => other !== candidate && candidate.element !== other.element && candidate.element.contains(other.element))) ?? candidates[0];
    if (owner) send({ type: "select", blockId: owner.blockId, entityId: owner.entityId });
    // Native widget clicks must reach the user's handlers. Only outgoing navigation is blocked.
    if (event.target.closest("a[href]")) event.preventDefault();
  }
  function command(event: MessageEvent) {
    if (event.source !== window.parent || !event.data || event.data.channel !== "tinymods-preview-command" || event.data.instanceId !== instanceId) return;
    const payload = event.data.payload;
    if (!payload || typeof payload !== "object") return;
    if (payload.type === "scroll-top") window.scrollTo(0, 0);
    if (payload.type === "reveal" && typeof payload.blockId === "string" && typeof payload.entityId === "string") {
      const owner = [...owners.values()].find(item => item.blockId === payload.blockId && item.entityId === payload.entityId);
      const details = owner?.element.closest("details");
      if (details) details.open = true;
      const block = blocks.find(item => item.blockId === payload.blockId);
      const item = block?.accordions.flatMap(group => group.items).find(item => item.answerEntityIds.includes(payload.entityId));
      if (item) {
        const question = [...owners.values()].find(owner => owner.blockId === block?.blockId && item.questionEntityIds.includes(owner.entityId));
        const trigger = question?.element.closest<HTMLElement>("button, [role=button]");
        if (trigger && trigger.getAttribute("aria-expanded") !== "true" && owner && !owner.element.getClientRects().length) trigger.click();
      }
    }
    if (payload.type === "slide" && typeof payload.blockId === "string" && typeof payload.widgetGroupId === "string" && Number.isInteger(payload.index)) {
      controllers.find(item => item.block.blockId === payload.blockId)?.controller.goToSlide(payload.widgetGroupId, payload.index);
      report();
    }
    if (payload.type === "highlight" && Array.isArray(payload.markerIds) && payload.markerIds.length <= 1000 && payload.markerIds.every((id: unknown) => typeof id === "string" && owners.has(id))) {
      document.querySelectorAll(".tinymods-preview-active").forEach(element => element.classList.remove("tinymods-preview-active"));
      for (const id of payload.markerIds) owners.get(id)?.element.classList.add("tinymods-preview-active");
    }
  }
  document.addEventListener("click", select);
  window.addEventListener("message", command);
  window.addEventListener("scroll", report, true);
  window.addEventListener("resize", report);
  const observer = new ResizeObserver(report);
  if (document.body) observer.observe(document.body);
  const mutations = new MutationObserver(() => { refreshOwners(); report(); });
  if (document.body) mutations.observe(document.body, { subtree: true, childList: true });
  // A short polling interval also observes script-driven slide changes with unchanged bounds.
  const interval = window.setInterval(report, 500);
  window.addEventListener("pagehide", () => {
    document.removeEventListener("click", select);
    window.removeEventListener("message", command);
    window.removeEventListener("scroll", report, true);
    window.removeEventListener("resize", report);
    observer.disconnect();
    mutations.disconnect();
    window.clearInterval(interval);
  }, { once: true });
  send({ type: "ready" });
  report();
}

export function buildLivePreview(blocks: BlockSource[], context: SiteContext, instanceId: string) {
  const registry: PreviewRegistry = new Map();
  const runtimeBlocks: RuntimeBlock[] = [];
  const html = blocks.map((block, index) => {
    const originalEntities = extractEditableEntities(assembleBlock(block).source);
    const originalGroups = detectSliderGroups(assembleBlock(block).source, originalEntities);
    const assembly = editedBlockAnalysis(block);
    const entities = assembly.entities;
    const localGroups = detectSliderGroups(assembly.source, entities);
    registry.set(block.id, { entityIds: new Set(originalEntities.map(entity => entity.id)), widgets: new Map() });
    const stableGroupId = (id: string) => originalGroups[localGroups.findIndex(group => group.id === id)]?.id ?? id;
    const groups = localGroups.map((group, groupIndex) => ({ ...group, id: editorEntityKey(block.id, originalGroups[groupIndex]?.id ?? group.id),
      parentSliderId: group.parentSliderId ? editorEntityKey(block.id, stableGroupId(group.parentSliderId)) : undefined,
      parentSlideId: group.parentSlideId ? editorEntityKey(block.id, group.parentSlideId) : undefined,
      slides: group.slides.map(slide => ({ ...slide, id: editorEntityKey(block.id, slide.id) })),
    }));
    const preview = buildPreviewSource(assembly.source, entities, { live: true, namespace: `block-${index + 1}`, sliderGroups: groups });
    runtimeBlocks.push({ blockId: block.id, markers: preview.markers, sliders: groups, accordions: detectAccordionGroups(assembleBlock(block).source, originalEntities) });
    // Bridge widget IDs are namespaced; registry checks the same IDs.
    registry.get(block.id)!.widgets = new Map(groups.map(group => [group.id, group.slides.length]));
    return preview.source;
  });
  const json = JSON.stringify({ instanceId, blocks: runtimeBlocks }).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
  const runtime = `<script data-tinymods-runtime>(${installPreviewMouseDragGuard.toString()})();document.addEventListener("DOMContentLoaded",()=>{const config=${json};(${installPreviewRuntime.toString()})(config.instanceId,config.blocks,${createLiveSliderNavigation.toString()});},{once:true});</script>`;
  const css = context.css ? fragmentExecutableSource(context.css, "css") : "";
  const js = context.js ? fragmentExecutableSource(context.js, "js") : "";
  // Bootstrap registration precedes user scripts; installation waits for the complete document.
  const style = '<style data-tinymods-runtime-style>.tinymods-preview-active{outline:2px solid #238fbc!important;outline-offset:3px!important}[data-tinymods-slider-viewport],[data-tinymods-slider-viewport] *{cursor:default!important}[data-tinymods-slider-viewport] [data-tinymods-preview-ids]{cursor:pointer!important}</style>';
  return { source: [runtime, style, css, ...html, js].filter(Boolean).join("\n"), registry, runtimeBlocks };
}
