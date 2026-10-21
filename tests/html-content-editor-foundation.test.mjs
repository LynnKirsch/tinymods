import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  createEditableEntityPatch,
  createEditableEntityPatches,
  compositeEditError,
  encodeEditableEntityValue,
} from "../app/lib/html-content-editor/encode-source-value.ts";
import { extractEditableEntities } from "../app/lib/html-content-editor/extract-editable-entities.ts";
import { groupImageEntities } from "../app/lib/html-content-editor/image-groups.ts";
import { validateRequiredImageValues } from "../app/lib/html-content-editor/image-validation.ts";
import { visibleOutputSource } from "../app/lib/html-content-editor/output-code.ts";
import { applySourcePatches } from "../app/lib/html-content-editor/patch-source.ts";
import { buildPreviewSource } from "../app/lib/html-content-editor/preview-source.ts";
import {
  calculatePreviewScale,
  DEFAULT_PREVIEW_VIEWPORT,
  DEFAULT_PREVIEW_VIEWPORT_ID,
  PREVIEW_VIEWPORTS,
  previewViewportById,
} from "../app/lib/html-content-editor/preview-viewport.ts";
import {
  detectRepeatingGroups,
  itemAddPatch,
  itemDeletePatch,
} from "../app/lib/html-content-editor/repeating-structures.ts";
import {
  explicitLineCount,
  textLengthWarning,
  userTextLength,
} from "../app/lib/html-content-editor/text-length.ts";

function assertRangeInvariant(source, entities) {
  for (const entity of entities) {
    assert.equal(
      source.slice(entity.range.start, entity.range.end),
      entity.rawValue,
      `range invariant failed for ${entity.id}`,
    );
  }
}

function requireEntity(entities, predicate) {
  const entity = entities.find(predicate);
  assert.ok(entity, "expected editable entity to exist");
  return entity;
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

const STATIC_WIDGET_FIXTURE = `<style>
.hv-contact-widget { opacity: 0; visibility: hidden; }
.hv-contact-widget.is-mounted.is-expanded { opacity: 1; visibility: visible; }
.hv-contact-card { color: #238fbc; transform: translateY(12px); }
</style>
<div id="contact-widget-root"></div>
<script>
const ICON_SRC = '/images/contact-icon.png';
const LANDSCAPE_SRC = "/images/contact-landscape.png";
const MOUNT_DELAY = 160;
const unsafeDynamic = baseUrl + '/dynamic.png';

function mountWidget() {
  const root = document.getElementById('contact-widget-root');
  root.innerHTML = \`
    <div class="hv-contact-widget" aria-label="contact-widget">
      <!-- ПЛАШКА -->
      <div class="hv-contact-text">
        <span>ВСЕ УСЛУГИ</span>
        <span>И БРОНИРОВАНИЕ</span>
      </div>
      <img class="hv-contact-icon" src="\${ICON_SRC}" alt="">
      <img class="hv-contact-landscape" src="\${LANDSCAPE_SRC}" alt="">
    </div>
  \`;
  root.addEventListener('click', () => console.log({ source: 'contact-widget' }));
}
</script>`;

const HTML_CONTENT_EDITOR_COMPONENT_SOURCE = readFileSync(
  new URL("../app/components/html-content-editor/HtmlContentEditor.tsx", import.meta.url),
  "utf8",
);
const HTML_CONTENT_EDITOR_STYLES_SOURCE = readFileSync(
  new URL("../app/components/html-content-editor/HtmlContentEditor.module.css", import.meta.url),
  "utf8",
);

test("editor chrome uses blue Editor theme tokens and shared V2 geometry and Onest without old cyan or heavy decoration", () => {
  const css = HTML_CONTENT_EDITOR_STYLES_SOURCE;
  assert.ok(HTML_CONTENT_EDITOR_COMPONENT_SOURCE.includes('<main className={styles.page} data-ui-theme="editor">'));
  assert.doesNotMatch(css, /--html-editor-|#238fbc|#146987|(?:linear|radial)-gradient\(|\b(?:Inter|Manrope)\b|font-weight:\s*[789]00/i);
  for (const token of ["bg-app", "surface-1", "surface-2", "bg-workspace", "border-soft", "border", "border-strong", "accent", "accent-hover", "accent-active", "accent-soft", "accent-border", "focus-ring", "danger", "danger-soft", "font-family"]) {
    assert.ok(css.includes("var(--ui-" + token + ")"), token);
  }
  assert.match(css, /\.page\s*\{[^}]*background: var\(--ui-bg-app\);/);
  assert.doesNotMatch(css, /--ui-gradient-/);
  const globals = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");
  const palette = globals.match(/\[data-ui-theme="editor"\]\s*\{([^}]+)\}/)[1];
  assert.match(palette, /--ui-accent: #5B7CFA;/);
  assert.match(palette, /--ui-focus-ring: rgb\(91 124 250 \/ 24%\);/);
  assert.match(palette, /--ui-accent-soft: #EEF3FF;/);
  assert.match(css, /\.page\s*\{[^}]*font-family: var\(--ui-font-family\);/);
  assert.match(css, /\.hero h1\s*\{[^}]*font-size: var\(--ui-font-24\);[^}]*font-weight: var\(--ui-weight-heading\);/);
  assert.equal([...css.matchAll(/font-size:\s*(\d+(?:\.\d+)?)px/g)].filter(([, size]) => Number(size) < 12).length, 0);
  assert.doesNotMatch(css, /box-shadow:\s*0\s+\d/);
});

test("V2 code actions keep 44px height, soft active lock, danger trash and conditional dirty COPY", () => {
  const css = HTML_CONTENT_EDITOR_STYLES_SOURCE;
  assert.match(css, /--code-action-height:\s*44px/);
  assert.match(css, /\.addCodeButton\s*\{[^}]*min-height: var\(--code-action-height, 44px\);/);
  assert.match(css, /\.codeIconButton\.lockButtonActive\s*\{[^}]*background: var\(--ui-accent-soft\);[^}]*color: var\(--ui-accent\);/);
  assert.match(css, /\.dangerIconButton:hover,[\s\S]*?color: var\(--ui-danger\);/);
  assert.equal((HTML_CONTENT_EDITOR_COMPONENT_SOURCE.match(/styles.dangerIconButton/g) || []).length, 2);
  assert.ok(HTML_CONTENT_EDITOR_COMPONENT_SOURCE.includes('aria-pressed={field.locked}'));
  assert.match(HTML_CONTENT_EDITOR_COMPONENT_SOURCE, /className=\{styles.addCodeButton\}[^\n]*>\+ ДОБАВИТЬ БЛОК/);
  assert.match(css, /\.contentActions \.primaryButton\s*\{[^}]*background: var\(--ui-accent\);/);
  assert.match(HTML_CONTENT_EDITOR_COMPONENT_SOURCE, /hasChanges \? <button[^>]*className=\{styles.primaryButton\}/);
});

test("Content fields use complete neutral borders, soft selection and neutral scrollbars", () => {
  const css = HTML_CONTENT_EDITOR_STYLES_SOURCE;
  assert.match(css, /\.compositeField input\s*\{[^}]*border: 1px solid var\(--ui-border\);[^}]*border-radius: var\(--ui-radius-sm\);[^}]*background: var\(--ui-surface-1\);[^}]*font-size: var\(--ui-font-14\);/);
  assert.match(css, /\.activeContentGroup\s*\{[^}]*background: var\(--ui-accent-soft\);/);
  assert.match(css, /\.slideGroup\s*\{[^}]*border: 0;[^}]*background: transparent;[^}]*border-bottom: 1px solid var\(--ui-border-soft\);/);
  assert.match(css, /\.compactCodeInput\s*\{[^}]*font: 13px\/1.5 ui-monospace/);
  assert.match(css, /\.compactCodeInput:focus\s*\{[^}]*outline: 3px solid var\(--ui-focus-ring\);/);
  assert.match(css, /scrollbar-width: thin;\s*scrollbar-color: var\(--ui-border-strong\) transparent;/);
});

test("viewport selection uses aria-pressed and arrows have neutral disabled states", () => {
  const css = HTML_CONTENT_EDITOR_STYLES_SOURCE;
  assert.match(css, /\.previewPresets button\[aria-pressed="true"\]\s*\{[^}]*background: var\(--ui-accent-soft\);/);
  assert.ok(HTML_CONTENT_EDITOR_COMPONENT_SOURCE.includes('aria-pressed={preset.id === viewport.id}'));
  assert.match(css, /\.externalSliderArrows button\s*\{[^}]*border: 1px solid var\(--ui-accent-border\);/);
  assert.match(css, /\.externalSliderArrows button:disabled\s*\{[^}]*color: var\(--ui-text-muted\);[^}]*border-color: var\(--ui-border-soft\);/);
  assert.match(css, /\.previewFrame\s*\{[^}]*background: var\(--ui-bg-workspace\);/);
});

test("code viewer portal owns its editor theme and shared modal typography and shadow", () => {
  assert.ok(HTML_CONTENT_EDITOR_COMPONENT_SOURCE.includes('createPortal(<div className={styles.modalBackdrop} data-ui-theme="editor"'));
  assert.ok(HTML_CONTENT_EDITOR_COMPONENT_SOURCE.includes('role="dialog" aria-modal="true" aria-label={modal.title}'));
  assert.match(HTML_CONTENT_EDITOR_STYLES_SOURCE, /\.codeModal\s*\{[^}]*border-radius: var\(--ui-radius-xl\);[^}]*box-shadow: var\(--ui-shadow-md\);/);
  assert.match(HTML_CONTENT_EDITOR_STYLES_SOURCE, /\.modalBackdrop\s*\{[^}]*font-family: var\(--ui-font-family\);/);
  assert.ok(HTML_CONTENT_EDITOR_COMPONENT_SOURCE.includes('className={styles.secondaryButton} onClick={() => setModal(null)}>Закрыть'));
});

