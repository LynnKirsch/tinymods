import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { buildContentGroups } from "../app/lib/html-content-editor/content-groups.ts";
import { createEditableEntityPatch } from "../app/lib/html-content-editor/encode-source-value.ts";
import { extractEditableEntities } from "../app/lib/html-content-editor/extract-editable-entities.ts";
import { applySourcePatches } from "../app/lib/html-content-editor/patch-source.ts";
import { buildPreviewSource } from "../app/lib/html-content-editor/preview-source.ts";
import { detectSliderGroups, sliderActivationPath } from "../app/lib/html-content-editor/slider-groups.ts";
import { installPreviewSliderNavigation } from "../app/lib/html-content-editor/preview-slider-navigation.ts";
import { ensureEditableContentVisible } from "../app/lib/html-content-editor/preview-content-visibility.ts";

const PREVIEW_SLIDER_NAVIGATION_SOURCE = readFileSync(
  new URL("../app/lib/html-content-editor/preview-slider-navigation.ts", import.meta.url),
  "utf8",
);
const HTML_CONTENT_EDITOR_COMPONENT_SOURCE = readFileSync(
  new URL("../app/components/html-content-editor/HtmlContentEditor.tsx", import.meta.url),
  "utf8",
);

function sliderGroups(source) {
  return detectSliderGroups(source, extractEditableEntities(source));
}

function nestedSource() {
  return `<section><nav class="object-navigation">${[0, 1, 2].map(i => `<button data-object-tab="${i}">0${i + 1}</button>`).join("")}</nav><div class="object-stage">${[0, 1, 2].map(i =>
    `<article class="object-card${i === 0 ? " is-active" : ""}"><div class="gallery"><div class="photo-slider">${[0, 1, 2, 3].map(j => `<img class="photo${j === 0 ? " is-active" : ""}" src="/${i}-${j}.webp" alt="">`).join("")}</div><button class="gallery-prev">Previous photo</button><button class="gallery-next">Next photo</button></div><h2>Object ${i + 1}</h2><p>Description ${i}</p><a class="next-offer" href="/book-${i}">Book ${i}</a></article>`).join("")}</div></section><div class="modal" aria-hidden="true"><img src="" alt=""></div>`;
}

test("nested groups have nearest parents, unique content ownership and separate controls at both levels", () => {
  const source = nestedSource();
  const entities = extractEditableEntities(source);
  const before = structuredClone(entities);
  const groups = detectSliderGroups(source, entities);
  assert.equal(groups.length, 4);
  const [outer, ...children] = groups;
  assert.deepEqual(outer.slides.map(s => s.label), ["Object 1", "Object 2", "Object 3"]);
  children.forEach((child, i) => {
    assert.equal(child.parentSliderId, outer.id);
    assert.equal(child.parentSlideId, outer.slides[i].id);
    assert.equal(child.slides.length, 4);
    assert.equal(child.mediaOnly, true);
    assert.equal(child.slideEntityIds.length, 8);
    assert.equal(child.controlEntityIds.length, 2);
    assert.ok(child.slideEntityIds.every(id => !outer.slideEntityIds.includes(id)));
  });
  const owned = groups.flatMap(g => g.slideEntityIds);
  assert.equal(new Set(owned).size, owned.length);
  const controls = new Set(groups.flatMap(g => g.controlEntityIds));
  assert.ok(owned.every(id => !controls.has(id)));
  assert.ok(entities.filter(e => e.kind === "href").every(e => outer.slideEntityIds.includes(e.id)));
  assert.equal(outer.controlEntityIds.length, 3);
  assert.deepEqual(buildContentGroups(source, entities.filter(e => !owned.includes(e.id) && !controls.has(e.id))), []);
  assert.deepEqual(sliderActivationPath(groups, children[2].id, 2).map(step => [step.sliderId, step.slide.index]), [[outer.id, 2], [children[2].id, 2]]);
  const deep = { ...children[2], id: "deeper", parentSliderId: children[2].id, parentSlideId: children[2].slides[2].id };
  assert.equal(sliderActivationPath([...groups, deep], deep.id, 1).length, 3);
  const preview = buildPreviewSource(source, entities, { sliderGroups: groups });
  assert.equal((preview.source.match(/data-tinymods-slider-parent-slide=/g) ?? []).length, 3);
  assert.deepEqual(entities, before);
  assert.equal(applySourcePatches(source, []), source);
});

