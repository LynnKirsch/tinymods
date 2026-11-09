import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { detectAccordionGroups } from "../app/lib/html-content-editor/accordion-groups.ts";
import {
  buildAccordionContentItems,
  buildContentGroups,
} from "../app/lib/html-content-editor/content-groups.ts";
import { createEditableEntityPatch, createEditableEntityPatches } from "../app/lib/html-content-editor/encode-source-value.ts";
import { extractEditableEntities } from "../app/lib/html-content-editor/extract-editable-entities.ts";
import {
  groupImageEntities,
  isImageEntity,
  isImageGroupEntity,
} from "../app/lib/html-content-editor/image-groups.ts";
import {
  byteSizeFromDataUrl,
  formatByteSize,
  imageFormatFromSource,
  imageMetadataLine,
} from "../app/lib/html-content-editor/image-metadata.ts";
import { validateRequiredImageValues } from "../app/lib/html-content-editor/image-validation.ts";
import { applySourcePatches } from "../app/lib/html-content-editor/patch-source.ts";
import { detectRepeatingGroups } from "../app/lib/html-content-editor/repeating-structures.ts";

const component = readFileSync(
  new URL("../app/components/html-content-editor/HtmlContentEditor.tsx", import.meta.url),
  "utf8",
);

function requireEntity(entities, predicate) {
  const entity = entities.find(predicate);
  assert.ok(entity, "expected editable entity to exist");
  return entity;
}

function imageEntities(source) {
  return extractEditableEntities(source).filter(isImageEntity);
}

function validateClearedImageValues(source, rawValuesToClear) {
  const cleared = new Set(rawValuesToClear);
  const entities = imageEntities(source);
  const values = Object.fromEntries(
    entities
      .filter((entity) => cleared.has(entity.rawValue))
      .map((entity) => [entity.id, "   "]),
  );

  return validateRequiredImageValues(entities, values);
}

function display(entity) {
  return entity.displayValue.replace(/\s+/g, " ").trim();
}

function customAccordionSource() {
  return `<section class="faq"><div>
    <article><button aria-expanded="true" aria-controls="a1"><span>Q1</span></button><div id="a1"><p>A1</p></div></article>
    <article><button aria-expanded="false" aria-controls="a2"><span>Q2</span></button><div id="a2">
      <p>A2 paragraph 1</p><p>A2 paragraph 2 <a href="/more">A2 link</a></p>
      <img src="/answer.webp" alt="Answer image">
    </div></article>
    <article><button aria-expanded="false" aria-controls="a3"><span>Q3</span></button><div id="a3"><ul><li>A3 item 1</li><li>A3 item 2</li></ul></div></article>
  </div></section>`;
}

function assertSingleUiOwnership(source, entities, items) {
  const owned = new Set(items.flatMap(item => item.ownedEntityIds));
  const remaining = entities.filter(entity => !owned.has(entity.id));
  const repeats = detectRepeatingGroups(source, remaining);
  const repeatIds = new Set(repeats.flatMap(group => group.items.flatMap(item => item.entityIds)));
  const generic = buildContentGroups(
    source,
    remaining.filter(entity => !isImageGroupEntity(entity)),
    repeatIds,
  );
  const images = groupImageEntities(
    remaining.filter(entity => !repeatIds.has(entity.id) && isImageGroupEntity(entity)),
  );
  const globalIds = [
    ...generic.flatMap(group => group.entities.map(entity => entity.id)),
    ...repeats.flatMap(group => group.items.flatMap(item => item.entityIds)),
    ...images.flatMap(group => [
      ...group.items.map(item => item.entity.id),
      ...(group.altEntity ? [group.altEntity.id] : []),
    ]),
  ];
  assert.deepEqual(globalIds.filter(id => owned.has(id)), []);
  const allOwnerIds = [...items.flatMap(item => item.ownedEntityIds), ...globalIds];
  assert.equal(new Set(allOwnerIds).size, allOwnerIds.length, "each entity has one Content UI owner");
}

