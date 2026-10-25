import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { IMAGE_OPTIMIZER_FAQ, loadServiceHelpContent, parseInstructionMarkdown } from "../app/lib/service-help-content.ts";

import {
  getTinymodsServiceByPathname,
  normalizeTinymodsPathname,
  TINYMODS_SERVICES,
} from "../app/lib/tinymods-services.ts";

const shellUrl = new URL("../app/components/tinymods-shell/", import.meta.url);
const tabsSource = readFileSync(new URL("GlobalServiceTabs.tsx", shellUrl), "utf8");
const curtainSource = readFileSync(new URL("ServiceCurtainTransition.tsx", shellUrl), "utf8");
const shellCss = readFileSync(new URL("TinymodsToolsShell.module.css", shellUrl), "utf8");

function renderShellComponent(source, pathname, { reducedMotion = false, onServiceClick, helpContent, helpView = null, selectedServiceId } = {}) {
  const calls = [];
  const jsx = (type, props, key) => ({ type, props, key });
  const exports = {};
  const nativeRequire = createRequire(import.meta.url);
  const mocks = {
    "react/jsx-runtime": { jsx, jsxs: jsx },
    react: { useState: (initial) => [initial === null ? helpView : initial, (value) => calls.push(["settled", value])] },
    "next/navigation": {
      usePathname: () => pathname,
      useRouter: () => ({ push: (...args) => calls.push(["push", ...args]) }),
    },
    "next/link": { __esModule: true, default: "Link" },
    "next/image": { __esModule: true, default: "Image" },
    "motion/react": {
      AnimatePresence: "AnimatePresence",
      motion: { div: "motion.div" },
      useReducedMotion: () => reducedMotion,
    },
    "./GlobalServiceTabs": { __esModule: true, default: "GlobalServiceTabs" },
    "./ServiceHelpDrawer": { __esModule: true, default: "ServiceHelpDrawer" },
    "./TinymodsToolsShell.module.css": {
      __esModule: true,
      default: new Proxy({}, { get: (_, name) => name }),
    },
    "../../lib/tinymods-services": { getTinymodsServiceByPathname, normalizeTinymodsPathname, TINYMODS_SERVICES },
  };
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  runInNewContext(compiled, {
    exports,
    require: (name) => mocks[name] ?? nativeRequire(name),
  });
  return { tree: exports.default({ children: "tool content", onServiceClick, helpContent, selectedServiceId }), calls };
}

test("lists only published Tinymods tool routes", () => {
  assert.deepEqual(
    TINYMODS_SERVICES.map((service) => service.href),
    ["/", "/html-content-editor"],
  );
  assert.ok(!TINYMODS_SERVICES.some((service) => service.href === "/png-to-svg"));
  assert.ok(!TINYMODS_SERVICES.some((service) => service.href.startsWith("/tools")));
});

test("keeps tab labels and accents in the shared services config", () => {
  assert.deepEqual(
    TINYMODS_SERVICES.map((service) => [service.shortTitle, service.accent]),
    [
      ["Optima", "#718134"],
      ["HTML", "#238fbc"],
    ],
  );
});

test("normalizes route pathnames for service navigation", () => {
  assert.equal(normalizeTinymodsPathname("/"), "/");
  assert.equal(normalizeTinymodsPathname("/html-content-editor/"), "/html-content-editor");
  assert.equal(normalizeTinymodsPathname("/html-content-editor?x=1"), "/html-content-editor");
});

test("detects active Tinymods service from pathname", () => {
  assert.equal(getTinymodsServiceByPathname("/").id, "image-optimizer");
  assert.equal(getTinymodsServiceByPathname("/html-content-editor").id, "html-content-editor");
  assert.equal(getTinymodsServiceByPathname("/html-content-editor/example").id, "html-content-editor");
});

