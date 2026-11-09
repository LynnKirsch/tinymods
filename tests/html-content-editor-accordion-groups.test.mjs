import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { detectAccordionGroups } from "../app/lib/html-content-editor/accordion-groups.ts";
import { extractEditableEntities } from "../app/lib/html-content-editor/extract-editable-entities.ts";
import { installPreviewAccordionNavigation } from "../app/lib/html-content-editor/preview-accordion-navigation.ts";

const component = readFileSync(new URL("../app/components/html-content-editor/HtmlContentEditor.tsx", import.meta.url), "utf8");

function source(count = 7) {
  return `<section class="questions"><div class="entries">${Array.from({ length: count }, (_, index) => `
    <article class="entry${index === 0 ? " expanded-item" : ""}">
      <h3><button type="button" aria-expanded="${index === 0}" aria-controls="reply-${index}">
        <span>Question ${index + 1}</span>
        <span aria-hidden="true"><img src="/icon.svg" alt=""></span>
      </button></h3>
      <div class="reply" id="reply-${index}"><div><p>Answer ${index + 1}</p></div></div>
    </article>`).join("")}</div></section>`;
}

function model(count = 7) {
  const html = source(count);
  const entities = extractEditableEntities(html);
  return { html, entities, groups: detectAccordionGroups(html, entities) };
}

function realFixture() {
  const file = readFileSync(new URL("./fixtures/html-content-editor/accordion-layouts.html", import.meta.url), "utf8");
  const start = file.indexOf('<section class="il-faq"');
  assert.ok(start >= 0, "synthetic FAQ block exists in the local fixture");
  const end = file.indexOf("</script>", start);
  assert.ok(end > start, "synthetic FAQ source JS closes");
  return file.slice(start, end + "</script>".length);
}

function structuralFixture() {
  const file = readFileSync(new URL("./fixtures/html-content-editor/accordion-layouts.html", import.meta.url), "utf8");
  const section = file.indexOf("<section", file.indexOf(".hvk-guide"));
  assert.ok(section > 0);
  const start = file.lastIndexOf("<style>", section);
  const end = file.indexOf("</script>", section);
  assert.ok(start >= 0 && end > section);
  return file.slice(start, end + "</script>".length);
}

function structuralSource(count = 7, stateClass = "opened") {
  return `<style>.reply { display:grid; grid-template-rows:0fr } ${stateClass ? `.card.${stateClass} .reply` : '.card > button[aria-expanded="true"] + .reply'} { grid-template-rows:1fr }</style>
  <section><div class="entries">${Array.from({ length: count }, (_, index) => `
    <article class="card${index === 0 && stateClass ? ` ${stateClass}` : ""}">
      <button aria-expanded="${index === 0}"><span>Question ${index + 1}</span><span aria-hidden="true"><span></span><span></span></span></button>
      <div class="reply"><p>Answer ${index + 1}</p></div>
    </article>`).join("")}</div></section>`;
}

test("structural fallback recognizes 21-card synthetic FAQ without altering source", () => {
  const html = structuralFixture();
  const entities = extractEditableEntities(html);
  const groups = detectAccordionGroups(html, entities);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].path, "structural");
  assert.equal(groups[0].singleOpen, true);
  assert.equal(groups[0].items.length, 21);
  assert.equal(groups[0].items[0].initiallyOpen, true);
  assert.ok(groups[0].items.slice(1).every(item => !item.initiallyOpen));
  assert.ok(groups[0].items.every(item => item.answerId === null && item.questionEntityIds.length && item.answerEntityIds.length));
  assert.ok(!entities.some(entity => /hvk-guide-icon-line/.test(entity.displayValue ?? "")));
  assert.ok(!html.includes("aria-controls="));
  assert.equal(html, structuralFixture());
});

