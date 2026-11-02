import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const basePath = process.env.NEXT_PUBLIC_BASE_PATH || "";
const siteUrl = process.env.NEXT_PUBLIC_SITE_URL || "https://tinymods.ru";
const routes = ["", "html-content-editor/", "privacy/"];
let checked = 0;

for (const route of routes) {
  const html = readFileSync(join("out", route, "index.html"), "utf8");
  assert.ok(!html.includes('id="tinymods-mirror-redirect"'), "No mirror redirect remains");
  const expectedCanonical = `${siteUrl}/${route.replace(/\/$/, "")}`;
  const canonical = html.match(/<link\b[^>]*rel="canonical"[^>]*href="([^"]+)"/)?.[1];
  assert.equal(canonical?.replace(/\/$/, ""), expectedCanonical.replace(/\/$/, ""));

  for (const [, rawUrl] of html.matchAll(/\b(?:href|src)="(\/[^"\s]*)"/g)) {
    if (rawUrl.startsWith("//")) continue;
    const pathname = new URL(rawUrl, "https://example.invalid").pathname;
    assert.ok(!basePath || pathname.startsWith(`${basePath}/`), `Missing base path: ${rawUrl}`);
    const path = decodeURIComponent(pathname.slice(basePath.length)).replace(/^\//, "");
    assert.ok(
      existsSync(join("out", path)) || existsSync(join("out", path, "index.html")),
      `Missing exported link or asset: ${rawUrl}`,
    );
    checked += 1;
  }
  assert.ok(html.includes(`${basePath}/brand/tinymods-logo.svg`), "Logo URL includes the base path");
  assert.ok(html.includes(`${basePath}/html-content-editor/`), "Editor link includes the base path");
  if (route !== "privacy/") {
    assert.ok(html.includes(`${basePath}/privacy/`), "Privacy link includes the base path");
  }
}

const manifest = JSON.parse(readFileSync("out/manifest.webmanifest", "utf8"));
assert.equal(manifest.start_url, `${basePath}/`);
assert.equal(manifest.scope, `${basePath}/`);
assert.equal(manifest.icons[0].src, `${basePath}/favicon.svg`);
assert.ok(readFileSync("out/sitemap.xml", "utf8").includes(`${siteUrl}/html-content-editor`));
assert.ok(readFileSync("out/robots.txt", "utf8").includes(`${siteUrl}/sitemap.xml`));

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  });
}
const assets = walk("out/_next/static");
assert.ok(assets.some(file => /optima-avif[.-].+\.js$/.test(file)), "AVIF worker is exported");
assert.ok(assets.some(file => file.endsWith(".wasm")), "Codec binaries are exported");
console.log(`PASS: ${routes.length} pages, ${checked} links/assets, metadata, manifest, worker and WASM.`);
