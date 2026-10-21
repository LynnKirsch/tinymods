import type { AccordionGroup, AccordionItem } from "./accordion-groups";

export type PreviewAccordionNavigationController = {
  openForEntity: (entityId: string) => void;
  cleanup: () => void;
};

type Owner = { model: AccordionItem; item: HTMLElement; trigger: HTMLButtonElement; answer: HTMLElement };

function ownerForItem(
  document: Document,
  model: AccordionItem,
  path: AccordionGroup["path"],
  previewMarkers: Record<string, string>,
): Owner | null {
  if (path === "structural") {
    const questionId = model.questionEntityIds.map(id => previewMarkers[id]).find(Boolean);
    const answerId = model.answerEntityIds.map(id => previewMarkers[id]).find(Boolean);
    if (!questionId || !answerId) return null;
    const question = document.querySelector<HTMLElement>(`[data-tinymods-preview-ids~="${questionId}"]`);
    const answerContent = document.querySelector<HTMLElement>(`[data-tinymods-preview-ids~="${answerId}"]`);
    const trigger = question?.closest<HTMLButtonElement>("button[aria-expanded]");
    const item = trigger?.parentElement;
    const answer = trigger?.nextElementSibling;
    if (!item || !trigger || !answer || answer.nodeType !== 1 ||
      !answerContent || !answer.contains(answerContent) || item.children.length !== 2 ||
      item.children[0] !== trigger || item.children[1] !== answer) return null;
    return { model, item, trigger, answer: answer as HTMLElement };
  }
  if (!model.answerId) return null;
  const answer = document.getElementById(model.answerId);
  if (!answer || [...document.querySelectorAll("[id]")].filter(element => element.id === model.answerId).length !== 1) return null;
  const triggers = [...document.querySelectorAll<HTMLButtonElement>("button[aria-expanded][aria-controls]")]
    .filter(button => button.getAttribute("aria-controls") === model.answerId);
  if (triggers.length !== 1) return null;
  const trigger = triggers[0];
  let item = trigger.parentElement;
  while (item && !item.contains(answer)) item = item.parentElement;
  if (!item || item === document.body || item === document.documentElement) return null;
  return { model, item, trigger, answer };
}

function openClass(owners: Owner[], window: Window, path: AccordionGroup["path"]) {
  const initiallyOpen = owners.filter(owner => owner.model.initiallyOpen);
  if (initiallyOpen.length !== 1) return null;
  const owner = initiallyOpen[0];
  const otherClasses = new Set(owners.filter(candidate => candidate !== owner).flatMap(candidate => [...candidate.item.classList]));
  const candidates = [...owner.item.classList].filter(name => !otherClasses.has(name));
  const initialStyle = owner.answer.getAttribute("style");
  owner.answer.style.setProperty("transition", "none", "important");
  try {
    for (const name of candidates) {
      const open = window.getComputedStyle(owner.answer);
      const before = [open.gridTemplateRows, open.opacity, open.visibility, open.display, open.maxHeight];
      const openHeight = owner.answer.getBoundingClientRect().height;
      owner.item.classList.remove(name);
      const closed = window.getComputedStyle(owner.answer);
      const after = [closed.gridTemplateRows, closed.opacity, closed.visibility, closed.display, closed.maxHeight];
      const closedHeight = owner.answer.getBoundingClientRect().height;
      owner.item.classList.add(name);
      owner.answer.getBoundingClientRect();
      if (path === "explicit" && before.some((value, index) => value !== after[index])) return name;
      if (!before.some((value, index) => value !== after[index]) || openHeight <= 0 || closedHeight > 0) continue;
      const peer = owners.find(candidate => candidate !== owner && candidate.trigger.getAttribute("aria-expanded") === "false");
      if (!peer) continue;
      const peerStyle = peer.answer.getAttribute("style");
      peer.answer.style.setProperty("transition", "none", "important");
      peer.item.classList.add(name);
      const transferred = peer.answer.getBoundingClientRect().height > 0;
      peer.item.classList.remove(name);
      peer.answer.getBoundingClientRect();
      if (peerStyle === null) peer.answer.removeAttribute("style");
      else peer.answer.setAttribute("style", peerStyle);
      if (transferred) return name;
    }
    return null;
  } finally {
    if (initialStyle === null) owner.answer.removeAttribute("style");
    else owner.answer.setAttribute("style", initialStyle);
  }
}