test("structural fallback rejects cards without a confirmed collapsing answer", () => {
  const html = structuralSource();
  assert.equal(detectAccordionGroups(html, extractEditableEntities(html))[0].path, "structural");
  for (const invalid of [
    html.replace(/<style>[\s\S]*?<\/style>/, ""),
    structuralSource(1),
    html.replaceAll('<div class="reply"><p>', '<div class="reply"></div><div><p>'),
    html.replaceAll('<div class="reply"><p>', '<div class="reply"><button aria-expanded="false"></button><p>'),
    html.replaceAll('<div class="reply"><p>', '<div class="menu"><ul><li>'),
    html.replaceAll('class="reply"', 'class="popup"'),
    html.replaceAll('<button aria-expanded=', '<button aria-haspopup="menu" aria-expanded='),
    html.replaceAll('<div class="reply"><p>', '<div class="reply" role="menu"><p>'),
    structuralSource(3, "").replace('class="card"', 'class="card featured"'),
  ]) {
    assert.deepEqual(detectAccordionGroups(invalid, extractEditableEntities(invalid)), []);
  }
});

test("synthetic FAQ is one single-open group with ten questions and protected icon URLs", () => {
  const html = realFixture();
  const entities = extractEditableEntities(html);
  const groups = detectAccordionGroups(html, entities);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].items.length, 10);
  assert.deepEqual(groups[0].items.map(item => item.initiallyOpen), [true, false, false, false, false, false, false, false, false, false]);
  for (const [index, item] of groups[0].items.entries()) {
    assert.equal(item.answerId, `il-faq-answer-${index + 1}`);
    assert.ok(item.questionEntityIds.length > 0);
    assert.ok(item.answerEntityIds.length > 0);
    assert.ok(item.controlEntityIds.some(id => entities.find(entity => entity.id === id)?.kind === "src"));
  }
});

test("semantic aria-controls pairs repeated question and answer owners without exposing icon media", () => {
  const { html, entities, groups } = model();
  assert.equal(groups.length, 1);
  assert.equal(groups[0].path, "explicit");
  assert.equal(groups[0].items.length, 7);
  assert.deepEqual(groups[0].items.map(item => item.initiallyOpen), [true, false, false, false, false, false, false]);
  for (const [index, item] of groups[0].items.entries()) {
    assert.equal(item.answerId, `reply-${index}`);
    assert.ok(item.questionEntityIds.some(id => entities.find(entity => entity.id === id)?.displayValue === `Question ${index + 1}`));
    assert.ok(item.answerEntityIds.some(id => entities.find(entity => entity.id === id)?.displayValue === `Answer ${index + 1}`));
    assert.ok(item.controlEntityIds.some(id => entities.find(entity => entity.id === id)?.displayValue === "/icon.svg"));
    assert.ok(!item.questionEntityIds.some(id => item.controlEntityIds.includes(id)));
  }
  assert.equal(html, source(), "detection is read-only");
  assert.ok(component.includes("!accordionControlEntityIds.has(entity.id)"));
  assert.ok(component.includes("previewAccordionControllerRef.current?.openForEntity(entity.id)"));
  assert.ok(component.includes('send({ type: "reveal", blockId: block.id, entityId })'));
});

test("requires unique controlled answers and at least two sibling items; leaves native details alone", () => {
  const single = source(1);
  assert.deepEqual(detectAccordionGroups(single, extractEditableEntities(single)), []);
  const duplicate = source(2).replace('id="reply-1"', 'id="reply-0"');
  assert.deepEqual(detectAccordionGroups(duplicate, extractEditableEntities(duplicate)), []);
  const details = "<details open><summary>Question</summary><p>Answer</p></details>";
  assert.deepEqual(detectAccordionGroups(details, extractEditableEntities(details)), []);
});

