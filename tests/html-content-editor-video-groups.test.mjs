import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { registerHooks } from "node:module";
import test from "node:test";
import ts from "typescript";
import React, { useEffect, useRef, useState } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { compositeEditError, createEditableEntityPatch, createEditableEntityPatches } from "../app/lib/html-content-editor/encode-source-value.ts";
import { extractEditableEntities, extractEditableEntitiesWithVideoStories } from "../app/lib/html-content-editor/extract-editable-entities.ts";
import { groupImageEntities, linkedVideoEntities, isVideoEntity, videoPosterEntity } from "../app/lib/html-content-editor/image-groups.ts";
import { applySourcePatches } from "../app/lib/html-content-editor/patch-source.ts";

registerHooks({ resolve(specifier, context, next) {
  try { return next(specifier, context); } catch (error) {
    if (specifier.startsWith(".") && context.parentURL && existsSync(new URL(`${specifier}.ts`, context.parentURL))) return next(`${specifier}.ts`, context);
    throw error;
  }
} });
const { createBlockSource, createSourceFragment, editorEntityKey } = await import("../app/lib/html-content-editor/block-source.ts");
const { assembleBlock, commitBlockEdits, exportBlock, isBlockContentDirty } = await import("../app/lib/html-content-editor/block-assembly.ts");
const { buildLivePreview } = await import("../app/lib/html-content-editor/preview-runtime.ts");

const COLLECTION = `<!-- preserve -->
<section class="unrelated-name">
  <div><button data-video='video-1.mp4' data-poster="A.webp"><span><img src="B.webp" alt="First"></span></button></div>
  <div hidden aria-hidden="true">
    <div data-video="video-1.mp4" data-poster="C.webp"></div>
    <div data-video="video-2.mp4"></div>
  </div>
  <img src="ordinary.webp" alt="Ordinary">
</section>
<style>.keep { background-image: url("video-1.mp4"); }</style>
<script>const unchanged = 'video-1.mp4';</script>`;

function block(source, id = "video-block") {
  return { ...createBlockSource(id), fragments: [{ ...createSourceFragment(`${id}-1`), source, draft: source, originalSource: source, loaded: true }] };
}

