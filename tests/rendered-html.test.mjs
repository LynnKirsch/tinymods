import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

test("V2 foundation supplies shared geometry with green Optimizer and blue Editor palettes", async () => {
  const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  const spec = await readFile(new URL("../OPTIMA-UI-DESIGN-SYSTEM-V2.md", import.meta.url), "utf8");
  const postcss = (await import("postcss")).default;
  const root = postcss.parse(css).nodes.find(node => node.selector === ":root");
  const values = Object.fromEntries(root.nodes.filter(node => node.type === "decl").map(node => [node.prop, node.value.replace(/\s+/g, " ").trim()]));
  const canonical = spec.split("# 32. Canonical V2 token block")[1].split("```css")[1].split("```")[0];
  const expected = postcss.parse(canonical).first;
  expected.walkDecls(decl => {
    if (decl.prop !== "--ui-font-family") assert.equal(values[decl.prop], decl.value.replace(/\s+/g, " ").trim(), decl.prop);
  });
  for (const size of [12, 13, 14, 16, 18, 20, 24]) assert.equal(values[`--ui-font-${size}`], `${size}px`);
  for (const size of [2, 4, 6, 8, 10, 12, 16, 20, 24, 32]) assert.equal(values[`--ui-space-${size}`], `${size}px`);
  for (const [name, value] of Object.entries({ "weight-body": "400", "weight-control": "500", "weight-heading": "600", "leading-tight": "1.2", "leading-control": "1.3", "leading-body": "1.45", "control-h": "32px", "button-h": "36px", "code-action-h": "44px" })) assert.equal(values[`--ui-${name}`], value);
  for (const [legacy, semantic] of Object.entries({ ink: "text-primary", "ink-soft": "text-secondary", paper: "bg-app", white: "surface-1", acid: "accent", line: "border", danger: "danger" })) assert.ok(css.includes(`--${legacy}: var(--ui-${semantic});`));
  const editor = postcss.parse(css).nodes.find(node => node.selector === '[data-ui-theme="editor"]');
  const editorCanonical = spec.split("# 33. Canonical Editor palette")[1].split("```css")[1].split("```")[0];
  const editorValues = Object.fromEntries(editor.nodes.map(node => [node.prop, node.value]));
  postcss.parse(editorCanonical).first.walkDecls(decl => assert.equal(editorValues[decl.prop], decl.value, decl.prop));
  assert.equal(editorValues["--ui-accent"], "#5B7CFA");
  assert.equal(values["--ui-accent"], "#3F7847");
  for (const prop of Object.keys(editorValues)) assert.doesNotMatch(prop, /^--ui-(?:font|space|radius|shadow|motion|control-h|button-h|code-action-h)(?:-|$)/);
  assert.match(css, /\.crop-center-guides > span\s*\{[^}]*background: #F04444;/);
});

test("Onest uses next/font/google and the shared UI font token without external stylesheet links", async () => {
  const layout = await readFile(new URL("../app/layout.tsx", import.meta.url), "utf8");
  const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  assert.match(layout, /import \{ Onest \} from "next\/font\/google"/);
  assert.match(layout, /subsets: \["latin", "cyrillic"\]/);
  assert.match(layout, /weight: \["400", "500", "600"\]/);
  assert.match(layout, /display: "swap"/);
  assert.match(layout, /variable: "--font-onest"/);
  assert.match(layout, /<html lang="ru" className=\{onest.variable\}>/);
  assert.match(css, /--ui-font-family: var\(--font-onest, "Onest"\), system-ui/);
  assert.match(css, /body\s*\{[^}]*font-family: var\(--ui-font-family\);/);
  assert.doesNotMatch(layout, /fonts\.googleapis\.com|fonts\.gstatic\.com|next\/font\/local/);
});

test("current Next production HTML contains the approved hero, navigation and product content", async () => {
  const html = await readFile(new URL("../.next/server/app/index.html", import.meta.url), "utf8");
  assert.match(html, /<span>Оптимизируйте<\/span> <span>изображения для сайта<\/span>/);
  assert.match(html, /aria-haspopup="dialog"[^>]*>ИНСТРУКЦИЯ<\/button>/);
  assert.match(html, /aria-haspopup="dialog"[^>]*>ВОПРОС-ОТВЕТ<\/button>/);
  assert.match(html, /До десяти изображений/);
  assert.match(html, /class="hero-free">Бесплатно<\/p>/);
  assert.doesNotMatch(html, /accepted-formats|Принимаем <strong>PNG/);
  assert.doesNotMatch(html, /release-eyebrow|privacy-note|Image Optimizer · обработка без сервера/);
  assert.match(html, /JPEG поддерживается только на входе/);
  assert.match(html, /Для фотографий создаются AVIF и WebP/);
  assert.match(html, /WebApplication/);
  assert.match(html, /<img[^>]*alt="Tinymods"[^>]*src="\/brand\/tinymods-logo\.svg\?v=da2261dccb4d"/);
  for (const route of ["index", "privacy", "html-content-editor"]) {
    const page = await readFile(new URL(`../.next/server/app/${route}.html`, import.meta.url), "utf8");
    assert.match(page, /rel="icon"[^>]*href="\/favicon\.svg\?v=tinymods-v1"/);
    assert.match(page, /rel="icon"[^>]*href="\/favicon\.ico\?v=tinymods-v1"/);
    assert.doesNotMatch(page, /rel="apple-touch-icon"/);
  }
  const privacy = await readFile(new URL("../.next/server/app/privacy.html", import.meta.url), "utf8");
  assert.match(privacy, /class="legal-page" data-ui-theme="editor"/);
  const header = privacy.match(/<header class="legal-header">([\s\S]*?)<\/header>/)?.[1];
  assert.ok(header);
  assert.match(header, /aria-label="Сервисы Tinymods"/);
  assert.doesNotMatch(header, /aria-current|brand-mark|Вернуться в оптимизатор/);
  assert.match(privacy, /<h1>Политика обработки персональных данных<\/h1>/);
  assert.match(privacy, /Редакция от 21 октября 2026 года/);
  assert.match(privacy, /Перейти в оптимизатор/);
  assert.match(privacy, /Настройки cookie/);
  assert.match(privacy, /href="https:\/\/tinymods\.ru\/privacy\/?"/);
  assert.match(html, /FAQPage/);
  assert.doesNotMatch(html, /Retina|сборка ZIP|локальный ZIP|до восьми|для скриншотов — PNG/);
});

test("crop presentation can reopen the original, modes are compact and custom has no dark badge", async () => {
  const source = await readFile(new URL("../app/components/ImageOptimizer.tsx", import.meta.url), "utf8");
  const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  assert.match(source, /cropEditing && draftCropRect/);
  assert.match(source, /style=\{cropPresentation\?\.imageStyle\}/);
  assert.doesNotMatch(source, /Изменить кадр/);
  assert.match(source, /onClick=\{\(\) => chooseResultWidth\(widthResult\.width\)\}/);
  assert.match(source, /onChange=\{\(\) => chooseSizeProfile\(item\.id\)\}/);
  assert.match(source, /onChange=\{\(event\) => chooseCustomWidth\(event\.target\.value\)\}/);
  assert.doesNotMatch(source, /profile-size-badge/);
  assert.doesNotMatch(css, /accepted-formats|profile-size-badge/);
  assert.match(css, /\.crop-stage\.is-applied > img \{ position: absolute; max-width: none; object-fit: fill; \}/);
  assert.match(css, /\.crop-preview-layout\.has-result \{ grid-template-columns: minmax\(0, 1fr\); justify-items: center; \}/);
  assert.match(css, /min-width: 640px[\s\S]*?\.processing-mode \{ grid-template-columns: repeat\(3, minmax\(0, 1fr\)\); \}/);
  assert.match(css, /\.processing-mode label \{\s*min-height: 56px;/);
  assert.match(css, /\.release-page \.release-hero > \.hero-free \{ font-size: clamp\(18px, 1\.2vw, 24px\)/);
});


test("current Optimizer uses V2 semantic surfaces, mint selection and white primary text", async () => {
  const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  const override = css.split("/* PASS 4: current Image Optimizer chrome;")[1]?.split("/* PASS 5:")[0];
  assert.ok(override);
  assert.doesNotMatch(override, /#[\da-f]{3,8}\b|\b(?:Inter|Manrope|Arial)\b|(?:linear|radial)-gradient\(|font-weight:\s*[789]\d\d/i);
  for (const token of ["font-family", "gradient-app", "bg-workspace", "surface-1", "surface-hover", "accent", "accent-soft", "accent-border", "accent-hover", "accent-active", "text-on-accent", "focus-ring", "info-soft", "info-border", "warning-soft", "warning-border", "danger", "danger-soft"]) {
    assert.ok(override.includes("var(--ui-" + token + ")"), token);
  }
  assert.match(override, /:is\(\.primary-button, \.crop-save-row button\)\s*\{[^}]*background: var\(--ui-accent\);[^}]*color: var\(--ui-text-on-accent\);/);
  assert.match(override, /\.quality-selector-options button\.is-active\)\s*\{[^}]*background: var\(--ui-gradient-soft\);[^}]*box-shadow: inset 0 0 0 1px var\(--ui-accent-border\);/);
  assert.match(override, /\.release-hero h1\s*\{[^}]*font-size: clamp\(28px, 2\.4vw, 48px\);[^}]*font-weight: var\(--ui-weight-heading\);/);
  assert.match(override, /\.release-hero > \.hero-free\s*\{[^}]*font-size: clamp\(18px, 1\.2vw, 24px\);/);
  assert.match(override, /\.format-result-row\.is-selected\s*\{[^}]*background: var\(--ui-gradient-soft\);/);
  assert.match(override, /\.profile-size-guide-button\s*\{[^}]*background: var\(--ui-info-soft\);/);
});