test("structural slider owners support variants and both scroll container layouts", () => {
  const item = (index, indexed = false) => `<article class="offer offer--${index}"${indexed ? ` data-slide="${index}"${index === 0 ? ' class-state="first" aria-hidden="false"' : ' aria-hidden="true"'}` : ""}><h2>Offer ${index}</h2><a class="next-offer" href="/${index}">Book ${index}</a><img src="/${index}.webp" alt="Photo ${index}"></article>`;
  const controls = `<nav class="gallery-controls"><button data-go-to="0">01</button><button data-go-to="1">02</button><span class="gallery-counter">10</span></nav>`;
  const fixtures = [
    { source: `<section><div class="quotes-carousel">${item(0)}${item(1)}</div>${controls}</section>`, same: true },
    { source: `<section><div class="feature-slides">${item(0, true)}${item(1, true)}</div>${controls}</section>`, stacked: true },
    { source: `<section><div class="offers-viewport"><div class="offers-track">${item(0)}${item(1)}</div></div>${controls}</section>` },
    { source: `<section class="feature-carousel"><div class="feature-viewport"><div class="feature-track">${item(0)}${item(1)}</div></div><div class="feature-dots"></div></section>` },
  ];
  for (const fixture of fixtures) {
    const entities = extractEditableEntities(fixture.source);
    const unchanged = structuredClone(entities);
    const groups = detectSliderGroups(fixture.source, entities);
    assert.equal(groups.length, 1);
    const [group] = groups;
    assert.equal(group.slides.length, 2);
    assert.deepEqual(entities, unchanged);
    if (fixture.stacked) assert.equal(group.viewportRange, null);
    else assert.equal(group.viewportRange.start === group.trackRange.start, Boolean(fixture.same));
    const controls = new Set(group.controlEntityIds);
    assert.ok(group.slideEntityIds.every(id => !controls.has(id)));
    assert.ok(entities.filter(e => e.kind === "href").every(e => group.slideEntityIds.includes(e.id)));
    const excluded = new Set([...group.slideEntityIds, ...group.controlEntityIds]);
    assert.deepEqual(buildContentGroups(fixture.source, entities.filter(e => !excluded.has(e.id))), []);
    const preview = buildPreviewSource(fixture.source, entities, { sliderGroups: groups });
    assert.equal((preview.source.match(/data-tinymods-slider-slide=/g) ?? []).length, 2);
    assert.ok(preview.source.includes(`data-tinymods-slider-track="${group.id}"`));
    assert.ok(!applySourcePatches(fixture.source, []).includes("data-tinymods-slider"));
  }
});

test("raw scripts and ordinary repeated content do not create slider structures", () => {
  const source = `<script>const html = '<div class="carousel"><div class="slide"><p>A</p></div><div class="slide"><p>B</p></div></div>';</script><section class="cards"><article class="card card--a"><p>A</p></article><article class="card card--b"><p>B</p></article></section>`;
  assert.deepEqual(sliderGroups(source), []);
});

test("detects standard Swiper slide groups conservatively", () => {
  const source = `<div class="swiper">
  <div class="swiper-wrapper">
    <article class="swiper-slide"><h2>Первый</h2><img src="/one.webp" alt="Первый дом"></article>
    <article class="swiper-slide"><h2>Второй</h2><img src="/two.webp" alt="Второй дом"></article>
    <article class="swiper-slide"><h2>Третий</h2><img src="/three.webp" alt="Третий дом"></article>
  </div>
</div>`;
  const groups = sliderGroups(source);

  assert.equal(groups.length, 1);
  assert.equal(groups[0].pattern, "Swiper");
  assert.equal(groups[0].slides.length, 3);
  assert.deepEqual(groups[0].slides.map((slide) => slide.index), [0, 1, 2]);
  assert.ok(groups[0].slides.every((slide) => slide.entityIds.length >= 3));
});

test("detects custom slider track only with strong slider signals", () => {
  const source = `<section class="hero-slider">
  <div class="slider-track">
    <div class="slide"><h3>One</h3></div>
    <div class="slide"><h3>Two</h3></div>
  </div>
</section>`;
  const groups = sliderGroups(source);

  assert.equal(groups.length, 1);
  assert.equal(groups[0].pattern, "Slider");
  assert.deepEqual(
    groups[0].slides.map((slide) => slide.entityIds.length),
    [1, 1],
  );
});

test("does not treat ordinary cards, services, reviews, or articles as sliders", () => {
  const fixtures = [
    `<section class="cards"><article class="card"><h3>A</h3></article><article class="card"><h3>B</h3></article></section>`,
    `<div class="services-grid"><div class="service-item"><h3>A</h3></div><div class="service-item"><h3>B</h3></div></div>`,
    `<section class="reviews"><article class="review"><p>A</p></article><article class="review"><p>B</p></article></section>`,
    `<main><article><h2>A</h2></article><article><h2>B</h2></article></main>`,
  ];

  for (const source of fixtures) {
    assert.deepEqual(sliderGroups(source), []);
  }
});

test("keeps multiple sliders independent", () => {
  const source = `<div class="swiper"><div class="swiper-wrapper">
  <div class="swiper-slide"><p>A1</p></div>
  <div class="swiper-slide"><p>A2</p></div>
</div></div>
<div class="carousel"><div class="carousel-track">
  <div class="carousel-item"><p>B1</p></div>
  <div class="carousel-item"><p>B2</p></div>
</div></div>`;
  const groups = sliderGroups(source);

  assert.equal(groups.length, 2);
  assert.notEqual(groups[0].id, groups[1].id);
  assert.deepEqual(groups.map((group) => group.slides.length), [2, 2]);
});

test("detects photo-only carousel slides without requiring text entities", () => {
  const source = `<div class="swiper"><div class="swiper-wrapper">
  <figure class="swiper-slide"><picture><source srcset="/one.avif" type="image/avif"><img src="/one.webp" alt=""></picture></figure>
  <figure class="swiper-slide"><picture><source srcset="/two.avif" type="image/avif"><img src="/two.webp" alt=""></picture></figure>
  <figure class="swiper-slide"><picture><source srcset="/three.avif" type="image/avif"><img src="/three.webp" alt=""></picture></figure>
</div></div>`;
  const groups = sliderGroups(source);

  assert.equal(groups.length, 1);
  assert.equal(groups[0].slides.length, 3);
  assert.ok(groups[0].slides.every((slide) => slide.entityIds.length >= 2));
});

