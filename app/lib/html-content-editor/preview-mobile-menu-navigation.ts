const OPEN_ATTRIBUTE = "data-tinymods-preview-menu-open";
const STYLE_ATTRIBUTE = "data-tinymods-preview-mobile-menu-style";
const CLEANUP_PROPERTY = "__tinymodsPreviewMobileMenuCleanup";
const CLOSE_LABEL = /\b(close|dismiss|cancel|закрыть|отмена)\b/i;

const PREVIEW_MENU_STYLE = `
dialog[${OPEN_ATTRIBUTE}] {
  top: var(--tinymods-preview-menu-top) !important;
  bottom: 0 !important;
  height: auto !important;
  max-height: none !important;
  opacity: 1 !important;
  transform: none !important;
  visibility: visible !important;
}
`;

export type PreviewMobileMenuNavigationController = {
  cleanup: () => void;
};

type ManagedDocument = Document & {
  [CLEANUP_PROPERTY]?: () => void;
};

type MenuOwner = {
  controller: HTMLButtonElement;
  dialog: HTMLDialogElement;
  header: HTMLElement;
  closeButton: HTMLButtonElement | null;
  initialExpanded: string | null;
  initialStyle: string | null;
  openedByRuntime: boolean;
};

function uniqueTarget(document: Document, id: string) {
  const targets = [...document.querySelectorAll("[id]")].filter(element => element.id === id);
  return targets.length === 1 ? targets[0] : null;
}

function isDialog(target: Element | null): target is HTMLDialogElement {
  return target?.tagName === "DIALOG" &&
    typeof (target as HTMLDialogElement).show === "function" &&
    typeof (target as HTMLDialogElement).close === "function";
}

function closeButtonFor(dialog: HTMLDialogElement) {
  const buttons = [...dialog.querySelectorAll<HTMLButtonElement>("button")];
  const labelled = buttons.filter(button => CLOSE_LABEL.test(
    `${button.getAttribute("aria-label") ?? ""} ${button.getAttribute("title") ?? ""}`,
  ));
  if (labelled.length === 1) return labelled[0];

  const technical = buttons.filter(button =>
    !button.hasAttribute("data-tinymods-preview-ids") &&
    !button.textContent?.trim() &&
    Boolean(button.querySelector("svg, [aria-hidden='true']")),
  );
  return technical.length === 1 ? technical[0] : null;
}

function menuOwners(document: Document): MenuOwner[] {
  return [...document.querySelectorAll<HTMLButtonElement>("button[aria-expanded][aria-controls]")]
    .flatMap((controller) => {
      const expanded = controller.getAttribute("aria-expanded");
      const id = controller.getAttribute("aria-controls");
      if (!id || !/^(true|false)$/.test(expanded ?? "")) return [];
      const target = uniqueTarget(document, id);
      if (!isDialog(target) || target.open || target.contains(controller)) return [];
      const header = controller.closest<HTMLElement>("header");
      if (!header || !header.contains(target)) return [];
      return [{
        controller,
        dialog: target,
        header,
        closeButton: closeButtonFor(target),
        initialExpanded: expanded,
        initialStyle: target.getAttribute("style"),
        openedByRuntime: false,
      }];
    });
}

function installStyle(document: Document) {
  const style = document.createElement("style");
  style.setAttribute(STYLE_ATTRIBUTE, "");
  style.textContent = PREVIEW_MENU_STYLE;
  (document.body ?? document.head).append(style);
  return () => style.remove();
}

export function installPreviewMobileMenuNavigation(document: Document): PreviewMobileMenuNavigationController {
  const managedDocument = document as ManagedDocument;
  managedDocument[CLEANUP_PROPERTY]?.();
  const owners = menuOwners(document);
  if (!owners.length) return { cleanup() {} };

  const removeStyle = installStyle(document);
  const window = document.defaultView;
  let disposed = false;

  function applyGeometry(owner: MenuOwner) {
    if (!owner.dialog.open) return;
    const top = Math.max(0, owner.header.getBoundingClientRect().bottom);
    owner.dialog.style.setProperty("--tinymods-preview-menu-top", `${top}px`);
  }

  function restoreDialogStyle(owner: MenuOwner) {
    if (owner.initialStyle === null) owner.dialog.removeAttribute("style");
    else owner.dialog.setAttribute("style", owner.initialStyle);
  }

  function syncClosed(owner: MenuOwner) {
    owner.dialog.removeAttribute(OPEN_ATTRIBUTE);
    restoreDialogStyle(owner);
    owner.controller.setAttribute("aria-expanded", "false");
    owner.openedByRuntime = false;
  }

  function open(owner: MenuOwner) {
    if (disposed || owner.dialog.open) return;
    owner.dialog.show();
    owner.dialog.setAttribute(OPEN_ATTRIBUTE, "");
    applyGeometry(owner);
    owner.controller.setAttribute("aria-expanded", "true");
    owner.openedByRuntime = true;
  }

  function close(owner: MenuOwner) {
    if (disposed) return;
    if (owner.dialog.open) owner.dialog.close();
    syncClosed(owner);
  }

  function ownerForElement(element: Element | null) {
    if (!element) return null;
    const button = element.closest<HTMLButtonElement>("button");
    return owners.find(owner => owner.controller === button) ?? null;
  }

  function onClick(event: MouseEvent) {
    const target = event.target && typeof (event.target as Element).closest === "function"
      ? event.target as Element
      : null;
    const controllerOwner = ownerForElement(target);
    if (controllerOwner) {
      event.preventDefault();
      if (controllerOwner.dialog.open) close(controllerOwner);
      else open(controllerOwner);
      return;
    }

    const closeOwner = owners.find(owner => owner.closeButton === target?.closest("button"));
    if (closeOwner) {
      event.preventDefault();
      close(closeOwner);
      return;
    }

    const link = target?.closest("a[href]");
    if (link && owners.some(owner => owner.dialog.open && owner.dialog.contains(link))) {
      event.preventDefault();
    }
  }

  const closeListeners = owners.map((owner) => {
    const onNativeClose = () => {
      if (!disposed) syncClosed(owner);
    };
    owner.dialog.addEventListener("close", onNativeClose);
    return () => owner.dialog.removeEventListener("close", onNativeClose);
  });
  const onResize = () => owners.forEach(applyGeometry);
  window?.addEventListener("resize", onResize);
  const ResizeObserverConstructor = window?.ResizeObserver;
  const resizeObserver = ResizeObserverConstructor ? new ResizeObserverConstructor(onResize) : null;
  for (const owner of owners) resizeObserver?.observe(owner.header);
  document.addEventListener("click", onClick);

  function cleanup() {
    if (disposed) return;
    disposed = true;
    document.removeEventListener("click", onClick);
    window?.removeEventListener("resize", onResize);
    resizeObserver?.disconnect();
    for (const removeListener of closeListeners) removeListener();
    for (const owner of owners) {
      if (owner.dialog.open && owner.openedByRuntime) owner.dialog.close();
      owner.dialog.removeAttribute(OPEN_ATTRIBUTE);
      restoreDialogStyle(owner);
      if (owner.initialExpanded === null) owner.controller.removeAttribute("aria-expanded");
      else owner.controller.setAttribute("aria-expanded", owner.initialExpanded);
    }
    if (managedDocument[CLEANUP_PROPERTY] === cleanup) delete managedDocument[CLEANUP_PROPERTY];
    removeStyle();
  }

  managedDocument[CLEANUP_PROPERTY] = cleanup;
  return { cleanup };
}