for (const [pathname, theme, activeHref] of [
  ["/", "optima", "/"],
  ["/html-content-editor", "editor", "/html-content-editor"],
  ["/html-content-editor/example", "editor", "/html-content-editor"],
  ["/html-content-editor/", "editor", "/html-content-editor"],
]) {
  test(`shell and tabs derive ${theme} theme and active route from ${pathname}`, () => {
    const { tree } = renderShellComponent(curtainSource, pathname);
    assert.equal(tree.props["data-ui-theme"], theme);
    assert.equal(tree.props.className, "transitionRoot");
    assert.equal(tree.props.children[0].type, "GlobalServiceTabs");
    assert.equal(tree.props.children[1].props.children.props.children.props.children, "tool content");

    const clickCalls = [];
    const { tree: nav } = renderShellComponent(tabsSource, pathname, {
      onServiceClick: (...args) => clickCalls.push(args),
    });
    assert.equal(nav.type, "nav");
    assert.equal(nav.props["aria-label"], "Сервисы Tinymods");
    assert.equal(nav.props.style, undefined);
    const logo = nav.props.children[0];
    assert.equal(logo.type, "Link");
    assert.equal(logo.props.href, "/");
    assert.equal(logo.props["aria-label"], "Tinymods — главная");
    assert.equal(logo.props.children.props.src, "/brand/tinymods-logo.svg?v=da2261dccb4d");
    assert.equal(logo.props.children.props.alt, "");
    assert.equal(logo.props.children.props.width / logo.props.children.props.height, 1961 / 385);
    const links = nav.props.children[1].props.children;
    assert.deepEqual(Array.from(links, (link) => link.props.href), ["/", "/html-content-editor"]);
    for (const [index, link] of links.entries()) {
      const active = link.props.href === activeHref;
      assert.equal(link.props["aria-current"], active ? "page" : undefined);
      assert.equal(link.props.className, active ? "tab activeTab" : "tab");
      assert.equal(link.props.style, undefined);
      assert.equal(link.props["data-ui-theme"], index === 1 ? "editor" : undefined);
      assert.equal(Boolean(link.props.children[0]), active);
      if (active) assert.equal(link.props.children[0].props["aria-hidden"], "true");
      const event = { button: 0 };
      link.props.onClick(event);
      assert.equal(clickCalls[index][0], event);
      assert.equal(clickCalls[index][1], TINYMODS_SERVICES[index]);
    }
  });
}

test("curtain preserves navigation, modified clicks and motion parameters", () => {
  for (const reducedMotion of [false, true]) {
    const { tree, calls } = renderShellComponent(curtainSource, "/", { reducedMotion });
    const [tabs, stack] = tree.props.children;
    const presence = stack.props.children;
    const page = presence.props.children;
    assert.equal(presence.props.initial, false);
    assert.equal(presence.props.mode, "popLayout");
    assert.equal(page.key, "/");
    assert.equal(page.props.className, "pageLayer");
    assert.equal(page.props.transition.duration, reducedMotion ? 0.01 : 0.58);
    assert.equal(JSON.stringify(page.props.initial), JSON.stringify(reducedMotion ? { opacity: 0 } : { y: "-100dvh" }));
    assert.equal(JSON.stringify(page.props.animate), JSON.stringify(reducedMotion ? { opacity: 1 } : { y: 0, transitionEnd: { transform: "none" } }));
    assert.equal(JSON.stringify(page.props.exit), JSON.stringify(reducedMotion ? { opacity: 1 } : { y: 0 }));
    if (!reducedMotion) assert.equal(JSON.stringify(page.props.transition.ease), "[0.22,1,0.36,1]");

    const event = { button: 0, preventDefault: () => calls.push(["preventDefault"]) };
    tabs.props.onServiceClick(event, TINYMODS_SERVICES[0]);
    assert.equal(calls.length, 0);
    for (const modifier of ["metaKey", "ctrlKey", "shiftKey", "altKey"]) {
      tabs.props.onServiceClick({ ...event, [modifier]: true }, TINYMODS_SERVICES[1]);
    }
    tabs.props.onServiceClick({ ...event, button: 1 }, TINYMODS_SERVICES[1]);
    assert.equal(calls.length, 0);
    tabs.props.onServiceClick(event, TINYMODS_SERVICES[1]);
    assert.equal(JSON.stringify(calls), JSON.stringify([["preventDefault"], ["push", "/html-content-editor", { scroll: true }]]));
    page.props.onAnimationComplete();
    assert.equal(JSON.stringify(calls.at(-1)), '["settled","/"]');
  }
});