test("detects stacked data-slide hero and keeps source navigation protected", () => {
  const source = `<section class="hero">
  <style>
    .hero__slides, .hero-slide { position: absolute; inset: 0; }
    .hero-slide { visibility: hidden; opacity: 0; pointer-events: none; }
    .hero-slide.is-active { visibility: visible; opacity: 1; pointer-events: auto; }
    .hero-slide.is-active .hero-slide__content-inner { opacity: 1; }
  </style>
  <div class="hero__slides">
    <article class="hero-slide is-active" data-slide="0">
      <div class="hero-slide__content-inner">
        <h1>Arrive at 10</h1>
        <p>First description</p>
        <a class="hero-cta" href="/first">Book first</a>
      </div>
      <img src="/first.webp" alt="First image">
    </article>
    <article class="hero-slide" data-slide="1">
      <div class="hero-slide__content-inner">
        <h1>Six for two</h1>
        <p>Second description</p>
        <a class="hero-cta" href="/second">Book second</a>
      </div>
      <img src="/second.webp" alt="Second image">
    </article>
    <article class="hero-slide" data-slide="2">
      <div class="hero-slide__content-inner">
        <h1>Child free</h1>
        <p>Third description</p>
        <a class="hero-cta" href="/third">Book third</a>
      </div>
      <img src="/third.webp" alt="Third image">
    </article>
  </div>
  <nav class="hero-controls" aria-label="Hero slide navigation">
    <button class="hero-arrow" data-go-to="0">Prev</button>
    <button class="hero-number" data-go-to="0">01</button>
    <button class="hero-number" data-go-to="1">02</button>
    <button class="hero-number" data-go-to="2">03</button>
    <button class="hero-arrow" data-go-to="1">Next</button>
  </nav>
</section>`;
  const entities = extractEditableEntities(source);
  const groups = detectSliderGroups(source, entities);
  const group = groups[0];

  assert.equal(groups.length, 1);
  assert.equal(group.slides.length, 3);
  assert.deepEqual(group.slides.map((slide) => slide.index), [0, 1, 2]);

  const entityById = new Map(entities.map((entity) => [entity.id, entity]));
  const slideValues = group.slideEntityIds.map((entityId) => entityById.get(entityId)?.displayValue);
  const controlValues = group.controlEntityIds.map((entityId) => entityById.get(entityId)?.displayValue);

  assert.ok(slideValues.includes("Arrive at 10"));
  assert.ok(slideValues.includes("Six for two"));
  assert.ok(slideValues.includes("Child free"));
  assert.ok(slideValues.includes("/second"));
  assert.ok(controlValues.includes("01"));
  assert.ok(controlValues.includes("02"));
  assert.ok(controlValues.includes("03"));
  assert.ok(!group.slideEntityIds.some((entityId) => group.controlEntityIds.includes(entityId)));

  const protectedIds = new Set([...group.slideEntityIds, ...group.controlEntityIds]);
  const ordinaryGroups = buildContentGroups(
    source,
    entities.filter((entity) => !protectedIds.has(entity.id) && entity.kind !== "src" && entity.kind !== "alt"),
  );
  assert.equal(
    ordinaryGroups.some((contentGroup) =>
      contentGroup.entities.some((entity) => ["01", "02", "03", "Prev", "Next"].includes(entity.displayValue)),
    ),
    false,
  );

  const secondSlideEntities = group.slides[1].entityIds
    .map((entityId) => entityById.get(entityId))
    .filter(Boolean);
  const secondSlideGroups = buildContentGroups(
    source,
    secondSlideEntities.filter((entity) => entity.kind !== "src" && entity.kind !== "alt"),
  );
  assert.deepEqual(
    secondSlideGroups.flatMap((contentGroup) => contentGroup.entities.map((entity) => entity.displayValue)),
    ["Six for two", "Second description", "/second", "Book second"],
  );
});

test("slider grouping and preview controls do not mutate final source", () => {
  const source = `<div class="swiper"><div class="swiper-wrapper">
  <div class="swiper-slide"><p>Old</p></div>
  <div class="swiper-slide"><p>Next</p></div>
</div></div>`;
  const entities = extractEditableEntities(source);
  const groups = detectSliderGroups(source, entities);
  const text = entities.find((entity) => entity.rawValue === "Old");
  assert.ok(text);

  const preview = buildPreviewSource(source, entities);
  const patched = applySourcePatches(source, [
    createEditableEntityPatch(text, "New"),
  ]);

  assert.equal(groups.length, 1);
  assert.equal(patched, source.replace("Old", "New"));
  assert.ok(!patched.includes("tinymods-preview-slider"));
  assert.ok(!patched.includes("tinymods-preview-slider-controls"));
  assert.ok(!preview.source.includes("tinymods-preview-slider-controls"));
});