test("accordion content items keep question, mixed answer, links, media and lists together", () => {
  const source = customAccordionSource();
  const entities = extractEditableEntities(source);
  const accordionGroups = detectAccordionGroups(source, entities);
  const items = buildAccordionContentItems(source, entities, accordionGroups);

  assert.equal(items.length, 3);
  assert.deepEqual(items.map(item => item.kind), ["custom", "custom", "custom"]);
  assert.deepEqual(items.map(item => item.questionEntityIds.map(id => display(requireEntity(entities, entity => entity.id === id)))), [
    ["Q1"], ["Q2"], ["Q3"],
  ]);
  assert.deepEqual(items.map(item => item.answerEntityIds.map(id => display(requireEntity(entities, entity => entity.id === id)))), [
    ["A1"],
    ["A2 paragraph 1", "A2 paragraph 2", "/more", "A2 link", "/answer.webp", "Answer image"],
    ["A3 item 1", "A3 item 2"],
  ]);
  assert.equal(items[1].answerGroups.some(group => group.kind === "link" && group.hrefEntity.displayValue === "/more"), true);
  assert.equal(items[1].ownedEntityIds.includes(requireEntity(entities, entity => entity.displayValue === "/answer.webp").id), true);
  assert.deepEqual(items.map(item => item.sourceStart), [...items.map(item => item.sourceStart)].sort((a, b) => a - b));
  assertSingleUiOwnership(source, entities, items);
});

test("synthetic custom accordion paths A and B give one ordered Content item per question without duplicates", () => {
  const file = readFileSync(new URL("./fixtures/html-content-editor/accordion-layouts.html", import.meta.url), "utf8");
  const pathAStart = file.indexOf('<section class="il-faq"');
  const pathA = file.slice(pathAStart, file.indexOf("</script>", pathAStart) + 9);
  const pathBSection = file.indexOf("<section", file.indexOf(".hvk-guide"));
  const pathBStart = file.lastIndexOf("<style>", pathBSection);
  const pathB = file.slice(pathBStart, file.indexOf("</script>", pathBSection) + 9);

  for (const [source, expectedCount, expectedPath] of [[pathA, 10, "explicit"], [pathB, 21, "structural"]]) {
    const entities = extractEditableEntities(source);
    const groups = detectAccordionGroups(source, entities);
    const items = buildAccordionContentItems(source, entities, groups);
    assert.equal(groups[0].path, expectedPath);
    assert.equal(items.length, expectedCount);
    assert.ok(items.every(item => item.questionEntityIds.length > 0 && item.answerEntityIds.length > 0));
    assert.deepEqual(items.map(item => item.sourceStart), [...items.map(item => item.sourceStart)].sort((a, b) => a - b));
    assertSingleUiOwnership(source, entities, items);
  }
});

test("native details owns summary and answer content without entering custom accordion runtime", () => {
  const source = `<section><details open><summary>Question</summary><div>
    <p>Answer one</p><p>Answer two <a href="/details">Details link</a></p>
    <img src="/details.webp" alt="Details image">
  </div></details><p>Outside</p></section>`;
  const entities = extractEditableEntities(source);
  const accordionGroups = detectAccordionGroups(source, entities);
  const items = buildAccordionContentItems(source, entities, accordionGroups);

  assert.deepEqual(accordionGroups, []);
  assert.equal(items.length, 1);
  assert.equal(items[0].kind, "details");
  assert.deepEqual(items[0].questionEntityIds.map(id => display(requireEntity(entities, entity => entity.id === id))), ["Question"]);
  assert.deepEqual(items[0].answerEntityIds.map(id => display(requireEntity(entities, entity => entity.id === id))), [
    "Answer one", "Answer two", "/details", "Details link", "/details.webp", "Details image",
  ]);
  assert.equal(items[0].answerGroups.some(group => group.kind === "link"), true);
  assert.equal(items[0].ownedEntityIds.includes(requireEntity(entities, entity => entity.displayValue === "Outside").id), false);
  assertSingleUiOwnership(source, entities, items);
  assert.equal(source.includes("<details open>"), true);
});

test("HCE gives accordion items UI ownership while preserving exact entity mapping", () => {
  assert.ok(component.includes("buildAccordionContentItems("));
  assert.ok(component.includes("!accordionOwnedEntityIds.has(entity.id)"));
  assert.ok(component.includes("groupByEntityId.set(entityId, item.id)"));
  assert.ok(component.includes('details[data-accordion-content-item]'));
  assert.ok(component.includes("previewAccordionControllerRef.current?.openForEntity(entity.id)"));
});

