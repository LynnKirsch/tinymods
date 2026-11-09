import assert from "node:assert/strict";
import test from "node:test";

import { createEditableEntityPatch, createEditableEntityPatches } from "../app/lib/html-content-editor/encode-source-value.ts";
import { extractEditableEntities } from "../app/lib/html-content-editor/extract-editable-entities.ts";
import { applySourcePatches } from "../app/lib/html-content-editor/patch-source.ts";
import {
  neutralizeHoverRulesInContainer,
  selectorListWithoutHover,
  splitSelectorList,
} from "../app/lib/html-content-editor/preview-hover-neutralizer.ts";
import { buildPreviewSource } from "../app/lib/html-content-editor/preview-source.ts";
import { detectSliderGroups } from "../app/lib/html-content-editor/slider-groups.ts";
import {
  CONTENT_VISIBLE_CLASS,
  ensureEditableContentVisible,
} from "../app/lib/html-content-editor/preview-content-visibility.ts";

test("faithful live source retains user script and whitespace without static conversion", () => {
  const source = '<div id="widget"></div><script>const root=document.querySelector("#widget");root.innerHTML=`<p>В лесу и на берегу</p>`;</script>';
  const preview = buildPreviewSource(source, extractEditableEntities(source), { live: true, namespace: "block-2" });
  assert.ok(preview.source.includes("root.innerHTML="));
  assert.equal((preview.source.match(/<script>/g) ?? []).length, 1);
  assert.ok(!preview.source.includes("\u00a0"));
  assert.ok(!preview.source.includes("tinymods-preview-content-visible"));
  assert.ok(preview.markers.every(marker => marker.previewId.startsWith("block-2-")));
  assert.ok(source.includes('id="widget"'));
  assert.ok(preview.source.includes('id="widget"'));
});

test("live image constant markers go into the literal template tag, never the JS value", () => {
  const source = '<div id="widget"></div><script>const img="https://example.com/photo.webp"; const root=document.querySelector("#widget");root.innerHTML=`<img src="${img}"><p>Caption</p>`;</script>';
  const preview = buildPreviewSource(source, extractEditableEntities(source), { live: true, namespace: "block-2" });
  assert.ok(preview.source.includes('const img="https://example.com/photo.webp";'));
  assert.match(preview.source, /<img src="\$\{img\}" data-tinymods-preview-ids="block-2-tm-\d+">/);
  assert.equal((preview.source.match(/root.innerHTML=/g) ?? []).length, 1);
});

function style(declarations) {
  return {
    getPropertyValue(property) {
      return declarations[property] ?? "";
    },
  };
}

function createElement(baseStyle = {}, tagName = "div") {
  const classes = new Set();
  const element = {
    classes,
    baseStyle,
    parentElement: null,
    tagName,
    classList: {
      add(className) {
        classes.add(className);
      },
      contains(className) {
        return classes.has(className);
      },
      remove(className) {
        classes.delete(className);
      },
    },
  };
  return element;
}

function append(parent, child) {
  child.parentElement = parent;
  return child;
}

function createVisibilityDocument(bodyChildren = []) {
  const html = createElement({}, "html");
  const body = append(html, createElement({}, "body"));
  for (const child of bodyChildren) append(body, child);
  return {
    body,
    documentElement: html,
    defaultView: {
      getComputedStyle(element) {
        if (element.classes.has(CONTENT_VISIBLE_CLASS)) {
          return style({
            ...element.baseStyle,
            opacity: "1",
            visibility: "visible",
            transform: "none",
            animation: "none",
            transition: "none",
          });
        }
        return style(element.baseStyle);
      },
    },
  };
}

class FakeStyleRule {
  constructor(selectorText, declarationText) {
    this.selectorText = selectorText;
    this.style = { cssText: declarationText };
    this.cssText = `${selectorText} { ${declarationText} }`;
  }
}

class FakeRuleContainer {
  constructor(rules = []) {
    this.cssRules = rules;
  }