function previewDocument(groups, { structural = false, stateClass = "expanded-item" } = {}) {
  class Element extends EventTarget {
    constructor(tag, parent = null) {
      super(); this.tagName = tag.toUpperCase(); this.parentElement = parent; this.children = [];
      this.nodeType = 1;
      this.attrs = new Map(); this.style = {
        setProperty: (name, value) => {
          const properties = new Map((this.getAttribute("style") ?? "").split(";").filter(Boolean).map(part => part.split(":")));
          properties.set(name, value);
          this.setAttribute("style", [...properties].map(([key, entry]) => `${key}:${entry}`).join(";"));
        },
      };
      this.classList = {
        [Symbol.iterator]: () => (this.getAttribute("class") ?? "").split(/\s+/).filter(Boolean)[Symbol.iterator](),
        contains: name => (this.getAttribute("class") ?? "").split(/\s+/).includes(name),
        add: name => this.classList.toggle(name, true),
        remove: name => this.classList.toggle(name, false),
        toggle: (name, on) => {
          const classes = new Set((this.getAttribute("class") ?? "").split(/\s+/).filter(Boolean));
          if (on) classes.add(name); else classes.delete(name);
          this.setAttribute("class", [...classes].join(" "));
        },
      };
      if (parent) parent.children.push(this);
    }
    setAttribute(name, value) { this.attrs.set(name, String(value)); }
    getAttribute(name) { return this.attrs.get(name) ?? null; }
    removeAttribute(name) { this.attrs.delete(name); }
    contains(node) { return node === this || this.children.some(child => child.contains(node)); }
    closest(selector) {
      if (selector === "button[aria-expanded]" && this.tagName === "BUTTON" && this.getAttribute("aria-expanded") !== null) return this;
      return this.parentElement?.closest(selector) ?? null;
    }
    get nextElementSibling() { const siblings = this.parentElement?.children ?? []; return siblings[siblings.indexOf(this) + 1] ?? null; }
    get id() { return this.getAttribute("id") ?? ""; }
    getBoundingClientRect() {
      const style = this.getAttribute("style") ?? "";
      if (/grid-template-rows:0fr/.test(style)) return { height: 0 };
      if (/grid-template-rows:1fr/.test(style)) return { height: 40 };
      const item = this.parentElement;
      const open = stateClass ? item?.classList.contains(stateClass) : item?.children[0]?.getAttribute("aria-expanded") === "true";
      return { height: open ? 40 : 0 };
    }
  }
  const body = new Element("body");
  const nodes = [];
  const markers = {};
  const owners = groups[0].items.map(item => {
    const owner = new Element("article", body); owner.setAttribute("class", `entry${item.initiallyOpen && stateClass ? ` ${stateClass}` : ""}`);
    const heading = structural ? owner : new Element("h3", owner);
    const trigger = new Element("button", heading);
    trigger.setAttribute("aria-expanded", String(item.initiallyOpen));
    if (item.answerId) trigger.setAttribute("aria-controls", item.answerId);
    const question = new Element("span", trigger);
    const answer = new Element("div", owner);
    if (item.answerId) answer.setAttribute("id", item.answerId);
    const answerContent = new Element("p", answer);
    if (structural) {
      const questionMarker = `q-${nodes.length}`;
      const answerMarker = `a-${nodes.length}`;
      question.setAttribute("data-tinymods-preview-ids", questionMarker);
      answerContent.setAttribute("data-tinymods-preview-ids", answerMarker);
      markers[item.questionEntityIds[0]] = questionMarker;
      markers[item.answerEntityIds[0]] = answerMarker;
    }
    nodes.push(owner, heading, trigger, question, answer, answerContent);
    return { owner, trigger, answer };
  });
  const document = {
    body,
    documentElement: new Element("html"),
    defaultView: { getComputedStyle(element) {
      const open = element.getBoundingClientRect().height > 0;
      return { gridTemplateRows: open ? "40px" : "0px", opacity: "1", visibility: "visible", display: "grid", maxHeight: "none" };
    } },
    getElementById: id => nodes.find(node => node.id === id) ?? null,
    querySelector: selector => nodes.find(node => node.getAttribute("data-tinymods-preview-ids") === selector.match(/~="([^"]+)"/)?.[1]) ?? null,
    querySelectorAll: selector => selector === "[id]" ? nodes.filter(node => node.id) :
      selector === "button[aria-expanded][aria-controls]" ? owners.map(owner => owner.trigger) : [],
  };
  return { document, owners, nodes, markers };
}

