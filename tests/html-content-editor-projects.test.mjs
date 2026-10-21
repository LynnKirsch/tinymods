import assert from "node:assert/strict";
import test from "node:test";

import {
  BrowserProjectRepository,
  PROJECT_STORAGE_KEY,
  decodeProjectState,
  encodeProjectState,
} from "../app/lib/html-content-editor/browser-project-repository.ts";
import {
  formatAppearanceTextareaValue,
  parseAppearanceInput,
} from "../app/lib/html-content-editor/appearance-input.ts";
import {
  clearProjectPageAppearance,
  clearTemporarySiteAppearance,
  createEditorWorkspaceContext,
  projectPageCss,
  saveProjectPageAppearance,
  saveTemporarySiteAppearance,
  saveTemporaryPageAppearance,
  temporaryPageCss,
  temporarySiteCss,
} from "../app/lib/html-content-editor/editor-workspace-context.ts";
import { buildPreviewAppearance } from "../app/lib/html-content-editor/preview-appearance.ts";
import { createEditableEntityPatch } from "../app/lib/html-content-editor/encode-source-value.ts";
import { extractEditableEntities } from "../app/lib/html-content-editor/extract-editable-entities.ts";
import { visibleOutputSource } from "../app/lib/html-content-editor/output-code.ts";
import { applySourcePatches } from "../app/lib/html-content-editor/patch-source.ts";
import { buildPreviewSource } from "../app/lib/html-content-editor/preview-source.ts";

class MemoryStorage {
  store = new Map();

  getItem(key) {
    return this.store.get(key) ?? null;
  }

  setItem(key, value) {
    this.store.set(key, value);
  }
}

function createRepository() {
  const storage = new MemoryStorage();
  let id = 0;
  let tick = 0;
  const repository = new BrowserProjectRepository({
    storage,
    createId: () => `id-${++id}`,
    now: () => `2026-09-13T10:00:${String(++tick).padStart(2, "0")}.000Z`,
  });
  return { repository, storage };
}

test("browser repository creates projects, renames them, and manages pages", async () => {
  const { repository } = createRepository();
  const project = await repository.createProject({ name: "  Ильино  " });
  const page = await repository.createProjectPage({ projectId: project.id, name: "Главная" });

  assert.deepEqual((await repository.listProjects()).map((item) => item.name), ["Ильино"]);
  assert.equal((await repository.getProject(project.id)).name, "Ильино");
  assert.deepEqual((await repository.listProjectPages(project.id)).map((item) => item.name), [
    "Главная",
  ]);

  const renamed = await repository.updateProject(project.id, { name: "Хвоя Карелия" });
  assert.equal(renamed.id, project.id);
  assert.equal(renamed.name, "Хвоя Карелия");

  await repository.setActiveContext({ projectId: project.id, pageId: page.id });
  assert.deepEqual(await repository.getActiveContext(), {
    projectId: project.id,
    pageId: page.id,
  });
});

test("project creation activates the new project and delete keeps no-project valid", async () => {
  const { repository } = createRepository();
  const first = await repository.createProject({ name: "Ильино" });
  assert.deepEqual(await repository.getActiveContext(), {
    projectId: first.id,
    pageId: null,
  });

  const second = await repository.createProject({ name: "Хвоя" });
  assert.deepEqual(await repository.getActiveContext(), {
    projectId: second.id,
    pageId: null,
  });

  await repository.deleteProject(second.id);
  assert.deepEqual(await repository.getActiveContext(), {
    projectId: first.id,
    pageId: null,
  });

  await repository.deleteProject(first.id);
  assert.deepEqual(await repository.getActiveContext(), {
    projectId: null,
    pageId: null,
  });
});

test("browser repository isolates site and page styles by project", async () => {
  const { repository } = createRepository();
  const ilyino = await repository.createProject({ name: "Ильино" });
  const hvoya = await repository.createProject({ name: "Хвоя" });
  const home = await repository.createProjectPage({ projectId: ilyino.id, name: "Главная" });

  await repository.saveSiteAppearance(ilyino.id, ":root { --brand: #111; }");
  await repository.saveSiteAppearance(hvoya.id, ":root { --brand: #222; }");
  await repository.savePageAppearance(ilyino.id, home.id, ".hero { color: var(--brand); }");

  assert.equal((await repository.getSiteAppearance(ilyino.id)).css, ":root { --brand: #111; }");
  assert.equal((await repository.getSiteAppearance(hvoya.id)).css, ":root { --brand: #222; }");
  assert.equal(
    (await repository.getPageAppearance(home.id)).css,
    ".hero { color: var(--brand); }",
  );
});

