import assert from "node:assert/strict";
import test from "node:test";

import { extractEditableEntities } from "../app/lib/html-content-editor/extract-editable-entities.ts";
import { installPreviewMobileMenuNavigation } from "../app/lib/html-content-editor/preview-mobile-menu-navigation.ts";

class ElementLike {
  constructor(tagName, attributes = {}, textContent = "") {
    this.tagName = tagName.toUpperCase();
    this.attributes = new Map(Object.entries(attributes));
    this.children = [];
    this.parentElement = null;
    this.textContent = textContent;
    this.listeners = new Map();
    this.hasGraphic = false;
    this.display = "grid";
    this.style = {
      values: new Map(),
      setProperty: (name, value) => this.style.values.set(name, value),
      getPropertyValue: (name) => this.style.values.get(name) ?? "",
    };
    this.bottom = 80;
  }

  get id() { return this.getAttribute("id") ?? ""; }
  append(...children) {
    for (const child of children) {
      child.parentElement = this;
      this.children.push(child);
    }
  }
  remove() {
    if (!this.parentElement) return;
    const index = this.parentElement.children.indexOf(this);
    if (index >= 0) this.parentElement.children.splice(index, 1);
    this.parentElement = null;
  }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  removeAttribute(name) { this.attributes.delete(name); }
  hasAttribute(name) { return this.attributes.has(name); }
  getBoundingClientRect() { return { bottom: this.bottom }; }
  contains(node) {
    return node === this || this.children.some(child => child.contains(node));
  }
  closest(selector) {
    if (selector === "button" && this.tagName === "BUTTON") return this;
    if (selector === "a[href]" && this.tagName === "A" && this.hasAttribute("href")) return this;
    if (selector === "header" && this.tagName === "HEADER") return this;
    return this.parentElement?.closest(selector) ?? null;
  }
  querySelectorAll(selector) {
    const result = [];
    const visit = (node) => {
      for (const child of node.children) {
        if (selector === "button" && child.tagName === "BUTTON") result.push(child);
        visit(child);
      }
    };
    visit(this);
    return result;
  }
  querySelector(selector) {
    if (selector === "svg, [aria-hidden='true']" && this.hasGraphic) return this.children[0] ?? this;
    return null;
  }
  addEventListener(type, listener) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  removeEventListener(type, listener) {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter(candidate => candidate !== listener));
  }
  emit(type) {
    for (const listener of this.listeners.get(type) ?? []) listener({ target: this });
  }
}

class DialogLike extends ElementLike {
  constructor(attributes = {}) {
    super("dialog", attributes);
    this.open = false;
    this.showCalls = 0;
    this.showModalCalls = 0;
  }

  showModal() {
    this.open = true;
    this.showModalCalls += 1;
  }
  show() {
    this.open = true;
    this.showCalls += 1;
  }
  close() {
    if (!this.open) return;
    this.open = false;
    this.emit("close");
  }
}

class DocumentLike {
  constructor(roots) {
    this.body = new ElementLike("body");
    this.head = new ElementLike("head");
    this.body.append(...roots);
    this.listeners = new Map();
    this.mappingCalls = 0;
    this.defaultView = {
      listeners: new Map(),
      addEventListener: (type, listener) => {
        this.defaultView.listeners.set(type, [...(this.defaultView.listeners.get(type) ?? []), listener]);
      },
      removeEventListener: (type, listener) => {
        this.defaultView.listeners.set(type, (this.defaultView.listeners.get(type) ?? []).filter(candidate => candidate !== listener));
      },
      emit: (type) => {
        for (const listener of this.defaultView.listeners.get(type) ?? []) listener();
      },
    };
  }