test("explicit navigation inside slides stays separate while ordinary CTA text and href stay editable", () => {
  const source = '<section class="carousel"><div class="carousel-track"><article class="card"><h2>First</h2><a class="next-offer" href="/offer">Next offer</a><button data-go-to="1">Next</button></article><article class="card"><h2>Second</h2><button data-go-to="0">Prev</button></article></div></section>';
  const entities = extractEditableEntities(source);
  const before = structuredClone(entities);
  const [group] = detectSliderGroups(source, entities);
  const values = ids => ids.map(id => entities.find(entity => entity.id === id).displayValue);
  assert.deepEqual(values(group.controlEntityIds), ["Next", "Prev"]);
  assert.deepEqual(values(group.slideEntityIds), ["First", "/offer", "Next offer", "Second"]);
  assert.ok(group.slides.every(slide => slide.entityIds.every(id => !group.controlEntityIds.includes(id))));
  assert.deepEqual(entities, before);
  const excluded = new Set([...group.slideEntityIds, ...group.controlEntityIds]);
  assert.deepEqual(buildContentGroups(source, entities.filter(entity => !excluded.has(entity.id))), []);
});

test("live preview enables user scripts only inside an opaque-origin iframe", () => {
  assert.ok(PREVIEW_SLIDER_NAVIGATION_SOURCE.includes("installPreviewSliderNavigation"));
  assert.ok(PREVIEW_SLIDER_NAVIGATION_SOURCE.includes("Предыдущий слайд"));
  assert.ok(PREVIEW_SLIDER_NAVIGATION_SOURCE.includes("Следующий слайд"));
  assert.ok(PREVIEW_SLIDER_NAVIGATION_SOURCE.includes("scrollTo"));
  assert.ok(PREVIEW_SLIDER_NAVIGATION_SOURCE.includes('setProperty("translate"'));
  assert.ok(HTML_CONTENT_EDITOR_COMPONENT_SOURCE.includes('sandbox="allow-scripts"'));
  assert.ok(!HTML_CONTENT_EDITOR_COMPONENT_SOURCE.includes("allow-same-origin"));
});