test("V2 restyle preserves pre-PASS Preview geometry, iframe and responsive declarations", () => {
  const expected = {
  ".previewScreenShell": [
    {
      "position": "relative",
      "width": "calc(var(--preview-width, 1440px) * var(--preview-scale, 1))",
      "height": "calc(var(--preview-height, 900px) * var(--preview-scale, 1))"
    }
  ],
  ".previewFrame": [
    {
      "height": "clamp(320px, calc(100dvh - 220px), 620px)",
      "min-height": "0",
      "padding": "12px 64px",
      "display": "grid",
      "overflow": "hidden"
    },
    {
      "height": "clamp(300px, 58dvh, 420px)"
    }
  ],
  ".previewViewport": [
    {
      "position": "relative",
      "z-index": "0",
      "min-width": "0",
      "width": "calc(var(--preview-width, 1440px) * var(--preview-scale, 1))",
      "height": "calc(var(--preview-height, 900px) * var(--preview-scale, 1))",
      "overflow": "hidden"
    }
  ],
  ".previewViewport iframe": [
    {
      "width": "var(--preview-width, 1440px)",
      "height": "var(--preview-height, 900px)",
      "display": "block",
      "transform": "scale(var(--preview-scale, 1))",
      "transform-origin": "0 0"
    },
    {
      "min-height": "0"
    }
  ],
  ".externalSliderArrows": [
    {
      "position": "absolute",
      "z-index": "1",
      "left": "-52px",
      "right": "-52px",
      "display": "flex",
      "transform": "translateY(-50%)"
    }
  ],
  ".externalSliderArrows button": [
    {
      "width": "44px",
      "height": "44px",
      "min-width": "44px",
      "padding": "0"
    }
  ],
  ".workspace": [
    {
      "width": "100%",
      "display": "grid",
      "grid-template-columns": "minmax(420px, .9fr) minmax(0, 1.25fr)",
      "grid-template-areas": "\"content preview\"",
      "gap": "20px"
    },
    {
      "grid-template-columns": "1fr",
      "grid-template-areas": "\"content\"\n      \"preview\""
    }
  ],
  ".previewPanel": [
    {
      "grid-area": "preview",
      "position": "sticky",
      "top": "14px"
    },
    {
      "position": "static"
    }
  ]
};
  const properties = new Set(["width", "height", "min-width", "min-height", "max-width", "max-height", "padding", "padding-inline", "padding-top", "padding-bottom", "position", "top", "left", "right", "bottom", "inset", "z-index", "transform", "transform-origin", "grid-area", "grid-template-areas", "grid-template-columns", "display", "overflow", "overflow-x", "overflow-y", "gap"]);
  for (const [selector, declarations] of Object.entries(expected)) {
    const rules = new RegExp("^[ \\t]*" + selector.replaceAll(".", "\\.") + " \\{([^}]*)\\}", "gm");
    const actual = [...HTML_CONTENT_EDITOR_STYLES_SOURCE.matchAll(rules)].map(match => match[1]).map(part =>
      Object.fromEntries(part.split("}")[0].split(";").map(declaration => declaration.trim().split(/:\s*(.*)/s)).filter(([name]) => properties.has(name)).map(([name, value]) => [name, value.trim()])),
    );
    assert.deepEqual(actual, declarations, selector);
  }
  assert.ok(HTML_CONTENT_EDITOR_COMPONENT_SOURCE.includes('<iframe key={preview.instanceId} ref={iframeRef} title="Предпросмотр HTML-блоков" srcDoc={preview.source} sandbox="allow-scripts" />'));
  assert.ok(HTML_CONTENT_EDITOR_COMPONENT_SOURCE.includes('"--preview-scale": previewScale, "--preview-width":'));
  assert.ok(HTML_CONTENT_EDITOR_COMPONENT_SOURCE.includes('style={{ top: position.top * previewScale }}'));
  for (const query of ["min-width: 1920px", "min-width: 2560px", "max-width: 959px", "max-width: 560px"]) {
    assert.equal(HTML_CONTENT_EDITOR_STYLES_SOURCE.split("@media (" + query + ")").length - 1, 1, query);
  }
});

test("client source reload starts from an empty textarea instead of current source", () => {
  assert.ok(HTML_CONTENT_EDITOR_COMPONENT_SOURCE.includes('source: "", draft: "", loaded: false')); assert.ok(HTML_CONTENT_EDITOR_COMPONENT_SOURCE.includes("Загрузить другой код"));
});

test("client-facing content UI does not expose structural repeating add or delete paths", () => {
  assert.ok(!HTML_CONTENT_EDITOR_COMPONENT_SOURCE.includes("itemAddPatch"));
  assert.ok(!HTML_CONTENT_EDITOR_COMPONENT_SOURCE.includes("itemDeletePatch"));
  assert.ok(!HTML_CONTENT_EDITOR_COMPONENT_SOURCE.includes("applyStructuralMutation"));
  assert.ok(!HTML_CONTENT_EDITOR_COMPONENT_SOURCE.includes("addRepeatingItem"));
  assert.ok(!HTML_CONTENT_EDITOR_COMPONENT_SOURCE.includes("deleteRepeatingItem"));
  assert.ok(!HTML_CONTENT_EDITOR_COMPONENT_SOURCE.includes("group.addLabel"));
});

test("code loader supports multiple logical blocks and ordered fragments", () => {
  for (const text of ["КОД ДЛЯ БЛОКА", "Загрузите HTML, CSS и JS код, относящийся к данному блоку.", "+ ДОБАВИТЬ КОД К БЛОКУ", "+ ДОБАВИТЬ БЛОК", "blocks.map", "block.fragments.map"]) assert.ok(HTML_CONTENT_EDITOR_COMPONENT_SOURCE.includes(text));
});

test("site context has explicit CSS/JS roles and participates in shared Preview", () => {
  for (const text of ["ОБЩИЕ СТИЛИ САЙТА · CSS", "ОБЩИЙ JS САЙТА", "buildLivePreview(blocks, context, instanceId)", "siteFields"]) assert.ok(HTML_CONTENT_EDITOR_COMPONENT_SOURCE.includes(text)); assert.ok(!HTML_CONTENT_EDITOR_COMPONENT_SOURCE.includes("rightContextFields"));
});

test("code view modal uses a portal and delete confirmation is absent", () => {
  for (const text of ["createPortal(", "document.body", 'role="dialog"', "setModal(null)"]) assert.ok(HTML_CONTENT_EDITOR_COMPONENT_SOURCE.includes(text)); assert.ok(!HTML_CONTENT_EDITOR_COMPONENT_SOURCE.includes("window.confirm"));
});