test("groups composite H1 as one entity with separate segment ranges", () => {
  const source = `<h1 class="title">
  Отдых в Карелии
  за <span class="accent">8 800 ₽</span>
  в сутки
</h1>`;
  const entities = extractEditableEntities(source);
  const groups = buildContentGroups(source, entities);

  assert.equal(groups.length, 1);
  assert.equal(groups[0].kind, "text");
  assert.equal(groups[0].label, "Заголовок");
  assert.equal(groups[0].entities.length, 1);
  assert.deepEqual(
    groups[0].entities.map((entity) => source.slice(entity.range.start, entity.range.end)),
    entities.map((entity) => entity.rawValue),
  );

  const price = entities[0];
  const patched = applySourcePatches(source, createEditableEntityPatches(price, price.displayValue.replace("8 800 ₽", "9 900 ₽")));

  assert.equal(
    patched,
    `<h1 class="title">
  Отдых в Карелии
  за <span class="accent">9 900 ₽</span>
  в сутки
</h1>`,
  );
});

test("does not merge text from different parent blocks", () => {
  const source = `<h1>Заголовок</h1>
<p>Описание</p>`;
  const groups = buildContentGroups(source, extractEditableEntities(source));

  assert.deepEqual(
    groups.map((group) => ({ kind: group.kind, label: group.label, count: group.entities.length })),
    [
      { kind: "text", label: "Заголовок", count: 1 },
      { kind: "text", label: "Текст", count: 1 },
    ],
  );
});

test("groups adjacent phrase spans in text-like containers", () => {
  const source = `<div class="hv-contact-text"><span>ALL SERVICES</span><span>AND BOOKING</span></div>`;
  const groups = buildContentGroups(source, extractEditableEntities(source));

  assert.equal(groups.length, 1);
  assert.equal(groups[0].kind, "text");
  assert.deepEqual(
    groups[0].entities.map((entity) => entity.rawValue),
    ["ALL SERVICES", "AND BOOKING"],
  );
});

test("extracts numeric and symbol-only visible HTML text nodes", () => {
  const source = `<section>
  <div>10%</div>
  <div>8 800 ₽</div>
  <div>24/7</div>
  <div>2026</div>
</section>`;
  const entities = extractEditableEntities(source).filter((entity) => entity.kind === "text");

  assert.deepEqual(
    entities.map((entity) => entity.displayValue),
    ["10%", "8 800 ₽", "24/7", "2026"],
  );
});

test("keeps numeric and symbol content protected in style, script, and inline SVG", () => {
  const source = `<style>
.promo { width: 10%; }
</style>
<script>
const discount = 10;
</script>
<svg viewBox="0 0 24 24">
  <path d="M10 20L15 5" stroke="currentColor"></path>
  <text>24/7</text>
</svg>`;
  const entities = extractEditableEntities(source);

  assert.equal(entities.some((entity) => entity.kind === "text"), false);
  assert.equal(entities.some((entity) => entity.rawValue.includes("10")), false);
  assert.equal(entities.some((entity) => entity.rawValue.includes("24/7")), false);
});

test("keeps external SVG icons editable as regular image entities", () => {
  const source = `<img src="https://example.com/phone.svg" alt="">`;
  const groups = groupImageEntities(extractEditableEntities(source));

  assert.equal(groups.length, 1);
  assert.equal(groups[0].items[0].entity.kind, "src");
  assert.equal(groups[0].items[0].entity.rawValue, "https://example.com/phone.svg");
});

test("keeps independent card metadata spans separate", () => {
  const source = `<div class="card"><span class="price">$120</span><span class="date">Friday</span></div>`;
  const groups = buildContentGroups(source, extractEditableEntities(source));

  assert.equal(groups.length, 2);
  assert.deepEqual(
    groups.map((group) => group.entities.map((entity) => entity.rawValue)),
    [["$120"], ["Friday"]],
  );
});