function editThroughProductionHandler(item, entity, value) {
  const source = readFileSync(new URL("../app/components/html-content-editor/HtmlContentEditor.tsx", import.meta.url), "utf8");
  const handler = source.slice(source.indexOf("  function updateValue("), source.indexOf("  function resetChanges("));
  const javascript = ts.transpileModule(handler, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  let result;
  let calls = 0;
  const run = new Function("block", "extraction", "onChange", "setCopyFeedback", "editorEntityKey", "linkedVideoEntities", "compositeEditError", javascript + "return updateValue;");
  run(item, { entities: extractEditableEntities(item.fragments[0].source) }, next => { result = next; calls++; }, () => {}, editorEntityKey, linkedVideoEntities, compositeEditError)(entity, value);
  assert.equal(calls, 1, "One atomic update for every linked occurrence");
  return result;
}

function videoGroups(source) {
  return groupImageEntities(extractEditableEntities(source)).filter((group) => group.title === "Видео");
}

function assertOnlyRangesChanged(original, patched, changes) {
  const sorted = [...changes].sort((left, right) => left.start - right.start);
  let originalCursor = 0;
  let patchedCursor = 0;

  for (const change of sorted) {
    assert.equal(
      patched.slice(patchedCursor, patchedCursor + change.start - originalCursor),
      original.slice(originalCursor, change.start),
    );
    patchedCursor += change.start - originalCursor;
    assert.equal(patched.slice(patchedCursor, patchedCursor + change.replacement.length), change.replacement);
    patchedCursor += change.replacement.length;
    originalCursor = change.end;
  }

  assert.equal(patched.slice(patchedCursor), original.slice(originalCursor));
}

test("extracts lazy video source data-src as one all-screens video group", () => {
  const source = `<video
  preload="none"
  muted
  playsinline
>
  <source
    data-src="https://example.com/video.mp4"
    type="video/mp4"
  >
</video>`;
  const groups = videoGroups(source);

  assert.equal(groups.length, 1);
  assert.equal(groups[0].items.length, 1);
  assert.deepEqual(
    groups[0].items.map((item) => ({
      label: item.label,
      detail: item.detail,
      rawValue: item.entity.rawValue,
      attribute: item.entity.context.name,
    })),
    [
      {
        label: "Все экраны",
        detail: "MP4",
        rawValue: "https://example.com/video.mp4",
        attribute: "data-src",
      },
    ],
  );

  const entity = groups[0].items[0].entity;
  const patch = createEditableEntityPatch(entity, "https://example.com/new-video.mp4");
  const patched = applySourcePatches(source, [patch]);

  assert.equal(patched.includes('data-src="https://example.com/new-video.mp4"'), true);
  assert.equal(/\ssrc="https:\/\/example\.com\/new-video\.mp4"/.test(patched), false);
  assertOnlyRangesChanged(source, patched, [patch]);
});

test("extracts video src and video data-src without changing attribute kind", () => {
  const srcSource = `<video src="/hero.mp4"></video>`;
  const dataSrcSource = `<video data-src="/hero.mp4"></video>`;
  const srcGroup = videoGroups(srcSource)[0];
  const dataSrcGroup = videoGroups(dataSrcSource)[0];

  assert.equal(srcGroup.items[0].entity.context.name, "src");
  assert.equal(dataSrcGroup.items[0].entity.context.name, "data-src");

  const patch = createEditableEntityPatch(dataSrcGroup.items[0].entity, "/new.mp4");
  const patched = applySourcePatches(dataSrcSource, [patch]);

  assert.equal(patched, `<video data-src="/new.mp4"></video>`);
});

test("groups responsive video sources by parent video with readable ranges", () => {
  const source = `<video>
  <source
    media="(max-width: 639px)"
    src="/mobile.mp4"
    type="video/mp4"
  >
  <source
    media="(min-width: 640px)"
    src="/desktop.mp4"
    type="video/mp4"
  >
</video>`;
  const groups = videoGroups(source);

  assert.equal(groups.length, 1);
  assert.deepEqual(
    groups[0].items.map((item) => ({
      label: item.label,
      detail: item.detail,
      rawValue: item.entity.rawValue,
      attribute: item.entity.context.name,
    })),
    [
      { label: "До 639 px", detail: "MP4", rawValue: "/mobile.mp4", attribute: "src" },
      { label: "От 640 px", detail: "MP4", rawValue: "/desktop.mp4", attribute: "src" },
    ],
  );
});

test("keeps mixed video src and data-src variants as independent exact ranges", () => {
  const source = `<video data-src="/desktop.mp4">
  <source media="(max-width: 639px)" src="/mobile.mp4">
  <source media="(min-width: 640px)" data-src="/tablet.webm" type="video/webm">
</video>`;
  const group = videoGroups(source)[0];

  assert.deepEqual(
    group.items.map((item) => ({
      label: item.label,
      detail: item.detail,
      rawValue: item.entity.rawValue,
      attribute: item.entity.context.name,
    })),
    [
      { label: "Все экраны", detail: "", rawValue: "/desktop.mp4", attribute: "data-src" },
      { label: "До 639 px", detail: "", rawValue: "/mobile.mp4", attribute: "src" },
      { label: "От 640 px", detail: "WebM", rawValue: "/tablet.webm", attribute: "data-src" },
    ],
  );
});

test("keeps picture source and video source in separate media groups", () => {
  const source = `<picture>
  <source media="(max-width: 639px)" srcset="/photo-mobile.webp">
  <img src="/photo.webp" alt="">
</picture>
<video>
  <source data-src="/video.mp4" type="video/mp4">
</video>`;
  const groups = groupImageEntities(extractEditableEntities(source));

  assert.equal(groups.length, 2);
  assert.equal(groups.find((group) => group.title === "Видео")?.items[0].entity.rawValue, "/video.mp4");
  assert.deepEqual(
    groups.find((group) => group.title !== "Видео")?.items.map((item) => item.entity.rawValue),
    ["/photo-mobile.webp", "/photo.webp"],
  );
});

test("skips technical video data-url placeholders when a real data-src exists", () => {
  const source = `<video src="data:video/mp4;base64,AAAA" data-src="/real.mp4"></video>`;
  const group = videoGroups(source)[0];

  assert.deepEqual(
    group.items.map((item) => item.entity.rawValue),
    ["/real.mp4"],
  );
});

test("keeps complex video media conditions as neutral condition labels", () => {
  const source = `<video>
  <source media="(orientation: landscape)" data-src="/landscape.ogg" type="video/ogg">
</video>`;
  const group = videoGroups(source)[0];

  assert.deepEqual(
    group.items.map((item) => ({ label: item.label, detail: item.detail })),
    [{ label: "Условие: orientation: landscape", detail: "OGG" }],
  );
});

test("media renderer shows item label and detail without exposing source attribute names", () => {
  const componentSource = readFileSync(
    new URL("../app/components/html-content-editor/HtmlContentEditor.tsx", import.meta.url),
    "utf8",
  );
  const renderStart = componentSource.indexOf("function renderImageGroupContent");
  const renderEnd = componentSource.indexOf("\n  function renderSliderGroup", renderStart);
  const renderSource = componentSource.slice(renderStart, renderEnd);

  assert.ok(renderSource.includes("item.label"));
  assert.ok(renderSource.includes("item.detail"));
  assert.ok(renderSource.includes('metadataText: isVideoVariant ? "Ссылка на видео" : options.storyField ? group.title : undefined'));
  assert.equal(renderSource.includes("data-src"), false);
});

test("custom collection exposes two logical videos from three exact attribute ranges", () => {
  const entities = extractEditableEntities(COLLECTION);
  const raw = entities.filter(entity => entity.context.type === "attribute" && entity.context.name === "data-video");
  assert.equal(raw.length, 3);
  const groups = videoGroups(COLLECTION);
  assert.equal(groups.length, 2);
  assert.ok(groups.every(group => group.items.length === 1));
  assert.deepEqual(groups.map(group => group.items[0].entity.displayValue), ["video-1.mp4", "video-2.mp4"]);
  assert.equal(linkedVideoEntities(entities, groups[0].items[0].entity).length, 2);
  for (const entity of raw) assert.equal(COLLECTION.slice(entity.range.start, entity.range.end), entity.rawValue);
});

test("production URL handler patches linked ranges only and keeps quotes, CSS, JS and other sources", () => {
  const item = block(COLLECTION);
  const entity = videoGroups(COLLECTION)[0].items[0].entity;
  const edited = editThroughProductionHandler(item, entity, "new.mp4?a=1&b=2");
  const entities = extractEditableEntities(COLLECTION);
  const patches = entities.flatMap(entity => {
    const value = edited.values[editorEntityKey(edited.id, entity.id)];
    return value === undefined ? [] : createEditableEntityPatches(entity, value);
  });
  assert.equal(patches.length, 2);
  const output = exportBlock(edited);
  assertOnlyRangesChanged(COLLECTION, output, patches);
  assert.ok(output.includes("data-video='new.mp4?a=1&amp;b=2'"));
  assert.ok(output.includes('data-video="new.mp4?a=1&amp;b=2"'));
  assert.ok(output.includes('data-video="video-2.mp4"'));
  assert.ok(output.includes("const unchanged = 'video-1.mp4';"));
  assert.ok(output.includes('background-image: url("video-1.mp4")'));
});

test("equal URLs in independent widgets inside one block remain separate logical fields", () => {
  const widget = `<div><button data-video="shared.mp4"></button><div hidden><div data-video="shared.mp4"></div></div></div>`;
  const source = `<section>${widget}${widget}<video src="shared.mp4"></video></section>`;
  const groups = videoGroups(source);
  assert.equal(groups.length, 3);
  const entities = extractEditableEntities(source);
  assert.equal(linkedVideoEntities(entities, groups[0].items[0].entity).length, 2);
  const item = editThroughProductionHandler(block(source), groups[0].items[0].entity, "first-widget.mp4");
  const changed = extractEditableEntities(exportBlock(item)).filter(entity => entity.context.mediaRole === "video");
  assert.deepEqual(changed.map(entity => entity.displayValue), ["first-widget.mp4", "first-widget.mp4", "shared.mp4", "shared.mp4", "shared.mp4"]);
});

test("ambiguous triggers, unrelated attributes and independent section boundaries are never guessed", () => {
  const ambiguous = `<section><button data-video="same.mp4"></button><button data-video="same.mp4"></button><div hidden data-video="same.mp4"></div></section>`;
  assert.equal(videoGroups(ambiguous).length, 3);
  const independent = `<section><button data-video="same.mp4"></button></section><section><div hidden data-video="same.mp4"></div></section>`;
  assert.equal(videoGroups(independent).length, 2);
  const separateWidgets = `<section><div><button data-video="same.mp4"></button></div><div><div hidden><div data-video="same.mp4"></div></div></div></section>`;
  assert.equal(videoGroups(separateWidgets).length, 2, "Do not search across an independent widget wrapper");
  const unrelated = `<div data-url="other.mp4" data-image="image.webp"></div><script>const template = '<button data-video="js.mp4"></button>';</script>`;
  assert.equal(videoGroups(unrelated).length, 0);
});

test("explicit posters and ordinary nested images keep their roles, values and ALT independent", () => {
  const groups = groupImageEntities(extractEditableEntities(COLLECTION));
  const posters = groups.filter(group => group.title === "Постер к видео");
  assert.equal(posters.length, 2);
  assert.deepEqual(posters.flatMap(group => group.items.map(item => item.entity.displayValue)).sort(), ["A.webp", "C.webp"]);
  const image = groups.find(group => group.title === "Медиа" && group.items[0].entity.displayValue === "B.webp");
  assert.equal(image.items[0].entity.kind, "src");
  assert.equal(image.altEntity.displayValue, "First");
  const ordinary = groups.find(group => group.title === "Медиа" && group.items[0].entity.displayValue === "ordinary.webp");
  assert.equal(ordinary.items[0].entity.displayValue, "ordinary.webp");
  const entity = posters.find(group => group.items[0].entity.displayValue === "A.webp").items[0].entity;
  const edited = editThroughProductionHandler(block(COLLECTION), entity, "new-poster.webp");
  assert.equal(Object.keys(edited.values).length, 1);
  const output = exportBlock(edited);
  assert.ok(output.includes('data-poster="new-poster.webp"'));
  assert.ok(output.includes('img src="B.webp" alt="First"'));
  assert.ok(output.includes('data-poster="C.webp"'));
  assertOnlyRangesChanged(COLLECTION, output, createEditableEntityPatches(entity, "new-poster.webp"));
});

test("equal data-poster and img URLs are still independent source values", () => {
  const source = `<button data-poster="same.webp"><img src="same.webp" alt=""></button>`;
  const groups = groupImageEntities(extractEditableEntities(source));
  assert.deepEqual(groups.map(group => group.title), ["Постер к видео", "Медиа"]);
  const entity = groups[0].items[0].entity;
  assert.equal(linkedVideoEntities(extractEditableEntities(source), entity).length, 1);
  const edited = editThroughProductionHandler(block(source), entity, "different.webp");
  assert.equal(exportBlock(edited), '<button data-poster="different.webp"><img src="same.webp" alt=""></button>');
});

test("linked video and poster edits preserve dirty A-B-A before and after commit/export", () => {
  const item = block(COLLECTION);
  assert.equal(isBlockContentDirty(item), false);
  for (const entity of [videoGroups(COLLECTION)[0].items[0].entity, extractEditableEntities(COLLECTION).find(entity => entity.kind === "poster")]) {
    const changed = editThroughProductionHandler(item, entity, "changed-url");
    assert.equal(isBlockContentDirty(changed), true);
    exportBlock(changed);
    assert.equal(isBlockContentDirty(changed), true, "Export does not clear dirty");
    assert.equal(isBlockContentDirty(editThroughProductionHandler(changed, entity, entity.displayValue)), false);
    const committed = commitBlockEdits(changed);
    assert.equal(isBlockContentDirty(committed), true, "Commit does not replace originalSource");
    const nextEntity = extractEditableEntities(committed.fragments[0].source).find(candidate => candidate.context.type === "attribute" && candidate.context.name === entity.context.name);
    const reverted = editThroughProductionHandler(committed, nextEntity, entity.displayValue);
    assert.equal(isBlockContentDirty(reverted), false);
  }
});

test("ordinary Preview assembly receives every patched video URL without changing user runtime", () => {
  const entity = videoGroups(COLLECTION)[0].items[0].entity;
  const edited = editThroughProductionHandler(block(COLLECTION), entity, "preview-new.mp4");
  const preview = buildLivePreview([edited], { css: ".site{color:red}", js: "window.site=true;" }, "video-test");
  assert.equal([...preview.source.matchAll(/data-video=['"]preview-new\.mp4['"]/g)].length, 2);
  assert.ok(preview.source.includes('data-video="video-2.mp4"'));
  assert.ok(preview.source.includes("<script>const unchanged = 'video-1.mp4';</script>"));
  assert.ok(preview.source.includes("window.site=true;"));
});

test("semantic media titles and linked value handler are used by existing Content renderer", () => {
  const component = readFileSync(new URL("../app/components/html-content-editor/HtmlContentEditor.tsx", import.meta.url), "utf8");
  assert.ok(component.includes('return "Постер к видео"'));
  assert.ok(component.includes('return "Ссылка на видео"'));
  assert.ok(component.includes("mediaTitleForEntities(itemEntities)"));
  assert.ok(component.includes("for (const linked of linkedVideoEntities(extraction.entities, entity))"));
  assert.equal(component.includes('isMediaGroup ? "Медиа"'), false);
});


const VIDEO_FIXTURE_SOURCE = readFileSync(new URL("./fixtures/html-content-editor/video-stories.html", import.meta.url), "utf8");

// Derive exact expected offsets from known fixture attributes, independently of extraction.
function fixtureRange(name, index, occurrence = 0) {
  const value = 'https://example.invalid/' + (name === 'data-video' ? 'clip' : 'poster') + '-' + index + (name === 'data-video' ? '.mp4' : '.png');
  const pattern = name + '="' + value + '"';
  let start = -1;
  for (let count = 0; count <= occurrence; count++) {
    start = VIDEO_FIXTURE_SOURCE.indexOf(pattern, start + 1);
    assert.ok(start >= 0, 'Missing fixture attribute ' + pattern + ' occurrence ' + occurrence);
  }
  return start + name.length + 2;
}

const COMPONENT = readFileSync(new URL("../app/components/html-content-editor/HtmlContentEditor.tsx", import.meta.url), "utf8");
const componentAst = ts.createSourceFile("editor.tsx", COMPONENT, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const helperNames = ["intrinsicFrameStyle", "resetVideoElement", "startVideoPreview", "observeVideoPreview", "bindVideoDialog", "composeVideoStories", "centeredRailScrollLeft", "videoPreviewEntries", "VideoThumbnail", "VideoGallery", "VideoModal"];
const helperCode = componentAst.statements.filter(node => ts.isFunctionDeclaration(node) && helperNames.includes(node.name?.text)).map(node => node.getText(componentAst)).join("\n");
function presentationHelpers(overrides = {}) {
  return new Function("React", "useState", "useRef", "useEffect", "styles", "createPortal", "groupImageEntities", "linkedVideoEntities", "isVideoEntity", "videoPosterEntity", "extractEditableEntitiesWithVideoStories", "assembleBlock", "editorEntityKey",
  ts.transpileModule(helperCode, { compilerOptions: { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2022 } }).outputText + `;return {${helperNames.join(",")}};`)(
  React, overrides.useState ?? useState, overrides.useRef ?? useRef, overrides.useEffect ?? useEffect, new Proxy({}, { get: (_, key) => key }), node => node,
  groupImageEntities, linkedVideoEntities, isVideoEntity, videoPosterEntity, extractEditableEntitiesWithVideoStories, assembleBlock, editorEntityKey);
}
const helpers = presentationHelpers();

function fakeVideo() {
  const listeners = new Map();
  const attributes = new Map();
  return {
    listeners, attributes, videoWidth: 1080, videoHeight: 1920, duration: 3, currentTime: 0,
    seeking: false, readyState: 2, seekable: { length: 0 }, pauses: 0, loads: 0,
    set src(value) { attributes.set("src", value); },
    get src() { return attributes.get("src"); },
    getAttribute(name) { return attributes.get(name) ?? null; },
    removeAttribute(name) { attributes.delete(name); },
    addEventListener(name, fn) { listeners.set(name, fn); },
    removeEventListener(name, fn) { if (listeners.get(name) === fn) listeners.delete(name); },
    emit(name) { listeners.get(name)?.(); },
    pause() { this.pauses++; }, load() { this.loads++; },
  };
}

test("synthetic video fixture has raw 9/4/2 and logical Video 7, Media 2, Poster 2", () => {
  const entities = extractEditableEntities(VIDEO_FIXTURE_SOURCE);
  const attributes = name => entities.filter(entity => entity.context.type === "attribute" && entity.context.name === name);
  assert.equal(attributes("data-video").length, 9);
  assert.equal(attributes("data-poster").length, 4);
  assert.equal(attributes("src").filter(entity => entity.context.elementName === "img").length, 2);
  const groups = groupImageEntities(entities);
  const counts = Object.fromEntries(["Видео", "Медиа", "Постер к видео"].map(title => [title, groups.filter(group => group.title === title).length]));
  assert.deepEqual(counts, { "Видео": 7, "Медиа": 2, "Постер к видео": 2 });
  assert.equal(groups.length, 11);
  assert.equal(groups.filter(group => group.title !== "Видео").length, 4);
  for (const entity of entities) assert.equal(VIDEO_FIXTURE_SOURCE.slice(entity.range.start, entity.range.end), entity.rawValue);
  assert.equal(helpers.videoPreviewEntries([block(VIDEO_FIXTURE_SOURCE)]).length, 7);
  assert.equal(groupImageEntities(entities).length, 11, "Presentation creates no editable entities");
});

test("synthetic fixture composes seven ordered Video stories without changing editable roles", () => {
  const { entities, videoStoryByImageEntityId } = extractEditableEntitiesWithVideoStories(VIDEO_FIXTURE_SOURCE);
  const groups = groupImageEntities(entities);
  const stories = helpers.composeVideoStories(groups, entities, videoStoryByImageEntityId);
  assert.deepEqual(stories.stories.map(story => story.title), ["ВИДЕО 1", "ВИДЕО 2", "ВИДЕО 3", "ВИДЕО 4", "ВИДЕО 5", "ВИДЕО 6", "ВИДЕО 7"]);
  assert.deepEqual(stories.stories.map(story => [
    story.video.items.some(item => isVideoEntity(item.entity)),
    ...story.related.map(group => group.title),
  ]), [
    [true, "Постер к видео", "Медиа"],
    [true, "Постер к видео", "Медиа"],
    [true], [true], [true], [true], [true],
  ]);
  const mediaOne = entities.find(entity => entity.range.start === fixtureRange('src', 1));
  const mediaTwo = entities.find(entity => entity.range.start === fixtureRange('src', 2));
  const posterOne = entities.find(entity => entity.range.start === fixtureRange('data-poster', 1));
  const posterTwo = entities.find(entity => entity.range.start === fixtureRange('data-poster', 2));
  const videoOne = entities.find(entity => entity.range.start === fixtureRange('data-video', 1));
  const videoTwo = entities.find(entity => entity.range.start === fixtureRange('data-video', 2));
  assert.deepEqual([...videoStoryByImageEntityId], [[mediaOne.id, videoOne.id], [mediaTwo.id, videoTwo.id]]);
  assert.equal(stories.storyEntityByEntityId.get(mediaOne.id), videoOne.id);
  assert.equal(stories.storyEntityByEntityId.get(posterOne.id), videoOne.id);
  assert.equal(stories.storyEntityByEntityId.get(mediaTwo.id), videoTwo.id);
  assert.equal(stories.storyEntityByEntityId.get(posterTwo.id), videoTwo.id);
  assert.equal(mediaOne.context.mediaRole, "image");
  assert.equal(mediaTwo.context.mediaRole, "image");
  assert.equal(posterOne.context.mediaRole, "video-poster");
  assert.equal(posterTwo.context.mediaRole, "video-poster");
  assert.notEqual(mediaOne.id, posterOne.id, "matching URLs do not combine editable identity");
});

test("Media story relation requires exactly one visible structural video trigger ancestor", () => {
  const source = `<section><button data-video="outer.mp4"><img src="outer.webp"><button data-video="inner.mp4"><img src="inner.webp"></button></button><img src="unrelated.webp"></section>`;
  const { entities, videoStoryByImageEntityId } = extractEditableEntitiesWithVideoStories(source);
  const imageByValue = value => entities.find(entity => entity.kind === "src" && entity.displayValue === value);
  assert.equal(videoStoryByImageEntityId.get(imageByValue("outer.webp").id), entities.find(isVideoEntity).id);
  assert.equal(videoStoryByImageEntityId.has(imageByValue("inner.webp").id), false);
  assert.equal(videoStoryByImageEntityId.has(imageByValue("unrelated.webp").id), false);
});

test("selected gallery card can be centered by horizontal rail scroll with clamped bounds", () => {
  const rail = { scrollLeft: 200, clientWidth: 400, scrollWidth: 1200, getBoundingClientRect: () => ({ left: 10 }) };
  const card = { getBoundingClientRect: () => ({ left: 600, width: 100 }) };
  assert.equal(helpers.centeredRailScrollLeft(rail, card), 640);
  assert.equal(helpers.centeredRailScrollLeft({ ...rail, scrollWidth: 600 }, card), 200);
  assert.equal(helpers.centeredRailScrollLeft({ ...rail, scrollLeft: 0 }, { getBoundingClientRect: () => ({ left: -100, width: 40 }) }), 0);
  const component = COMPONENT.slice(COMPONENT.indexOf("function VideoGallery"), COMPONENT.indexOf("function bindVideoDialog"));
  assert.ok(component.includes('rail.scrollTo({ left: centeredRailScrollLeft(rail, card), behavior: "smooth" })'));
  assert.ok(component.includes("ref={railRef}"));
  assert.ok(component.includes("cardRefs.current.set(entry.key, node)"));
  assert.equal(component.includes("scrollIntoView"), false);
});

test("synthetic first two Video and Poster edits patch exactly two ranges, Media exactly one", () => {
  const entities = extractEditableEntities(VIDEO_FIXTURE_SOURCE);
  const cases = [
    [fixtureRange('data-video', 1), [fixtureRange('data-video', 1), fixtureRange('data-video', 1, 1)]], [fixtureRange('data-video', 2), [fixtureRange('data-video', 2), fixtureRange('data-video', 2, 1)]],
    [fixtureRange('data-poster', 1), [fixtureRange('data-poster', 1), fixtureRange('data-poster', 1, 1)]], [fixtureRange('data-poster', 2), [fixtureRange('data-poster', 2), fixtureRange('data-poster', 2, 1)]],
    [fixtureRange('src', 1), [fixtureRange('src', 1)]], [fixtureRange('src', 2), [fixtureRange('src', 2)]],
  ];
  for (const [start, expectedStarts] of cases) {
    const entity = entities.find(item => item.range.start === start);
    const linked = linkedVideoEntities(entities, entity);
    assert.deepEqual(linked.map(item => item.range.start), expectedStarts);
    const value = "replacement?a=1&b=2";
    const edited = editThroughProductionHandler(block(VIDEO_FIXTURE_SOURCE), entity, value);
    assert.equal(Object.keys(edited.values).length, expectedStarts.length);
    const patches = linked.flatMap(item => createEditableEntityPatches(item, value));
    assertOnlyRangesChanged(VIDEO_FIXTURE_SOURCE, exportBlock(edited), patches);
    assert.equal(isBlockContentDirty(edited), true);
    assert.equal(isBlockContentDirty(editThroughProductionHandler(edited, entity, entity.displayValue)), false);
  }
});

test("same URL Media and linked Poster remain independent in both directions", () => {
  const entities = extractEditableEntities(VIDEO_FIXTURE_SOURCE);
  const media = entities.find(entity => entity.range.start === fixtureRange('src', 1));
  const poster = entities.find(entity => entity.range.start === fixtureRange('data-poster', 1));
  assert.equal(media.displayValue, poster.displayValue);
  assert.equal(media.context.mediaRole, "image");
  assert.equal(poster.context.mediaRole, "video-poster");
  for (const [entity, untouched] of [[media, poster], [poster, media]]) {
    const edited = editThroughProductionHandler(block(VIDEO_FIXTURE_SOURCE), entity, "changed.webp");
    assert.equal(edited.values[editorEntityKey(edited.id, untouched.id)], undefined);
  }
});

test("ordinary images and picture sources inside video stay Media; only explicit poster is Poster", () => {
  const source = `<video src="clip" poster="poster"><img src="same"><picture><source srcset="small 1x"><img src="large"></picture></video>`;
  const entities = extractEditableEntities(source);
  assert.ok(entities.filter(entity => entity.kind === "src" && entity.context.elementName === "img").every(entity => entity.context.mediaRole === "image"));
  assert.ok(entities.filter(entity => entity.context.type === "srcset-url").every(entity => entity.context.mediaRole === "image"));
  assert.equal(groupImageEntities(entities).filter(group => group.title === "Постер к видео").length, 1);
  const video = entities.find(isVideoEntity);
  assert.equal(videoPosterEntity(entities, video).displayValue, "poster");
});

test("conflicting posters, ambiguous stories and independent widgets never merge", () => {
  const sources = [
    COLLECTION,
    `<section><button data-video="same" data-poster="p"></button><button data-video="same" data-poster="p"></button><div hidden><div data-video="same" data-poster="p"></div></div></section>`,
    `<section><div><button data-video="same" data-poster="p"></button><div hidden><div data-video="same" data-poster="p"></div></div></div><div><button data-video="same" data-poster="p"></button><div hidden><div data-video="same" data-poster="p"></div></div></div></section>`,
  ];
  assert.equal(groupImageEntities(extractEditableEntities(sources[0])).filter(group => group.title === "Постер к видео").length, 2);
  assert.equal(videoPosterEntity(extractEditableEntities(COLLECTION), videoGroups(COLLECTION)[0].items[0].entity), undefined);
  assert.equal(groupImageEntities(extractEditableEntities(sources[1])).filter(group => group.title === "Постер к видео").length, 3);
  const independent = extractEditableEntities(sources[2]);
  const posters = groupImageEntities(independent).filter(group => group.title === "Постер к видео");
  assert.equal(posters.length, 2);
  const edited = editThroughProductionHandler(block(sources[2]), posters[0].items[0].entity, "other");
  assert.equal(Object.keys(edited.values).length, 2);
});

test("derived gallery uses live block values and block/entity identities, no extension-based format", () => {
  const blocks = [block(VIDEO_FIXTURE_SOURCE, "first"), block(VIDEO_FIXTURE_SOURCE, "second")];
  const original = helpers.videoPreviewEntries(blocks);
  assert.equal(original.length, 14);
  assert.equal(new Set(original.map(entry => entry.key)).size, 14);
  assert.equal(original.filter(entry => entry.poster).length, 4);
  assert.ok(original.every(entry => entry.sourceType === undefined));
  const changed = editThroughProductionHandler(blocks[0], original[0].entity, "new-video");
  const changedPoster = editThroughProductionHandler(changed, extractEditableEntities(VIDEO_FIXTURE_SOURCE).find(entity => entity.range.start === fixtureRange('data-poster', 1)), "new-poster");
  const next = helpers.videoPreviewEntries([changedPoster, blocks[1]]);
  assert.equal(next[0].key, original[0].key);
  assert.equal(next[0].source, "new-video");
  assert.equal(next[0].poster, "new-poster");
  assert.equal(next[7].source, original[7].source);
});

test("gallery SSR has seven lazy video elements outside iframe, selected card and no players on left", () => {
  const entries = helpers.videoPreviewEntries([block(VIDEO_FIXTURE_SOURCE)]);
  const html = renderToStaticMarkup(React.createElement(helpers.VideoGallery, { entries, selectedKey: entries[2].key, onOpen() {} }));
  assert.equal((html.match(/<video\b/g) ?? []).length, 7);
  assert.equal((html.match(/<button\b/g) ?? []).length, 7);
  assert.equal((html.match(/aria-pressed="true"/g) ?? []).length, 1);
  assert.equal((html.match(/poster=/g) ?? []).length, 2);
  assert.equal(html.includes("<iframe"), false);
  assert.equal(html.includes("<img"), false);
  for (const tag of html.match(/<video\b[^>]*>/g)) {
    assert.ok(tag.includes('preload="metadata"'));
    assert.ok(tag.includes('muted=""'));
    assert.ok(tag.includes('playsInline=""'));
    assert.equal(/\ssrc=|\scontrols|autoplay/i.test(tag), false);
  }
  let chosen;
  const directGallery = presentationHelpers({ useRef: initial => ({ current: initial }), useEffect() {} }).VideoGallery;
  const gallery = directGallery({ entries, selectedKey: entries[2].key, onOpen: (...args) => { chosen = args; } });
  const buttons = gallery.props.children[1].props.children;
  const trigger = {};
  buttons[4].props.onClick({ currentTarget: trigger });
  assert.equal(chosen[0].key, entries[4].key);
  assert.equal(chosen[0].source, entries[4].source);
  assert.equal(chosen[1], trigger);
});

test("IntersectionObserver assigns src once on visibility and retains initialized video", () => {
  const previous = globalThis.IntersectionObserver;
  const observers = [];
  globalThis.IntersectionObserver = class {
    constructor(callback) { this.callback = callback; observers.push(this); }
    observe(node) { this.target = node; }
    disconnect() { this.disconnected = true; }
  };
  const video = fakeVideo(); const states = []; const card = {};
  const dispose = helpers.observeVideoPreview(video, card, "clip", state => states.push(state));
  const observer = observers[0];
  try {
    assert.equal(video.src, undefined);
    assert.equal(observer.target, card);
    observer.callback([{ isIntersecting: false }]);
    assert.equal(video.loads, 0);
    observer.callback([{ isIntersecting: true }]);
    assert.equal(video.src, "clip"); assert.equal(video.loads, 1);
    observer.callback([{ isIntersecting: false }]); observer.callback([{ isIntersecting: true }]);
    assert.equal(video.loads, 1);
    assert.equal(states.at(-1).phase, "loading");
  } finally { dispose(); globalThis.IntersectionObserver = previous; }
  assert.equal(video.src, undefined); assert.ok(video.pauses > 0);
  assert.equal(video.loads, 2);
});

test("metadata, safe seek and paused decoded frames preserve portrait, landscape and square ratios", () => {
  for (const [width, height] of [[1080, 1920], [1920, 1080], [1080, 1080]]) {
    const video = fakeVideo(); video.videoWidth = width; video.videoHeight = height; video.duration = 0.08;
    const states = []; const dispose = helpers.startVideoPreview(video, "clip", state => states.push(state));
    try {
      video.emit("loadedmetadata");
      assert.equal(video.currentTime, 0.04);
      assert.deepEqual(states.at(-1), { phase: "loading", width, height });
      video.emit("seeked");
      assert.deepEqual(states.at(-1), { phase: "ready", width, height });
      assert.ok(video.pauses > 0);
      const frame = helpers.intrinsicFrameStyle(width, height, 300, 220);
      assert.equal(frame.aspectRatio, `${width} / ${height}`);
      assert.ok(frame.width <= 300 && frame.width / (width / height) <= 220);
    } finally { dispose(); }
  }
  assert.equal(helpers.intrinsicFrameStyle(), undefined);
});

test("seek respects available ranges and decoded frame readiness", () => {
  const video = fakeVideo(); video.seekable = { length: 1, start: () => 2, end: () => 3 }; video.readyState = 1;
  const states = []; const dispose = helpers.startVideoPreview(video, "clip", state => states.push(state));
  try {
    video.emit("loadedmetadata"); assert.equal(video.currentTime, 2);
    video.emit("seeked"); assert.equal(states.at(-1).phase, "loading");
    video.readyState = 2; video.emit("loadeddata"); assert.equal(states.at(-1).phase, "ready");
  } finally { dispose(); }
});

test("URL replacement resets dimensions and ignores late metadata/seek/error from old generation", () => {
  const oldVideo = fakeVideo(); const states = [];
  const disposeOld = helpers.startVideoPreview(oldVideo, "A", state => states.push(state));
  const late = [...oldVideo.listeners.values()];
  oldVideo.emit("loadedmetadata"); oldVideo.emit("seeked");
  disposeOld();
  const nextVideo = fakeVideo(); const disposeNext = helpers.startVideoPreview(nextVideo, "B", state => states.push(state));
  try {
    const count = states.length;
    assert.deepEqual(states.at(-1), { phase: "loading" });
    for (const callback of late) callback();
    assert.equal(states.length, count);
    assert.equal(oldVideo.src, undefined);
    assert.equal(nextVideo.src, "B");
    nextVideo.emit("loadedmetadata"); nextVideo.emit("seeked");
    assert.equal(states.at(-1).phase, "ready");
  } finally { disposeNext(); }
});

test("metadata/network/seek failures have neutral state and do not affect another video", () => {
  for (const failure of ["network", "dimensions", "seek"]) {
    const video = fakeVideo(); const states = [];
    if (failure === "dimensions") video.videoWidth = 0;
    if (failure === "seek") Object.defineProperty(video, "currentTime", { get: () => 0, set: () => { throw new Error("unseekable"); } });
    const dispose = helpers.startVideoPreview(video, "bad", state => states.push(state));
    try {
      video.emit(failure === "network" ? "error" : "loadedmetadata");
      assert.deepEqual(states.at(-1), { phase: "error" });
      const count = states.length; video.emit("loadedmetadata"); video.emit("seeked"); assert.equal(states.length, count);
    } finally { dispose(); }
  }
  const video = fakeVideo(); const states = []; const dispose = helpers.startVideoPreview(video, "good", state => states.push(state));
  try { video.emit("loadedmetadata"); video.emit("seeked"); assert.equal(states.at(-1).phase, "ready"); } finally { dispose(); }
});

test("video modal owns one controls player, correct poster, no autoplay and backdrop/close callbacks", () => {
  const previous = globalThis.document; globalThis.document = { body: {} };
  try {
    const entries = helpers.videoPreviewEntries([block(VIDEO_FIXTURE_SOURCE)]);
    const entry = entries[1];
    const html = renderToStaticMarkup(React.createElement(helpers.VideoModal, { entry, trigger: null, onClose() {} }));
    assert.equal((html.match(/<video\b/g) ?? []).length, 1);
    assert.ok(html.includes('data-ui-theme="editor"'));
    assert.ok(html.includes('role="dialog"') && html.includes('aria-modal="true"'));
    assert.ok(/<video[^>]*controls=""[^>]*playsInline=""/.test(html));
    assert.equal(/autoplay/i.test(html), false);
  } finally { globalThis.document = previous; }
});

test("modal focus transfer, trap, Escape and focus return share production dialog binding", () => {
  const previous = globalThis.document;
  let handler; let closes = 0;
  const document = { activeElement: null, addEventListener(name, fn) { assert.equal(name, "keydown"); handler = fn; }, removeEventListener(name, fn) { assert.equal(fn, handler); handler = null; } };
  globalThis.document = document;
  const control = () => ({ tabIndex: 0, hidden: false, hasAttribute: () => false, focus() { document.activeElement = this; }, isConnected: true });
  const first = control(), last = control(), trigger = control();
  const dialog = { querySelectorAll: () => [first, last], contains: node => [first, last].includes(node), focus() { document.activeElement = this; } };
  const dispose = helpers.bindVideoDialog(dialog, trigger, () => { closes++; });
  try {
    assert.equal(document.activeElement, first);
    let prevented = false;
    handler({ key: "Tab", shiftKey: true, preventDefault() { prevented = true; } });
    assert.equal(document.activeElement, last); assert.equal(prevented, true);
    handler({ key: "Tab", shiftKey: false, preventDefault() {} }); assert.equal(document.activeElement, first);
    handler({ key: "Escape", preventDefault() {}, stopPropagation() {} }); assert.equal(closes, 1);
  } finally { dispose(); globalThis.document = previous; }
  assert.equal(document.activeElement, trigger);
  const video = fakeVideo(); video.src = "playing"; helpers.resetVideoElement(video);
  assert.equal(video.pauses, 1); assert.equal(video.src, undefined); assert.equal(video.loads, 1);
});


test("modal uses selected URL and real close/backdrop/Escape paths pause, reset source and restore focus", () => {
  const previous = globalThis.document;
  const entry = helpers.videoPreviewEntries([block(VIDEO_FIXTURE_SOURCE)])[4];
  for (const action of ["button", "backdrop", "Escape"]) {
    let keydown; let closes = 0; let cleanup;
    const document = { body: {}, activeElement: null,
      addEventListener(name, fn) { keydown = fn; },
      removeEventListener(name, fn) { assert.equal(fn, keydown); keydown = null; } };
    const button = { tabIndex: 0, hidden: false, hasAttribute: () => false, focus() { document.activeElement = button; } };
    const trigger = { isConnected: true, focus() { document.activeElement = trigger; } };
    const dialog = { querySelectorAll: () => [button], contains: node => node === button, focus() {} };
    const video = fakeVideo(); const refs = [dialog, video]; const effects = [];
    const bound = presentationHelpers({ useRef: () => ({ current: refs.shift() }), useEffect: fn => effects.push(fn) });
    globalThis.document = document;
    try {
      const tree = bound.VideoModal({ entry, trigger, onClose() { closes++; cleanup(); } });
      cleanup = effects[0]();
      assert.equal(video.src, entry.source);
      assert.equal(document.activeElement, button);
      const section = tree.props.children;
      const player = section.props.children[1];
      assert.equal(player.props.controls, true);
      assert.equal(player.props.playsInline, true);
      assert.equal(player.props.autoPlay, undefined);
      tree.props.onClick({ target: {}, currentTarget: {} });
      assert.equal(closes, 0, "Clicking inside the dialog does not close it");
      if (action === "button") section.props.children[0].props.children[1].props.onClick();
      if (action === "backdrop") { const backdrop = {}; tree.props.onClick({ target: backdrop, currentTarget: backdrop }); }
      if (action === "Escape") keydown({ key: "Escape", preventDefault() {}, stopPropagation() {} });
      assert.equal(closes, 1);
      assert.equal(video.pauses, 1);
      assert.equal(video.src, undefined);
      assert.equal(video.loads, 2);
      assert.equal(document.activeElement, trigger);
      assert.equal(keydown, null);
    } finally { if (keydown) cleanup?.(); globalThis.document = previous; }
  }
});

test("thumbnail drops poster for decoded frame, keeps explicit error fallback and invents none", () => {
  const entry = helpers.videoPreviewEntries([block(VIDEO_FIXTURE_SOURCE)])[0];
  for (const phase of ["idle", "loading", "ready", "error"]) {
    const state = phase === "ready" ? { phase, width: 1920, height: 1080 } : { phase };
    const bound = presentationHelpers({ useState: () => [state, () => {}], useRef: () => ({ current: null }), useEffect() {} });
    const node = bound.VideoThumbnail({ source: entry.source, poster: entry.poster });
    const video = node.props.children[0];
    assert.equal(video.props.src, undefined);
    assert.equal(video.props.poster, phase === "ready" ? undefined : entry.poster);
    assert.equal(video.props.autoPlay, undefined);
    assert.equal(video.props.muted, true);
    assert.equal(video.props.playsInline, true);
    if (phase === "ready") assert.equal(node.props.style.aspectRatio, "1920 / 1080");
    if (phase === "error") assert.equal(React.Children.toArray(node.props.children[1].props.children).find(child => React.isValidElement(child) && child.type === "img").props.src, entry.poster);
    const noPoster = bound.VideoThumbnail({ source: entry.source });
    assert.equal(Boolean(noPoster.props.children[1]), false);
    assert.equal(noPoster.props.children[0].props.poster, undefined);
  }
});

test("unmounted never-visible card cannot initialize after a late observer callback", () => {
  const previous = globalThis.IntersectionObserver;
  const observers = [];
  globalThis.IntersectionObserver = class {
    constructor(callback) { this.callback = callback; observers.push(this); }
    observe() {} disconnect() {}
  };
  try {
    const video = fakeVideo(); const states = [];
    const dispose = helpers.observeVideoPreview(video, {}, "old", state => states.push(state));
    dispose(); observers[0].callback([{ isIntersecting: true }]);
    assert.equal(video.loads, 0); assert.equal(video.src, undefined); assert.deepEqual(states, []);
  } finally { globalThis.IntersectionObserver = previous; }
});

test("zero duration uses decoded data without out-of-bounds seek; metadata timeout is neutral", () => {
  const video = fakeVideo(); video.duration = 0; video.readyState = 1;
  const states = []; const dispose = helpers.startVideoPreview(video, "still", state => states.push(state));
  try {
    video.emit("loadedmetadata"); assert.equal(video.currentTime, 0);
    video.readyState = 2; video.emit("loadeddata"); assert.equal(states.at(-1).phase, "ready");
  } finally { dispose(); }
  const previousSet = globalThis.setTimeout, previousClear = globalThis.clearTimeout;
  let timeout;
  globalThis.setTimeout = fn => { timeout = fn; return 1; };
  globalThis.clearTimeout = () => {};
  const stalled = fakeVideo(); const stalledStates = [];
  const cleanup = helpers.startVideoPreview(stalled, "stalled", state => stalledStates.push(state));
  try {
    timeout(); assert.deepEqual(stalledStates.at(-1), { phase: "error" });
    assert.equal(stalled.src, undefined, "Timeout terminates the media resource");
    assert.ok(stalled.pauses > 0);
  } finally { cleanup(); globalThis.setTimeout = previousSet; globalThis.clearTimeout = previousClear; }
});