  all() {
    const result = [];
    const visit = (node) => {
      result.push(node);
      for (const child of node.children) visit(child);
    };
    visit(this.body);
    return result;
  }
  getElementById(id) { return this.all().find(node => node.id === id) ?? null; }
  querySelectorAll(selector) {
    if (selector === "[id]") return this.all().filter(node => node.id);
    if (selector === "button[aria-expanded][aria-controls]") {
      return this.all().filter(node => node.tagName === "BUTTON" &&
        node.hasAttribute("aria-expanded") && node.hasAttribute("aria-controls"));
    }
    return [];
  }
  createElement(tagName) { return new ElementLike(tagName); }
  addEventListener(type, listener) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  removeEventListener(type, listener) {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter(candidate => candidate !== listener));
  }
  click(target) {
    const event = {
      target,
      defaultPrevented: false,
      cancelBubble: false,
      preventDefault() { this.defaultPrevented = true; },
    };
    if (target.closest("a[href]")) this.mappingCalls += 1;
    for (const listener of this.listeners.get("click") ?? []) listener(event);
    return event;
  }
}

function menuDocument({ desktop = false } = {}) {
  const header = new ElementLike("header");
  const burger = new ElementLike("button", {
    "aria-expanded": "false",
    "aria-controls": "mobile-menu",
    "aria-label": "Open menu",
  });
  burger.display = desktop ? "none" : "grid";
  const span = new ElementLike("span");
  burger.append(span);

  const dialog = new DialogLike({ id: "mobile-menu" });
  const close = new ElementLike("button", { "aria-label": "Закрыть меню" });
  const closeIcon = new ElementLike("svg");
  close.hasGraphic = true;
  close.append(closeIcon);
  const link = new ElementLike("a", { href: "#directions", "data-tinymods-preview-ids": "tm-1" }, "Направления");
  const phone = new ElementLike("a", { href: "tel:+74950000000", "data-tinymods-preview-ids": "tm-2" }, "+7 (495) 000 00 00");
  dialog.append(close, link, phone);
  header.append(burger, dialog);
  return { document: new DocumentLike([header]), header, burger, span, dialog, close, closeIcon, link, phone };
}

const originalElement = globalThis.Element;
const originalDialog = globalThis.HTMLDialogElement;
globalThis.Element = ElementLike;
globalThis.HTMLDialogElement = DialogLike;

test.after(() => {
  globalThis.Element = originalElement;
  globalThis.HTMLDialogElement = originalDialog;
});

test("nested burger span opens non-modal dialog below its source header", () => {
  const { document, header, burger, span, dialog } = menuDocument();
  const navigation = installPreviewMobileMenuNavigation(document);

  const click = document.click(span);
  assert.equal(click.defaultPrevented, true);
  assert.equal(click.cancelBubble, false);
  assert.equal(dialog.showCalls, 1);
  assert.equal(dialog.showModalCalls, 0);
  assert.equal(dialog.open, true);
  assert.equal(dialog.getAttribute("data-tinymods-preview-menu-open"), "");
  assert.equal(burger.getAttribute("aria-expanded"), "true");
  assert.equal(document.body.children.at(-1).tagName, "STYLE");
  assert.match(document.body.children.at(-1).textContent, /top: var\(--tinymods-preview-menu-top\)/);
  assert.equal(dialog.style.getPropertyValue("--tinymods-preview-menu-top"), `${header.bottom}px`);

  navigation.cleanup();
});

test("open menu geometry follows the current header bottom on viewport resize", () => {
  const { document, header, span, dialog } = menuDocument();
  const navigation = installPreviewMobileMenuNavigation(document);
  document.click(span);
  assert.equal(dialog.style.getPropertyValue("--tinymods-preview-menu-top"), "80px");

  header.bottom = 132;
  document.defaultView.emit("resize");
  assert.equal(dialog.style.getPropertyValue("--tinymods-preview-menu-top"), "132px");
  navigation.cleanup();
});

