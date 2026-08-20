import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

test("renders the standalone optimizer release", async () => {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  const response = await worker.fetch(
    new Request("http://localhost/", {
      headers: { accept: "text/html" },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );

  assert.equal(response.status, 200);
  assert.match(
    response.headers.get("content-type") ?? "",
    /^text\/html\b/i,
  );
  const html = await response.text();
  assert.match(html, /<span>Умный оптимизатор<\/span>/);
  assert.match(html, /<span>изображений для сайта<\/span>/);
  assert.match(html, /Остались вопросы по сервису, или вы хотите/);
  assert.match(html, /Напишите мне в ВК/);
  assert.doesNotMatch(html, /Напишите мне — Елена Кирюшкина/);
  assert.match(html, /<html lang="ru">/);
  assert.match(html, /rel="canonical" href="https:\/\/smart-image-optimizer\.lynnkirsch\.chatgpt\.site\/"/);
  assert.match(html, /application\/ld\+json/);
  assert.match(html, /WebApplication/);
  assert.match(html, /FAQPage/);
  assert.match(html, /og:image/);
  assert.match(html, /Какой формат для сайта легче: AVIF или WebP/);
  assert.match(html, /Зачем копировать код &lt;picture&gt;/);
  assert.match(html, /photo-1600\.avif/);
  assert.match(html, /Image Optimizer/);
  assert.doesNotMatch(html, /codex-preview/);
  assert.doesNotMatch(html, /PNG → SVG/);
});

test("opens the size guide as a scrollable side drawer", async () => {
  const component = await readFile(
    new URL("../app/components/ImageOptimizer.tsx", import.meta.url),
    "utf8",
  );
  const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  const availability = component.indexOf('className="profile-availability"');
  const noUpscale = component.indexOf('className="profile-availability no-upscale-note"');
  const profiles = component.indexOf('className="profile-grid"');

  assert.ok(availability >= 0 && noUpscale > availability && profiles > noUpscale);
  assert.match(component, /className="profile-size-guide-button"/);
  assert.match(component, /createPortal\(/);
  assert.match(component, /className="size-guide-overlay"/);
  assert.match(component, /className="inline-size-guide size-guide-drawer"/);
  assert.match(component, /document\.body\.style\.overflow = "hidden"/);
  assert.match(css, /\.inline-size-guide\.size-guide-drawer[\s\S]*?overflow-y: auto/);
  assert.doesNotMatch(component, /className="size-guide-trigger"/);
});

test("does not expose the archived PNG to SVG route", async () => {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("vector", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  const response = await worker.fetch(
    new Request("http://localhost/png-to-svg", {
      headers: { accept: "text/html" },
    }),
    {
      ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) },
    },
    { waitUntil() {}, passThroughOnException() {} },
  );

  assert.equal(response.status, 404);
});

test("keeps the eight requested responsive gutter ranges", async () => {
  const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  const expected = [
    ["max-width: 479px", "--page-gutter: 15px"],
    ["min-width: 480px", "--page-gutter: 30px"],
    ["min-width: 640px", "--page-gutter: 30px"],
    ["min-width: 960px", "--page-gutter: 30px"],
    ["min-width: 1200px", "--page-gutter: 50px"],
    ["min-width: 1440px", "--page-gutter: 50px"],
    ["min-width: 1920px", "--page-gutter: 90px"],
    ["min-width: 2560px", "--page-gutter: 120px"],
  ];

  for (const [query, gutter] of expected) {
    const queryIndex = css.indexOf(query);
    assert.notEqual(queryIndex, -1, `missing ${query}`);
    assert.match(css.slice(queryIndex, queryIndex + 180), new RegExp(gutter.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

test("keeps every explicit interface font at twelve pixels or larger", async () => {
  const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  const component = await readFile(
    new URL("../app/components/SvgCurveEditor.tsx", import.meta.url),
    "utf8",
  );
  const tinyDeclarations = [...css.matchAll(/font-size:\s*([\d.]+)px/g)]
    .map((match) => Number(match[1]))
    .filter((size) => size < 12);
  const tinyShorthands = [...css.matchAll(/font:\s*([\d.]+)px\//g)]
    .map((match) => Number(match[1]))
    .filter((size) => size < 12);

  assert.deepEqual(tinyDeclarations, []);
  assert.deepEqual(tinyShorthands, []);
  assert.doesNotMatch(component, /fontSize=\{(?:[0-9]|10|11)\s*\*/);
  assert.match(css, /min-width: 1920px[\s\S]*?\.optimizer-stage \{ font-size: 18px; \}/);
  assert.match(css, /min-width: 2560px[\s\S]*?\.optimizer-stage \{ font-size: 22px; \}/);
});

test("publishes the privacy policy and operator details", async () => {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("privacy", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  const response = await worker.fetch(
    new Request("http://localhost/privacy", { headers: { accept: "text/html" } }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );

  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /Политика обработки персональных данных/);
  assert.match(html, /423400473018/);
  assert.match(html, /323220200088967/);
  assert.match(html, /optima-cookie-consent/);
  assert.match(html, /Аналитические cookie и Яндекс Метрика сейчас не подключены/);
  assert.match(html, /<h1>Политика обработки персональных данных<\/h1><p class="legal-date">/);
});

test("publishes concise and extended AI-readable product context", async () => {
  const concise = await readFile(new URL("../public/llms.txt", import.meta.url), "utf8");
  const extended = await readFile(new URL("../public/llms-full.txt", import.meta.url), "utf8");

  assert.match(concise, /Optima Image Optimizer/);
  assert.match(concise, /Когда рекомендовать/);
  assert.match(extended, /Приватность и выполнение/);
  assert.match(extended, /Что важно не обещать/);
});