test("site style revisions keep history and restore creates a new current snapshot", async () => {
  const { repository } = createRepository();
  const project = await repository.createProject({ name: "Ильино" });

  const first = await repository.saveSiteAppearance(project.id, "A { color: red; }");
  const second = await repository.saveSiteAppearance(project.id, "B { color: blue; }");
  assert.equal((await repository.getSiteAppearance(project.id)).css, second.css);

  const restored = await repository.restoreSiteStyleRevision(project.id, first.currentRevisionId);
  const revisions = await repository.listSiteStyleRevisions(project.id);
  assert.equal(restored.css, first.css);
  assert.deepEqual(revisions.map((revision) => revision.css), [
    "A { color: red; }",
    "B { color: blue; }",
    "A { color: red; }",
  ]);
});

test("clearing site appearance creates a reversible empty current revision", async () => {
  const { repository } = createRepository();
  const project = await repository.createProject({ name: "Ильино" });
  await repository.saveSiteAppearance(project.id, ":root { --brand: #123; }");

  await repository.clearSiteAppearance(project.id);
  const revisions = await repository.listSiteStyleRevisions(project.id);

  assert.equal(await repository.getSiteAppearance(project.id), null);
  assert.deepEqual(revisions.map((revision) => revision.css), [
    ":root { --brand: #123; }",
    "",
  ]);
});

test("project persistence uses a versioned state and corrupt data falls back safely", () => {
  const empty = decodeProjectState("not json");
  assert.equal(empty.schemaVersion, 1);
  assert.deepEqual(empty.projects, []);

  const state = {
    schemaVersion: 1,
    projects: [{ id: "p1", name: "Ильино", createdAt: "1", updatedAt: "1" }],
    pages: [],
    styleRevisions: [],
    activeProjectId: "p1",
    activePageId: null,
  };
  const encoded = encodeProjectState(state);
  assert.equal(JSON.parse(encoded).schemaVersion, 1);
  assert.equal(decodeProjectState(encoded).projects[0].id, "p1");
});

test("browser repository writes to the single versioned local storage key", async () => {
  const { repository, storage } = createRepository();
  await repository.createProject({ name: "Ильино" });

  assert.ok(storage.getItem(PROJECT_STORAGE_KEY));
  assert.equal(storage.store.size, 1);
});

test("temporary workspace appearance persists inside the versioned project state", async () => {
  const { repository, storage } = createRepository();
  const workspace = saveTemporarySiteAppearance(
    createEditorWorkspaceContext(),
    ":root { --brand: #456; }",
    () => "2026-09-13T10:00:00.000Z",
  );
  await repository.saveEditorWorkspaceContext(workspace);

  const restoredRepository = new BrowserProjectRepository({
    storage,
    createId: () => "unused",
    now: () => "2026-09-13T10:00:01.000Z",
  });
  assert.equal(
    temporarySiteCss(await restoredRepository.getEditorWorkspaceContext()),
    ":root { --brand: #456; }",
  );

  await restoredRepository.saveEditorWorkspaceContext(
    clearTemporarySiteAppearance(await restoredRepository.getEditorWorkspaceContext()),
  );
  assert.equal(temporarySiteCss(await restoredRepository.getEditorWorkspaceContext()), "");
});

test("additional page styles persist in the workspace context without a page entity", async () => {
  const { repository, storage } = createRepository();
  const first = await repository.createProject({ name: "Ильино" });
  const second = await repository.createProject({ name: "Хвоя" });
  let workspace = saveProjectPageAppearance(
    createEditorWorkspaceContext(),
    first.id,
    ".hero { color: #111; }",
    () => "2026-09-13T10:00:00.000Z",
  );
  workspace = saveProjectPageAppearance(
    workspace,
    second.id,
    ".hero { color: #222; }",
    () => "2026-09-13T10:00:01.000Z",
  );
  await repository.saveEditorWorkspaceContext(workspace);

  const restoredRepository = new BrowserProjectRepository({
    storage,
    createId: () => "unused",
    now: () => "2026-09-13T10:00:02.000Z",
  });
  const restored = await restoredRepository.getEditorWorkspaceContext();

  assert.equal(projectPageCss(restored, first.id), ".hero { color: #111; }");
  assert.equal(projectPageCss(restored, second.id), ".hero { color: #222; }");

  const cleared = clearProjectPageAppearance(restored, first.id);
  assert.equal(projectPageCss(cleared, first.id), "");
  assert.equal(projectPageCss(cleared, second.id), ".hero { color: #222; }");
});