test("groups static JavaScript template phrase spans while preserving source ranges", () => {
  const source = `<script>
const root = document.querySelector("#widget");
root.innerHTML = \`<div class="hv-contact-text"><span>ALL SERVICES</span><span>AND BOOKING</span></div>\`;
</script>`;
  const entities = extractEditableEntities(source);
  const groups = buildContentGroups(source, entities);

  assert.equal(groups.length, 1);
  assert.equal(groups[0].entities.length, 2);
  assert.deepEqual(
    groups[0].entities.map((entity) => source.slice(entity.range.start, entity.range.end)),
    ["ALL SERVICES", "AND BOOKING"],
  );
});

test("keeps nested inline span markup intact through grouped segment editing", () => {
  const source = `<p>Номер <span class="accent">Стандарт</span> с завтраком</p>`;
  const entities = extractEditableEntities(source);
  const groups = buildContentGroups(source, entities);
  const accent = entities[0];
  const patched = applySourcePatches(source, createEditableEntityPatches(accent, accent.displayValue.replace("Стандарт", "Комфорт")));

  assert.equal(groups.length, 1);
  assert.equal(groups[0].entities.length, 1);
  assert.equal(patched, `<p>Номер <span class="accent">Комфорт</span> с завтраком</p>`);
});

test("groups text and href from the same normal anchor together", () => {
  const source = `<a href="/booking">Забронировать</a>`;
  const groups = buildContentGroups(source, extractEditableEntities(source));

  assert.equal(groups.length, 1);
  assert.equal(groups[0].kind, "link");
  assert.equal(groups[0].label, "Ссылка");
  assert.equal(groups[0].textEntities.length, 1);
  assert.equal(groups[0].hrefEntity.rawValue, "/booking");
});

test("groups button-like anchor text and href together", () => {
  const source = `<a class="button" href="/booking">Забронировать</a>`;
  const groups = buildContentGroups(source, extractEditableEntities(source));

  assert.equal(groups.length, 1);
  assert.equal(groups[0].kind, "link");
  assert.equal(groups[0].label, "Кнопка");
  assert.deepEqual(
    groups[0].entities.map((entity) => entity.rawValue),
    ["/booking", "Забронировать"].sort((left, right) => source.indexOf(left) - source.indexOf(right)),
  );
});

test("keeps picture image variants as one image group", () => {
  const source = `<picture>
  <source media="(max-width: 1199px)" type="image/avif" srcset="mobile.avif">
  <source media="(max-width: 1199px)" type="image/webp" srcset="mobile.webp">
  <img src="desktop.webp" alt="">
</picture>`;
  const groups = groupImageEntities(extractEditableEntities(source));

  assert.equal(groups.length, 1);
  assert.equal(groups[0].title, "Медиа");
  assert.deepEqual(
    groups[0].items.map((item) => item.entity.rawValue),
    ["mobile.avif", "mobile.webp", "desktop.webp"],
  );
});

test("adds one picture alt field from fallback img only", () => {
  const source = `<picture>
  <source srcset="/photo.avif">
  <source srcset="/photo.webp">
  <img src="/photo.webp" alt="Дом">
</picture>`;
  const groups = groupImageEntities(extractEditableEntities(source));

  assert.equal(groups.length, 1);
  assert.equal(groups[0].altEntity?.rawValue, "Дом");
  assert.equal(groups[0].altStatus, "filled");
  assert.deepEqual(
    groups[0].items.map((item) => item.entity.rawValue),
    ["/photo.avif", "/photo.webp", "/photo.webp"],
  );
});

test("keeps PNG and SVG media editable without alt fields", () => {
  const source = `<img src="/icon.png" alt="">
<img src="/icon.svg" alt="">`;
  const groups = groupImageEntities(extractEditableEntities(source));

  assert.equal(groups.length, 2);
  assert.deepEqual(groups.map((group) => group.altEntity), [undefined, undefined]);
  assert.deepEqual(
    groups.map((group) => group.items[0].entity.rawValue),
    ["/icon.png", "/icon.svg"],
  );
});