test("service navigation uses shared typography and semantic theme tokens without raw accents", () => {
  assert.doesNotMatch(tabsSource, /CSSProperties|style=|\.accent/);
  assert.doesNotMatch(shellCss, /var\(--ui-gradient-(?:brand|atmosphere|glass)\)/);
  assert.doesNotMatch(shellCss, /#[\da-f]{3,8}\b|rgba?\(|(?:linear|radial)-gradient\(|--(?:tool|service)-accent|\b(?:Inter|Manrope|Arial)\b|font-weight:\s*[789]00/i);
  for (const token of [
    "font-family", "font-12", "weight-control", "weight-heading", "leading-control",
    "gradient-app", "surface-1", "surface-hover", "text-primary", "text-secondary",
    "border", "border-strong", "accent", "gradient-soft", "accent-ink", "accent-border", "accent-hover",
    "focus-ring", "radius-md", "motion-normal", "ease",
  ]) assert.ok(shellCss.includes(`var(--ui-${token})`), token);
  assert.match(shellCss, /\.tab:focus-visible\s*\{\s*outline: 3px solid var\(--ui-focus-ring\);/);
  assert.match(shellCss, /\.activeTab\s*\{[^}]*background: var\(--ui-gradient-soft\);[^}]*font-weight: var\(--ui-weight-heading\);/);
  assert.doesNotMatch(shellCss.match(/\.activeTab\s*\{([^}]*)\}/)[1], /height|padding|radius/);
  assert.match(shellCss, /\.tabAccent\s*\{[^}]*width: var\(--ui-space-8\);[^}]*height: var\(--ui-space-8\);/);
});

test("Editor shell uses cool background and soft blue tabs without changing shared geometry", () => {
  assert.match(shellCss, /\.transitionRoot:global\(\[data-ui-theme="editor"\]\)\s*\{\s*background: var\(--ui-bg-app\);\s*\}/);
  assert.match(shellCss, /\.transitionRoot:global\(\[data-ui-theme="editor"\]\) \.activeTab,\s*\.transitionRoot:global\(\[data-ui-theme="editor"\]\) \.activeTab:hover\s*\{\s*background: var\(--ui-accent-soft\);\s*\}/);
  assert.match(shellCss, /\.activeTab\s*\{[^}]*border-color: var\(--ui-accent-border\);[^}]*background: var\(--ui-gradient-soft\);[^}]*color: var\(--ui-accent-ink\);/);
  assert.match(shellCss, /\.tabAccent\s*\{[^}]*background: var\(--ui-accent\);/);
});

test("shell retains responsive gutters, tab scrolling and working area geometry", () => {
  const gutters = [...shellCss.matchAll(/@media \(min-width: (\d+)px\)\s*\{\s*\.tabs\s*\{\s*padding-inline: (\d+)px;/g)]
    .map(([, min, padding]) => [Number(min), Number(padding)]);
  for (const [width, expected] of [
    [479, 15], [480, 30], [639, 30], [640, 30], [959, 30], [960, 30],
    [1199, 30], [1200, 50], [1439, 50], [1440, 50], [1919, 50], [1920, 90],
    [2559, 90], [2560, 120],
  ]) {
    const padding = gutters.filter(([min]) => width >= min).at(-1)?.[1] ?? 15;
    assert.equal(padding, expected, `gutter at ${width}px`);
  }
  assert.match(shellCss, /\.tabs\s*\{[^}]*position: relative;[^}]*padding: 0 15px;[^}]*display: grid;[^}]*grid-template-columns: repeat\(12, minmax\(0, 1fr\)\);/);
  assert.match(shellCss, /\.brandLink\s*\{[^}]*grid-column: 1 \/ 5;[^}]*display: inline-flex;/);
  assert.match(shellCss, /\.brandLink img\s*\{[^}]*max-width: 100%;[^}]*height: auto;/);
  assert.doesNotMatch(shellCss.match(/\.brandLink\s*\{([^}]*)\}/)[1], /position:\s*absolute|margin-left|transform/);
  assert.match(shellCss, /\.tabScroller\s*\{[^}]*display: flex;[^}]*overflow-x: auto;[^}]*overflow-y: hidden;/);
  assert.match(shellCss, /\.pageStack\s*\{[^}]*display: grid;[^}]*overflow-x: clip;/);
  assert.match(shellCss, /\.pageLayer\s*\{[^}]*grid-area: 1 \/ 1;[^}]*contain: paint;[^}]*will-change: transform;/);
  assert.match(shellCss, /\.pageLayerEntering\s*\{\s*height: 100dvh;\s*overflow: clip;/);
  assert.match(shellCss, /@media \(max-width: 479px\)[\s\S]*\.fullTitle\s*\{\s*display: none;\s*\}[\s\S]*\.shortTitle\s*\{\s*display: inline;/);
  assert.match(shellCss, /@media \(prefers-reduced-motion: reduce\)[\s\S]*transition: none;[\s\S]*will-change: auto;/);
});