test("temporary additional page styles work without project", () => {
  const workspace = saveTemporaryPageAppearance(
    createEditorWorkspaceContext(),
    ".hero { color: #333; }",
    () => "2026-09-13T10:00:00.000Z",
  );

  assert.equal(temporaryPageCss(workspace), ".hero { color: #333; }");
});

test("project context is optional and does not auto-create pages", async () => {
  const { repository } = createRepository();
  const project = await repository.createProject({ name: "Ильино" });

  assert.deepEqual(await repository.listProjectPages(project.id), []);
  await repository.setActiveContext({ projectId: null, pageId: null });
  assert.deepEqual(await repository.getActiveContext(), {
    projectId: null,
    pageId: null,
  });
});

test("project pages can keep an optional path without making it required", async () => {
  const { repository } = createRepository();
  const project = await repository.createProject({ name: "Ильино" });
  const home = await repository.createProjectPage({ projectId: project.id, name: "Главная" });
  const rooms = await repository.createProjectPage({
    projectId: project.id,
    name: "Номера",
    path: "/rooms",
  });

  assert.equal(home.path, undefined);
  assert.equal(rooms.path, "/rooms");
});

test("appearance parser accepts raw CSS, style tags, and ignores scripts in large fragments", () => {
  assert.deepEqual(parseAppearanceInput(":root { --brand: #123; }"), {
    ok: true,
    css: ":root { --brand: #123; }",
    sourceKind: "raw-css",
  });

  assert.deepEqual(
    parseAppearanceInput("<style>.a { color: red; }</style><style>.b { color: blue; }</style>"),
    {
      ok: true,
      css: ".a { color: red; }\n\n.b { color: blue; }",
      sourceKind: "style-tags",
    },
  );

  assert.equal(
    parseAppearanceInput('<link href="x.css"><style>.a { color: red; }</style><script>alert(1)</script><div>x</div>').css,
    ".a { color: red; }",
  );
  assert.equal(parseAppearanceInput("обычный текст").ok, false);
  assert.equal(parseAppearanceInput(" ").message, "Введите код оформления.");
});

test("appearance textarea helper prepares a style wrapper without making it required", () => {
  assert.equal(formatAppearanceTextareaValue(), "<style>\n\n</style>");
  assert.equal(
    formatAppearanceTextareaValue(":root {\n  --color-bg-main: #F3EFE4;\n}"),
    "<style>\n:root {\n  --color-bg-main: #F3EFE4;\n}\n</style>",
  );
  assert.deepEqual(
    parseAppearanceInput("<style>\n:root {\n  --color-bg-main: #F3EFE4;\n}\n</style>"),
    {
      ok: true,
      css: ":root {\n  --color-bg-main: #F3EFE4;\n}",
      sourceKind: "style-tags",
    },
  );
  assert.deepEqual(parseAppearanceInput(":root { --color-bg-main: #F3EFE4; }"), {
    ok: true,
    css: ":root { --color-bg-main: #F3EFE4; }",
    sourceKind: "raw-css",
  });
});

test("current preview flow uses site styles and block styles", () => {
  const blockSource = `<style>.card { color: var(--text-primary); }</style><div class="card">Text</div>`;
  const missing = buildPreviewAppearance({ blockSource });
  assert.equal(missing.needsAppearance, true);
  assert.deepEqual(missing.unresolvedVariables, ["--text-primary"]);

  const covered = buildPreviewAppearance({
    siteCss: ":root { --text-primary: #111; }",
    blockSource,
  });
  assert.equal(covered.needsAppearance, false);
  assert.equal(covered.css, ":root { --text-primary: #111; }");
});