test("groups video sources together while keeping poster as image content", () => {
  const source = `<video src="hero.mp4" poster="poster.webp">
  <source src="hero-mobile.mp4" type="video/mp4">
</video>`;
  const groups = groupImageEntities(extractEditableEntities(source));

  assert.equal(groups.length, 2);
  const videoGroup = groups.find((group) => group.title === "Видео");
  const posterGroup = groups.find((group) => group.title === "Постер к видео");
  assert.ok(videoGroup);
  assert.ok(posterGroup);
  assert.deepEqual(
    videoGroup.items.map((item) => ({
      label: item.label,
      detail: item.detail,
      rawValue: item.entity.rawValue,
      role: item.entity.context.mediaRole,
    })),
    [
      { label: "Все экраны", detail: "", rawValue: "hero.mp4", role: "video" },
      { label: "Все экраны", detail: "MP4", rawValue: "hero-mobile.mp4", role: "video" },
    ],
  );
  assert.deepEqual(
    posterGroup.items.map((item) => ({
      label: item.label,
      rawValue: item.entity.rawValue,
      role: item.entity.context.mediaRole,
    })),
    [{ label: "Постер к видео", rawValue: "poster.webp", role: "video-poster" }],
  );
});

test("blocks output when an extracted img src is cleared", () => {
  const source = `<img src="hero.webp" alt="">`;
  const issues = validateClearedImageValues(source, ["hero.webp"]);

  assert.equal(issues.length, 1);
  assert.equal(issues[0].kind, "required-image");
});

test("blocks output when any picture image variant is cleared", () => {
  const source = `<picture>
  <source media="(max-width: 1199px)" type="image/avif" srcset="mobile.avif">
  <source media="(max-width: 1199px)" type="image/webp" srcset="mobile.webp">
  <img src="desktop.webp" alt="">
</picture>`;
  const issues = validateClearedImageValues(source, ["mobile.webp"]);

  assert.equal(issues.length, 1);
});

test("blocks output for cleared srcset candidates without validating URL syntax", () => {
  const source = `<img srcset="image-800.webp 800w, image-1600.webp 1600w">`;
  const entities = imageEntities(source);
  const clearedCandidate = requireEntity(entities, (entity) => entity.rawValue === "image-800.webp");
  const keptInvalidCandidate = requireEntity(
    entities,
    (entity) => entity.rawValue === "image-1600.webp",
  );

  assert.deepEqual(
    validateRequiredImageValues(entities, {
      [clearedCandidate.id]: "",
      [keptInvalidCandidate.id]: "not a url at all",
    }).map((issue) => issue.entityId),
    [clearedCandidate.id],
  );
});

test("blocks output when a background image URL is cleared", () => {
  const source = `<div style="background-image: url('hero.webp')"></div>`;
  const issues = validateClearedImageValues(source, ["hero.webp"]);

  assert.equal(issues.length, 1);
});

test("blocks output when an external SVG image is cleared", () => {
  const source = `<img src="https://example.com/icon.svg" alt="">`;
  const issues = validateClearedImageValues(source, ["https://example.com/icon.svg"]);

  assert.equal(issues.length, 1);
});

test("blocks output when video src or poster is cleared", () => {
  const source = `<video src="hero.mp4" poster="poster.webp">
  <source src="hero-mobile.mp4" type="video/mp4">
</video>`;
  const issues = validateClearedImageValues(source, ["hero.mp4", "poster.webp", "hero-mobile.mp4"]);

  assert.equal(issues.length, 3);
  assert.deepEqual(issues.map((issue) => issue.kind), [
    "required-image",
    "required-image",
    "required-image",
  ]);
});

test("blocks output when a static JavaScript image constant is cleared", () => {
  const source = `<script>
const ICON_SRC = '/images/contact-icon.png';
const root = document.querySelector("#widget");
root.innerHTML = \`<img src="\${ICON_SRC}" alt="">\`;
</script>`;
  const issues = validateClearedImageValues(source, ["/images/contact-icon.png"]);

  assert.equal(issues.length, 1);
});