test("PASS 5 inherits V2 without local palettes and separates help from warnings", async () => {
  const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  const polish = css.split("/* PASS 5:")[1].split("/* Shared help drawer content:")[0];
  const postcss = (await import("postcss")).default;
  const root = postcss.parse(polish.slice(polish.indexOf("*/") + 2));
  root.walkDecls(/^--/, decl => assert.fail(`Local palette override: ${decl.prop}`));
  root.walkRules(rule => assert.ok(rule.selector.startsWith(".release-page")));
  assert.doesNotMatch(polish, /#(?:D6E86A|CCDE61|BED052|F1F4DE|AAB878|FFF8DC|DED28A)/i);
  const active = css.split("/* PASS 4:")[1];
  assert.doesNotMatch(active, /--ui-(?:yellow|olive)/);
  assert.match(active, /\.optimizer-stage \.warnings\s*\{[^}]*background: var\(--ui-warning-soft\);[^}]*border-color: var\(--ui-warning-border\);/);
  assert.match(active, /\.profile-size-guide-button\s*\{[^}]*background: var\(--ui-info-soft\);/);
  const drawerCss = await readFile(new URL("../app/components/tinymods-shell/ServiceHelpDrawer.module.css", import.meta.url), "utf8");
  assert.match(drawerCss, /background: var\(--ui-surface-1\)/);
  const shell = await readFile(new URL("../app/components/tinymods-shell/ServiceCurtainTransition.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(shell, /release-page/);
  assert.match(shell, /<GlobalServiceTabs[\s\S]*?\{children\}/);
});

test("PASS 5 primary CTA and selection use semantic states without duplicate lines", async () => {
  const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  const polish = css.split("/* PASS 5:")[1].split("/* Shared help drawer content:")[0];
  const postcss = (await import("postcss")).default;
  const root = postcss.parse(polish.slice(polish.indexOf("*/") + 2));
  const cta = ".release-page .optimizer-stage .batch-action-grid > .primary-button";
  const declarations = selector => {
    const values = {};
    root.walkRules(rule => {
      if (rule.selector === selector) rule.walkDecls(decl => { values[decl.prop] = decl.value; });
    });
    return values;
  };
  assert.equal(declarations(cta)["background-color"], "var(--ui-accent)");
  assert.equal(declarations(cta).color, "var(--ui-text-on-accent)");
  assert.equal(declarations(cta)["border-radius"], "var(--ui-radius-md)");
  assert.equal(declarations(cta)["letter-spacing"], "normal");
  assert.equal(declarations(cta + ":hover:not(:disabled)")["background-color"], "var(--ui-accent-hover)");
  assert.equal(declarations(cta + ":active:not(:disabled)")["background-color"], "var(--ui-accent-active)");
  assert.equal(declarations(cta + ":focus-visible").outline, "3px solid var(--ui-focus-ring)");
  assert.equal(declarations(cta + " i").background, "transparent");
  const sharedCta = ".release-page .optimizer-stage :is(.batch-action-grid > .primary-button, .batch-optimize-all, .result-download-button, .png-download-button)";
  const sharedCtaType = declarations(sharedCta);
  assert.equal(sharedCtaType["font-family"], "var(--ui-font-family)");
  assert.equal(sharedCtaType["font-weight"], "var(--ui-weight-heading)");
  assert.equal(sharedCtaType["line-height"], "var(--ui-leading-tight)");
  assert.equal(sharedCtaType["letter-spacing"], "normal");
  assert.doesNotMatch(sharedCtaType.transition, /\ball\b/);
  assert.match(sharedCtaType.transition, /background-color/);
  assert.doesNotMatch(sharedCtaType.transition, /background\s/);
  const pngButton = {};
  root.walkRules(rule => {
    if (rule.selector !== ".release-page .optimizer-stage .png-download-button" || rule.parent.type === "atrule") return;
    rule.walkDecls(decl => { pngButton[decl.prop] = decl.value; });
  });
  for (const property of ["font-size", "font-weight", "line-height", "letter-spacing"]) assert.equal(pngButton[property], undefined, `PNG CTA should share ${property}`);
  assert.equal(declarations(".release-page .optimizer-stage .png-download-raw")["background-color"], "var(--ui-accent-soft)");
  const pngIcons = declarations(".release-page .optimizer-stage .png-download-raw > i,\n.release-page .optimizer-stage .png-download-optimized > i");
  assert.equal(pngIcons.color, "var(--ui-accent-ink)", "Raw and optimized PNG arrows share the explicit dark color instead of inheriting button text");
  assert.equal(pngIcons.background, "var(--ui-accent-soft-strong)");
  assert.equal(declarations(".release-page .optimizer-stage .png-download-button:disabled > i").color, "var(--ui-text-secondary)");
  const responsiveFontSizes = [];
  postcss.parse(css).walkRules(rule => {
    if (rule.selector !== ".release-page .optimizer-stage :where(button, input, select, textarea)" || rule.parent.type !== "atrule") return;
    const size = rule.nodes.find(node => node.type === "decl" && node.prop === "font-size")?.value;
    if (size) responsiveFontSizes.push([rule.parent.params, size]);
  });
  assert.deepEqual(responsiveFontSizes, [
    ["(min-width: 1440px) and (max-width: 1919px)", "14px"],
    ["(min-width: 1920px) and (max-width: 2559px)", "17px"],
    ["(min-width: 2560px)", "19px"],
  ]);
  root.walkRules(rule => {
    if (rule.selector.includes(".is-selected") || rule.selector.includes(".is-active,")) {
      const values = declarations(rule.selector);
      assert.equal(values.background, "var(--ui-gradient-soft)");
      assert.equal(values["border-color"], "var(--ui-accent-border)");
      assert.equal(values["box-shadow"], "none");
    }
    if (rule.selector.includes("primary-button")) rule.walkDecls(decl => {
      assert.doesNotMatch(decl.prop, /^(?:width|height|min-height|min-width|padding|margin)/, "Keep existing CTA hit area");
      assert.doesNotMatch(decl.value, /#[\da-f]+|yellow/);
    });
  });
  const source = await readFile(new URL("../app/components/ImageOptimizer.tsx", import.meta.url), "utf8");
  assert.match(source, /className="primary-button" type="button"[\s\S]*?onClick=\{\(\) => void runOptimization\(\)\}[\s\S]*?<svg[^>]*fill="none"[^>]*stroke="currentColor"/);
});

test("PASS 5 how-it-works cards keep content and use 1/2/3 columns at all breakpoint boundaries", async () => {
  const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  const polish = css.split("/* PASS 5:")[1];
  const postcss = (await import("postcss")).default;
  const root = postcss.parse(polish.slice(polish.indexOf("*/") + 2));
  const columnsAt = width => {
    let columns;
    root.walkRules(rule => {
      if (rule.selector !== ".release-page .release-how > ol") return;
      if (rule.parent.type === "atrule") {
        assert.equal(rule.parent.name, "media");
        const minimum = rule.parent.params.match(/^\(min-width: (\d+)px\)$/);
        assert.ok(minimum);
        if (width < Number(minimum[1])) return;
      }
      rule.walkDecls("grid-template-columns", decl => { columns = decl.value; });
    });
    return columns;
  };
  for (const width of [320, 479, 480, 639, 640, 959, 960, 1199, 1200, 1439, 1440, 1919, 1920, 2559, 2560]) {
    assert.equal(columnsAt(width), width < 640 ? "minmax(0, 1fr)" : `repeat(${width < 960 ? 2 : 3}, minmax(0, 1fr))`, `${width}px`);
  }
  assert.match(polish, /\.release-how > h2,\s*\.release-page \.release-how > ol \{ grid-column: 1 \/ -1; \}/);
  assert.match(polish, /\.release-how li:last-child\s*\{[^}]*min-height: 0;[^}]*background: var\(--ui-surface-1\);[^}]*border: 1px solid var\(--ui-border-soft\);[^}]*border-radius: var\(--ui-radius-lg\);[^}]*box-shadow: none;/);
  assert.doesNotMatch(polish, /(?:^|[;{\s])height\s*:/);
  const page = await readFile(new URL("../app/(tools)/page.tsx", import.meta.url), "utf8");
  const section = page.match(/<section className="release-how"[\s\S]*?<\/section>/)[0];
  assert.match(section, /<h2[^>]*>Как это работает<\/h2>\s*<ol>/);
  assert.equal([...section.matchAll(/<li>/g)].length, 3);
  for (const text of ["Загрузите", "До десяти изображений одним выбором", "Настройте", "Режим, кадр, размеры и качество", "Скачайте", "Один или несколько выбранных файлов"]) assert.ok(section.includes(text));
});

