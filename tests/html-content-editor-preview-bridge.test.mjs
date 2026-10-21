import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import vm from "node:vm";
import test from "node:test";

registerHooks({ resolve(specifier, context, next) {
  try { return next(specifier, context); } catch (error) {
    if (specifier.startsWith(".") && context.parentURL && existsSync(new URL(`${specifier}.ts`, context.parentURL))) return next(`${specifier}.ts`, context);
    throw error;
  }
} });
const { validatePreviewMessage, sendPreviewCommand } = await import("../app/lib/html-content-editor/preview-bridge.ts");
const { installPreviewRuntime, installPreviewMouseDragGuard, buildLivePreview } = await import("../app/lib/html-content-editor/preview-runtime.ts");
const { createBlockSource, createSourceFragment } = await import("../app/lib/html-content-editor/block-source.ts");
const { createLiveSliderNavigation } = await import("../app/lib/html-content-editor/preview-slider-navigation.ts");

const registry = new Map([['a', { entityIds: new Set(['title']), widgets: new Map([['a::slider', 3]]) }], ['b', { entityIds: new Set(['title']), widgets: new Map() }]]);
const frame = {};
const event = payload => ({ source: frame, data: { channel: 'tinymods-preview', instanceId: 'current', payload } });

test("bridge selects Block 2 even when Block 1 has the same entity ID", () => {
  assert.deepEqual(validatePreviewMessage(event({ type: 'select', blockId: 'b', entityId: 'title' }), frame, 'current', registry), { type: 'select', blockId: 'b', entityId: 'title' });
});

test("bridge rejects foreign/stale/malformed messages, IDs, bounds and executable requests", () => {
  const valid = event({ type: 'select', blockId: 'a', entityId: 'title' });
  for (const input of [
    { ...valid, source: {} }, { ...valid, data: null },
    { ...valid, data: { ...valid.data, instanceId: 'old' } },
    event({ type: 'select', blockId: 'c', entityId: 'title' }),
    event({ type: 'select', blockId: 'a', entityId: 'missing' }),
    event({ type: 'eval', code: 'parent.document.body.remove()' }),
    event({ type: 'sliders', sliders: [null] }),
    event({ type: 'sliders', sliders: [{ blockId: 'a', widgetGroupId: 'a::slider', count: 3, index: 3, top: 100 }] }),
    event({ type: 'sliders', sliders: [{ blockId: 'a', widgetGroupId: 'a::slider', count: 3, index: 0, top: Infinity }] }),
    event({ type: 'sliders', sliders: [{ blockId: 'b', widgetGroupId: 'a::slider', count: 3, index: 0, top: 100 }] }),
  ]) assert.equal(validatePreviewMessage(input, frame, 'current', registry), null);
});

test("outgoing commands have fixed channel/instance and no executable payload", () => {
  const sent = [];
  sendPreviewCommand({ postMessage: (...args) => sent.push(args) }, 'id', { type: 'slide', blockId: 'a', widgetGroupId: 'a::slider', index: 1 });
  assert.deepEqual(sent[0], [{ channel: 'tinymods-preview-command', instanceId: 'id', payload: { type: 'slide', blockId: 'a', widgetGroupId: 'a::slider', index: 1 } }, '*']);
});

test("runtime serialization is self-contained, routes clicks and cleans listeners on teardown", () => {
  const listeners = new Map();
  const sent = [];
  let disconnected = 0;
  let intervals = 0;
  class TestElement { contains(target) { return target === this; } closest() { return null; } }
  const element = new TestElement();
  const document = {
    body: {}, createTreeWalker: () => ({ nextNode: () => null }),
    querySelector: () => element, querySelectorAll: () => [],
    addEventListener: (type, handler) => listeners.set('document:' + type, handler),
    removeEventListener: type => listeners.delete('document:' + type),
  };
  const window = {
    document, parent: { postMessage: message => sent.push(message) },
    addEventListener: (type, handler) => listeners.set(type, handler),
    removeEventListener: type => listeners.delete(type),
    setInterval: () => ++intervals, clearInterval: () => --intervals,
  };
  const context = vm.createContext({ window, NodeFilter: { SHOW_COMMENT: 128 }, Element: TestElement, ResizeObserver: class { observe() {} disconnect() { disconnected++; } }, MutationObserver: class { observe() {} disconnect() {} } });
  // Use the actual production function after TypeScript stripping, not a copied runtime.
  vm.runInContext('(' + installPreviewRuntime.toString() + ')("id",[{blockId:"b",markers:[{entityId:"title",previewId:"tm-1"}],sliders:[]}],()=>({positions:()=>[],goToSlide:()=>{}}))', context);
  assert.equal(sent[0].payload.type, 'ready');
  assert.equal(intervals, 1);
  listeners.get('document:click')({ target: element });
  assert.equal(sent.at(-1).payload.type, 'select');
  assert.equal(sent.at(-1).payload.blockId, 'b');
  assert.equal(sent.at(-1).payload.entityId, 'title');
  const cleanup = listeners.get('pagehide');
  cleanup();
  assert.equal(intervals, 0);
  assert.equal(disconnected, 1);
  assert.ok(!listeners.has('message'));
  assert.ok(!listeners.has('document:click'));
});