// A small deterministic DOM adapter exercises the real controller; browser acceptance covers CSS layout.
function runtimeFixture({ sameTrack = false, stacked = false, overflow = "auto", total = 7, initialScroll = 0 } = {}) {
  const layout = { width: 650, card: 200, gap: 20 };
  const observers = new Set();
  const win = new EventTarget();
  win.scrollX = win.scrollY = 0;
  win.innerWidth = 1200;
  win.innerHeight = 800;
  win.ResizeObserver = class {
    constructor(callback) { this.callback = callback; observers.add(this); }
    observe() {}
    disconnect() { observers.delete(this); }
  };
  const doc = { defaultView: win };
  class Element extends EventTarget {
    constructor(tagName = "div") {
      super(); this.tagName = tagName.toUpperCase(); this.attributes = new Map();
      this.children = []; this.parentElement = null; this.ownerDocument = doc;
      this.scrollLeft = 0; this.scrollCalls = 0; this.clientLeft = 0;
      this.offsetWidth = 230; this.offsetHeight = 58;
      this.style = {
        getPropertyValue: name => this.declarations().get(name)?.[0] ?? "",
        setProperty: (name, value, priority = "") => {
          const props = this.declarations(); props.set(name, [value, priority]);
          this.setAttribute("style", [...props].map(([key, [v, p]]) => key + ":" + v + (p ? " !" + p : "")).join(";"));
        },
      };
      const classes = () => (this.getAttribute("class") ?? "").split(/\s+/).filter(Boolean);
      this.classList = {
        [Symbol.iterator]: () => classes()[Symbol.iterator](),
        contains: name => classes().includes(name),
        add: name => this.classList.toggle(name, true),
        toggle: (name, active) => {
          const values = new Set(classes()); if (active) values.add(name); else values.delete(name);
          this.setAttribute("class", [...values].join(" "));
        },
      };
    }
    declarations() { return new Map((this.getAttribute("style") ?? "").split(";").filter(Boolean).map(part => {
      const colon = part.indexOf(":"); const value = part.slice(colon + 1).split(" !"); return [part.slice(0, colon), value];
    })); }
    get className() { return this.getAttribute("class") ?? ""; }
    set className(value) { this.setAttribute("class", value); }
    setAttribute(name, value) { this.attributes.set(name, String(value)); }
    getAttribute(name) { return this.attributes.get(name) ?? null; }
    removeAttribute(name) { this.attributes.delete(name); }
    append(...children) { for (const child of children) { child.parentElement = this; this.children.push(child); } }
    contains(child) { return child === this || this.children.some(node => node.contains(child)); }
    remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(child => child !== this); }
    querySelectorAll(selector) {
      const descendants = this.children.flatMap(child => [child, ...child.querySelectorAll("*")]);
      if (selector === "*") return descendants;
      const match = selector.match(/^\[([^=\]]+)(?:="([^"]*)")?\]$/);
      return descendants.filter(child => match && child.getAttribute(match[1]) !== null && (match[2] === undefined || child.getAttribute(match[1]) === match[2]));
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
    getBoundingClientRect() {
      if (this.className === "tinymods-preview-slider-controls") {
        const scale = Number(this.style.transform?.match(/scale\(([^)]+)\)/)?.[1] ?? 1);
        const left = parseFloat(this.style.left) || 0, top = parseFloat(this.style.top) || 0;
        const width = this.offsetWidth * scale, height = this.offsetHeight * scale;
        return { left, top, width, height, right: left + width, bottom: top + height };
      }
      return { left: 0, top: 0, width: layout.width, height: 300, right: layout.width, bottom: 300 };
    }
    scrollTo({ left }) { this.scrollCalls++; this.scrollLeft = left; this.dispatchEvent(new Event("scroll")); }
    click() { if (!this.disabled) this.dispatchEvent(new Event("click")); }
  }
  doc.head = new Element("head"); doc.body = new Element("body");
  doc.createElement = name => new Element(name);
  doc.querySelector = selector => doc.body.querySelector(selector);
  doc.getElementById = id => [...doc.head.querySelectorAll("*"), ...doc.body.querySelectorAll("*")].find(e => e.id === id) ?? null;
  const root = new Element("section"), viewport = new Element(), track = sameTrack ? viewport : new Element();
  root.setAttribute("data-tinymods-slider-root", "test");
  viewport.setAttribute("data-tinymods-slider-viewport", "test");
  track.setAttribute("data-tinymods-slider-track", "test");
  doc.body.append(root); root.append(viewport); if (!sameTrack) viewport.append(track);
  const slides = Array.from({ length: total }, (_, i) => {
    const slide = new Element("article");
    slide.className = "card card--" + i + (stacked && i === 0 ? " is-active" : "");
    slide.setAttribute("data-tinymods-slider-slide", "s" + i);
    slide.setAttribute("aria-hidden", stacked && i ? "true" : "false");
    slide.setAttribute("style", "transform:scale(1) !important;transition:opacity 1s;translate:0px 0");
    const text = new Element("h2"); text.setAttribute("data-tinymods-preview-ids", "content" + i); slide.append(text);
    slide.getBoundingClientRect = () => {
      const left = stacked ? 0 : i * (layout.card + layout.gap) - viewport.scrollLeft + (parseFloat(slide.style.getPropertyValue("translate")) || 0);
      return { left, right: left + layout.card, top: 0, width: layout.card, height: 300 };
    };
    track.append(slide); return slide;
  });
  const contentWidth = () => total * (layout.card + layout.gap) - layout.gap;
  Object.defineProperties(viewport, { clientWidth: { get: () => layout.width }, scrollWidth: { get: contentWidth } });
  if (!sameTrack) Object.defineProperties(track, { clientWidth: { get: contentWidth }, scrollWidth: { get: contentWidth } });
  viewport.scrollLeft = initialScroll;
  win.getComputedStyle = element => {
    const slide = slides.find(s => s === element || s.contains(element));
    const active = !stacked || !slide || slide.classList.contains("is-active");
    const style = {
      display: "block", overflowX: element === viewport ? overflow : "visible",
      opacity: active ? "1" : "0", visibility: active ? "visible" : "hidden",
    };
    for (const [name, [value]] of element.declarations()) style[name] = value;
    return style;
  };
  const original = [root, viewport, track, ...slides.flatMap(slide => [slide, ...slide.children])].map(e => [e, [...e.attributes]]);
  const group = { id: "test", slides: slides.map((_, i) => ({ id: "s" + i })) };
  const changes = [];
  const controller = installPreviewSliderNavigation(doc, [group], { onSlideChange: (id, index) => changes.push([id, index]) });
  const controls = doc.body.children.find(e => e.className === "tinymods-preview-slider-controls");
  return {
    doc, layout, viewport, track, slides, controls, controller, changes, original, observers,
    prev: controls.children[0], counter: controls.children[1], next: controls.children[2],
    resize: () => win.dispatchEvent(new Event("resize")),
    observeResize: () => [...observers].forEach(observer => observer.callback()),
  };
}

test("scroll runtime resolves true viewport for shared and separate tracks and counts full cards", () => {
  for (const sameTrack of [true, false]) {
    const f = runtimeFixture({ sameTrack, total: 10, initialScroll: 33 });
    assert.equal(f.controls.getAttribute("data-mode"), "scroll-viewport");
    assert.equal(f.controls.getAttribute("data-visible-count"), "3");
    assert.equal(f.counter.textContent, "Слайд 1 из 10");
    f.layout.width = 600; f.resize();
    assert.equal(f.controls.getAttribute("data-visible-count"), "2"); // Third card is only partial.
    f.next.click();
    assert.equal(f.viewport.scrollLeft, 220);
    assert.equal(f.counter.textContent, "Слайд 2 из 10");
    if (!sameTrack) assert.equal(f.track.scrollCalls, 0);
    assert.ok(f.slides.every(slide => slide.style.getPropertyValue("translate") === "0px 0"));
    f.prev.click(); assert.equal(f.viewport.scrollLeft, 0);
    f.controller.cleanup();
    assert.equal(f.viewport.scrollLeft, 33);
    for (const [element, attributes] of f.original) assert.deepEqual([...element.attributes].sort(), attributes.sort());
    assert.equal(f.doc.getElementById("tinymods-preview-slider-navigation-style"), null);
  }
});