test("blocks output when a button link href is cleared", () => {
  const source = `<a class="button" href="/booking">Забронировать</a><button>Открыть</button>`;
  const entities = extractEditableEntities(source);
  const href = requireEntity(
    entities,
    (entity) => entity.kind === "href" && entity.context.linkRole === "button",
  );
  const issues = validateRequiredImageValues(entities, {
    [href.id]: "",
  });

  assert.equal(issues.length, 1);
  assert.deepEqual(issues[0], {
    entityId: href.id,
    kind: "required-button-link",
    message: "Укажите ссылку для кнопки.",
  });
  assert.deepEqual(validateRequiredImageValues(entities, { [href.id]: "/rooms" }), []);
});

test("clears required image validation when values return to extracted source values", () => {
  const source = `<picture>
  <source type="image/avif" srcset="desktop.avif">
  <img src="desktop.webp" alt="">
</picture>`;
  const entities = imageEntities(source);
  const issues = validateRequiredImageValues(
    entities,
    Object.fromEntries(entities.map((entity) => [entity.id, entity.displayValue])),
  );

  assert.deepEqual(issues, []);
});

test("content groups skip comments and grouped edits preserve protected source", () => {
  const source = `<section>
  <!-- keep me -->
  <h2>Old</h2>
</section>`;
  const entities = extractEditableEntities(source);
  const groups = buildContentGroups(source, entities);
  const title = requireEntity(entities, (entity) => entity.rawValue === "Old");
  const patched = applySourcePatches(source, [
    createEditableEntityPatch(title, "New"),
  ]);

  assert.equal(groups.length, 1);
  assert.equal(groups[0].entities.length, 1);
  assert.equal(
    patched,
    `<section>
  <!-- keep me -->
  <h2>New</h2>
</section>`,
  );
});

test("formats image metadata without rendered CSS dimensions", () => {
  const dataUrl = "data:image/png;base64,AAAA";

  assert.equal(imageFormatFromSource("/assets/photo.webp?v=1"), "WebP");
  assert.equal(imageFormatFromSource(dataUrl), "PNG");
  assert.equal(imageFormatFromSource("/icons/phone.svg?v=2"), "SVG");
  assert.equal(imageFormatFromSource("/icons/phone.png"), "PNG");
  assert.equal(imageFormatFromSource("/icons/phone.avif"), "AVIF");
  assert.equal(imageFormatFromSource("/asset", "image/svg+xml; charset=utf-8"), "SVG");
  assert.equal(imageFormatFromSource("/asset"), "формат неизвестен");
  assert.equal(byteSizeFromDataUrl(dataUrl), 3);
  assert.equal(formatByteSize(512), "512 B");
  assert.equal(formatByteSize(1536), "2 KB");
  assert.equal(formatByteSize(2 * 1024 * 1024), "2.0 MB");
  assert.equal(
    imageMetadataLine("/assets/photo.webp", {
      status: "ready",
      format: "WebP",
      width: 640,
      height: 720,
      bytes: 92160,
    }),
    "WebP · 640 × 720 px · 90 KB",
  );
  assert.equal(
    imageMetadataLine("/icons/phone.svg", {
      status: "ready",
      format: "SVG",
      bytes: 1843,
    }),
    "SVG · размер неизвестен · 2 KB",
  );
});


test("composite grouping stops at independent blocks controls media and links", () => {
  for (const source of [
    '<div><h3>Title</h3><p>Description</p></div>',
    '<p>Before <button>Action</button> after</p>',
    '<p>Before <a href="/x"><span>Link</span></a> after</p>',
    '<p>Before <img src="/x.png"> after</p>',
    '<p>Before <input value="x"> after</p>',
    '<p>Before <span role="button">Action</span> after</p>',
  ]) {
    const entities = extractEditableEntities(source);
    assert.ok(!entities.some(entity => entity.composite?.segments.some(segment => source.slice(segment.range.start, segment.range.end).includes('<'))));
    if (source.includes('<a ')) {
      const groups = buildContentGroups(source, entities);
      const link = groups.find(group => group.kind === 'link');
      assert.ok(link);
      assert.ok(link.entities.some(entity => entity.kind === 'href'));
      assert.ok(link.entities.some(entity => entity.kind === 'text' && entity.displayValue === 'Link'));
    }
    if (source.startsWith('<div>')) assert.equal(entities.filter(entity => entity.kind === 'text').length, 2);
    if (source.includes('role="button"')) assert.ok(!entities.some(entity => entity.composite));
  }
});
