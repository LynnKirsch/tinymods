import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { registerHooks } from "node:module";
import test from "node:test";

registerHooks({ resolve(specifier, context, next) {
  try { return next(specifier, context); } catch (error) {
    if (specifier.startsWith(".") && context.parentURL && existsSync(new URL(`${specifier}.ts`, context.parentURL))) return next(`${specifier}.ts`, context);
    throw error;
  }
} });
const { createBlockSource, createSourceFragment, editorEntityKey, reorderFragments } = await import("../app/lib/html-content-editor/block-source.ts");
const { assembleBlock, blockHasInvalidContent, editedBlockAnalysis, isBlockContentDirty, commitBlockEdits, detectFragmentType, exportBlock, exportPage, routeBlockPatches } = await import("../app/lib/html-content-editor/block-assembly.ts");
const { extractEditableEntities } = await import("../app/lib/html-content-editor/extract-editable-entities.ts");
const { detectSliderGroups } = await import("../app/lib/html-content-editor/slider-groups.ts");
const { buildLivePreview } = await import("../app/lib/html-content-editor/preview-runtime.ts");

test("empty and length-changing edits retain original marker IDs, including Block 2", () => {
  const items = [block("a", ['<h2>First</h2><p>Second</p>']), block("b", ['<h2>First</h2><p>Second</p>'])];
  const entities = extractEditableEntities(assembleBlock(items[1]).source);
  items[1].values[editorEntityKey("b", entities[0].id)] = "";
  items[1].values[editorEntityKey("b", entities[1].id)] = "A much longer second paragraph";
  const preview = buildLivePreview(items, { css: "", js: "" }, "id");
  assert.deepEqual(preview.runtimeBlocks[1].markers.map(marker => marker.entityId), entities.map(entity => entity.id));
  assert.ok(preview.source.includes('<h2><!--tinymods-preview-start:block-2-tm-1--><!--tinymods-preview-end:block-2-tm-1--></h2>'));
  assert.ok(preview.source.includes('<!--tinymods-preview-start:block-2-tm-2-->A much longer second paragraph<!--tinymods-preview-end:block-2-tm-2-->'));
});

function block(id, sources) {
  return { ...createBlockSource(id), fragments: sources.map((source, index) => ({ ...createSourceFragment(`${id}-${index}`), source, draft: source, originalSource: source, loaded: true })) };
}
const slider = '<section class="carousel"><div class="carousel-track"><article class="card"><h2>One</h2></article><article class="card"><h2>Two</h2></article></div></section>';

test("one block / one fragment preserves raw whitespace and comments", () => {
  const source = '<!-- keep -->\n<style>.x { color: red; }</style>\n<h2>В лесу и на берегу</h2>\n';
  const item = block("a", [source]);
  assert.equal(assembleBlock(item).source, source);
  assert.equal(exportBlock(item), source);
  assert.equal(exportPage([item], { css: "", js: "" }), source);
});

test("three fragments keep CSS / HTML / JS order; raw block export has no added wrappers", () => {
  const sources = ['.card { color: red; }', slider, 'window.sliderRuns = (window.sliderRuns || 0) + 1;'];
  const item = block("a", sources);
  const assembly = assembleBlock(item);
  assert.equal(exportBlock(item), sources.join("\n"));
  assert.ok(assembly.source.indexOf("<style>") < assembly.source.indexOf(slider));
  assert.ok(assembly.source.indexOf(slider) < assembly.source.indexOf("<script>"));
  assert.equal(detectSliderGroups(assembly.source, extractEditableEntities(assembly.source)).length, 1);
  assert.deepEqual(item.fragments.map(fragment => fragment.source), sources);
});

test("ambiguous auto preserves raw source without requesting manual classification", () => {
  assert.equal(detectFragmentType("something unknown"), null);
  const item = block("a", ["something unknown"]);
  assert.equal(assembleBlock(item).source, "something unknown");
  assert.equal(exportPage([item], { css: "", js: "" }), "something unknown");
  assert.ok(buildLivePreview([item], { css: "", js: "" }, "ambiguous").source.includes("something unknown"));
});