test("nested runtime activates ancestors, measures revealed children and preserves independent state and cleanup", () => {
  for (const mobile of [false, true]) {
    const f = runtimeFixture({ stacked: true, total: 3 });
    f.controller.cleanup();
    const parent = { id: "test", slides: f.slides.map((_, index) => ({ id: "s" + index, index, label: "Object " + (index + 1) })) };
    const children = f.slides.map((parentSlide, i) => {
      const root = f.doc.createElement("div");
      const id = "gallery" + i;
      root.setAttribute("data-tinymods-slider-root", id);
      root.setAttribute("data-tinymods-slider-track", id);
      parentSlide.append(root);
      const owners = Array.from({ length: 4 }, (_, j) => {
        const img = f.doc.createElement("img");
        img.className = "photo" + (j === 0 ? " is-active" : "");
        img.setAttribute("data-tinymods-slider-slide", id + "-" + j);
        img.setAttribute("data-tinymods-preview-ids", id + "-entity-" + j);
        img.getBoundingClientRect = () => {
          const hidden = mobile && !parentSlide.classList.contains("is-active");
          const active = img.classList.contains("is-active");
          const width = hidden ? 0 : active ? 400 : 406;
          const left = active ? 0 : -3;
          return { left, top: 0, right: left + width, bottom: hidden ? 0 : 300, width, height: hidden ? 0 : 300 };
        };
        root.append(img);
        return img;
      });
      return { root, owners, model: { id, parentSliderId: "test", parentSlideId: "s" + i, mediaOnly: true,
        slides: owners.map((_, j) => ({ id: id + "-" + j, index: j })) } };
    });
    const originalStyle = f.doc.defaultView.getComputedStyle;
    f.doc.defaultView.getComputedStyle = element => {
      const ownStyle = originalStyle(element);
      if (f.slides.includes(element) && mobile) ownStyle.display = element.classList.contains("is-active") ? "grid" : "none";
      if (children.some(child => child.owners.includes(element))) {
        ownStyle.position = "absolute";
        ownStyle.opacity = element.classList.contains("is-active") ? "1" : "0";
        ownStyle.visibility = "visible";
      }
      for (const [name, [value]] of element.declarations()) ownStyle[name] = value;
      return ownStyle;
    };
    const before = f.doc.body.querySelectorAll("*").map(element => [element, [...element.attributes]]);
    const controller = installPreviewSliderNavigation(f.doc, [parent, ...children.map(c => c.model)]);
    const panels = () => f.doc.body.children.filter(e => e.className === "tinymods-preview-slider-controls");
    const activePhotos = () => children.map(child => child.owners.findIndex(e => e.classList.contains("is-active")));
    assert.deepEqual(panels().map(p => p.hidden), [false, false, true, true]);
    for (const scale of [1, 0.68, 0.61, 0.22]) {
      controller.setPreviewScale(scale);
      const [outerPanel, childPanel] = panels().filter(p => !p.hidden).map(p => p.getBoundingClientRect());
      assert.ok(childPanel.top >= outerPanel.bottom, "nested controls remain separate at reduced scale");
    }
    controller.goToSlide("gallery2", 2);
    assert.equal(f.slides[2].classList.contains("is-active"), true);
    assert.deepEqual(activePhotos(), [0, 0, 2]);
    assert.deepEqual(panels().map(p => p.hidden), [false, true, true, false]);
    assert.equal(panels()[3].getAttribute("data-mode"), "stacked-single");
    assert.equal(panels()[3].children[1].textContent, "Фото 3 из 4");
    if (mobile) assert.equal(f.doc.defaultView.getComputedStyle(f.slides[2]).display, "grid");
    controller.goToSlide("gallery0", 1);
    controller.goToSlide("gallery1", 3);
    assert.deepEqual(activePhotos(), [1, 3, 2]);
    controller.goToSlide("test", 2);
    assert.deepEqual(activePhotos(), [1, 3, 2]);
    const mappedText = f.slides[2].children[0];
    mappedText.classList.add("tinymods-preview-active");
    f.resize();
    assert.equal(mappedText.classList.contains("tinymods-preview-active"), true);
    mappedText.classList.toggle("tinymods-preview-active", false);
    // Remove the test-only empty class attribute before checking byte-for-byte cleanup.
    mappedText.removeAttribute("class");
    assert.equal(panels()[3].getAttribute("data-mode"), "stacked-single");
    assert.deepEqual(activePhotos(), [1, 3, 2]);
    panels()[3].children[0].click();
    assert.deepEqual(activePhotos(), [1, 3, 1]);
    controller.cleanup();
    for (const [element, attrs] of before) assert.deepEqual([...element.attributes].sort(), attrs.sort());
    assert.equal(panels().length, 0);
    assert.equal(f.observers.size, 0);
  }
});

test("Content renderer keeps hierarchy, cross-realm event targets and column-scoped click scrolling", () => {
  assert.ok(HTML_CONTENT_EDITOR_COMPONENT_SOURCE.includes("sliderActivationPath(sliderGroups"));
  assert.ok(HTML_CONTENT_EDITOR_COMPONENT_SOURCE.includes("child.parentSlideId === slide.id"));
  assert.ok(HTML_CONTENT_EDITOR_COMPONENT_SOURCE.includes("filter(group => !group.parentSliderId)"));
  assert.ok(!HTML_CONTENT_EDITOR_COMPONENT_SOURCE.includes("target instanceof Element"));
  assert.ok(HTML_CONTENT_EDITOR_COMPONENT_SOURCE.includes("validatePreviewMessage(event,"));
  assert.ok(HTML_CONTENT_EDITOR_COMPONENT_SOURCE.includes("data-content-scroll"));
  assert.ok(HTML_CONTENT_EDITOR_COMPONENT_SOURCE.includes("parent.scrollTo({ top:"));
});