test("prepared Markdown preserves paragraph order, emphasis and ordered/unordered lists as data", () => {
  assert.deepEqual(parseInstructionMarkdown("# Title\r\n\r\nFirst **important** paragraph.\r\nContinued.\r\n\r\n## Step\r\n- A\r\n- B\r\n\r\n### Detail\r\n1. C\r\n2. D"), [
    { kind: "paragraph", text: "First **important** paragraph. Continued." },
    { kind: "heading", text: "Step" }, { kind: "list", ordered: false, items: ["A", "B"] },
    { kind: "subheading", text: "Detail" }, { kind: "list", ordered: true, items: ["C", "D"] },
  ]);
});

test("build-time help uses the prepared docs and shares the exact FAQ source with SEO", async () => {
  const help = await loadServiceHelpContent();
  assert.equal(help["image-optimizer"].faq, IMAGE_OPTIMIZER_FAQ);
  const instruction = readFileSync(new URL("../OPTIMA-IMAGE-OPTIMIZER-INSTRUCTION.md", import.meta.url), "utf8");
  const combined = readFileSync(new URL("../OPTIMA-SERVICE-INSTRUCTIONS.md", import.meta.url), "utf8");
  assert.ok(combined.includes(instruction.trim()));
  assert.deepEqual(help["image-optimizer"].instruction, parseInstructionMarkdown(instruction));
  assert.doesNotMatch(instruction, /поворот|развернуть|ZIP|Retina|<picture>/i);
  assert.match(instruction, /JPEG используется только как входной формат/);
  assert.match(instruction, /до 10 изображений/);
  assert.match(instruction, /выбрано 85/);
  const page = readFileSync(new URL("../app/(tools)/page.tsx", import.meta.url), "utf8");
  assert.match(page, /IMAGE_OPTIMIZER_FAQ as FAQ_ITEMS/);
  assert.equal((page.match(/FAQ_ITEMS\.map/g) ?? []).length, 2);
  assert.doesNotMatch(page, /const FAQ_ITEMS/);
  const client = tabsSource + curtainSource + readFileSync(new URL("ServiceHelpDrawer.tsx", shellUrl), "utf8");
  assert.doesNotMatch(client, /node:fs|readFile\(|fetch\(|dangerouslySetInnerHTML/);
  assert.equal(help["html-content-editor"].instruction.filter(block => block.kind === "heading").length, 11);
});

test("help buttons open the current service content without navigation or replacing tool children", async () => {
  const helpContent = await loadServiceHelpContent();
  for (const [path, theme] of [["/", "optima"], ["/html-content-editor", "editor"]]) {
    const { tree: nav, calls } = renderShellComponent(tabsSource, path, { helpContent, helpView: "faq" });
    const [, , actions, drawer] = nav.props.children;
    assert.equal(actions.props.children.length, 2);
    actions.props.children[0].props.onClick();
    actions.props.children[1].props.onClick();
    assert.equal(JSON.stringify(calls), JSON.stringify([["settled", "instruction"], ["settled", "faq"]]));
    assert.equal(drawer.type, "ServiceHelpDrawer");
    assert.equal(drawer.props.open, true);
    assert.equal(drawer.props.theme, theme);
    assert.equal(drawer.props.id, "service-help-panel");
    assert.equal(drawer.props.children.length, helpContent[path === "/" ? "image-optimizer" : "html-content-editor"].faq.length);
    drawer.props.onClose();
    assert.equal(calls.at(-1)[1], null);
  }
});

test("Privacy selects the blue Editor tab without claiming a different URL is current", () => {
  const { tree } = renderShellComponent(tabsSource, "/privacy/", { selectedServiceId: "html-content-editor" });
  const links = tree.props.children[1].props.children;
  assert.equal(links[0].props.className, "tab");
  assert.equal(links[1].props.className, "tab activeTab");
  assert.equal(links[1].props["data-ui-theme"], "editor");
  assert.equal(links[0].props["aria-current"], undefined);
  assert.equal(links[1].props["aria-current"], undefined);
  assert.equal(tree.props.children[2], null);
});
