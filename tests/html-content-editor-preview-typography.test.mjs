import assert from "node:assert/strict";
import test from "node:test";

import { extractEditableEntities } from "../app/lib/html-content-editor/extract-editable-entities.ts";
import {
  applyPreviewTypographyText,
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
  assert.equal(applyPreviewTypographyText("Так же красиво"), "Так\u00a0же красиво");
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