  deleteRule(index) {
    this.cssRules.splice(index, 1);
  }

  insertRule(ruleText, index = this.cssRules.length) {
    const match = ruleText.match(/^([^{]+)\{([\s\S]*)\}$/);
    if (!match) throw new Error(`Cannot parse fake CSS rule: ${ruleText}`);
    this.cssRules.splice(index, 0, new FakeStyleRule(match[1].trim(), match[2].trim()));
  }
}

class FakeGroupingRule extends FakeRuleContainer {
  constructor(conditionText, rules = []) {
    super(rules);
    this.conditionText = conditionText;
  }
}

function fakeRuleSummary(container) {
  return container.cssRules.map((rule) => {
    if (rule.selectorText) return rule.selectorText;
    return {
      conditionText: rule.conditionText,
      rules: fakeRuleSummary(rule),
    };
  });
}

test("adds preview-only markers without changing final source output", () => {
  const source = `<h1>Отдых за <span>8 800 ₽</span> в сутки</h1><a href="/booking">Забронировать</a>`;
  const entities = extractEditableEntities(source);
  const preview = buildPreviewSource(source, entities);

  assert.match(preview.source, /<h1 data-tinymods-preview-ids="tm-1">/);
  assert.match(preview.source, /data-tinymods-preview-ids="tm-/);
  assert.match(preview.source, /tinymods-preview-active/);
  assert.equal(applySourcePatches(source, []), source);
  assert.ok(!source.includes("tinymods-preview"));
  assert.ok(!source.includes("data-tinymods-preview-ids"));
});

test("preview hover neutralizer removes a single source hover selector", () => {
  const container = new FakeRuleContainer([
    new FakeStyleRule(".card:hover", "transform: translateY(-8px);"),
  ]);

  const result = neutralizeHoverRulesInContainer(container);

  assert.equal(result, 1);
  assert.deepEqual(fakeRuleSummary(container), []);
});

test("preview hover neutralizer preserves base transforms while dropping hover transforms", () => {
  const container = new FakeRuleContainer([
    new FakeStyleRule(".image", "transform: translateX(-50%);"),
    new FakeStyleRule(".image:hover", "transform: translateX(-50%) scale(1.05);"),
  ]);

  neutralizeHoverRulesInContainer(container);

  assert.deepEqual(fakeRuleSummary(container), [".image"]);
  assert.equal(container.cssRules[0].style.cssText, "transform: translateX(-50%);");
});

test("preview hover neutralizer removes only hover branches from grouped selectors", () => {
  const container = new FakeRuleContainer([
    new FakeStyleRule(".card:hover, .card:focus", "opacity: .8;"),
  ]);

  neutralizeHoverRulesInContainer(container);

  assert.deepEqual(fakeRuleSummary(container), [".card:focus"]);
  assert.equal(container.cssRules[0].style.cssText, "opacity: .8;");
});

test("preview hover neutralizer removes descendant hover selectors", () => {
  const container = new FakeRuleContainer([
    new FakeStyleRule(".button:hover svg", "transform: translateX(3px);"),
  ]);

  neutralizeHoverRulesInContainer(container);

  assert.deepEqual(fakeRuleSummary(container), []);
});

test("preview hover neutralizer walks nested media and support rules", () => {
  const container = new FakeRuleContainer([
    new FakeGroupingRule("@media (hover: hover) and (pointer: fine)", [
      new FakeStyleRule(".image:hover", "transform: scale(1.05);"),
      new FakeStyleRule(".image:focus-visible", "outline: 2px solid blue;"),
    ]),
  ]);

  neutralizeHoverRulesInContainer(container);

  assert.deepEqual(fakeRuleSummary(container), [
    {
      conditionText: "@media (hover: hover) and (pointer: fine)",
      rules: [".image:focus-visible"],
    },
  ]);
});

test("preview hover selector splitter keeps commas inside functional pseudos and attributes", () => {
  assert.deepEqual(splitSelectorList(':is(.a, .b):hover, .c:focus, [data-x="a,b"]'), [
    ":is(.a, .b):hover",
    ".c:focus",
    '[data-x="a,b"]',
  ]);
  assert.equal(
    selectorListWithoutHover(':is(.a, .b):hover, .c:focus, [data-x="a,b"]'),
    '.c:focus, [data-x="a,b"]',
  );
});

test("preview hover neutralizer is idempotent for already-neutralized rules", () => {
  const container = new FakeRuleContainer([
    new FakeStyleRule(".card:hover, .card:focus", "opacity: .8;"),
  ]);

  assert.equal(neutralizeHoverRulesInContainer(container), 1);
  assert.equal(neutralizeHoverRulesInContainer(container), 0);
  assert.deepEqual(fakeRuleSummary(container), [".card:focus"]);
});

test("preview hover neutralizer leaves Tinymods runtime CSS in source output untouched", () => {
  const source = `<style>
.card { transform: translateY(0); }
.card:hover { transform: translateY(-8px); }
</style>
<article class="card">Card</article>`;
  const preview = buildPreviewSource(source, extractEditableEntities(source));

  assert.match(preview.source, /tinymods-preview-active/);
  assert.match(preview.source, /\.card:hover \{ transform: translateY\(-8px\); \}/);
  assert.equal(applySourcePatches(source, []), source);
});

test("keeps composite text source ranges independent from preview markers", () => {
  const source = `<h1>Отдых за <span>8 800 ₽</span> в сутки</h1>`;
  const entities = extractEditableEntities(source);
  const price = entities.find((entity) => entity.composite);
  assert.ok(price);

  const preview = buildPreviewSource(source, entities);
  const finalSource = applySourcePatches(source, createEditableEntityPatches(price, price.displayValue.replace("8 800 ₽", "9 900 ₽")));

  assert.match(preview.source, /<h1 data-tinymods-preview-ids="tm-1">/);
  assert.equal(finalSource, `<h1>Отдых за <span>9 900 ₽</span> в сутки</h1>`);
  assert.ok(!finalSource.includes("tinymods-preview"));
});

test("adds one preview-only content visibility class instead of data-reveal special case", () => {
  const source = `<style>
.hv-about [data-reveal] { opacity: 0; transform: translateY(60px); }
</style>
<section class="hv-about"><h2 data-reveal>О нас</h2></section>`;
  const entities = extractEditableEntities(source);
  const preview = buildPreviewSource(source, entities);
  const previewSystemStyle = preview.source.slice(0, preview.source.indexOf("</style>"));

  assert.match(preview.source, /tinymods-preview-content-visible/);
  assert.match(preview.source, /opacity: 1 !important/);
  assert.match(preview.source, /visibility: visible !important/);
  assert.match(preview.source, /transform: none !important/);
  assert.match(preview.source, /animation: none !important/);
  assert.match(preview.source, /transition: none !important/);
  assert.ok(!previewSystemStyle.includes("[data-reveal]"));
  assert.equal(applySourcePatches(source, []), source);
  assert.ok(!source.includes("data-tinymods-preview-style"));
});

test("makes an opacity-hidden ancestor of mapped editable content visible", () => {
  const source = `<section class="example">
  <h2 class="title">Title</h2>
  <article class="card">Card</article>
</section>

<style>
.title,
.card {
  opacity:0;
  transform:translateY(30px);
}

.title.is-visible,
.card.is-visible {
  opacity:1;
  transform:translateY(0);
}
</style>

<script>
const items = document.querySelectorAll('.title, .card');

const observer = new IntersectionObserver(entries => {
  entries.forEach(entry => {
    if (entry.isIntersecting) {
      entry.target.classList.add('is-visible');
    }
  });
});

items.forEach(item => observer.observe(item));
</script>`;
  const entities = extractEditableEntities(source);
  const title = entities.find((entity) => entity.rawValue === "Title");
  const preview = buildPreviewSource(source, entities);
  const finalSource = applySourcePatches(source, [
    createEditableEntityPatch(title, "New title"),
  ]);

  const reveal = createElement({
    opacity: "0",
    transform: "translateY(30px)",
    animation: "fade 1s",
    transition: "opacity .4s",
  });
  const heading = append(reveal, createElement({}, "h2"));
  const text = append(heading, createElement({}, "span"));
  const document = createVisibilityDocument([reveal]);
  const results = ensureEditableContentVisible(document, [text]);

  assert.equal(results.length, 1);
  assert.equal(results[0].reason, "opacity");
  assert.equal(reveal.classes.has(CONTENT_VISIBLE_CLASS), true);
  assert.equal(text.classes.has(CONTENT_VISIBLE_CLASS), false);
  assert.ok(!preview.source.includes("data-tinymods-visibility-recovery"));
  assert.equal(finalSource, source.replace("Title", "New title"));
  assert.ok(!finalSource.includes("data-tinymods-visibility-recovery"));
  assert.ok(!finalSource.includes("tinymods-visibility-recovery"));
});

test("makes a visibility-hidden ancestor of mapped editable content visible", () => {
  const reveal = createElement({ visibility: "hidden" });
  const text = append(reveal, createElement({}, "span"));
  const document = createVisibilityDocument([reveal]);
  const results = ensureEditableContentVisible(document, [text]);

  assert.equal(results.length, 1);
  assert.equal(results[0].reason, "visibility");
  assert.equal(reveal.classes.has(CONTENT_VISIBLE_CLASS), true);
});

test("recovers hv-feelings hidden ancestors without touching child transforms", () => {
  const source = `<section class="hv-feelings">
  <h2 class="hv-feelings__title">Title</h2>
  <p class="hv-feelings__quote">Quote</p>
  <img class="hv-feelings__butterfly" src="/butterfly.webp">
  <article class="hv-feelings__card">Card</article>
  <p class="hv-feelings__cta-text">CTA</p>
  <a class="hv-feelings__btn" href="/booking">Book</a>
</section>
<style>
.hv-feelings__title,
.hv-feelings__quote,
.hv-feelings__butterfly,
.hv-feelings__card,
.hv-feelings__cta-text,
.hv-feelings__btn {
  opacity:0;
  transform:translateY(38px);
}

.hv-feelings__title.is-visible,
.hv-feelings__quote.is-visible,
.hv-feelings__butterfly.is-visible,
.hv-feelings__card.is-visible,
.hv-feelings__cta-text.is-visible,
.hv-feelings__btn.is-visible {
  opacity:1;
  transform:translateY(0);
}
</style>
<script>
const observer = new IntersectionObserver(entries => {
  entries.forEach(entry => {
    if (entry.isIntersecting) {
      entry.target.classList.add('is-visible');
    }
  });
});
document.querySelectorAll('.hv-feelings__title, .hv-feelings__quote, .hv-feelings__butterfly, .hv-feelings__card, .hv-feelings__cta-text, .hv-feelings__btn')
  .forEach(item => observer.observe(item));
</script>`;
  const preview = buildPreviewSource(source, extractEditableEntities(source));

  const title = createElement({ opacity: "0", transform: "translateY(38px)" }, "h2");
  const titleSpan = append(title, createElement({ transform: "translateX(-90px)" }, "span"));
  const quote = createElement({ opacity: "0", transform: "translateY(38px)" }, "p");
  const quoteText = append(quote, createElement({}, "span"));
  const card = createElement({ opacity: "0", transform: "translateY(38px)" }, "article");
  const cardImage = append(card, createElement({}, "img"));
  const cardText = append(card, createElement({}, "span"));
  const document = createVisibilityDocument([title, quote, card]);
  const results = ensureEditableContentVisible(document, [titleSpan, quoteText, cardImage, cardText]);

  assert.equal(results.length, 3);
  assert.equal(title.classes.has(CONTENT_VISIBLE_CLASS), true);
  assert.equal(quote.classes.has(CONTENT_VISIBLE_CLASS), true);
  assert.equal(card.classes.has(CONTENT_VISIBLE_CLASS), true);
  assert.equal(titleSpan.classes.has(CONTENT_VISIBLE_CLASS), false);
  assert.equal(document.defaultView.getComputedStyle(title).getPropertyValue("transform"), "none");
  assert.equal(
    document.defaultView.getComputedStyle(titleSpan).getPropertyValue("transform"),
    "translateX(-90px)",
  );
  assert.ok(!preview.source.includes("data-tinymods-visibility-recovery"));
  assert.equal(applySourcePatches(source, []), source);
  assert.ok(!source.includes("data-tinymods-visibility-recovery"));
});

test("does not recover display none ancestors", () => {
  const hidden = createElement({ display: "none", opacity: "0" });
  const text = append(hidden, createElement({}, "span"));
  const document = createVisibilityDocument([hidden]);
  const results = ensureEditableContentVisible(document, [text]);

  assert.deepEqual(results, []);
  assert.equal(hidden.classes.has(CONTENT_VISIBLE_CLASS), false);
});

test("confirmed stacked subtrees are excluded but outer and unrelated hidden content still recover", () => {
  for (const state of ["active", "inactive"]) {
    const outer = createElement({ opacity: "0" });
    const slide = append(outer, createElement({ visibility: "hidden", opacity: "0" }, "article"));
    slide.getAttribute = name => name === "data-tinymods-slider-state" ? state : null;
    const text = append(slide, createElement({ visibility: "hidden" }, "h2"));
    const unrelated = createElement({ opacity: "0" });
    const displayNone = createElement({ display: "none", opacity: "0" });
    const document = createVisibilityDocument([outer, unrelated, displayNone]);
    ensureEditableContentVisible(document, [text, unrelated, displayNone]);
    assert.equal(slide.classes.has(CONTENT_VISIBLE_CLASS), false);
    assert.equal(text.classes.has(CONTENT_VISIBLE_CLASS), false);
    assert.equal(outer.classes.has(CONTENT_VISIBLE_CLASS), true);
    assert.equal(unrelated.classes.has(CONTENT_VISIBLE_CLASS), true);
    assert.equal(displayNone.classes.has(CONTENT_VISIBLE_CLASS), false);
  }
});

test("nested recovery respects the full managed ancestor chain, including inactive display-none parents", () => {
  for (const display of ["grid", "none"]) {
    const unrelatedOuter = createElement({ opacity: "0" });
    const parent = append(unrelatedOuter, createElement({ display, opacity: "0", visibility: "hidden" }));
    parent.getAttribute = name => name === "data-tinymods-slider-state" ? "inactive" : null;
    const gallery = append(parent, createElement({ opacity: "0" }));
    const photo = append(gallery, createElement({ visibility: "hidden" }, "img"));
    photo.getAttribute = name => name === "data-tinymods-slider-state" ? "active" : null;
    const document = createVisibilityDocument([unrelatedOuter]);
    ensureEditableContentVisible(document, [photo]);
    assert.equal(unrelatedOuter.classes.has(CONTENT_VISIBLE_CLASS), true);
    for (const node of [parent, gallery, photo]) assert.equal(node.classes.has(CONTENT_VISIBLE_CLASS), false);
  }
});

test("exact slider owners are preview-only and follow content patches without corrupting opening tags", () => {
  const source = '<section class="carousel"><div class="carousel-viewport"><div class="carousel-track"><article class="card card--a"><h2>First</h2></article><article class="card card--b"><h2>Second</h2></article></div></div><nav class="carousel-pagination"><button data-go-to="0">01</button></nav></section>';
  const entities = extractEditableEntities(source);
  const heading = entities.find(entity => entity.rawValue === "First");
  const finalSource = applySourcePatches(source, [createEditableEntityPatch(heading, "A longer heading")]);
  const updatedEntities = extractEditableEntities(finalSource);
  const groups = detectSliderGroups(finalSource, updatedEntities);
  const preview = buildPreviewSource(finalSource, updatedEntities, { sliderGroups: groups });
  const [group] = groups;
  for (const [attribute, range, id] of [
    ["root", group.rootRange, group.id],
    ["viewport", group.viewportRange, group.id],
    ["track", group.trackRange, group.id],
    ...group.slides.map(slide => ["slide", slide, slide.id]),
  ]) {
    const startTag = finalSource.slice(range.start, finalSource.indexOf(">", range.start));
    const previewStart = preview.source.indexOf(startTag);
    const previewTag = preview.source.slice(previewStart, preview.source.indexOf(">", previewStart));
    assert.ok(previewTag.includes('data-tinymods-slider-' + attribute + '="' + id + '"'));
  }
  assert.equal(finalSource, source.replace("First", "A longer heading"));
  assert.equal(preview.markers.length, updatedEntities.length);
  assert.ok(!finalSource.includes("data-tinymods"));
});

test("slider opening-tag ranges survive an earlier static JS widget replacement", () => {
  const source = '<script>const root = document.querySelector("#widget"); root.innerHTML = `<div class="widget"><p>Widget</p></div>`;</script><div class="carousel"><div class="carousel-track"><article class="card"><p>One</p></article><article class="card"><p>Two</p></article></div></div>';
  const entities = extractEditableEntities(source);
  const [group] = detectSliderGroups(source, entities);
  const preview = buildPreviewSource(source, entities, { sliderGroups: [group] });
  assert.ok(!preview.source.includes("root.innerHTML"));
  for (const slide of group.slides) {
    assert.ok(preview.source.includes('<article class="card" data-tinymods-slider-slide="' + slide.id + '">'));
  }
  assert.equal(applySourcePatches(source, []), source);
});

test("does not recover unrelated hidden elements without mapped editable content", () => {
  const source = `<style>
.modal {
  opacity: 0;
  transform: translateY(30px);
}
.modal.is-open {
  opacity: 1;
  transform: translateY(0);
}
</style>
<div class="modal">Modal</div>
<script>
document.querySelector('.modal').classList.add('is-open');
</script>`;
  const preview = buildPreviewSource(source, extractEditableEntities(source));
  const modal = createElement({ opacity: "0" });
  const unrelatedEditable = createElement({});
  const document = createVisibilityDocument([modal, unrelatedEditable]);
  const results = ensureEditableContentVisible(document, [unrelatedEditable]);

  assert.ok(!preview.source.includes("data-tinymods-visibility-recovery"));
  assert.deepEqual(results, []);
  assert.equal(modal.classes.has(CONTENT_VISIBLE_CLASS), false);
});

test("keeps video poster preview markers out of final source", () => {
  const source = `<video src="hero.mp4" poster="poster.webp"></video>`;
  const entities = extractEditableEntities(source);
  const poster = entities.find((entity) => entity.kind === "poster");
  assert.ok(poster);

  const preview = buildPreviewSource(source, entities);
  const finalSource = applySourcePatches(source, [
    createEditableEntityPatch(poster, "poster-new.webp"),
  ]);

  assert.match(preview.source, /data-tinymods-preview-ids="tm-/);
  assert.equal(finalSource, `<video src="hero.mp4" poster="poster-new.webp"></video>`);
  assert.ok(!finalSource.includes("data-tinymods-preview"));
  assert.ok(!finalSource.includes("tinymods-preview"));
});


test("composite marker is attached to semantic parent rather than accent span", () => {
  const source = '<h2>Когда обратиться<br>к <span class="accent" data-x="1">психологу?</span></h2>';
  const entities = extractEditableEntities(source);
  const preview = buildPreviewSource(source, entities, { live: true });
  assert.equal(preview.markers.length, 1);
  assert.equal(preview.source, '<h2 data-tinymods-preview-ids="tm-1">Когда обратиться<br>к <span class="accent" data-x="1">психологу?</span></h2>');
  assert.equal(entities[0].context.tagName, 'h2');
  assert.equal(source.includes('data-tinymods'), false);
});