export function installPreviewAccordionNavigation(
  document: Document,
  groups: AccordionGroup[],
  previewMarkers: Record<string, string> = {},
): PreviewAccordionNavigationController {
  const window = document.defaultView;
  if (!window) return { openForEntity() {}, cleanup() {} };
  const disposers: Array<() => void> = [];
  const byEntity = new Map<string, () => void>();
  let disposed = false;

  for (const group of groups) {
    const owners = group.items.map(item => ownerForItem(document, item, group.path, previewMarkers));
    if (owners.some(owner => !owner)) continue;
    const items = owners as Owner[];
    if (new Set(items.map(owner => owner.item)).size !== items.length) continue;
    if (group.path === "structural" && (
      items.filter(owner => owner.trigger.getAttribute("aria-expanded") === "true").length !== 1 ||
      items.some(owner => (owner.answer.getBoundingClientRect().height > 0) !==
        (owner.trigger.getAttribute("aria-expanded") === "true"))
    )) continue;
    const token = openClass(items, window, group.path);
    const snapshots = items.map(owner => ({
      className: owner.item.getAttribute("class"),
      expanded: owner.trigger.getAttribute("aria-expanded"),
      style: owner.answer.getAttribute("style"),
    }));

    function setOpen(nextIndex: number | null) {
      if (disposed) return;
      items.forEach((owner, index) => {
        const active = index === nextIndex;
        if (token) owner.item.classList.toggle(token, active);
        owner.trigger.setAttribute("aria-expanded", String(active));
        owner.answer.style.setProperty("transition", "none", "important");
        if (!token && !active) {
          owner.answer.style.setProperty("grid-template-rows", "0fr", "important");
          owner.answer.style.setProperty("max-height", "0px", "important");
          owner.answer.style.setProperty("overflow", "hidden", "important");
        } else if (active && (!token || owner.answer.getBoundingClientRect().height <= 0)) {
          // A confirmed answer may need its final layout even when source JS did more than class transfer.
          owner.answer.style.setProperty("display", "grid", "important");
          owner.answer.style.setProperty("grid-template-rows", "1fr", "important");
          owner.answer.style.setProperty("opacity", "1", "important");
          owner.answer.style.setProperty("visibility", "visible", "important");
          owner.answer.style.setProperty("max-height", "none", "important");
          owner.answer.style.setProperty("height", "auto", "important");
        } else if (!active) {
          const original = snapshots[index].style;
          if (original === null) owner.answer.removeAttribute("style");
          else owner.answer.setAttribute("style", original);
        }
      });
    }

    items.forEach((owner, index) => {
      const onClick = () => setOpen(owner.trigger.getAttribute("aria-expanded") === "true" ? null : index);
      owner.trigger.addEventListener("click", onClick);
      disposers.push(() => owner.trigger.removeEventListener("click", onClick));
      for (const id of [...owner.model.questionEntityIds, ...owner.model.answerEntityIds]) {
        byEntity.set(id, () => {
          if (owner.trigger.getAttribute("aria-expanded") !== "true") setOpen(index);
        });
      }
    });
    disposers.push(() => items.forEach((owner, index) => {
      const snapshot = snapshots[index];
      for (const [element, name, value] of [
        [owner.item, "class", snapshot.className],
        [owner.trigger, "aria-expanded", snapshot.expanded],
        [owner.answer, "style", snapshot.style],
      ] as const) {
        if (value === null) element.removeAttribute(name);
        else element.setAttribute(name, value);
      }
    }));
  }

  return {
    openForEntity(entityId) { if (!disposed) byEntity.get(entityId)?.(); },
    cleanup() {
      if (disposed) return;
      disposed = true;
      for (const dispose of disposers) dispose();
      byEntity.clear();
    },
  };
}