test("preview cascade uses site styles then page styles while final source stays block-only", () => {
  const blockSource = `<style>.card { color: var(--text-primary); background: var(--page-bg); }</style><h2>Old</h2>`;
  const siteCss = ":root { --text-primary: #111; }";
  const pageCss = ":root { --page-bg: #fff; }";
  const appearance = buildPreviewAppearance({
    siteCss,
    pageCss,
    blockSource,
  });
  const title = extractEditableEntities(blockSource).find((entity) => entity.rawValue === "Old");
  const finalSource = applySourcePatches(blockSource, [
    createEditableEntityPatch(title, "New"),
  ]);

  assert.equal(appearance.needsAppearance, false);
  assert.equal(appearance.css, `${siteCss}\n\n${pageCss}`);
  assert.equal(finalSource, `<style>.card { color: var(--text-primary); background: var(--page-bg); }</style><h2>New</h2>`);
  assert.ok(!finalSource.includes(siteCss));
  assert.ok(!finalSource.includes(pageCss));
});

test("block-only flow works without project, page, or appearance", () => {
  const source = `<style>.card { color: #111; }</style><h2>Old</h2>`;
  const entities = extractEditableEntities(source);
  const preview = buildPreviewSource(source, entities);

  assert.ok(preview.source.includes("Old"));
  assert.equal(buildPreviewAppearance({ blockSource: source }).css, "");
  assert.equal(visibleOutputSource(source, ""), source);
});

test("temporary site appearance works without project and stays preview-only", () => {
  const source = `<style>.card { color: var(--text-primary); }</style><h2>Old</h2>`;
  const workspace = saveTemporarySiteAppearance(
    createEditorWorkspaceContext(),
    ":root { --text-primary: #111; }",
    () => "2026-09-13T10:00:00.000Z",
  );
  const previewAppearance = buildPreviewAppearance({
    siteCss: temporarySiteCss(workspace),
    blockSource: source,
  });

  assert.equal(previewAppearance.needsAppearance, false);
  assert.equal(previewAppearance.css, ":root { --text-primary: #111; }");
  assert.equal(visibleOutputSource(source, ""), source);
});

test("project can be created after temporary editing without losing styles or block source", async () => {
  const { repository } = createRepository();
  const source = `<h2>Block</h2>`;
  const workspace = saveTemporarySiteAppearance(
    createEditorWorkspaceContext(),
    ":root { --brand: #123; }",
    () => "2026-09-13T10:00:00.000Z",
  );
  const project = await repository.createProject({ name: "Ильино" });
  await repository.saveSiteAppearance(project.id, temporarySiteCss(workspace));

  assert.equal((await repository.getSiteAppearance(project.id)).css, ":root { --brand: #123; }");
  assert.equal(visibleOutputSource(source, ""), source);
});

test("project switch changes appearance context without changing block source", async () => {
  const { repository } = createRepository();
  const source = `<style>.card { color: var(--brand); }</style><h2>Block</h2>`;
  const first = await repository.createProject({ name: "Ильино" });
  const second = await repository.createProject({ name: "Хвоя" });
  await repository.saveSiteAppearance(first.id, ":root { --brand: #111; }");
  await repository.saveSiteAppearance(second.id, ":root { --brand: #222; }");

  const firstAppearance = buildPreviewAppearance({
    siteCss: (await repository.getSiteAppearance(first.id)).css,
    blockSource: source,
  });
  const secondAppearance = buildPreviewAppearance({
    siteCss: (await repository.getSiteAppearance(second.id)).css,
    blockSource: source,
  });

  assert.equal(firstAppearance.css, ":root { --brand: #111; }");
  assert.equal(secondAppearance.css, ":root { --brand: #222; }");
  assert.equal(visibleOutputSource(source, ""), source);
});

test("appearance styles are preview-only and never alter source patches", () => {
  const source = `<style>.card { color: var(--text-primary); }</style><h2>Old</h2>`;
  const entities = extractEditableEntities(source);
  const title = entities.find((entity) => entity.rawValue === "Old");
  const preview = buildPreviewSource(source, entities, {
    appearanceCss: ":root { --text-primary: #111; }",
  });
  const finalSource = applySourcePatches(source, [
    createEditableEntityPatch(title, "New"),
  ]);

  assert.match(preview.source, /data-tinymods-appearance-style/);
  assert.equal(finalSource, `<style>.card { color: var(--text-primary); }</style><h2>New</h2>`);
  assert.ok(!finalSource.includes("tinymods-appearance"));
  assert.ok(!finalSource.includes("--text-primary: #111"));
});