test("live slider delegates to the user's real JS control once and creates no internal controls", () => {
  let clicks = 0;
  const root = {
    querySelectorAll: selector => selector.includes('data-go-to') ? [{ click: () => clicks++, closest: () => root }] : [],
    getAttribute: () => 'a::slider', getClientRects: () => [1],
    getBoundingClientRect: () => ({ top: 100, bottom: 300 }),
  };
  const document = { querySelector: () => ({}), defaultView: { innerHeight: 900, getComputedStyle: () => ({}) }, querySelectorAll: selector => selector.includes('slider-root') ? [root] : [] };
  const controller = createLiveSliderNavigation(document, [{ id: 'a::slider', slides: [{ id: 'one' }, { id: 'two' }] }]);
  controller.goToSlide('a::slider', 1);
  assert.equal(clicks, 1);
  assert.equal(controller.positions()[0].top, 200);
});

test("the assembled user slider and Site JS execute once in original order", () => {
  const item = createBlockSource('a');
  item.fragments = [
    '<div id="slider"></div>',
    '<script>window.order=["block"]; window.slider={next(){window.slide=(window.slide||0)+1;}};</script>',
  ].map((source, index) => ({ ...createSourceFragment(String(index)), source, draft: source, originalSource: source, loaded: true }));
  const preview = buildLivePreview([item], { css: '', js: 'window.order.push("site"); window.slider.next();' }, 'id');
  const context = vm.createContext({ window: { addEventListener() {}, removeEventListener() {} }, document: { addEventListener() {} } });
  for (const script of preview.source.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) vm.runInContext(script[1], context);
  assert.deepEqual(Array.from(context.window.order), ['block', 'site']);
  assert.equal(context.window.slide, 1);
});

test("editor config uses one opaque-origin iframe and no direct runtime DOM access", () => {
  const source = readFileSync(new URL('../app/components/html-content-editor/HtmlContentEditor.tsx', import.meta.url), 'utf8');
  assert.equal((source.match(/<iframe\b/g) ?? []).length, 1);
  assert.ok(source.includes('sandbox="allow-scripts"'));
  assert.ok(!source.includes('allow-same-origin'));
  assert.ok(!source.includes('contentDocument'));
  assert.ok(source.includes('window.removeEventListener("message", receive)'));
  assert.ok(source.includes('position.top * previewScale'));
});

test("bridge accepts boolean navigation capabilities and rejects missing or forged capabilities", () => {
  const position = { blockId: "a", widgetGroupId: "a::slider", count: 3, index: 0, top: 100, canPrev: false, canNext: true };
  const payload = { type: "sliders", sliders: [position] };
  assert.deepEqual(validatePreviewMessage(event(payload), frame, "current", registry), payload);
  for (const invalid of [{ ...position, canNext: "true" }, { ...position, canPrev: undefined }]) assert.equal(validatePreviewMessage(event({ type: "sliders", sliders: [invalid] }), frame, "current", registry), null);
});