test("close button, second burger click and native close synchronize dialog state", () => {
  const { document, burger, span, dialog, closeIcon } = menuDocument();
  const navigation = installPreviewMobileMenuNavigation(document);

  document.click(span);
  document.click(closeIcon);
  assert.equal(dialog.open, false);
  assert.equal(dialog.hasAttribute("data-tinymods-preview-menu-open"), false);
  assert.equal(burger.getAttribute("aria-expanded"), "false");

  document.click(span);
  document.click(span);
  assert.equal(dialog.open, false);
  assert.equal(burger.getAttribute("aria-expanded"), "false");

  document.click(span);
  dialog.close();
  assert.equal(dialog.hasAttribute("data-tinymods-preview-menu-open"), false);
  assert.equal(burger.getAttribute("aria-expanded"), "false");

  navigation.cleanup();
});

test("reinstalling the runtime replaces earlier document listeners", () => {
  const { document, burger, span, dialog } = menuDocument();
  const first = installPreviewMobileMenuNavigation(document);
  const second = installPreviewMobileMenuNavigation(document);

  document.click(span);
  assert.equal(dialog.open, true);
  assert.equal(burger.getAttribute("aria-expanded"), "true");

  first.cleanup();
  assert.equal(dialog.open, true, "disposed prior controller cannot close the active menu");
  second.cleanup();
  assert.equal(dialog.open, false);
  assert.equal(burger.getAttribute("aria-expanded"), "false");
});

test("menu links preserve Content mapping, block navigation and keep dialog open", () => {
  const { document, span, dialog, link } = menuDocument();
  const navigation = installPreviewMobileMenuNavigation(document);
  document.click(span);

  const click = document.click(link);
  assert.equal(document.mappingCalls, 1);
  assert.equal(click.defaultPrevented, true);
  assert.equal(click.cancelBubble, false);
  assert.equal(dialog.open, true);

  navigation.cleanup();
});

test("ordinary aria-controls panel is not treated as a mobile menu and cleanup restores state", () => {
  const accordion = new ElementLike("button", { "aria-expanded": "false", "aria-controls": "panel" });
  const panel = new ElementLike("div", { id: "panel" });
  const document = new DocumentLike([accordion, panel]);
  const navigation = installPreviewMobileMenuNavigation(document);
  document.click(accordion);
  assert.equal(accordion.getAttribute("aria-expanded"), "false");
  assert.equal(document.body.children.some(child => child.tagName === "STYLE"), false);
  navigation.cleanup();

  const menu = menuDocument({ desktop: true });
  const controller = installPreviewMobileMenuNavigation(menu.document);
  menu.document.click(menu.span);
  controller.cleanup();
  assert.equal(menu.burger.display, "none", "runtime never changes CSS visibility");
  assert.equal(menu.dialog.open, false);
  assert.equal(menu.burger.getAttribute("aria-expanded"), "false");
  assert.equal(menu.dialog.hasAttribute("data-tinymods-preview-menu-open"), false);
});

test("mobile menu technical controls stay outside extracted source content", () => {
  const source = `<button type="button" aria-label="Открыть меню" aria-expanded="false" aria-controls="mobile-menu"><span></span><span></span></button>
  <dialog id="mobile-menu"><button aria-label="Закрыть меню"><svg><path d="M0 0"></path></svg></button><a href="#directions">Направления</a><a href="tel:+74950000000">+7 (495) 000 00 00</a><p>Пн–Вс: 10:00–21:00</p></dialog>`;
  const originalSource = source;
  const entities = extractEditableEntities(source);

  assert.ok(entities.some(entity => entity.displayValue === "Направления"));
  assert.ok(entities.some(entity => entity.displayValue === "#directions"));
  assert.ok(entities.some(entity => entity.displayValue === "+7 (495) 000 00 00"));
  assert.ok(entities.some(entity => entity.displayValue === "tel:+74950000000"));
  assert.ok(entities.some(entity => entity.displayValue === "Пн–Вс: 10:00–21:00"));
  assert.ok(!entities.some(entity => /Открыть меню|Закрыть меню/.test(entity.displayValue)));
  assert.equal(source.includes("aria-controls=\"mobile-menu\""), true);
  assert.equal(source, originalSource, "Preview runtime has no source mutation path");
});
