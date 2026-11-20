import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";

import { extractEditableEntities } from "../app/lib/html-content-editor/extract-editable-entities.ts";
import {
  applyPreviewTypographyText,
  createPreviewTypography,
  isPreviewTypographySkippedTag,
  installPreviewTypography,
} from "../app/lib/html-content-editor/preview-typography.ts";
import { buildPreviewSource } from "../app/lib/html-content-editor/preview-source.ts";

test("faithful typography installation is a no-op unless explicitly enabled", () => {
  const controller = installPreviewTypography({});
  const node = { nodeValue: "В лесу и на берегу" };
  controller.applyTextNode(node);
  controller.cleanup();
  assert.equal(node.nodeValue, "В лесу и на берегу");
});

test("preview typography joins Russian short words with the following word", () => {
  assert.equal(applyPreviewTypographyText("В лесу"), "В\u00a0лесу");
  assert.equal(applyPreviewTypographyText("Дом на берегу"), "Дом на\u00a0берегу");
  assert.equal(
    applyPreviewTypographyText("Природные виды и тишина"),
    "Природные виды и\u00a0тишина",
  );
  assert.equal(
    applyPreviewTypographyText("Отдых для всей семьи"),
    "Отдых для\u00a0всей семьи",
  );
  assert.equal(applyPreviewTypographyText("SPA и массаж"), "SPA и\u00a0массаж");
});

test("preview typography is case-insensitive and preserves the exact whitespace rule", () => {
  assert.equal(applyPreviewTypographyText("И снова"), "И\u00a0снова");
  assert.equal(applyPreviewTypographyText("Так же красиво"), "Так\u00a0же\u00a0красиво");
  assert.equal(applyPreviewTypographyText("К дому и на берег"), "К\u00a0дому и\u00a0на\u00a0берег");
  assert.equal(applyPreviewTypographyText("В   лесу"), "В\u00a0лесу");
  assert.equal(applyPreviewTypographyText("Дом\nна берегу"), "Дом\nна\u00a0берегу");
});

test("preview typography is idempotent", () => {
  const previewValue = applyPreviewTypographyText("В лесу и на берегу");

  assert.equal(applyPreviewTypographyText(previewValue), previewValue);
});

test("preview typography keeps excluded source contexts untouched", () => {
  for (const tagName of [
    "script", "style", "noscript", "textarea", "option", "select",
    "input", "button", "code", "pre",
  ]) {
    assert.equal(isPreviewTypographySkippedTag(tagName), true, tagName);
  }

  assert.equal(isPreviewTypographySkippedTag("div"), false);
});

test("preview typography does not mutate source or preview source construction", () => {
  const source = "<h1>Природные виды и тишина</h1>";
  const previewOnlyValue = applyPreviewTypographyText("Природные виды и тишина");
  const preview = buildPreviewSource(source, extractEditableEntities(source));

  assert.equal(previewOnlyValue, "Природные виды и\u00a0тишина");
  assert.equal(source, "<h1>Природные виды и тишина</h1>");
  assert.ok(preview.source.includes("Природные виды и тишина"));
  assert.ok(!preview.source.includes("и\u00a0тишина"));
});

test("leaves trailing whitespace, URLs, numbers and existing nonbreaking spaces intact", () => {
  const unchanged = "В \nСсылка на https://example.test/на?q=и цифры 123\u00a0456";
  assert.equal(applyPreviewTypographyText(unchanged), unchanged);
  assert.equal(applyPreviewTypographyText("К слову"), "К\u00a0слову");
  assert.equal(applyPreviewTypographyText("В  \nлесу"), "В  \nлесу");
});

function previewDocument() {
  const string = (data) => ({ nodeType: 3, data, get nodeValue() { return this.data; } });
  let callback;
  let disconnected = false;
  const document = {
    defaultView: { getComputedStyle: node => ({ display: node.display, whiteSpace: node.whiteSpace }) },
    createTreeWalker(root) {
      const walk = node => node.nodeType === 3 ? [node] : node.children.flatMap(walk);
      const nodes = walk(root);
      return { nextNode: () => nodes.shift() ?? null };
    },
  };
  function element(tagName, ...children) {
    const attributes = new Map();
    return {
      nodeType: 1, tagName, ownerDocument: document, attributes,
      getAttribute: name => attributes.get(name) ?? null,
      hasAttribute: name => attributes.has(name),
      get firstChild() { return this.children[0]; },
      children,
      append(child) {
        if (this.children.length) this.children.at(-1).nextSibling = child;
        child.parentElement = this;
        this.children.push(child);
      },
      contains(target) {
        return this === target || this.children.some(child => child === target || child.contains?.(target));
      },
    };
  }
  const connect = parent => {
    if (parent.nodeType !== 1) return;
    parent.children.forEach((child, index) => {
      child.parentElement = parent;
      child.nextSibling = parent.children[index + 1] ?? null;
      connect(child);
    });
  };
  const first = string("В ");
  const second = string("и");
  const separateSpace = string(" ");
  const regular = string("Пока пусто");
  const skipped = string("В лесу");
  const editable = string("На природе");
  const section = element("P", regular);
  const edit = element("DIV", element("SPAN", editable));
  edit.attributes.set("contenteditable", "plaintext-only");
  document.body = element("BODY", element("P", first, element("EM", string("лесу"))),
    element("P", element("SPAN", second), separateSpace, element("STRONG", string("дождь"))),
    element("PRE", element("SPAN", skipped)), edit, section);
  connect(document.body);
  const context = vm.createContext({
    document, queueMicrotask,
    MutationObserver: class {
      constructor(handler) { callback = handler; }
      observe() {}
      disconnect() { disconnected = true; callback = undefined; }
    },
  });
  const controller = vm.runInContext("(" + createPreviewTypography.toString() +
    ")().installPreviewTypography(document, {enabled: true})", context);
  return {
    controller, first, second, separateSpace, regular, skipped, editable, section, element, string,
    notify(...mutations) { callback?.(mutations); },
    isDisconnected: () => disconnected,
  };
}

test("serializable Preview typography joins inline boundaries and observes in-place and added text", async () => {
  const frame = previewDocument();
  assert.equal(frame.first.data, "В\u00a0");
  assert.equal(frame.second.data, "и");
  assert.equal(frame.separateSpace.data, "\u00a0");
  assert.equal(frame.skipped.data, "В лесу");
  assert.equal(frame.editable.data, "На природе");

  frame.regular.data = "Дом с камином";
  const added = frame.string("И снова");
  frame.section.append(added);
  frame.notify({ type: "childList", target: frame.section }, { type: "characterData", target: frame.regular });
  await Promise.resolve();
  assert.equal(frame.regular.data, "Дом с\u00a0камином");
  assert.equal(added.data, "И\u00a0снова");
  frame.regular.data = "На берегу";
  frame.notify({ type: "characterData", target: frame.regular });
  frame.controller.cleanup();
  await Promise.resolve();
  assert.equal(frame.regular.data, "На берегу");
  assert.equal(frame.isDisconnected(), true);

  const replacement = previewDocument();
  assert.equal(replacement.first.data, "В\u00a0");
  replacement.controller.cleanup();
});