test("HTML editor button variants define readable interaction states", () => {
  for (const selector of [".primaryButton", ".secondaryButton", ".plusButton", ".iconMenuButton"]) {
    assert.ok(HTML_CONTENT_EDITOR_STYLES_SOURCE.includes(selector));
    assert.ok(HTML_CONTENT_EDITOR_STYLES_SOURCE.includes(`${selector}:hover`));
    assert.ok(HTML_CONTENT_EDITOR_STYLES_SOURCE.includes(`${selector}:active`));
    assert.ok(HTML_CONTENT_EDITOR_STYLES_SOURCE.includes(`${selector}:disabled`));
  }
  assert.match(
    HTML_CONTENT_EDITOR_STYLES_SOURCE,
    /\.sourceActions \.secondaryButton:hover \{[\s\S]*color: var\(--ui-accent\);/,
  );
});

test("editor removes Project UI and its exclusive state without leaving a wrapper", () => {
  assert.ok(!HTML_CONTENT_EDITOR_COMPONENT_SOURCE.includes("BrowserProjectRepository")); assert.ok(!HTML_CONTENT_EDITOR_COMPONENT_SOURCE.includes("Создать проект")); assert.ok(HTML_CONTENT_EDITOR_COMPONENT_SOURCE.includes("КОД ДЛЯ БЛОКА"));
});

test("extracts simple heading text with source range", () => {
  const source = "<h1>Новый год в Карелии</h1>";
  const entities = extractEditableEntities(source);

  assert.deepEqual(
    entities.map(({ kind, rawValue, displayValue }) => ({
      kind,
      rawValue,
      displayValue,
    })),
    [
      {
        kind: "text",
        rawValue: "Новый год в Карелии",
        displayValue: "Новый год в Карелии",
      },
    ],
  );
  assert.equal(entities[0].context.tagName, "h1");
  assertRangeInvariant(source, entities);
});

test("extracts supported tags and attributes case-insensitively", () => {
  const source = '<H1>Заголовок</H1><A HREF="/test">Ссылка</A>';
  const entities = extractEditableEntities(source);

  assert.deepEqual(
    entities.map(({ kind, rawValue }) => ({ kind, rawValue })),
    [
      { kind: "text", rawValue: "Заголовок" },
      { kind: "href", rawValue: "/test" },
      { kind: "text", rawValue: "Ссылка" },
    ],
  );
  assertRangeInvariant(source, entities);
});

test("extracts href and link text independently", () => {
  const source = '<a href="/booking">Забронировать</a>';
  const entities = extractEditableEntities(source);

  assert.deepEqual(
    entities.map(({ kind, rawValue }) => ({ kind, rawValue })),
    [
      { kind: "href", rawValue: "/booking" },
      { kind: "text", rawValue: "Забронировать" },
    ],
  );
  assertRangeInvariant(source, entities);
});

test("extracts single-quoted href and keeps its delimiter context", () => {
  const source = "<a href='/booking'>Забронировать</a>";
  const entities = extractEditableEntities(source);
  const href = requireEntity(entities, (entity) => entity.kind === "href");

  assert.equal(href.rawValue, "/booking");
  assert.deepEqual(href.context, {
    type: "attribute",
    name: "href",
    quote: "'",
    linkRole: "link",
  });
  assertRangeInvariant(source, entities);
});

test("adds client link context for text links, button links, and card links", () => {
  const source = `<nav>
  <a href="/plain">Read more</a>
  <a class="button button-primary" href="/book">Book</a>
  <a class="feature-card" href="/house"><article><h3>House</h3><p>Forest</p></article></a>
</nav>`;
  const entities = extractEditableEntities(source);

  assert.deepEqual(
    entities.map(({ kind, rawValue, context }) => ({
      kind,
      rawValue,
      linkRole: context.linkRole,
    })),
    [
      { kind: "href", rawValue: "/plain", linkRole: "link" },
      { kind: "text", rawValue: "Read more", linkRole: "link" },
      { kind: "href", rawValue: "/book", linkRole: "button" },
      { kind: "text", rawValue: "Book", linkRole: "button" },
      { kind: "href", rawValue: "/house", linkRole: "card" },
      { kind: "text", rawValue: "House", linkRole: "card" },
      { kind: "text", rawValue: "Forest", linkRole: "card" },
    ],
  );
  assertRangeInvariant(source, entities);
});

test("keeps complex anchor href editable even without card class fallback", () => {
  const source = `<a href="/house"><article><picture><img src="/house.webp"></picture><h3>House</h3></article></a>`;
  const entities = extractEditableEntities(source);
  const href = requireEntity(entities, (entity) => entity.kind === "href");
  const patched = applySourcePatches(source, [
    createEditableEntityPatch(href, "/new-house"),
  ]);

  assert.equal(href.context.linkRole, "link");
  assert.equal(
    patched,
    `<a href="/new-house"><article><picture><img src="/house.webp"></picture><h3>House</h3></article></a>`,
  );
  assertRangeInvariant(source, entities);
});

test("extracts multiline opening tag attributes without depending on order", () => {
  const source = `<a
  class="button"
  title="1 > 0"
  href="/booking"
>
  Забронировать
</a>
<img alt="Дом" data-id="7" src="house.webp">`;
  const entities = extractEditableEntities(source);

  assert.deepEqual(
    entities.map(({ kind, rawValue }) => ({ kind, rawValue })),
    [
      { kind: "href", rawValue: "/booking" },
      { kind: "text", rawValue: "\n  Забронировать\n" },
      { kind: "alt", rawValue: "Дом" },
      { kind: "src", rawValue: "house.webp" },
    ],
  );
  assertRangeInvariant(source, entities);
});

test("extracts image src and supported alt metadata as editable content", () => {
  const source = '<img src="image.webp" alt="Дом">';
  const entities = extractEditableEntities(source);

  assert.deepEqual(
    entities.map(({ kind, rawValue }) => ({ kind, rawValue })),
    [
      { kind: "src", rawValue: "image.webp" },
      { kind: "alt", rawValue: "Дом" },
    ],
  );
  assertRangeInvariant(source, entities);
});

test("patches only an existing alt value range", () => {
  const source = '<img class="photo" src="/house.webp" alt="Старый ALT" loading="lazy">';
  const alt = requireEntity(extractEditableEntities(source), (entity) => entity.kind === "alt");
  const patched = applySourcePatches(source, [
    createEditableEntityPatch(alt, "Новый ALT"),
  ]);

  assert.equal(
    patched,
    '<img class="photo" src="/house.webp" alt="Новый ALT" loading="lazy">',
  );
});

test("inserts missing alt only after explicit user input", () => {
  const source = '<img src="/house.webp">';
  const alt = requireEntity(extractEditableEntities(source), (entity) => entity.kind === "alt");
  const unchanged = applySourcePatches(source, []);
  const patched = applySourcePatches(source, [
    createEditableEntityPatch(alt, "Дом & лес"),
  ]);

  assert.equal(alt.rawValue, "");
  assert.equal(alt.range.start, alt.range.end);
  assert.equal(unchanged, source);
  assert.equal(patched, '<img src="/house.webp" alt="Дом &amp; лес">');
});

test("keeps missing alt absent when user returns it to empty before output", () => {
  const source = '<img src="/house.webp">';
  const alt = requireEntity(extractEditableEntities(source), (entity) => entity.kind === "alt");
  const values = { [alt.id]: "" };
  const patches = extractEditableEntities(source)
    .filter((entity) => values[entity.id] !== undefined && values[entity.id] !== entity.displayValue)
    .map((entity) => createEditableEntityPatch(entity, values[entity.id]));

  assert.equal(applySourcePatches(source, patches), source);
});

test("keeps existing empty alt as an editable non-blocking metadata field", () => {
  const source = '<img src="/house.webp" alt="">';
  const entities = extractEditableEntities(source);
  const alt = requireEntity(entities, (entity) => entity.kind === "alt");
  const issues = validateRequiredImageValues(entities, {});

  assert.equal(alt.rawValue, "");
  assert.equal(alt.context.missing, false);
  assert.deepEqual(issues, []);
});

test("does not expose alt editor for PNG or SVG images", () => {
  const source = '<img src="/icon.png" alt=""><img src="/icon.svg" alt="Icon">';
  const entities = extractEditableEntities(source);

  assert.deepEqual(
    entities.map(({ kind, rawValue }) => ({ kind, rawValue })),
    [
      { kind: "src", rawValue: "/icon.png" },
      { kind: "src", rawValue: "/icon.svg" },
    ],
  );
});

test("semantic text owns nested formatting and retains every source segment", () => {
  for (const source of [
    '<h1>Отдых <span class="accent">от 8 800 ₽</span> в сутки</h1>',
    '<h2>Отдых <span>в Карелии <strong>зимой</strong></span></h2>',
  ]) {
    const entities = extractEditableEntities(source);
    assert.equal(entities.length, 1);
    assert.ok(entities[0].composite.segments.length >= 3);
    assertRangeInvariant(source, entities);
    for (const segment of entities[0].composite.segments) assert.ok(source.slice(segment.range.start, segment.range.end));
  }
});

test("keeps raw HTML entity while exposing decoded display value", () => {
  const source = "<p>SPA &amp; бассейн</p>";
  const entities = extractEditableEntities(source);

  assert.equal(entities[0].rawValue, "SPA &amp; бассейн");
  assert.equal(entities[0].displayValue, "SPA & бассейн");
  assertRangeInvariant(source, entities);
});

test("keeps source ranges correct for unicode and HTML entities", () => {
  const source = "<p>Новый год 🎄 &amp; SPA</p>";
  const entities = extractEditableEntities(source);

  assert.equal(entities[0].rawValue, "Новый год 🎄 &amp; SPA");
  assert.equal(entities[0].displayValue, "Новый год 🎄 & SPA");
  assertRangeInvariant(source, entities);
});

test("extracts href when another attribute contains a greater-than sign", () => {
  const source = '<a title="1 > 0" href="/test">Ссылка</a>';
  const entities = extractEditableEntities(source);

  assert.deepEqual(
    entities.map(({ kind, rawValue }) => ({ kind, rawValue })),
    [
      { kind: "href", rawValue: "/test" },
      { kind: "text", rawValue: "Ссылка" },
    ],
  );
  assertRangeInvariant(source, entities);
});

test("does not extract text from comments, style, or script", () => {
  const source = [
    "<!-- <p>Комментарий</p> -->",
    "<style>.button { color: red; }</style>",
    "<script>const title = '<h1>JS</h1>';</script>",
    "<p>Видимый текст</p>",
  ].join("\n");
  const entities = extractEditableEntities(source);

  assert.deepEqual(
    entities.map(({ kind, rawValue }) => ({ kind, rawValue })),
    [{ kind: "text", rawValue: "Видимый текст" }],
  );
  assertRangeInvariant(source, entities);
});

test("does not extract fake markup from raw-text script and style content", () => {
  const source = `<script>
  const value = "<a href='/fake'>Fake</a>";
</script>
<style>
  .x::after { content: "<span>fake</span>"; }
</style>`;

  assert.deepEqual(extractEditableEntities(source), []);
});

test("does not extract fake href or image entities from HTML comments", () => {
  const source = `<!-- <a href="/fake">Fake</a><img src="/fake.webp"> -->
<a href="/real">Real</a>
<img src="/real.webp">`;
  const entities = extractEditableEntities(source);

  assert.deepEqual(
    entities.map(({ kind, rawValue }) => ({ kind, rawValue })),
    [
      { kind: "href", rawValue: "/real" },
      { kind: "text", rawValue: "Real" },
      { kind: "src", rawValue: "/real.webp" },
      { kind: "alt", rawValue: "" },
    ],
  );
  assertRangeInvariant(source, entities);
});

test("preserves HTML comments while patching nearby visible text", () => {
  const source = `<section>
  <!-- hero title must stay source-only -->
  <h1>Old</h1>
</section>`;
  const text = requireEntity(
    extractEditableEntities(source),
    (entity) => entity.kind === "text",
  );
  const patched = applySourcePatches(source, [
    createEditableEntityPatch(text, "New"),
  ]);

  assert.equal(
    patched,
    `<section>
  <!-- hero title must stay source-only -->
  <h1>New</h1>
</section>`,
  );
});

test("does not extract fake entities from JavaScript comments", () => {
  const source = `<script>
  // <a href="/fake">Fake</a>
  /* <img src="/fake.webp"> */
</script>`;

  assert.deepEqual(extractEditableEntities(source), []);
});

test("does not expose unquoted href or src as editable", () => {
  const source = '<a href=/unsafe>Link</a><img src=image.webp alt="Дом">';
  const entities = extractEditableEntities(source);

  assert.deepEqual(
    entities.map(({ kind, rawValue }) => ({ kind, rawValue })),
    [{ kind: "text", rawValue: "Link" }],
  );
  assertRangeInvariant(source, entities);
});

test("applies multiple length-changing replacements from right to left", () => {
  const source = '<h1>Зима</h1><a href="/old">Тур</a><img src="old.webp">';
  const entities = extractEditableEntities(source);
  const byRaw = new Map(entities.map((entity) => [entity.rawValue, entity]));

  const patched = applySourcePatches(source, [
    { ...byRaw.get("Зима").range, replacement: "Новогодние каникулы" },
    { ...byRaw.get("/old").range, replacement: "/booking/karelia" },
    { ...byRaw.get("Тур").range, replacement: "Забронировать" },
    { ...byRaw.get("old.webp").range, replacement: "house.webp" },
  ]);

  assert.equal(
    patched,
    '<h1>Новогодние каникулы</h1><a href="/booking/karelia">Забронировать</a><img src="house.webp">',
  );
});

test("supports deterministic replace, delete, and insert patch semantics", () => {
  assert.equal(
    applySourcePatches("abcdef", [
      { start: 1, end: 3, replacement: "X" },
      { start: 4, end: 5, replacement: "" },
      { start: 6, end: 6, replacement: "!" },
    ]),
    "aXd f!".replace(" ", ""),
  );

  assert.equal(
    applySourcePatches("ab", [
      { start: 1, end: 1, replacement: "X" },
      { start: 1, end: 1, replacement: "Y" },
    ]),
    "aXYb",
  );
});

test("allows insertion at patch boundaries and rejects insertion inside a patch range", () => {
  assert.equal(
    applySourcePatches("abcdef", [
      { start: 1, end: 4, replacement: "X" },
      { start: 1, end: 1, replacement: "[" },
      { start: 4, end: 4, replacement: "]" },
    ]),
    "a[X]ef",
  );

  assert.throws(
    () =>
      applySourcePatches("abcdef", [
        { start: 1, end: 4, replacement: "X" },
        { start: 2, end: 2, replacement: "!" },
      ]),
    /overlap/,
  );
});

test("returns unchanged source when no editable values changed", () => {
  const source = '<p>SPA &amp; бассейн</p><a href="/booking">Тур</a>';
  assert.equal(applySourcePatches(source, []), source);
});

test("encodes HTML-sensitive text before creating a source patch", () => {
  const source = "<p>SPA &amp; бассейн</p>";
  const text = requireEntity(
    extractEditableEntities(source),
    (entity) => entity.kind === "text",
  );
  const patch = createEditableEntityPatch(text, "Новый <год> & отдых");

  assert.equal(patch.replacement, "Новый &lt;год&gt; &amp; отдых");
  assert.equal(
    applySourcePatches(source, [patch]),
    "<p>Новый &lt;год&gt; &amp; отдых</p>",
  );
});

test("encodes attribute-sensitive values using the original quote delimiter", () => {
  const doubleQuotedSource = '<a href="/booking">Тур</a>';
  const singleQuotedSource = "<img src='old.webp'>";
  const href = requireEntity(
    extractEditableEntities(doubleQuotedSource),
    (entity) => entity.kind === "href",
  );
  const src = requireEntity(
    extractEditableEntities(singleQuotedSource),
    (entity) => entity.kind === "src",
  );

  assert.equal(
    applySourcePatches(doubleQuotedSource, [
      createEditableEntityPatch(href, '/new?title="sale"&ok=<yes>'),
    ]),
    '<a href="/new?title=&quot;sale&quot;&amp;ok=&lt;yes&gt;">Тур</a>',
  );
  assert.equal(
    applySourcePatches(singleQuotedSource, [
      createEditableEntityPatch(src, "folder/image's.webp"),
    ]),
    "<img src='folder/image&#39;s.webp'>",
  );
});

test("encodes values without assuming raw and display values are identical", () => {
  const source = "<p>SPA &amp; бассейн</p>";
  const text = requireEntity(
    extractEditableEntities(source),
    (entity) => entity.kind === "text",
  );

  assert.equal(text.rawValue, "SPA &amp; бассейн");
  assert.equal(text.displayValue, "SPA & бассейн");
  assert.equal(encodeEditableEntityValue(text, text.displayValue), "SPA &amp; бассейн");
});

test("counts user-facing text length with ASCII, Cyrillic, emoji, and decoded entities", () => {
  const entitySource = "<p>SPA &amp; бассейн</p>";
  const entity = requireEntity(
    extractEditableEntities(entitySource),
    (item) => item.kind === "text",
  );

  assert.equal(userTextLength("Tinymods"), 8);
  assert.equal(userTextLength("Карелия"), 7);
  assert.equal(userTextLength("🎄"), 1);
  assert.equal(userTextLength(entity.displayValue), 13);
});

test("reports text length warning states without using source offsets", () => {
  const source = "<p>SPA &amp; бассейн</p>";
  const entity = requireEntity(
    extractEditableEntities(source),
    (item) => item.kind === "text",
  );

  assert.equal(entity.rawValue.length, 17);
  assert.equal(entity.displayValue.length, 13);

  const same = textLengthWarning(entity, "SPA & бассейн");
  const shorter = textLengthWarning(entity, "SPA");
  const longer = textLengthWarning(entity, "SPA & бассейн рядом");

  assert.equal(same.originalLength, 13);
  assert.equal(same.currentLength, 13);
  assert.equal(same.overLimit, false);
  assert.equal(shorter.overLimit, false);
  assert.equal(longer.overLimit, true);
  assert.equal(longer.overflow, 6);
  assert.match(longer.message, /увеличить высоту текстового блока/);
});

test("reports explicit line break growth separately from visual wrapping", () => {
  const source = "<button>Купить</button>";
  const entity = requireEntity(
    extractEditableEntities(source),
    (item) => item.kind === "text",
  );
  const warning = textLengthWarning(entity, "Купить\nсегодня");

  assert.equal(explicitLineCount("Купить"), 1);
  assert.equal(warning.originalLines, 1);
  assert.equal(warning.currentLines, 2);
  assert.equal(warning.hasExtraLineBreaks, true);
  assert.match(warning.lineBreakMessage, /Исходник: 1 строка/);
  assert.match(warning.message, /увеличить кнопку/);
});

test("does not calculate text length warnings for href or src entities", () => {
  const source = '<a href="/booking">Тур</a><img src="/house.webp">';
  const entities = extractEditableEntities(source);

  assert.equal(
    textLengthWarning(
      requireEntity(entities, (entity) => entity.kind === "href"),
      "/booking/longer",
    ),
    null,
  );
  assert.equal(
    textLengthWarning(
      requireEntity(entities, (entity) => entity.kind === "src"),
      "/images/house-large.webp",
    ),
    null,
  );
});

test("preserves every other source character in a multiline regression case", () => {
  const source = `<section class="card" data-id="7">
  <h2 class="title">Старый заголовок</h2>
  <a class="button" data-state="primary" href="/booking">
    Забронировать
  </a>
</section>`;
  const title = extractEditableEntities(source).find(
    (entity) => entity.rawValue === "Старый заголовок",
  );

  const patched = applySourcePatches(source, [
    { ...title.range, replacement: "Новый заголовок" },
  ]);

  assert.equal(
    patched,
    `<section class="card" data-id="7">
  <h2 class="title">Новый заголовок</h2>
  <a class="button" data-state="primary" href="/booking">
    Забронировать
  </a>
</section>`,
  );
});

test("preserves all source outside one edited text entity in mixed HTML CSS and JS", () => {
  const source = `<section data-id="7" class="hero" aria-label="x">
	<!-- keep this exact comment -->
  <style>
.hero  {  background-image: url("/old.webp");  }
  </style>
  <h2 class="title" data-custom="a">Old title</h2>
  <script>
const ICON_SRC = "/icon.webp";
const markup = \`<img class="icon" src="\${ICON_SRC}" alt="">\`;
  </script>
</section>`;
  const entity = requireEntity(
    extractEditableEntities(source),
    (item) => item.kind === "text" && item.rawValue === "Old title",
  );
  const replacement = "New title";
  const patched = applySourcePatches(source, [
    createEditableEntityPatch(entity, replacement),
  ]);

  assertOnlyRangesChanged(source, patched, [
    { ...entity.range, replacement },
  ]);
});

test("preserves all source outside multiple exact content ranges", () => {
  const source = `<section class="card" data-id="42">
  <h2>Old title</h2>
  <img alt="Hero" data-x="1" src="/old.webp">
  <video poster="/poster-old.webp" src="/video-old.mp4"></video>
  <a data-cta="main" class="button" href="/booking">Book</a>
</section>`;
  const entities = extractEditableEntities(source);
  const changes = [
    {
      entity: requireEntity(entities, (item) => item.kind === "text" && item.rawValue === "Old title"),
      value: "New title",
    },
    {
      entity: requireEntity(entities, (item) => item.kind === "src" && item.rawValue === "/old.webp"),
      value: "/new.webp",
    },
    {
      entity: requireEntity(entities, (item) => item.kind === "src" && item.rawValue === "/video-old.mp4"),
      value: "/video-new.mp4",
    },
    {
      entity: requireEntity(entities, (item) => item.kind === "href" && item.rawValue === "/booking"),
      value: "/reserve",
    },
  ];
  const patches = changes.map(({ entity, value }) => createEditableEntityPatch(entity, value));
  const patched = applySourcePatches(source, patches);

  assertOnlyRangesChanged(
    source,
    patched,
    changes.map(({ entity, value }) => ({ ...entity.range, replacement: value })),
  );
});

test("rejects invalid and overlapping patches", () => {
  assert.throws(
    () => applySourcePatches("abcdef", [{ start: 1, end: 9, replacement: "x" }]),
    /outside/,
  );
  assert.throws(
    () =>
      applySourcePatches("abcdef", [
        { start: 1, end: 4, replacement: "x" },
        { start: 3, end: 5, replacement: "y" },
      ]),
    /overlap/,
  );
});

test("extracts a single source srcset URL with context", () => {
  const source = '<source type="image/avif" srcset="image.avif">';
  const entities = extractEditableEntities(source);
  const srcset = requireEntity(entities, (entity) => entity.kind === "srcset");

  assert.equal(srcset.rawValue, "image.avif");
  assert.deepEqual(srcset.context, {
    type: "srcset-url",
    descriptor: "",
    quote: '"',
    elementName: "source",
    pictureId: undefined,
    media: undefined,
    sourceType: "image/avif",
  });
  assertRangeInvariant(source, entities);
});

test("extracts srcset density descriptors as independent URL ranges", () => {
  const source = '<img src="fallback.webp" srcset="image.webp 1x, image@2x.webp 2x">';
  const entities = extractEditableEntities(source);
  const imageUrls = entities.filter((entity) => entity.kind === "srcset");

  assert.deepEqual(
    imageUrls.map(({ rawValue, context }) => ({
      rawValue,
      descriptor: context.descriptor,
    })),
    [
      { rawValue: "image.webp", descriptor: "1x" },
      { rawValue: "image@2x.webp", descriptor: "2x" },
    ],
  );
  assertRangeInvariant(source, entities);
});

test("extracts srcset width descriptors without exposing descriptors as editable", () => {
  const source = '<img srcset="image-800.webp 800w, image-1600.webp 1600w">';
  const entities = extractEditableEntities(source);

  assert.deepEqual(
    entities.map(({ kind, rawValue, context }) => ({
      kind,
      rawValue,
      descriptor: context.descriptor,
    })),
    [
      { kind: "srcset", rawValue: "image-800.webp", descriptor: "800w" },
      { kind: "srcset", rawValue: "image-1600.webp", descriptor: "1600w" },
      { kind: "alt", rawValue: "", descriptor: undefined },
    ],
  );
  assertRangeInvariant(source, entities);
});

test("groups picture image variants while keeping source entities independent", () => {
  const source = `<picture>
  <source media="(max-width: 959px)" type="image/avif" srcset="mobile.avif">
  <source media="(max-width: 959px)" type="image/webp" srcset="mobile.webp">
  <source type="image/avif" srcset="desktop.avif">
  <img src="desktop.webp" alt="">
</picture>`;
  const entities = extractEditableEntities(source);
  const groups = groupImageEntities(entities);

  assert.deepEqual(
    entities.map(({ kind, rawValue }) => ({ kind, rawValue })),
    [
      { kind: "srcset", rawValue: "mobile.avif" },
      { kind: "srcset", rawValue: "mobile.webp" },
      { kind: "srcset", rawValue: "desktop.avif" },
      { kind: "src", rawValue: "desktop.webp" },
      { kind: "alt", rawValue: "" },
    ],
  );
  assert.equal(groups.length, 1);
  assert.deepEqual(
    groups[0].items.map(({ label, detail, entity }) => ({
      label,
      detail,
      rawValue: entity.rawValue,
    })),
    [
      { label: "AVIF", detail: "до 959 px", rawValue: "mobile.avif" },
      { label: "WebP", detail: "до 959 px", rawValue: "mobile.webp" },
      { label: "AVIF", detail: "", rawValue: "desktop.avif" },
      { label: "Основное изображение", detail: "", rawValue: "desktop.webp" },
    ],
  );
  assertRangeInvariant(source, entities);
});

test("extracts inline background-image URL only", () => {
  const source = '<div style="color: red; background-image: url(\'hero.webp\')"></div>';
  const entity = requireEntity(
    extractEditableEntities(source),
    (item) => item.kind === "background-image",
  );

  assert.equal(entity.rawValue, "hero.webp");
  assert.deepEqual(entity.context, {
    type: "css-url",
    property: "background-image",
    quote: "'",
    container: "style-attribute",
    attributeQuote: '"',
  });
  assertRangeInvariant(source, [entity]);
});

test("preserves CSS comments around background-image URL edits", () => {
  const source = `<style>
.hero {
  /* keep this note */
  background-image: url("old.webp");
}
</style>`;
  const image = requireEntity(
    extractEditableEntities(source),
    (entity) => entity.kind === "background-image",
  );
  const patched = applySourcePatches(source, [
    createEditableEntityPatch(image, "new.webp"),
  ]);

  assert.equal(
    patched,
    `<style>
.hero {
  /* keep this note */
  background-image: url("new.webp");
}
</style>`,
  );
});

test("patches only the exact background-image URL range inside CSS", () => {
  const source = `<style>
.hero {
  background-image: url("/old.webp");
}
</style>`;
  const image = requireEntity(
    extractEditableEntities(source),
    (entity) => entity.kind === "background-image",
  );
  const patched = applySourcePatches(source, [
    createEditableEntityPatch(image, "/new.webp"),
  ]);

  assert.equal(image.rawValue, "/old.webp");
  assert.equal(
    patched,
    source.slice(0, image.range.start) + "/new.webp" + source.slice(image.range.end),
  );
  assert.equal(
    patched,
    `<style>
.hero {
  background-image: url("/new.webp");
}
</style>`,
  );
});

test("extracts background-image URLs from style blocks without exposing style text", () => {
  const source = `<style>
.hero {
  background-image: url("hero.webp");
}
</style>`;
  const entities = extractEditableEntities(source);

  assert.deepEqual(
    entities.map(({ kind, rawValue }) => ({ kind, rawValue })),
    [{ kind: "background-image", rawValue: "hero.webp" }],
  );
  assertRangeInvariant(source, entities);
});

test("extracts multiple supported background-image declarations", () => {
  const source = `<style>
.hero { background-image: url("hero.webp"); }
.card { background-image: url('card.webp'); }
</style>`;
  const entities = extractEditableEntities(source);

  assert.deepEqual(
    entities.map(({ kind, rawValue }) => ({ kind, rawValue })),
    [
      { kind: "background-image", rawValue: "hero.webp" },
      { kind: "background-image", rawValue: "card.webp" },
    ],
  );
  assertRangeInvariant(source, entities);
});

test("patches one picture URL without rebuilding surrounding source", () => {
  const source = `<picture>
  <source media="(max-width: 959px)" type="image/avif" srcset="mobile.avif">
  <source media="(max-width: 959px)" type="image/webp" srcset="mobile.webp">
  <source type="image/avif" srcset="desktop.avif">
  <img src="desktop.webp" alt="">
</picture>`;
  const entity = requireEntity(
    extractEditableEntities(source),
    (item) => item.rawValue === "mobile.avif",
  );
  const patched = applySourcePatches(source, [
    createEditableEntityPatch(entity, "new-mobile.avif"),
  ]);

  assert.equal(
    patched,
    source.slice(0, entity.range.start) +
      "new-mobile.avif" +
      source.slice(entity.range.end),
  );
});

test("patches one srcset URL while preserving descriptors and neighbors", () => {
  const source = '<img srcset="image.webp 1x, image@2x.webp 2x">';
  const entity = requireEntity(
    extractEditableEntities(source),
    (item) => item.rawValue === "image.webp",
  );
  const patched = applySourcePatches(source, [
    createEditableEntityPatch(entity, "new.webp"),
  ]);

  assert.equal(patched, '<img srcset="new.webp 1x, image@2x.webp 2x">');
});

test("detects one repeating group for sibling paragraphs", () => {
  const source = `<div>
  <p>One</p>
  <p>Two</p>
  <p>Three</p>
</div>`;
  const entities = extractEditableEntities(source);
  const groups = detectRepeatingGroups(source, entities);

  assert.equal(groups.length, 1);
  assert.equal(groups[0].tagName, "p");
  assert.deepEqual(
    groups[0].items.map(({ rawSource, separatorBefore, entityIds }) => ({
      rawSource,
      separatorBefore,
      entityCount: entityIds.length,
    })),
    [
      { rawSource: "<p>One</p>", separatorBefore: "", entityCount: 1 },
      { rawSource: "<p>Two</p>", separatorBefore: "\n  ", entityCount: 1 },
      { rawSource: "<p>Three</p>", separatorBefore: "\n  ", entityCount: 1 },
    ],
  );
  for (const item of groups[0].items) {
    assert.equal(source.slice(item.start, item.end), item.rawSource);
  }
});

test("does not group same tags when another sibling breaks the run", () => {
  const source = `<div>
  <p>One</p>
  <span>Two</span>
  <p>Three</p>
</div>`;

  assert.deepEqual(detectRepeatingGroups(source, extractEditableEntities(source)), []);
});

test("does not group paragraphs with different structural signatures", () => {
  const source = `<div>
  <p>One</p>
  <p><strong>Two</strong></p>
</div>`;

  assert.deepEqual(detectRepeatingGroups(source, extractEditableEntities(source)), []);
});

test("detects a repeating group for sibling list items", () => {
  const source = `<ul>
  <li>Pool</li>
  <li>Sauna</li>
</ul>`;
  const groups = detectRepeatingGroups(source, extractEditableEntities(source));

  assert.equal(groups.length, 1);
  assert.equal(groups[0].tagName, "li");
  assert.equal(groups[0].title, "Список");
  assert.equal(groups[0].addLabel, "+ Добавить пункт");
});

test("blocks add when raw clone would duplicate dangerous id references", () => {
  const source = `<div>
  <p id="item-1">One</p>
  <p id="item-2">Two</p>
</div>`;
  const groups = detectRepeatingGroups(source, extractEditableEntities(source));

  assert.equal(groups.length, 1);
  assert.equal(groups[0].canAdd, false);
  assert.match(groups[0].addBlockedReason, /служебные атрибуты/);
  assert.equal(itemAddPatch(groups[0]), null);
});

test("disables structural add and delete when a repeated item contains an HTML comment", () => {
  const source = `<div>
  <p><!-- source note -->One</p>
  <p><!-- source note -->Two</p>
</div>`;
  const group = detectRepeatingGroups(source, extractEditableEntities(source))[0];

  assert.equal(group.canAdd, false);
  assert.equal(group.canDelete, false);
  assert.equal(group.items[0].canDelete, false);
  assert.match(group.addBlockedReason, /защищённые комментарии/);
  assert.match(group.deleteBlockedReason, /source-комментарии/);
  assert.equal(itemAddPatch(group), null);
  assert.equal(itemDeletePatch(group, group.items[0]), null);
});

test("disables structural add and delete when a sibling separator contains an HTML comment", () => {
  const source = `<div>
  <p>One</p>
  <!-- keep this separator -->
  <p>Two</p>
</div>`;
  const group = detectRepeatingGroups(source, extractEditableEntities(source))[0];

  assert.equal(group.canAdd, false);
  assert.equal(group.canDelete, false);
  assert.deepEqual(group.items.map((item) => item.canDelete), [false, false]);
  assert.equal(itemAddPatch(group), null);
  assert.equal(itemDeletePatch(group, group.items[1]), null);
});

test("deletes first, middle, and last repeating items while preserving formatting", () => {
  const source = `<div>
  <p>One</p>
  <p>Two</p>
  <p>Three</p>
</div>`;
  const group = detectRepeatingGroups(source, extractEditableEntities(source))[0];

  assert.equal(
    applySourcePatches(source, [itemDeletePatch(group, group.items[0])]),
    `<div>
  <p>Two</p>
  <p>Three</p>
</div>`,
  );
  assert.equal(
    applySourcePatches(source, [itemDeletePatch(group, group.items[1])]),
    `<div>
  <p>One</p>
  <p>Three</p>
</div>`,
  );
  assert.equal(
    applySourcePatches(source, [itemDeletePatch(group, group.items[2])]),
    `<div>
  <p>One</p>
  <p>Two</p>
</div>`,
  );
});

test("adds a new item by cloning raw source with the same indentation pattern", () => {
  const source = `<div>
  <p>One</p>
  <p>Two</p>
</div>`;
  const group = detectRepeatingGroups(source, extractEditableEntities(source))[0];
  const patch = itemAddPatch(group);

  assert.deepEqual(patch, {
    start: source.indexOf("\n</div>"),
    end: source.indexOf("\n</div>"),
    replacement: "\n  <p>Two</p>",
  });
  assert.equal(
    applySourcePatches(source, [patch]),
    `<div>
  <p>One</p>
  <p>Two</p>
  <p>Two</p>
</div>`,
  );
});

test("can return to the original source after add, delete, and value patches", () => {
  const original = `<div>
  <p>One</p>
  <p>Two</p>
</div>`;
  const group = detectRepeatingGroups(original, extractEditableEntities(original))[0];
  const edited = requireEntity(
    extractEditableEntities(original),
    (entity) => entity.rawValue === "One",
  );

  const mutated = applySourcePatches(original, [
    createEditableEntityPatch(edited, "Changed"),
    itemAddPatch(group),
    itemDeletePatch(group, group.items[1]),
  ]);

  assert.notEqual(mutated, original);
  assert.equal(original, `<div>
  <p>One</p>
  <p>Two</p>
</div>`);
});

test("detects repeating image group for sibling img wrappers", () => {
  const source = `<div class="gallery">
  <div class="item"><img src="1.webp"></div>
  <div class="item"><img src="2.webp"></div>
</div>`;
  const groups = detectRepeatingGroups(source, extractEditableEntities(source));

  assert.equal(groups.length, 1);
  assert.equal(groups[0].groupKind, "image");
  assert.equal(groups[0].tagName, "div");
  assert.equal(groups[0].title, "Галерея");
  assert.equal(groups[0].addLabel, "+ Добавить фотографию");
  assert.deepEqual(
    groups[0].items.map(({ rawSource, entityIds, canDelete }) => ({
      rawSource,
      entityCount: entityIds.length,
      canDelete,
    })),
    [
      { rawSource: '<div class="item"><img src="1.webp"></div>', entityCount: 2, canDelete: true },
      { rawSource: '<div class="item"><img src="2.webp"></div>', entityCount: 2, canDelete: true },
    ],
  );
});

test("detects repeating image group for figure picture wrappers", () => {
  const source = `<div class="gallery">
  <figure class="slide">
    <picture>
      <source type="image/avif" srcset="1.avif">
      <img src="1.webp" alt="">
    </picture>
  </figure>
  <figure class="slide">
    <picture>
      <source type="image/avif" srcset="2.avif">
      <img src="2.webp" alt="">
    </picture>
  </figure>
</div>`;
  const groups = detectRepeatingGroups(source, extractEditableEntities(source));

  assert.equal(groups.length, 1);
  assert.equal(groups[0].groupKind, "image");
  assert.equal(groups[0].tagName, "figure");
  assert.deepEqual(groups[0].items.map((item) => item.entityIds.length), [3, 3]);
});

test("does not group image wrappers with different structural shapes", () => {
  const source = `<div class="gallery">
  <div class="item"><img src="1.webp"></div>
  <div class="item"><picture><img src="2.webp"></picture></div>
</div>`;

  assert.deepEqual(detectRepeatingGroups(source, extractEditableEntities(source)), []);
});

test("does not group similar image wrappers from different parents", () => {
  const source = `<section>
  <div class="gallery"><div class="item"><img src="1.webp"></div></div>
  <div class="gallery"><div class="item"><img src="2.webp"></div></div>
</section>`;

  assert.deepEqual(detectRepeatingGroups(source, extractEditableEntities(source)), []);
});

test("keeps delete available but disables add for image wrappers with dangerous ids", () => {
  const source = `<div class="gallery">
  <figure id="slide-1"><img src="1.webp"></figure>
  <figure id="slide-2"><img src="2.webp"></figure>
</div>`;
  const groups = detectRepeatingGroups(source, extractEditableEntities(source));

  assert.equal(groups.length, 1);
  assert.equal(groups[0].groupKind, "image");
  assert.equal(groups[0].canDelete, true);
  assert.equal(groups[0].items[0].canDelete, true);
  assert.equal(groups[0].canAdd, false);
  assert.match(groups[0].addBlockedReason, /служебные атрибуты/);
});

test("disables raw clone for image wrappers with service data or handlers", () => {
  const source = `<div class="gallery">
  <div class="item" data-slide="1"><img src="1.webp"></div>
  <div class="item" data-slide="2"><img src="2.webp"></div>
</div>`;
  const handlerSource = `<div class="gallery">
  <div class="item" onclick="openSlide(1)"><img src="1.webp"></div>
  <div class="item" onclick="openSlide(2)"><img src="2.webp"></div>
</div>`;

  assert.equal(
    detectRepeatingGroups(source, extractEditableEntities(source))[0].canAdd,
    false,
  );
  assert.equal(
    detectRepeatingGroups(handlerSource, extractEditableEntities(handlerSource))[0].canAdd,
    false,
  );
});

test("adds an image item by cloning raw wrapper source with indentation", () => {
  const source = `<div class="gallery">
  <div class="item"><img src="1.webp"></div>
  <div class="item"><img src="2.webp"></div>
</div>`;
  const group = detectRepeatingGroups(source, extractEditableEntities(source))[0];
  const patch = itemAddPatch(group);

  assert.equal(patch.replacement, '\n  <div class="item"><img src="2.webp"></div>');
  assert.equal(
    applySourcePatches(source, [patch]),
    `<div class="gallery">
  <div class="item"><img src="1.webp"></div>
  <div class="item"><img src="2.webp"></div>
  <div class="item"><img src="2.webp"></div>
</div>`,
  );
});

test("deletes first, middle, and last image items while preserving picture formatting", () => {
  const source = `<div class="gallery">
  <figure class="slide"><picture><img src="1.webp"></picture></figure>
  <figure class="slide"><picture><img src="2.webp"></picture></figure>
  <figure class="slide"><picture><img src="3.webp"></picture></figure>
</div>`;
  const group = detectRepeatingGroups(source, extractEditableEntities(source))[0];

  assert.equal(
    applySourcePatches(source, [itemDeletePatch(group, group.items[0])]),
    `<div class="gallery">
  <figure class="slide"><picture><img src="2.webp"></picture></figure>
  <figure class="slide"><picture><img src="3.webp"></picture></figure>
</div>`,
  );
  assert.equal(
    applySourcePatches(source, [itemDeletePatch(group, group.items[1])]),
    `<div class="gallery">
  <figure class="slide"><picture><img src="1.webp"></picture></figure>
  <figure class="slide"><picture><img src="3.webp"></picture></figure>
</div>`,
  );
  assert.equal(
    applySourcePatches(source, [itemDeletePatch(group, group.items[2])]),
    `<div class="gallery">
  <figure class="slide"><picture><img src="1.webp"></picture></figure>
  <figure class="slide"><picture><img src="2.webp"></picture></figure>
</div>`,
  );
});

test("supports add then re-extract then edit URL inside the new image item", () => {
  const source = `<div class="gallery">
  <div class="item"><img src="1.webp"></div>
  <div class="item"><img src="2.webp"></div>
</div>`;
  const group = detectRepeatingGroups(source, extractEditableEntities(source))[0];
  const withClone = applySourcePatches(source, [itemAddPatch(group)]);
  const clonedGroups = detectRepeatingGroups(withClone, extractEditableEntities(withClone));
  const clonedImageEntities = extractEditableEntities(withClone).filter(
    (entity) => entity.kind === "src",
  );
  const newEntity = clonedImageEntities.at(-1);
  const patched = applySourcePatches(withClone, [
    createEditableEntityPatch(newEntity, "3.webp"),
  ]);

  assert.equal(clonedGroups[0].items.length, 3);
  assert.equal(
    patched,
    `<div class="gallery">
  <div class="item"><img src="1.webp"></div>
  <div class="item"><img src="2.webp"></div>
  <div class="item"><img src="3.webp"></div>
</div>`,
  );
});

test("extracts editable content from safe static innerHTML widget templates", () => {
  const entities = extractEditableEntities(STATIC_WIDGET_FIXTURE);

  assert.ok(entities.length > 0);
  assert.deepEqual(
    new Set(entities.map(({ kind, displayValue }) => `${kind}:${displayValue}`)),
    new Set([
      "text:ВСЕ УСЛУГИ",
      "text:И БРОНИРОВАНИЕ",
      "src:/images/contact-icon.png",
      "src:/images/contact-landscape.png",
    ]),
  );
  assert.ok(!entities.some((entity) => entity.displayValue.includes("ПЛАШКА")));
  assert.ok(!entities.some((entity) => entity.displayValue.includes("MOUNT_DELAY")));
  assert.ok(!entities.some((entity) => entity.displayValue.includes("contact-widget")));
  assert.ok(!entities.some((entity) => entity.displayValue.includes("#238fbc")));
  assert.ok(!entities.some((entity) => entity.displayValue.includes("click")));
  assertRangeInvariant(STATIC_WIDGET_FIXTURE, entities);
});

test("patches static innerHTML widget text and image constants without rebuilding JS", () => {
  const entities = extractEditableEntities(STATIC_WIDGET_FIXTURE);
  const title = requireEntity(entities, (entity) => entity.displayValue === "ВСЕ УСЛУГИ");
  const icon = requireEntity(entities, (entity) => entity.displayValue === "/images/contact-icon.png");
  const landscape = requireEntity(
    entities,
    (entity) => entity.displayValue === "/images/contact-landscape.png",
  );

  const patchedTitle = applySourcePatches(STATIC_WIDGET_FIXTURE, [
    createEditableEntityPatch(title, "УСЛУГИ"),
  ]);
  const patchedIcon = applySourcePatches(STATIC_WIDGET_FIXTURE, [
    createEditableEntityPatch(icon, "/images/new-icon.png"),
  ]);
  const patchedLandscape = applySourcePatches(STATIC_WIDGET_FIXTURE, [
    createEditableEntityPatch(landscape, "/images/new-landscape.png"),
  ]);

  assert.equal(
    patchedTitle,
    STATIC_WIDGET_FIXTURE.slice(0, title.range.start) +
      "УСЛУГИ" +
      STATIC_WIDGET_FIXTURE.slice(title.range.end),
  );
  assert.equal(
    patchedIcon,
    STATIC_WIDGET_FIXTURE.replace(
      "const ICON_SRC = '/images/contact-icon.png';",
      "const ICON_SRC = '/images/new-icon.png';",
    ),
  );
  assert.equal(
    patchedLandscape,
    STATIC_WIDGET_FIXTURE.replace(
      'const LANDSCAPE_SRC = "/images/contact-landscape.png";',
      'const LANDSCAPE_SRC = "/images/new-landscape.png";',
    ),
  );
  assert.ok(patchedIcon.includes('src="${ICON_SRC}"'));
  assert.ok(patchedLandscape.includes('src="${LANDSCAPE_SRC}"'));
});

test("patches only the exact static JavaScript content range", () => {
  const source = `<script>
const ICON_SRC = '/old.webp';
const root = document.querySelector("#widget");
root.innerHTML = \`<img class="hero" src="\${ICON_SRC}" alt="">\`;
</script>`;
  const image = requireEntity(
    extractEditableEntities(source),
    (entity) => entity.kind === "src" && entity.rawValue === "/old.webp",
  );
  const patched = applySourcePatches(source, [
    createEditableEntityPatch(image, "/new.webp"),
  ]);

  assert.equal(
    patched,
    source.slice(0, image.range.start) + "/new.webp" + source.slice(image.range.end),
  );
  assert.ok(patched.includes("const ICON_SRC = '/new.webp';"));
  assert.ok(patched.includes('document.querySelector("#widget")'));
  assert.ok(patched.includes('src="${ICON_SRC}"'));
});

test("escapes edited text inside JavaScript template literals", () => {
  const entity = requireEntity(
    extractEditableEntities(STATIC_WIDGET_FIXTURE),
    (item) => item.displayValue === "ВСЕ УСЛУГИ",
  );
  const patch = createEditableEntityPatch(entity, "Цена `${alert(1)}` \\ <b>");

  assert.equal(patch.replacement, "Цена \\`\\${alert(1)}\\` \\\\ &lt;b&gt;");
});

test("does not expose dynamic JavaScript template expressions as editable", () => {
  const source = `<script>
const baseUrl = '/images';
const ICON_SRC = baseUrl + '/icon.png';
document.body.innerHTML = \`<img src="\${ICON_SRC}"><span>Hidden</span>\`;
</script>`;

  assert.deepEqual(extractEditableEntities(source), []);
});

test("builds preview-only static widget markup without leaking it into final source", () => {
  const entities = extractEditableEntities(STATIC_WIDGET_FIXTURE);
  const preview = buildPreviewSource(STATIC_WIDGET_FIXTURE, entities);
  const finalSource = applySourcePatches(STATIC_WIDGET_FIXTURE, [
    createEditableEntityPatch(entities[0], "УСЛУГИ"),
  ]);

  assert.match(preview.source, /hv-contact-widget/);
  assert.match(preview.source, /is-mounted/);
  assert.match(preview.source, /data-tinymods-preview-ids="tm-/);
  assert.match(preview.source, /tinymods-preview-start:tm-/);
  assert.ok(!finalSource.includes("tinymods-preview"));
  assert.ok(!finalSource.includes("data-tinymods-preview-ids"));
  assert.ok(!finalSource.includes("is-mounted is-shifted is-expanded"));
});

test("calculates preview scale by both width and height and caps it at 100 percent", () => {
  assert.equal(calculatePreviewScale(1440, 900), 1);
  assert.equal(calculatePreviewScale(720, 450), 0.5);
  assert.equal(calculatePreviewScale(1000, 400), 400 / 900);
  assert.equal(calculatePreviewScale(1800, 1200), 1);
});

test("defines the fixed preview viewport presets in breakpoint order", () => {
  assert.deepEqual(
    PREVIEW_VIEWPORTS.map(({ width, height }) => ({ width, height })),
    [
      { width: 390, height: 844 },
      { width: 480, height: 854 },
      { width: 640, height: 960 },
      { width: 960, height: 720 },
      { width: 1200, height: 800 },
      { width: 1440, height: 900 },
      { width: 1920, height: 1080 },
      { width: 2560, height: 1440 },
    ],
  );
  assert.deepEqual(
    PREVIEW_VIEWPORTS.map(({ label }) => label),
    [
      "iPhone",
      "Phone XL",
      "Tablet 640",
      "Tablet / Landscape",
      "Laptop 1200",
      "Laptop 1440",
      "Full HD",
      "2K",
    ],
  );
});

test("uses the 1440 laptop preview preset by default", () => {
  assert.equal(DEFAULT_PREVIEW_VIEWPORT_ID, "laptop-1440");
  assert.equal(DEFAULT_PREVIEW_VIEWPORT.label, "Laptop 1440");
  assert.deepEqual(
    {
      width: DEFAULT_PREVIEW_VIEWPORT.width,
      height: DEFAULT_PREVIEW_VIEWPORT.height,
    },
    { width: 1440, height: 900 },
  );
  assert.equal(previewViewportById("missing").id, DEFAULT_PREVIEW_VIEWPORT_ID);
});

test("calculates preview scale for fixed viewport presets", () => {
  const phone = previewViewportById("iphone");
  const notebook = previewViewportById("laptop-1440");
  const largeScreen = previewViewportById("two-k");

  assert.equal(
    calculatePreviewScale(800, 600, phone.width, phone.height),
    600 / 844,
  );
  assert.equal(
    calculatePreviewScale(720, 450, notebook.width, notebook.height),
    0.5,
  );
  assert.equal(
    calculatePreviewScale(800, 600, largeScreen.width, largeScreen.height),
    800 / 2560,
  );
});

test("visible output source follows the code that will be copied", () => {
  assert.equal(visibleOutputSource("<p>Source</p>", ""), "<p>Source</p>");
  assert.equal(visibleOutputSource("<p>Source</p>", "<p>Updated</p>"), "<p>Updated</p>");
});

test("simplified editor has one assembly note in hero and no type selector or global copy flow", () => {
  assert.ok(HTML_CONTENT_EDITOR_COMPONENT_SOURCE.includes("Редактируйте тексты, ссылки и изображения прямо в браузере."));
  assert.equal(HTML_CONTENT_EDITOR_COMPONENT_SOURCE.split("Загружайте блоки в том порядке, в котором они расположены на странице. Общие стили и скрипты страницы или сайта загружайте отдельно.").length - 1, 1);
  const hero = HTML_CONTENT_EDITOR_COMPONENT_SOURCE.match(/<section className=\{styles.hero\}>[\s\S]*?<\/section>/)[0];
  assert.ok(hero.includes("Загружайте блоки в том порядке, в котором они расположены на странице. Общие стили и скрипты страницы или сайта загружайте отдельно."));
  for (const removed of ["Код обрабатывается в браузере", "previewCopy", "<select", "Тип фрагмента", "Выберите HTML, CSS или JS"]) assert.ok(!HTML_CONTENT_EDITOR_COMPONENT_SOURCE.includes(removed), removed);
  assert.ok(!HTML_CONTENT_EDITOR_STYLES_SOURCE.includes(".previewCopy"));
  assert.ok(!HTML_CONTENT_EDITOR_STYLES_SOURCE.includes(".fragmentHeader select"));
});

test("code panels share header and field alignment, and add-code hover keeps focus", () => {
  assert.equal(HTML_CONTENT_EDITOR_COMPONENT_SOURCE.split("<div className={styles.codePanelHeader}>").length - 1, 2);
  assert.match(HTML_CONTENT_EDITOR_STYLES_SOURCE, /\.codePanelHeader\s*\{\s*min-height: 76px;/);
  assert.match(HTML_CONTENT_EDITOR_STYLES_SOURCE, /\.codeField > label \{ min-height: 36px;/);
  for (const state of ["hover:not(:disabled)", "active:not(:disabled)", "disabled", "focus-visible"]) assert.ok(HTML_CONTENT_EDITOR_STYLES_SOURCE.includes(".addCodeButton:" + state));
  assert.ok(HTML_CONTENT_EDITOR_COMPONENT_SOURCE.includes("className={styles.addCodeButton}"));
  assert.ok(HTML_CONTENT_EDITOR_COMPONENT_SOURCE.includes("value={fragment.loaded ? fragment.source : fragment.draft}"));
  assert.ok(HTML_CONTENT_EDITOR_COMPONENT_SOURCE.includes("update(commitBlockEdits(block))"));
  assert.ok(HTML_CONTENT_EDITOR_COMPONENT_SOURCE.includes("source: item.draft, originalSource: item.draft, loaded: true"));
});

test("site context uses actual load/replace/delete/lock helpers and composition lifecycle", async () => {
  const ts = await import("typescript");
  const ast = ts.createSourceFile("editor.tsx", HTML_CONTENT_EDITOR_COMPONENT_SOURCE, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const names = new Set(["emptySiteCodeField", "updateSiteCodeField", "advanceSiteComposition"]);
  const declarations = ast.statements.filter(node => ts.isFunctionDeclaration(node) && names.has(node.name?.text)).map(node => node.getText(ast)).join("\n");
  const output = ts.transpileModule(declarations, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
  const helpers = {}; new Function("exports", output)(helpers);
  const { emptySiteCodeField, updateSiteCodeField, advanceSiteComposition } = helpers;
  const initial = emptySiteCodeField();
  assert.equal(initial.loaded, false);
  let css = updateSiteCodeField({ ...initial, draft: ".site { color: red; }" }, "load");
  let js = updateSiteCodeField({ ...initial, draft: "window.site = 1;" }, "load");
  assert.equal(css.source, css.draft); assert.equal(css.loaded, true);
  assert.equal(js.source, js.draft); assert.equal(js.loaded, true);
  for (const role of ["css", "js"]) {
    let fields = { css, js };
    fields = { ...fields, [role]: updateSiteCodeField(fields[role], "lock") };
    assert.equal(fields[role].locked, true);
    for (const [hadSource, hasSource] of [[false, true], [true, true]]) {
      assert.equal(advanceSiteComposition(hadSource, hasSource, false, fields).fields, fields);
    }
    const clearedBlocks = advanceSiteComposition(true, false, false, fields);
    assert.equal(clearedBlocks.fields, fields); assert.equal(clearedBlocks.pending, true);
    const draftOnly = advanceSiteComposition(false, false, clearedBlocks.pending, fields);
    assert.equal(draftOnly.fields, fields); assert.equal(draftOnly.pending, true);
    const next = advanceSiteComposition(false, true, draftOnly.pending, fields);
    const unlocked = role === "css" ? "js" : "css";
    assert.equal(next.fields[role], fields[role]);
    assert.deepEqual(next.fields[unlocked], initial); assert.equal(next.pending, false);
    assert.deepEqual(updateSiteCodeField(fields[role], "delete"), initial);
    const replaced = updateSiteCodeField(fields[role], "replace");
    assert.equal(replaced.source, ""); assert.equal(replaced.draft, ""); assert.equal(replaced.loaded, false); assert.equal(replaced.locked, true);
    assert.equal(updateSiteCodeField(fields[role], "lock").locked, false);
  }
  assert.ok(HTML_CONTENT_EDITOR_COMPONENT_SOURCE.includes('field.loaded ? field.source : field.draft'));
  assert.ok(HTML_CONTENT_EDITOR_COMPONENT_SOURCE.includes('setModal({ title: label, code: field.source })'));
  assert.ok(HTML_CONTENT_EDITOR_COMPONENT_SOURCE.includes('aria-pressed={field.locked}'));
  assert.ok(HTML_CONTENT_EDITOR_COMPONENT_SOURCE.includes('action("load")'));
  assert.ok(!HTML_CONTENT_EDITOR_COMPONENT_SOURCE.includes("Применить"));
  assert.ok(!HTML_CONTENT_EDITOR_COMPONENT_SOURCE.includes(">Удалить</button>"));
  assert.equal((HTML_CONTENT_EDITOR_COMPONENT_SOURCE.match(/<CodeTrashIcon \/>/g) || []).length, 2);
  assert.ok(HTML_CONTENT_EDITOR_STYLES_SOURCE.includes(".codeIconButton:focus-visible"));
});

test("960/1200/1440/1920/2560 share viewport variables and exactly one visual scale", () => {
  const cssRule = selector => HTML_CONTENT_EDITOR_STYLES_SOURCE.slice(HTML_CONTENT_EDITOR_STYLES_SOURCE.indexOf(selector + " {")).split("}")[0];
  const shell = cssRule(".previewScreenShell"), wrapper = cssRule(".previewViewport"), iframe = cssRule(".previewViewport iframe");
  assert.ok(!/--preview-(?:width|height|scale)\s*:/.test(wrapper));
  assert.ok(!shell.includes("transform:")); assert.ok(!wrapper.includes("transform:"));
  assert.ok(iframe.includes("width: var(--preview-width, 1440px)"));
  assert.ok(iframe.includes("height: var(--preview-height, 900px)"));
  assert.ok(iframe.includes("transform: scale(var(--preview-scale, 1))"));
  assert.ok(iframe.includes("transform-origin: 0 0"));
  for (const width of [960, 1200, 1440, 1920, 2560]) {
    const preset = PREVIEW_VIEWPORTS.find(item => item.width === width);
    const scale = calculatePreviewScale(691.2, 600, width, preset.height);
    const variables = { "--preview-width": width + "px", "--preview-height": preset.height + "px", "--preview-scale": scale };
    const evaluate = rule => {
      const expression = rule.match(/(?:^|[;{])\s*width:\s*([^;]+);/)[1].replace(/var\((--[\w-]+),\s*[^)]+\)/g, (_, name) => String(variables[name])).replaceAll("px", "").replace("calc(", "(");
      assert.match(expression, /^[\d.e+*()\s-]+$/); return new Function("return " + expression)();
    };
    assert.equal(evaluate(iframe), width);
    assert.equal(evaluate(shell), width * scale);
    assert.equal(evaluate(wrapper), width * scale);
    assert.ok(width * scale <= 691.2 + 1e-8);
  }
  const arrow = cssRule(".externalSliderArrows"), button = cssRule(".externalSliderArrows button");
  assert.ok(arrow.includes("left: -52px")); assert.ok(arrow.includes("right: -52px"));
  assert.ok(button.includes("pointer-events: auto")); assert.ok(button.includes("width: 44px"));
  assert.ok(button.includes("cursor: pointer"));
  assert.ok(cssRule(".previewFrame").includes("padding: 12px 64px"));
  assert.ok(HTML_CONTENT_EDITOR_COMPONENT_SOURCE.includes("stage.clientWidth - 128"));
  assert.ok(HTML_CONTENT_EDITOR_COMPONENT_SOURCE.includes("disabled={!position.canPrev}"));
  assert.ok(HTML_CONTENT_EDITOR_COMPONENT_SOURCE.includes("disabled={!position.canNext}"));
  assert.ok(!HTML_CONTENT_EDITOR_COMPONENT_SOURCE.includes("position.count - 1"));
});


test("composite semantic owners keep every formatting tag and attribute through local edits", () => {
  for (const owner of ["h1", "h2", "h3", "h4", "h5", "h6", "p", "li", "figcaption", "blockquote"]) {
    for (const tag of ["span", "strong", "em", "b", "i", "u", "mark", "small"]) {
      const source = `<${owner}>Когда стоит обратиться<br>к <${tag} class="accent" data-note="a>b">нейропсихологу?</${tag}></${owner}>`;
      const entities = extractEditableEntities(source);
      assert.equal(entities.length, 1, owner + tag);
      const entity = entities[0];
      assert.equal(entity.displayValue, "Когда стоит обратиться\nк нейропсихологу?");
      const patched = applySourcePatches(source, createEditableEntityPatches(entity, entity.displayValue.replace("нейропсихологу?", "психологу?")));
      assert.equal(patched, source.replace("нейропсихологу?", "психологу?"));
      const beforeSpan = applySourcePatches(source, createEditableEntityPatches(entity, entity.displayValue.replace("Когда стоит обратиться", "Когда нужна консультация")));
      assert.equal(beforeSpan, source.replace("Когда стоит обратиться", "Когда нужна консультация"));
      assertRangeInvariant(source, entities);
    }
  }
});

test("composite supports ordinary typing deletion paste and replacement inside a segment", () => {
  const source = '<h2>До <span class="accent">психологу?</span> после</h2>';
  const entity = extractEditableEntities(source)[0];
  for (const next of ["психологу?!", "психолог?", "консультанту по развитию", "😀 & < >", ""]) {
    const value = entity.displayValue.replace("психологу?", next);
    assert.equal(compositeEditError(entity, value), null);
    const output = applySourcePatches(source, createEditableEntityPatches(entity, value));
    assert.ok(output.includes('<span class="accent">'));
    assert.ok(output.endsWith('</span> после</h2>'));
    if (next) assert.equal(extractEditableEntities(output)[0].displayValue, value);
  }
});

test("composite entities and Unicode retain untouched source and escape changed text", () => {
  const source = '<p>Лес &#38; море <span data-x="1">🎄 &amp; SPA</span>!</p>';
  const entity = extractEditableEntities(source)[0];
  assert.equal(entity.displayValue, "Лес & море 🎄 & SPA!");
  const output = applySourcePatches(source, createEditableEntityPatches(entity, entity.displayValue.replace("🎄", "🌲🌲")));
  assert.equal(output, '<p>Лес &#38; море <span data-x="1">🌲🌲 &amp; SPA</span>!</p>');
  assert.equal(compositeEditError(entity, entity.displayValue), null);
  assert.deepEqual(createEditableEntityPatches(entity, entity.displayValue), []);
  assert.equal(extractEditableEntities('<p>&#38;lt; <span>&amp;gt;</span></p>')[0].displayValue, '&lt; &gt;');
});

test("ambiguous cross-format replacement and br changes cannot mutate source", () => {
  const source = '<h2>AAAA<br>BBBB<span>CCCC</span>DDDD</h2>';
  const entity = extractEditableEntities(source)[0];
  for (const value of ["AAAA\nXYZ", "AAAABBBBCCCCDDDD", "AAAA\nBBBB\nCCCCDDDD"]) {
    assert.ok(compositeEditError(entity, value));
    assert.throws(() => createEditableEntityPatches(entity, value), /форматирование/);
    assert.equal(applySourcePatches(source, []), source);
  }
});

test("code actions share the 44px token and copy belongs to dirty Content only", () => {
  const css = readFileSync(new URL('../app/components/html-content-editor/HtmlContentEditor.module.css', import.meta.url), 'utf8');
  assert.match(css, /--code-action-height:\s*44px/);
  assert.match(css, /\.codeActionRow \.secondaryButton,[\s\S]*height: var\(--code-action-height\)/);
  assert.match(css, /\.codeIconButton \{[^}]*width: var\(--code-action-height, 44px\);[^}]*height: var\(--code-action-height, 44px\)/);
  for (const state of ['hover', 'active', 'focus-visible']) assert.ok(css.includes('.codeIconButton:' + state));
  assert.match(HTML_CONTENT_EDITOR_COMPONENT_SOURCE, /hasChanges \? <button[^>]*className=\{styles.primaryButton\}/);
  assert.ok(HTML_CONTENT_EDITOR_COMPONENT_SOURCE.includes('disabled={hasInvalidContent || blockingValidationIssues.length > 0}'));
  assert.ok(HTML_CONTENT_EDITOR_COMPONENT_SOURCE.includes('navigator.clipboard.writeText(exportBlock(block))'));
  assert.ok(HTML_CONTENT_EDITOR_COMPONENT_SOURCE.includes('setTimeout(() => setCopyFeedback(""), 1800)'));
  assert.ok(!HTML_CONTENT_EDITOR_COMPONENT_SOURCE.includes('previewCopy'));
  assert.ok(HTML_CONTENT_EDITOR_COMPONENT_SOURCE.includes('aria-label="Удалить этот код"'));
  assert.ok(HTML_CONTENT_EDITOR_COMPONENT_SOURCE.includes('><CodeTrashIcon /></button>'));
});


test("Editor-owned VideoGallery follows page preview outside iframe without altering its stage", () => {
  const source = HTML_CONTENT_EDITOR_COMPONENT_SOURCE;
  const workspace = source.slice(source.indexOf('<section className={styles.workspace}'));
  assert.ok(workspace.indexOf('sandbox="allow-scripts"') >= 0);
  assert.ok(workspace.indexOf("<VideoGallery") > workspace.indexOf('sandbox="allow-scripts"'));
  assert.ok(workspace.indexOf("<VideoGallery") < workspace.indexOf('<div className={styles.blockStack}>'));
  assert.ok(workspace.includes('className={styles.previewFrame} ref={stageRef}'));
  assert.ok(workspace.includes('className={styles.rightPreviewColumn}'));
  assert.ok(source.includes('const videos = useMemo(() => videoPreviewEntries(blocks), [blocks])'));
  assert.ok(source.includes('setVideoModalKey(entry.key)'));
  assert.ok(source.includes('onSelectVideo={selectVideo}'));
  assert.ok(source.includes('aria-pressed={selectedKey === entry.key}'));
  assert.match(HTML_CONTENT_EDITOR_STYLES_SOURCE, /\.videoRail\s*\{[^}]*overflow-x: auto;/);
  assert.match(HTML_CONTENT_EDITOR_STYLES_SOURCE, /\.rightPreviewColumn\s*\{[^}]*position: sticky;[^}]*max-height: calc\(100dvh - 28px\);[^}]*overflow-y: auto;[^}]*display: flex;[^}]*flex-direction: column;/);
});

test("video story Content selection maps fields to the stable Video ID and only scrolls the horizontal gallery", () => {
  const source = HTML_CONTENT_EDITOR_COMPONENT_SOURCE;
  assert.ok(source.includes("...extractEditableEntitiesWithVideoStories(source)"));
  assert.ok(source.includes("function composeVideoStories("));
  assert.ok(source.includes("for (const [imageEntityId, videoEntityId] of videoStoryByImageEntityId)"));
  assert.ok(source.includes("const storyVideoId = videoStoryEntityByEntityId.get(entity.id)"));
  assert.ok(source.includes("onClick={() => onSelectVideo(block.id, story.id)}"));
  assert.ok(source.includes("{renderImageGroupContent(story.video"));
  assert.ok(source.includes(".map((group) => renderImageGroupContent(group, `story-${story.id}`, { storyField: true }))"));
  assert.ok(source.includes("entry.relatedEntityIds.includes(selected.entityId)"));
  assert.ok(source.includes("rail.scrollTo({ left: centeredRailScrollLeft(rail, card), behavior: \"smooth\" })"));
  assert.doesNotMatch(source.slice(source.indexOf("function VideoGallery"), source.indexOf("function bindVideoDialog")), /scrollIntoView|window\.scrollTo/);
  const contentSelectionEffect = source.slice(source.indexOf("if (!selected || selected.blockId !== block.id) return;"), source.indexOf("function contentGroupInteractionProps"));
  assert.ok(contentSelectionEffect.includes("if (videoStoryEntityByEntityId.has(selected.entityId)) return;"));
});

test("both Content media paths use intrinsic image preview and exclude Video image sources", () => {
  const source = HTML_CONTENT_EDITOR_COMPONENT_SOURCE;
  const normal = source.slice(source.indexOf("function renderImageGroupContent"), source.indexOf("function renderSliderGroup"));
  const repeating = source.slice(source.indexOf("{repeatingGroups.map"), source.indexOf("{imageGroups.map"));
  assert.ok(normal.includes("usesImageMetadata(previewEntity)"));
  assert.ok(repeating.includes("usesImageMetadata(entity)"));
  for (const renderer of [normal, repeating]) {
    assert.ok(renderer.includes("<IntrinsicImagePreview"));
    assert.equal(renderer.includes("<img"), false);
  }
  assert.ok(source.includes("event.currentTarget.naturalWidth"));
  assert.ok(source.includes("event.currentTarget.naturalHeight"));
  assert.ok(source.includes("aspectRatio: `${width} / ${height}`"));
  const css = HTML_CONTENT_EDITOR_STYLES_SOURCE;
  assert.doesNotMatch(css, /\.imagePreviewFrame\s*\{[^}]*(?:^|\n)\s*height: (?:136|112)px;/);
  assert.match(css, /\.imagePreview\s*\{[^}]*object-fit: contain;/);
  assert.match(css, /\.videoCardFrame img\s*\{[^}]*object-fit: contain;/);
});

test("video presentation is lazy, source-isolated and uses Editor modal accessibility", () => {
  const source = HTML_CONTENT_EDITOR_COMPONENT_SOURCE;
  assert.ok(source.includes('new IntersectionObserver'));
  assert.ok(source.includes('observer.disconnect()'));
  assert.ok(source.includes('key={`${entry.key}:${entry.source}`}'));
  assert.ok(source.includes('!disposed && !failed && video.getAttribute("src") === source'));
  assert.ok(source.includes('video.videoWidth'));
  assert.ok(source.includes('video.videoHeight'));
  assert.ok(source.includes('video.addEventListener("seeked", seeked)'));
  assert.ok(source.includes('<video ref={videoRef} muted playsInline preload="metadata"'));
  assert.ok(source.includes('<video ref={videoRef} controls playsInline preload="metadata"'));
  const presentation = source.slice(source.indexOf("type VideoPreviewState"), source.indexOf("type BlockFieldsProps"));
  assert.doesNotMatch(presentation, /fetch\(|\.blob\(|canvas|autoPlay|autoplay|\.play\(/);
  assert.ok(presentation.includes('data-ui-theme="editor"'));
  assert.ok(presentation.includes('role="dialog" aria-modal="true"'));
  assert.ok(presentation.includes('event.key === "Escape"'));
  assert.ok(presentation.includes('event.key !== "Tab"'));
  assert.ok(presentation.includes('trigger.focus()'));
  assert.ok(presentation.includes('resetVideoElement(video); restoreFocus()'));
  assert.ok(presentation.includes('event.target === event.currentTarget'));
  assert.ok(presentation.includes('state.phase === "ready" ? undefined : poster'));
  const videoStyles = HTML_CONTENT_EDITOR_STYLES_SOURCE.slice(HTML_CONTENT_EDITOR_STYLES_SOURCE.indexOf("/* Editor-owned media presentation"));
  assert.doesNotMatch(videoStyles, /#[0-9a-f]{3,8}\b|gradient/i);
  assert.ok(videoStyles.includes("var(--ui-accent-soft)"));
  assert.ok(videoStyles.includes("var(--ui-focus-ring)"));
});