test("current HTML editor production page renders code loader without Project controls", async () => {
  const html = await readFile(new URL("../.next/server/app/html-content-editor.html", import.meta.url), "utf8");
  assert.doesNotMatch(html, /Контекст проекта|Необязательно — проект нужен|Нет проекта — создать проект|Действия проекта|Новый проект/);
  assert.match(html, /КОД ДЛЯ БЛОКА/);
  assert.match(html, /Загрузка кода/);
});

test("settings order and committed controls are independent of pending quality", async () => {
  const source = await readFile(new URL("../app/components/ImageOptimizer.tsx", import.meta.url), "utf8");
  const size = source.indexOf('className="profile-grid"');
  const quality = source.indexOf('{optimizationMode !== "transparent-png" ? qualitySelector : null}', size);
  const optimize = source.indexOf("onClick={() => void runOptimization()}", quality);
  const result = source.indexOf('className="format-comparison-list"', optimize);
  assert.ok(size >= 0 && quality > size && optimize > quality && result > optimize);
  const rows = source.slice(result);
  assert.match(rows, /<label className=\{`format-result-row/);
  assert.match(rows, /type="checkbox"/);
  assert.match(rows, /onChange=\{\(\) => \{[\s\S]*?toggleOutputSelection/);
  assert.match(rows, /disabled=\{!selectedOutputs\.length \|\| downloadingFiles\}/);
  assert.doesNotMatch(rows, /qualitySelector|qualityTier|customQuality|format-download/);
  assert.match(source, /Math\.round\(draftCropRect\.width\)[\s\S]*?Math\.round\(draftCropRect\.height\)/);
  assert.equal([...source.matchAll(/setResult\(null\)/g)].length, 1);
  assert.match(source, /function clearEditor\(\)[\s\S]*?setResult\(null\)/);
});

test("optimizer removes range/code controls and keeps mouse crop and committed result details", async () => {
  const source = await readFile(new URL("../app/components/ImageOptimizer.tsx", import.meta.url), "utf8");
  const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  assert.doesNotMatch(source, /type="range"|Сюжет по горизонтали|Сюжет по вертикали|code-size-helper|analyzeBlockCode|createDetectedProfile|selectedCodeWidths|useCodeWidths|blockCode|codeAnalysis|codeError/);
  assert.doesNotMatch(source, /Выберите, какой размер хотите сжать|Недоступно:|unavailableProfilesCount|Недоступные размеры отключены|Изображение не увеличивается|quality-lossless-note/);
  assert.doesNotMatch(css, /\.crop-controls|\.code-size-helper|\.detected-sizes|\.largest-size-editor|\.quality-lossless-note/);
  for (const handler of ["handleCropPointerDown", "handleCropPointerMove", "handleCropPointerEnd", "updateDraftCrop", "cropSettingsFromRect", "resizeCropRect"]) assert.ok(source.includes(handler));
  for (const mode of ["photo", "screenshot", "transparent-png"]) assert.ok(source.includes(`value="${mode}"`));
  assert.match(source, /<strong>PNG с прозрачностью<\/strong><small>Для PNG с прозрачным фоном<\/small>/);
  assert.doesNotMatch(source, /PNG С ПРОЗРАЧНОСТЬЮ/);
  assert.match(source, /После кадрирования доступно \{effectiveMaxWidth\}px/);
  assert.match(source, /Исходный размер: \{sourceInfo\.width\} × \{sourceInfo\.height\} px · \{formatBytes\(file\.size\)\}/);
  assert.match(source, /className="result-quality">Q\{resultQuality\}/);
  const rows = source.slice(source.indexOf('className="format-comparison-list"'));
  assert.doesNotMatch(rows, /Q\$\{|Q\{variant|variant\.quality/);
  assert.match(rows, /variant\.format === "png" \? <small>Без потерь<\/small>/);
  assert.doesNotMatch(source, /или анализ кода блока|браузер загрузит только одну/);
});

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
  assert.doesNotMatch(html, /Какой формат для сайта легче: AVIF или WebP/);
  assert.doesNotMatch(html, /photo-1600\.avif/);
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

  assert.ok(availability >= 0 && profiles > availability);
  assert.equal(noUpscale, -1);
  assert.doesNotMatch(css, /\.no-upscale-note/);
  assert.match(component, /availableProfiles\.map/);
  assert.match(component, /className="profile-size-guide-button"/);
  const drawer = await readFile(new URL("../app/components/tinymods-shell/ServiceHelpDrawer.tsx", import.meta.url), "utf8");
  const drawerCss = await readFile(new URL("../app/components/tinymods-shell/ServiceHelpDrawer.module.css", import.meta.url), "utf8");
  assert.match(component, /<ServiceHelpDrawer open=\{sizeGuideOpen\}/);
  assert.match(drawer, /createPortal\(/);
  assert.match(drawer, /dialog\.showModal\(\)/);
  assert.match(drawer, /document\.body\.style\.overflow = "hidden"/);
  assert.match(drawerCss, /overflow-y: auto/);
  assert.doesNotMatch(css, /\.inline-size-guide|\.size-guide-overlay/);
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


test("V2 brand gradients are restricted to primary actions and user Preview stays isolated", async () => {
  const postcss = (await import("postcss")).default;
  const globalCss = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  const editorCss = await readFile(new URL("../app/components/html-content-editor/HtmlContentEditor.module.css", import.meta.url), "utf8");
  const shellCss = await readFile(new URL("../app/components/tinymods-shell/TinymodsToolsShell.module.css", import.meta.url), "utf8");
  for (const [css, expected] of [
    [globalCss, []],
    [editorCss, []],
    [shellCss, []],
  ]) {
    const selectors = [];
    postcss.parse(css).walkDecls(decl => {
      if (decl.value.includes("var(--ui-gradient-brand)")) selectors.push(decl.parent.selector);
      if (!decl.prop.startsWith("--")) assert.doesNotMatch(decl.value, /var\(--ui-gradient-(?:atmosphere|glass)\)/);
    });
    assert.deepEqual(selectors, expected);
  }
  const editor = postcss.parse(editorCss);
  editor.walkRules(rule => {
    if (rule.selector === ".previewViewport iframe") rule.walkDecls(decl => assert.doesNotMatch(decl.value, /--ui-/));
    if (/input|textarea/.test(rule.selector)) rule.walkDecls("background", decl => assert.doesNotMatch(decl.value, /gradient/));
  });
  const active = globalCss.split("/* PASS 4:")[1];
  assert.doesNotMatch(active, /#(?:D9F45F|D6E86A|CDEB52|CCDE61|BED052|5B7CFA|4C6EEA|405FD3|238FBC|146987)\b|--ui-(?:yellow|olive)/i);
  assert.match(globalCss, /body\s*\{[^}]*background: var\(--ui-gradient-app\);/);
  for (const selector of [".page", ".transitionRoot"]) {
    const css = selector === ".page" ? editorCss : shellCss;
    assert.equal(postcss.parse(css).nodes.find(node => node.selector === selector).nodes.find(decl => decl.prop === "background").value, selector === ".page" ? "var(--ui-bg-app)" : "var(--ui-gradient-app)");
  }
  assert.match(shellCss, /\.transitionRoot:global\(\[data-ui-theme="editor"\]\)\s*\{[^}]*background: var\(--ui-bg-app\);/);
  assert.doesNotMatch(editorCss, /--ui-gradient-/);
});