test("runtime keeps initial state, opens one item, closes current, opens on content focus and restores DOM", () => {
  const { groups } = model();
  const { document, owners, nodes } = previewDocument(groups);
  const before = nodes.map(node => [node, [...node.attrs]]);
  const navigation = installPreviewAccordionNavigation(document, groups);
  const open = () => owners.map(owner => owner.trigger.getAttribute("aria-expanded") === "true");
  assert.deepEqual(open(), [true, false, false, false, false, false, false]);
  owners[1].trigger.dispatchEvent(new Event("click"));
  assert.deepEqual(open(), [false, true, false, false, false, false, false]);
  assert.equal(owners[1].answer.getBoundingClientRect().height, 40);
  owners[1].trigger.dispatchEvent(new Event("click"));
  assert.deepEqual(open(), [false, false, false, false, false, false, false]);
  navigation.openForEntity(groups[0].items[6].answerEntityIds[0]);
  assert.deepEqual(open(), [false, false, false, false, false, false, true]);
  navigation.openForEntity(groups[0].items[6].questionEntityIds[0]);
  assert.deepEqual(open(), [false, false, false, false, false, false, true], "focus does not toggle");
  navigation.cleanup();
  for (const [node, attrs] of before) assert.deepEqual([...node.attrs], attrs);
  owners[1].trigger.dispatchEvent(new Event("click"));
  assert.deepEqual(open(), [true, false, false, false, false, false, false]);
});

test("structural runtime transfers a proven class and restores every preview mutation", () => {
  const html = structuralSource();
  const groups = detectAccordionGroups(html, extractEditableEntities(html));
  const { document, owners, nodes, markers } = previewDocument(groups, { structural: true, stateClass: "expanded-item" });
  const before = nodes.map(node => [node, [...node.attrs]]);
  const navigation = installPreviewAccordionNavigation(document, groups, markers);
  const open = () => owners.map((owner, index) => owner.trigger.getAttribute("aria-expanded") === "true" ? index + 1 : null).filter(Boolean);
  assert.deepEqual(open(), [1]);
  owners[1].trigger.dispatchEvent(new Event("click"));
  assert.deepEqual(open(), [2]);
  assert.equal(owners[0].owner.classList.contains("expanded-item"), false);
  assert.equal(owners[1].owner.classList.contains("expanded-item"), true);
  assert.equal(owners[0].answer.getBoundingClientRect().height, 0);
  assert.equal(owners[1].answer.getBoundingClientRect().height, 40);
  owners[1].trigger.dispatchEvent(new Event("click"));
  assert.deepEqual(open(), []);
  owners[6].trigger.dispatchEvent(new Event("click"));
  assert.deepEqual(open(), [7]);
  navigation.openForEntity(groups[0].items[1].answerEntityIds[0]);
  assert.deepEqual(open(), [2]);
  navigation.openForEntity(groups[0].items[1].questionEntityIds[0]);
  assert.deepEqual(open(), [2], "Content selection is idempotent");
  navigation.cleanup();
  for (const [node, attrs] of before) assert.deepEqual([...node.attrs], attrs);
  owners[1].trigger.dispatchEvent(new Event("click"));
  assert.deepEqual(open(), [1]);
  assert.ok(component.includes('send({ type: "reveal", blockId: block.id, entityId })'));
});

test("ambiguous source class uses scoped Preview-only panel state", () => {
  const html = structuralSource(3, "");
  const groups = detectAccordionGroups(html, extractEditableEntities(html));
  assert.equal(groups.length, 1);
  const { document, owners, nodes, markers } = previewDocument(groups, { structural: true, stateClass: "" });
  const before = nodes.map(node => [node, [...node.attrs]]);
  const navigation = installPreviewAccordionNavigation(document, groups, markers);
  owners[1].trigger.dispatchEvent(new Event("click"));
  assert.equal(owners[0].answer.getBoundingClientRect().height, 0);
  assert.equal(owners[1].answer.getBoundingClientRect().height, 40);
  assert.equal(owners[0].owner.getAttribute("class"), "entry");
  navigation.cleanup();
  for (const [node, attrs] of before) assert.deepEqual([...node.attrs], attrs);
});