test("six cards / four visible report real scroll limits and viewport center; native controls own movement", () => {
  let nextClicks = 0, prevClicks = 0;
  const viewport = { scrollWidth: 600, clientWidth: 400, clientLeft: 0, scrollLeft: 0, getBoundingClientRect: () => ({ left: 0, top: 300, bottom: 700 }) };
  const prev = { matches: () => viewport.scrollLeft <= 0, closest: () => root, click: () => { prevClicks++; viewport.scrollLeft = Math.max(0, viewport.scrollLeft - 100); } };
  const next = { matches: () => viewport.scrollLeft >= 200, closest: () => root, click: () => { nextClicks++; viewport.scrollLeft = Math.min(200, viewport.scrollLeft + 100); } };
  const root = { getAttribute: () => "b::slider", getClientRects: () => [1], getBoundingClientRect: () => ({ top: 0, bottom: 900 }), querySelectorAll: selector => selector.includes("data-go-to") ? [] : selector.includes("data-next") ? [next] : selector.includes("data-prev") ? [prev] : [] };
  const slides = Array.from({ length: 6 }, (_, index) => ({ getAttribute: () => "b::slide-" + index, matches: () => false, getBoundingClientRect: () => ({ left: index * 100 - viewport.scrollLeft, width: 100 }) }));
  const markedViewport = { ...viewport, getAttribute: () => "b::slider" };
  // Keep scrollLeft live on the marked viewport, just as a real DOM element.
  Object.defineProperty(markedViewport, "scrollLeft", { get: () => viewport.scrollLeft });
  const document = { querySelector: () => ({}), defaultView: { innerHeight: 900, getComputedStyle: () => ({}) }, querySelectorAll: selector => selector.includes("slider-root") ? [root] : selector.includes("slider-viewport") ? [markedViewport] : selector.includes("slider-slide") ? slides : [] };
  const group = { id: "b::slider", viewportRange: {}, slides: slides.map((_, index) => ({ id: "b::slide-" + index })) };
  const controller = createLiveSliderNavigation(document, [group]);
  let position = controller.positions()[0];
  assert.equal(position.top, 500); assert.equal(position.index, 0);
  assert.equal(position.canPrev, false); assert.equal(position.canNext, true);
  controller.goToSlide("foreign", 1); assert.equal(nextClicks, 0);
  controller.goToSlide("b::slider", -1); assert.equal(prevClicks, 0);
  controller.goToSlide("b::slider", 1);
  position = controller.positions()[0]; assert.equal(position.index, 1); assert.equal(position.canPrev, true); assert.equal(position.canNext, true);
  controller.goToSlide("b::slider", 2);
  position = controller.positions()[0]; assert.equal(position.index, 2); assert.equal(position.canNext, false); assert.equal(position.canPrev, true);
  controller.goToSlide("b::slider", 5); assert.equal(nextClicks, 2); assert.equal(prevClicks, 0);
  controller.goToSlide("b::slider", 1); assert.equal(prevClicks, 1);
  viewport.scrollLeft = 10; controller.goToSlide("b::slider", 0); assert.equal(viewport.scrollLeft, 0);
});

test("runtime routes an active next command to the exact block and slider controller", () => {
  const listeners = new Map(), calls = [];
  const document = { createTreeWalker: () => ({ nextNode: () => null }), querySelector: () => null, addEventListener() {}, body: null };
  const parent = { postMessage() {} };
  const window = { document, parent, addEventListener: (name, handler) => listeners.set(name, handler), setInterval: () => 1 };
  const context = vm.createContext({ window, NodeFilter: { SHOW_COMMENT: 128 }, ResizeObserver: class {}, MutationObserver: class {}, factory: (_, groups) => ({ positions: () => [], goToSlide: (id, index) => calls.push([groups[0].id, id, index]) }) });
  const blocks = [{ blockId: "a", markers: [], sliders: [{ id: "a::slider" }] }, { blockId: "b", markers: [], sliders: [{ id: "b::slider" }] }];
  vm.runInContext("(" + installPreviewRuntime.toString() + ")(\"id\"," + JSON.stringify(blocks) + ",factory)", context);
  const payload = { type: "slide", blockId: "b", widgetGroupId: "b::slider", index: 1 };
  const target = { postMessage: message => listeners.get("message")({ source: parent, data: message }) };
  sendPreviewCommand(target, "id", payload);
  assert.deepEqual(calls, [["b::slider", "b::slider", 1]]);
  sendPreviewCommand(target, "stale", payload); assert.equal(calls.length, 1);
});