test("content patches route to the correct raw fragment and cannot cross boundaries", () => {
  const item = block("a", ['.x{color:red}', '<h2>First</h2>', '<p>Second</p>']);
  const assembly = assembleBlock(item);
  const entity = extractEditableEntities(assembly.source).find(entity => entity.displayValue === "Second");
  item.values[editorEntityKey(item.id, entity.id)] = "Longer & second";
  assert.equal(exportBlock(item), '.x{color:red}\n<h2>First</h2>\n<p>Longer &amp; second</p>');
  const committed = commitBlockEdits(item);
  assert.equal(committed.fragments[0].source, item.fragments[0].source);
  assert.equal(committed.fragments[1].source, item.fragments[1].source);
  assert.equal(committed.fragments[2].source, '<p>Longer &amp; second</p>');
  assert.throws(() => routeBlockPatches(item, [{ start: assembly.ranges[0].start, end: assembly.ranges[1].end, replacement: "bad" }]), /boundary/);
});

test("reorder commits edits before changing offsets and preserves fragment identity", () => {
  const item = block("a", ['<h2>One</h2>', '<p>Two</p>', '<script>window.done=true;</script>']);
  const entity = extractEditableEntities(assembleBlock(item).source)[0];
  item.values[editorEntityKey(item.id, entity.id)] = "Edited";
  const reordered = reorderFragments(commitBlockEdits(item), "a-0", 1);
  assert.deepEqual(reordered.fragments.map(fragment => fragment.id), ["a-1", "a-0", "a-2"]);
  assert.equal(exportBlock(reordered), '<p>Two</p>\n<h2>Edited</h2>\n<script>window.done=true;</script>');
});

test("two and three blocks have independent entity namespaces under shared site CSS / JS", () => {
  const items = [block("a", ['<h2 class="clinic">Title</h2>']), block("b", ['<h2 class="clinic">Title</h2>']), block("c", ['<h2 class="clinic">Title</h2>'])];
  const entityId = extractEditableEntities(assembleBlock(items[0]).source)[0].id;
  items[1].values[editorEntityKey("b", entityId)] = "Block two";
  const context = { css: '.clinic { color: red; }', js: 'window.siteRuns = 1;' };
  for (const count of [2, 3]) {
    const output = exportPage(items.slice(0, count), context);
    assert.equal((output.match(/class="clinic"/g) ?? []).length, count);
    assert.ok(output.indexOf("<style>") < output.indexOf("<h2"));
    assert.ok(output.indexOf("window.siteRuns") > output.lastIndexOf("</h2>"));
    assert.equal((output.match(/Block two/g) ?? []).length, 1);
    assert.ok(!/tinymods|data-tinymods|runtime|arrows/.test(output));
  }
  const preview = buildLivePreview(items, context, "instance");
  assert.equal(preview.registry.size, 3);
  assert.equal(preview.runtimeBlocks[1].markers[0].entityId, entityId);
  assert.notEqual(preview.runtimeBlocks[0].markers[0].previewId, preview.runtimeBlocks[1].markers[0].previewId);
});

test("live JS runs once without static widget conversion or typography transformation", () => {
  const source = '<div id="widget"></div><script>const root=document.querySelector("#widget"); root.innerHTML = `<p>В лесу и на берегу</p>`; window.runs=(window.runs||0)+1;</script>';
  const preview = buildLivePreview([block("a", [source])], { css: "", js: "" }, "one");
  assert.equal((preview.source.match(/window.runs=/g) ?? []).length, 1);
  assert.ok(preview.source.includes("root.innerHTML"));
  assert.ok(!preview.source.includes("\u00a0"));
  assert.ok(!preview.source.includes("tinymods-preview-content-visible"));
  assert.ok(!preview.source.includes("installPreviewTypography"));
  assert.equal(exportBlock(block("a", [source])), source);
});