test("scroll observation updates counter without initiating movement or callback reentry", () => {
  const f = runtimeFixture();
  const calls = f.viewport.scrollCalls;
  f.viewport.scrollLeft = 235;
  for (let i = 0; i < 10; i++) f.viewport.dispatchEvent(new Event("scroll"));
  assert.equal(f.counter.textContent, "Слайд 2 из 7");
  assert.equal(f.viewport.scrollCalls, calls);
  assert.equal(f.changes.length, 0);
  assert.equal(f.controls.getAttribute("data-visible-count"), "3");
  f.controller.cleanup();
});

test("resize remeasures positions, clamps logical index, and cleanup removes observers", () => {
  const f = runtimeFixture();
  f.controller.goToSlide("test", 6);
  assert.equal(f.counter.textContent, "Слайд 5 из 7");
  f.layout.width = 1050; f.layout.card = 180; f.observeResize();
  assert.equal(f.controls.getAttribute("data-visible-count"), "5");
  assert.equal(f.counter.textContent, "Слайд 3 из 7");
  assert.equal(f.viewport.scrollLeft, 330);
  assert.equal(f.next.disabled, true);
  f.prev.click(); assert.equal(f.viewport.scrollLeft, 200);
  f.controller.cleanup();
  const calls = f.viewport.scrollCalls;
  f.resize(); f.observeResize(); f.controller.goToSlide("test", 1);
  assert.equal(f.viewport.scrollCalls, calls);
  assert.equal(f.observers.size, 0);
});

test("stacked runtime transfers active classes and coordinates narrowly with visibility recovery", () => {
  const f = runtimeFixture({ stacked: true, total: 3 });
  assert.equal(f.controls.getAttribute("data-mode"), "stacked-single");
  const texts = f.slides.map(slide => slide.children[0]);
  ensureEditableContentVisible(f.doc, texts);
  assert.ok(f.slides.every(slide => !slide.classList.contains("tinymods-preview-content-visible")));
  f.next.click();
  assert.equal(f.counter.textContent, "Слайд 2 из 3");
  assert.deepEqual(f.slides.map(slide => slide.classList.contains("is-active")), [false, true, false]);
  assert.deepEqual(f.slides.map(slide => slide.style.getPropertyValue("opacity")), ["0", "1", "0"]);
  assert.equal(f.doc.defaultView.getComputedStyle(texts[1]).opacity, "1");
  f.next.click(); assert.equal(f.counter.textContent, "Слайд 3 из 3"); assert.equal(f.next.disabled, true);
  f.prev.click(); assert.equal(f.counter.textContent, "Слайд 2 из 3");
  assert.equal(f.viewport.scrollCalls, 0);
  f.controller.cleanup();
  for (const [element, attributes] of f.original) assert.deepEqual([...element.attributes].sort(), attributes.sort());
});

test("offset is confined to a clipped horizontal layout and restores original transforms", () => {
  const f = runtimeFixture({ overflow: "hidden" });
  assert.equal(f.controls.getAttribute("data-mode"), "offset");
  f.next.click();
  assert.equal(f.slides[0].style.getPropertyValue("translate"), "-220px 0");
  assert.equal(f.viewport.scrollCalls, 0);
  f.resize(); assert.equal(f.slides[0].style.getPropertyValue("translate"), "-220px 0");
  f.controller.cleanup();
  for (const [element, attributes] of f.original) assert.deepEqual([...element.attributes].sort(), attributes.sort());
  const unsupported = runtimeFixture({ overflow: "visible" });
  assert.equal(unsupported.controls.hidden, true);
  unsupported.controller.goToSlide("test", 1);
  assert.equal(unsupported.viewport.scrollCalls, 0);
  assert.ok(unsupported.slides.every(slide => slide.style.getPropertyValue("translate") === "0px 0"));
  unsupported.controller.cleanup();
});