test("mouse drag guard precedes user handlers, preserves click selection, and cleans up", () => {
  const listeners = new Map(), sent = [];
  class TestElement {
    constructor(parent = null, viewport = false) { this.parent = parent; this.viewport = viewport; }
    closest(selector) {
      if (selector === '[data-tinymods-slider-viewport]') return this.viewport ? this : this.parent?.closest(selector) ?? null;
      return null;
    }
    contains(target) { return target === this || Boolean(target?.parent && this.contains(target.parent)); }
  }
  const viewport = new TestElement(null, true);
  const heading = new TestElement(viewport), accent = new TestElement(heading), image = new TestElement(viewport);
  viewport.scrollLeft = 0;
  let captures = 0, userDown = 0;
  const add = (name, fn, capture = false) => { const list = listeners.get(name) ?? []; list.push({ fn, capture }); listeners.set(name, list); };
  const remove = (name, fn) => listeners.set(name, (listeners.get(name) ?? []).filter(item => item.fn !== fn));
  const document = {
    body: null, createTreeWalker: () => ({ nextNode: () => null }),
    querySelector: selector => selector.includes('tm-1') ? heading : image,
    querySelectorAll: () => [], addEventListener: (name, fn) => add('document:' + name, fn), removeEventListener: (name, fn) => remove('document:' + name, fn),
  };
  const window = { document, parent: { postMessage: value => sent.push(value) }, addEventListener: add, removeEventListener: remove, setInterval: () => 1, clearInterval() {} };
  const context = vm.createContext({ window, Element: TestElement, NodeFilter: { SHOW_COMMENT: 128 }, ResizeObserver: class { disconnect() {} }, MutationObserver: class { disconnect() {} } });
  vm.runInContext('(' + installPreviewMouseDragGuard.toString() + ')()', context);
  add('pointerdown', () => { userDown++; captures++; });
  add('pointermove', () => { viewport.scrollLeft += 100; });
  vm.runInContext('(' + installPreviewRuntime.toString() + ')("id",[{blockId:"a",markers:[{entityId:"title",previewId:"tm-1"},{entityId:"image",previewId:"tm-2"}],sliders:[]}],()=>({positions:()=>[],goToSlide:()=>{}}))', context);
  function dispatch(type, target, options = {}) {
    const event = { type, target, pointerType: 'mouse', pointerId: 1, button: 0, stopped: false, prevented: false,
      stopImmediatePropagation() { this.stopped = true; }, preventDefault() { this.prevented = true; }, ...options };
    for (const { fn } of listeners.get(type) ?? []) { fn(event); if (event.stopped) break; }
    if (!event.stopped) for (const { fn } of listeners.get('document:' + type) ?? []) fn(event);
    return event;
  }
  const down = dispatch('pointerdown', accent);
  assert.equal(down.stopped, true); assert.equal(down.prevented, false);
  dispatch('pointermove', accent);
  assert.equal(viewport.scrollLeft, 0); assert.equal(captures, 0); assert.equal(userDown, 0);
  dispatch('pointerup', accent);
  dispatch('click', accent);
  assert.equal(sent.at(-1).payload.entityId, 'title');
  dispatch('click', image);
  assert.equal(sent.at(-1).payload.entityId, 'image');
  assert.equal(dispatch('dragstart', image).prevented, true);
  assert.equal(dispatch('pointerdown', accent, { pointerType: 'touch' }).stopped, false);
  const outside = new TestElement();
  assert.equal(dispatch('pointerdown', outside).stopped, false);
  dispatch('pagehide', outside);
  assert.equal((listeners.get('pointerdown') ?? []).length, 1); // only user's listener
  assert.equal((listeners.get('blur') ?? []).length, 0);
});

test("guard and cursor override are preview-only; exported slider keeps mouse code", async () => {
  const { exportBlock } = await import('../app/lib/html-content-editor/block-assembly.ts');
  const source = '<section class="slider"><div class="slider-viewport"><div class="slider-track"><article>One</article><article>Two</article></div></div></section><script>window.userStarted=true;</script>';
  const item = { ...createBlockSource('a'), fragments: [{ ...createSourceFragment('f'), loaded: true, source, draft: source, originalSource: source }] };
  const preview = buildLivePreview([item], { css: '', js: 'window.siteStarted=true;' }, 'id');
  assert.ok(preview.source.indexOf('installPreviewMouseDragGuard') < preview.source.indexOf('window.userStarted=true'));
  assert.ok(preview.source.includes('[data-tinymods-slider-viewport] *{cursor:default!important}'));
  assert.equal(exportBlock(item), source);
  const fixture = readFileSync(new URL('./fixtures/html-content-editor/responsive-slider.html', import.meta.url), 'utf8');
  const real = { ...item, fragments: [{ ...item.fragments[0], source: fixture, draft: fixture, originalSource: fixture }] };
  assert.equal(exportBlock(real), fixture);
  assert.ok(fixture.includes('setPointerCapture'));
  assert.ok(fixture.includes("'pointerdown'"));
});