test("synthetic slider acceptance fixture preserves equivalent whole/split order and shared page context", () => {
  const source = readFileSync(new URL("./fixtures/html-content-editor/responsive-slider.html", import.meta.url), "utf8");
  const tags = [...source.matchAll(/<(?:style|script)\b[^>]*>[\s\S]*?<\/(?:style|script)>/gi)];
  assert.ok(tags.length >= 2);
  const splitAt = tags[0].index + tags[0][0].length;
  const second = tags.find(tag => tag.index > splitAt && tag[0].startsWith("<script"));
  const splitEnd = second?.index ?? Math.floor((source.length + splitAt) / 2);
  // Only split at complete resource boundaries: fragments remain ordinary HTML.
  const pieces = [source.slice(0, splitAt), source.slice(splitAt, splitEnd), source.slice(splitEnd)];
  const whole = block("a", [source]);
  const split = block("a", pieces);
  assert.equal(exportBlock(split).replace(/\r?\n/g, ""), exportBlock(whole).replace(/\r?\n/g, ""));
  const normalized = value => value.replace(/\r?\n/g, "");
  assert.equal(normalized(assembleBlock(split).source), normalized(source));
  const wholePreview = buildLivePreview([whole], { css: "", js: "" }, "whole");
  const splitPreview = buildLivePreview([split], { css: "", js: "" }, "split");
  const styles = value => [...value.matchAll(/<style(?! data-tinymods-runtime-style)[^>]*>([\s\S]*?)<\/style>/gi)].map(match => normalized(match[1]));
  assert.deepEqual(styles(wholePreview.source), styles(splitPreview.source));
  assert.equal(wholePreview.runtimeBlocks[0].sliders[0].slides.length, splitPreview.runtimeBlocks[0].sliders[0].slides.length);
  const page = exportPage([split, block("b", ['<section class="clinic">Two</section>']), block("c", ['<section class="clinic">Three</section>'])], { css: '.clinic{--acceptance:1}', js: 'window.acceptance=true;' });
  assert.ok(page.indexOf("--acceptance") < page.indexOf(source.slice(0, 20)));
  assert.ok(page.indexOf("Two</section>") < page.indexOf("Three</section>"));
  assert.ok(page.endsWith('window.acceptance=true;\n</script>'));
});

test("first unloaded fragment draft survives commit, load, subsequent commits and block operations", () => {
  const source = '<style>.first{color:red}</style>\n<h2 class="first">First loaded code</h2>\n<script>window.firstRuns=1;</script>';
  let first = createBlockSource("first");
  first.fragments[0].draft = source;
  const committed = commitBlockEdits(first);
  assert.equal(committed.fragments[0].draft, source);
  assert.equal(committed.fragments[0].source, "");
  assert.equal(committed.fragments[0].loaded, false);
  // The same commit -> load mapping used by the component load handler.
  first = { ...committed, fragments: committed.fragments.map(item => ({ ...item, source: item.draft, originalSource: item.draft, loaded: true })) };
  assert.equal(first.fragments[0].source, source);
  assert.equal(first.fragments[0].draft, source);
  assert.equal(first.fragments[0].originalSource, source);
  assert.equal(assembleBlock(first).source, source);
  const extra = { ...createSourceFragment("extra"), draft: ".extra{color:blue}" };
  first = commitBlockEdits({ ...first, fragments: [...first.fragments, extra] });
  assert.equal(first.fragments[1].draft, extra.draft);
  first = reorderFragments(first, "extra", -1);
  const items = [first, block("second", ["<h2>Second</h2>"])];
  const preview = buildLivePreview(items, { css: ".first{font-weight:700}", js: "window.siteRuns=1;" }, "loaded");
  assert.ok(preview.source.includes("First loaded code"));
  assert.ok(preview.source.includes("window.firstRuns=1;"));
  assert.ok(preview.source.includes("window.siteRuns=1;"));
  assert.equal(preview.registry.size, 2);
  assert.equal(items[0].fragments.find(fragment => fragment.id === first.fragments[1].id).source, source);
  assert.equal(commitBlockEdits(items[0]).fragments.find(fragment => fragment.id === "extra").draft, extra.draft);
});