for (const cssAvailable of [true, false]) test(`Swiper owns active state with CSS ${cssAvailable ? "available" : "unavailable"}`, () => {
  const f = runtimeFixture({ overflow: "hidden", total: 4 });
  f.controller.cleanup();
  const root = f.viewport.parentElement;
  root.className = "swiper-container";
  f.track.className = "swiper-wrapper";
  f.viewport.clientHeight = 720;
  let externalCss = cssAvailable;
  const rect = (left, width, height) => ({ left, top: 0, right: left + width, bottom: height, width, height });
  f.track.getBoundingClientRect = () => rect(0, f.layout.width,
    externalCss ? 720 : parseFloat(f.track.style.getPropertyValue("height")) || 0);
  f.slides.forEach((slide, i) => {
    slide.className = "swiper-slide";
    slide.getBoundingClientRect = () => {
      const valid = externalCss || (f.track.style.getPropertyValue("display") === "flex" && slide.style.getPropertyValue("height") === "100%");
      const left = (valid ? i * f.layout.width : 0) + (parseFloat(slide.style.getPropertyValue("translate")) || 0);
      return rect(left, f.layout.width, valid ? f.viewport.clientHeight : 0);
    };
  });
  const computed = f.doc.defaultView.getComputedStyle;
  f.doc.defaultView.getComputedStyle = element => {
    const result = computed(element);
    const slide = f.slides.find(slide => slide.contains(element));
    if (slide && slide !== element) result.opacity = slide.classList.contains("swiper-slide-active") ? "1" : "0";
    for (const [name, [value]] of element.declarations()) result[name] = value;
    return result;
  };
  const before = f.doc.body.querySelectorAll("*").map(element => [element, [...element.attributes]]);
  const group = { id: "test", slides: f.slides.map((_, i) => ({ id: "s" + i })) };
  const controller = installPreviewSliderNavigation(f.doc, [group]);
  const controls = f.doc.body.children.find(e => e.className === "tinymods-preview-slider-controls");
  const assertActive = index => {
    assert.equal(controls.hidden, false);
    assert.equal(controls.getAttribute("data-mode"), "offset");
    assert.equal(controls.children[1].textContent, `Слайд ${index + 1} из 4`);
    assert.equal(f.slides.length, 4);
    f.slides.forEach((slide, i) => {
      assert.equal(slide.classList.contains("swiper-slide-active"), i === index);
      assert.equal(slide.style.getPropertyValue("opacity"), i === index ? "1" : "0");
      assert.equal(slide.getAttribute("data-tinymods-slider-state"), i === index ? "active" : "inactive");
      assert.ok(slide.getBoundingClientRect().height > 0);
      assert.equal(slide.getAttribute("data-swiper-slide-index"), null);
    });
    assert.equal(f.slides[index].getBoundingClientRect().left, 0);
    assert.equal(f.doc.defaultView.getComputedStyle(f.slides[index].children[0]).opacity, "1");
    if (externalCss) assert.equal(f.track.getAttribute("style"), null, "working geometry stays source-owned");
  };
  assertActive(0);
  ensureEditableContentVisible(f.doc, f.slides.map(slide => slide.children[0]));
  assert.ok(f.slides.every(slide => !slide.children[0].classList.contains("tinymods-preview-content-visible")));
  for (let i = 1; i < 4; i++) { controls.children[2].click(); assertActive(i); }
  assert.equal(controls.children[2].disabled, true);
  controls.children[0].click(); assertActive(2);
  f.layout.width = 390; f.viewport.clientHeight = 844; f.resize(); assertActive(2);
  externalCss = !externalCss; f.observeResize(); assertActive(2);
  controller.goToSlide("test", 0); assertActive(0);
  assert.equal(controls.children[0].disabled, true);
  controller.cleanup();
  for (const [element, attributes] of before) assert.deepEqual([...element.attributes].sort(), attributes.sort());
  assert.equal(f.observers.size, 0);
});

test("slider UI does not expose structural slide editing controls", () => {
  assert.ok(!HTML_CONTENT_EDITOR_COMPONENT_SOURCE.includes("Добавить слайд"));
  assert.ok(!HTML_CONTENT_EDITOR_COMPONENT_SOURCE.includes("Удалить слайд"));
  assert.ok(!HTML_CONTENT_EDITOR_COMPONENT_SOURCE.includes("Клонировать слайд"));
  assert.ok(!HTML_CONTENT_EDITOR_COMPONENT_SOURCE.includes("Reorder"));
});

test("control scale updates preserve slide state and keep readable labels and tooltip names", () => {
  const f = runtimeFixture({ stacked: true, total: 3 });
  f.next.click();
  const slidesBefore = f.slides.map(slide => [...slide.attributes]);
  const calls = f.viewport.scrollCalls;
  const changes = f.changes.length;
  for (const scale of [1, 0.68, 0.61]) {
    f.controller.setPreviewScale(scale);
    assert.equal(f.controls.style.transform, `scale(${1 / scale})`);
    assert.equal(f.counter.textContent, "Слайд 2 из 3");
    assert.equal(f.prev.getAttribute("title"), "Предыдущий слайд");
    assert.equal(f.next.getAttribute("title"), "Следующий слайд");
    assert.equal(f.prev.getAttribute("aria-label"), f.prev.getAttribute("title"));
    assert.equal(f.next.getAttribute("aria-label"), f.next.getAttribute("title"));
    assert.ok(parseFloat(f.controls.style.left) * scale >= 12);
    assert.ok(parseFloat(f.controls.style.top) * scale >= 12);
    assert.ok((parseFloat(f.controls.style.left) + f.controls.offsetWidth / scale) * scale <= f.doc.defaultView.innerWidth * scale - 12);
    assert.deepEqual(f.slides.map(slide => [...slide.attributes]), slidesBefore);
    assert.equal(f.viewport.scrollCalls, calls);
    assert.equal(f.changes.length, changes);
  }
  f.next.click(); assert.equal(f.counter.textContent, "Слайд 3 из 3");
  assert.equal(f.next.disabled, true);
  f.prev.click(); f.prev.click(); assert.equal(f.prev.disabled, true);
  f.controller.setPreviewScale(0);
  assert.equal(f.controls.style.transform, "scale(1)");
  f.controller.cleanup();
  const style = f.controls.style.transform;
  f.controller.setPreviewScale(0.61);
  assert.equal(f.controls.style.transform, style);
});