test("complete HTML CSS JS fragment stays raw and ordered; pure fragments get assembly-only wrappers", () => {
  const raw = '<style>.box{color:red}</style>\n<div class="box">Whole</div>\n<script>window.whole=1;</script>';
  for (const source of [raw, "<!-- keep -->\n" + raw]) {
    const item = block("whole", [source]);
    assert.equal(assembleBlock(item).source, source);
    assert.equal(exportBlock(item), source);
    assert.equal(exportPage([item], { css: "", js: "" }), source);
  }
  for (const [rawSource, tag] of [[".box{color:blue}", "style"], ["window.extra=1;", "script"]]) {
    const item = block(tag, [rawSource]);
    assert.equal(assembleBlock(item).source, "<" + tag + ">\n" + rawSource + "\n</" + tag + ">");
    assert.equal(exportBlock(item), rawSource);
    assert.equal(item.fragments[0].source, rawSource);
    assert.ok(buildLivePreview([item], { css: "", js: "" }, tag).source.includes(rawSource));
  }
});

test("synthetic slider expected 1440 and 2560 geometry comes from user CSS without editor resets", () => {
  const source = readFileSync(new URL("./fixtures/html-content-editor/responsive-slider.html", import.meta.url), "utf8");
  const gutters = [...source.matchAll(/@media\s*\(min-width:\s*(\d+)px\)\s*\{\s*\.clinic\s*\{\s*--page-gutter:\s*(\d+)px;/g)].map(match => ({ min: Number(match[1]), gutter: Number(match[2]) }));
  const gapRule = source.match(/--grid-gap:\s*clamp\((\d+)px,\s*([\d.]+)vw,\s*(\d+)px\)/);
  assert.ok(gapRule); assert.ok(gutters.length >= 3);
  assert.match(source, /@media\s*\(min-width:\s*1440px\)[\s\S]*?\.clinic-slider__item[\s\S]*?\/\s*4/);
  for (const [width, expectedViewport, expectedCard] of [[1440, 1340, 317], [2560, 2320, 550]]) {
    const gutter = gutters.filter(rule => rule.min <= width).at(-1).gutter;
    const gap = Math.min(Number(gapRule[3]), Math.max(Number(gapRule[1]), width * Number(gapRule[2]) / 100));
    const viewport = width - 2 * gutter;
    const card = (viewport - 3 * gap) / 4;
    assert.equal(viewport, expectedViewport); assert.ok(Math.abs(card - expectedCard) < .01);
  }
  const preview = buildLivePreview([block("a", [source])], { css: "", js: "" }, "faithful");
  assert.ok(!/body\s*\{\s*margin:\s*0/.test(preview.source));
});


test("dirty is independent of context and survives commit and fragment reorder", () => {
  const a = block('a', ['<h2>Original</h2>', '<p>Second</p>']);
  const b = block('b', ['<h2>Other</h2>']);
  assert.equal(isBlockContentDirty(a), false);
  const entity = extractEditableEntities(assembleBlock(a).source)[0];
  a.values[editorEntityKey(a.id, entity.id)] = 'Edited';
  assert.equal(isBlockContentDirty(a), true);
  assert.equal(isBlockContentDirty(b), false);
  const committed = commitBlockEdits(a);
  assert.deepEqual(committed.values, {});
  assert.equal(isBlockContentDirty(committed), true);
  assert.equal(isBlockContentDirty(reorderFragments(committed, committed.fragments[0].id, 1)), true);
  assert.equal(isBlockContentDirty(reorderFragments(block('c', ['<h2>A</h2>', '<p>B</p>']), 'c-0', 1)), false);
  exportPage([a, b], { css: 'h2{color:red}', js: 'window.x=1;' });
  assert.equal(isBlockContentDirty(b), false);
  assert.equal(isBlockContentDirty(a), true);
  a.values[editorEntityKey(a.id, entity.id)] = 'Original';
  assert.equal(isBlockContentDirty(a), false);
  const reset = { ...committed, fragments: committed.fragments.map(fragment => ({ ...fragment, source: fragment.originalSource, draft: fragment.originalSource })), values: {} };
  assert.equal(isBlockContentDirty(reset), false);
});

test("reverting actual entity values cleans even after HTML entity spelling changed by commit", () => {
  const item = block('a', ['<p>A &#38; B</p>']);
  let entity = extractEditableEntities(assembleBlock(item).source)[0];
  item.values[editorEntityKey(item.id, entity.id)] = 'Changed';
  const committed = commitBlockEdits(item);
  entity = extractEditableEntities(assembleBlock(committed).source)[0];
  committed.values[editorEntityKey(item.id, entity.id)] = 'A & B';
  assert.equal(isBlockContentDirty(committed), false);
  assert.equal(isBlockContentDirty(commitBlockEdits(committed)), false);
});

test("dirty tracks text link image alt separately and source replacement starts clean", () => {
  for (const kind of ['text', 'href', 'src', 'alt']) {
    const item = block('a', ['<p>Text</p><a href="/x">Link</a><img src="/x.jpg" alt="A">']);
    const entity = extractEditableEntities(assembleBlock(item).source).find(entity => entity.kind === kind);
    item.values[editorEntityKey(item.id, entity.id)] = 'New';
    assert.equal(isBlockContentDirty(item), true, kind);
    item.values[editorEntityKey(item.id, entity.id)] = entity.displayValue;
    assert.equal(isBlockContentDirty(item), false, kind);
  }
  assert.equal(isBlockContentDirty(block('a', ['<h2>New replacement source</h2>'])), false);
});

test("copy exports edited current block fragments only and does not clear dirty", () => {
  const item = block('a', ['<style>.local{color:red}</style>', '<h2>Original</h2>', '<script>window.local=1;</script>']);
  const entity = extractEditableEntities(assembleBlock(item).source).find(entity => entity.kind === 'text');
  item.values[editorEntityKey(item.id, entity.id)] = 'Edited';
  const exported = exportBlock(item);
  assert.equal(exported, '<style>.local{color:red}</style>\n<h2>Edited</h2>\n<script>window.local=1;</script>');
  assert.equal(isBlockContentDirty(item), true);
  for (const artifact of ['data-tinymods', 'runtime', 'Site CSS', 'Other block']) assert.ok(!exported.includes(artifact));
});

test("invalid composite draft survives and cannot be committed or copied as saved code", () => {
  const item = block('a', ['<h2>AAAA<br>BBBB<span>CCCC</span>DDDD</h2>']);
  const entity = extractEditableEntities(assembleBlock(item).source)[0];
  const key = editorEntityKey(item.id, entity.id);
  item.values[key] = 'AAAA\nXYZ';
  item.values[key + '::valid'] = entity.displayValue.replace('CCCC', 'CC Longer CC');
  assert.equal(blockHasInvalidContent(item), true);
  assert.equal(commitBlockEdits(item), item);
  assert.equal(item.values[key], 'AAAA\nXYZ');
  assert.throws(() => exportBlock(item), /форматирования/);
  const analysis = editedBlockAnalysis(item);
  assert.equal(analysis.source, item.fragments[0].source.replace('CCCC', 'CC Longer CC'));
  item.values[key] = entity.displayValue.replace('CCCC', 'CC Valid CC');
  delete item.values[key + '::valid'];
  assert.equal(blockHasInvalidContent(item), false);
  assert.equal(exportBlock(item), item.fragments[0].source.replace('CCCC', 'CC Valid CC'));
});

test("composite length changes remap owner and segments while preserving entity IDs", () => {
  const item = block('a', ['<h2>Before <span class="accent">Short</span> after</h2><p>Next</p>']);
  const entities = extractEditableEntities(assembleBlock(item).source);
  item.values[editorEntityKey(item.id, entities[0].id)] = entities[0].displayValue.replace('Short', 'Considerably longer');
  const analysis = editedBlockAnalysis(item);
  assert.deepEqual(analysis.entities.map(entity => entity.id), entities.map(entity => entity.id));
  for (const entity of analysis.entities) assert.equal(analysis.source.slice(entity.range.start, entity.range.end), entity.rawValue);
  assert.equal(analysis.source.slice(analysis.entities[1].range.start, analysis.entities[1].range.end), 'Next');
  const span = analysis.entities[0].composite.segments.find(segment => segment.displayValue === 'Short');
  assert.equal(analysis.source.slice(span.range.start, span.range.end), 'Considerably longer');
  const preview = buildLivePreview([item], { css: '', js: '' }, 'id');
  assert.ok(preview.source.includes('<h2 data-tinymods-preview-ids="block-1-tm-1">Before <span class="accent">Considerably longer</span> after</h2>'));
});

test("composite static JS template editing retains template syntax and parent marker", () => {
  const source = '<script>const root=document.createElement("div"); root.innerHTML = `<h2>Title <span>Accent</span></h2>`; document.body.appendChild(root);</script>';
  const item = block('a', [source]);
  const entity = extractEditableEntities(source).find(entity => entity.composite);
  assert.ok(entity);
  item.values[editorEntityKey(item.id, entity.id)] = 'Title New Accent';
  assert.equal(exportBlock(item), source.replace('>Accent<', '>New Accent<'));
  const preview = buildLivePreview([item], { css: '', js: '' }, 'id');
  assert.ok(preview.source.includes('<h2 data-tinymods-preview-ids="block-1-tm-1">Title <span>New Accent</span></h2>'));
});


test("actual Content render shows one composite field and per-block dirty copy with invalid draft feedback", async () => {
  const ts = await import('typescript');
  const React = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { createRequire } = await import('node:module');
  const file = new URL('../app/components/html-content-editor/HtmlContentEditor.tsx', import.meta.url);
  const source = readFileSync(file, 'utf8');
  const ast = ts.createSourceFile('editor.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const names = [], bindings = [];
  for (const declaration of ast.statements.filter(ts.isImportDeclaration)) {
    const clause = declaration.importClause;
    if (!clause || clause.isTypeOnly) continue;
    const specifier = declaration.moduleSpecifier.text;
    const module = specifier.endsWith('.css') ? { default: new Proxy({}, { get: (_, key) => key }) }
      : await import(specifier.startsWith('.') ? new URL(specifier + '.ts', file).href : specifier);
    if (clause.name) { names.push(clause.name.text); bindings.push(module.default); }
    for (const item of clause.namedBindings?.elements ?? []) if (!item.isTypeOnly) {
      names.push(item.name.text); bindings.push(module[item.propertyName?.text ?? item.name.text]);
    }
  }
  const declarations = ast.statements.filter(node => !ts.isImportDeclaration(node)).map(node => node.getText(ast)).join('\n') + '\nexport { BlockFields };';
  const output = ts.transpileModule(declarations, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports = {};
  new Function('exports', 'require', ...names, output)(exports, createRequire(import.meta.url), ...bindings);
  const render = item => renderToStaticMarkup(React.createElement(exports.BlockFields, { block: item, index: 0, selected: null, onChange() {}, send() {} }));
  const item = block('a', ['<h2>Before<br>text <span class="accent">Accent</span> after</h2>']);
  const entity = extractEditableEntities(assembleBlock(item).source)[0];
  const clean = render(item);
  assert.equal((clean.match(/<textarea/g) ?? []).length, 1);
  assert.ok(!clean.includes('copyBlockCode'));
  assert.ok(!clean.includes('disabled="" class="primaryButton"'));
  const key = editorEntityKey(item.id, entity.id);
  item.values[key] = entity.displayValue.replace('Accent', 'Changed');
  const dirty = render(item);
  assert.equal((dirty.match(/class="primaryButton"/g) ?? []).length, 1);
  assert.ok(dirty.includes('Before\ntext Changed after'));
  const other = block('b', ['<p>Untouched</p>']);
  assert.equal((render(other).match(/class="primaryButton"/g) ?? []).length, 0);
  item.values[key + '::valid'] = item.values[key];
  item.values[key] = 'Before\nCompletely replaced';
  const invalid = render(item);
  assert.ok(invalid.includes('aria-invalid="true"'));
  assert.ok(invalid.includes('Before\nCompletely replaced'));
  assert.match(invalid, /class="primaryButton" disabled=""/);
  assert.ok(invalid.includes('class="warningText"'));
  item.values[key] = entity.displayValue;
  delete item.values[key + '::valid'];
  const reverted = render(item);
  assert.equal((reverted.match(/class="primaryButton"/g) ?? []).length, 0);
  assert.ok(!reverted.includes('aria-invalid="true"'));
});
