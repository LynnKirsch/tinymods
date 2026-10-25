# Optima — Image Optimizer & HTML Content Editor

Optima provides two free browser tools without registration.

- **[Image Optimizer](https://tinymods.ru/)** prepares website images: crop, resize without upscaling, encode and download.
- **[HTML Content Editor](https://tinymods.ru/html-content-editor)** edits content in existing HTML blocks with a live Preview.

## Image Optimizer

Inputs: JPEG/JPG, PNG, HEIC/HEIF, WebP and AVIF. JPEG is input-only.

| Mode | Outputs |
| --- | --- |
| Photo | AVIF and WebP |
| Screenshot | AVIF, WebP and PNG |
| Transparent PNG | Prepared PNG and OxiPNG-optimized PNG |

AVIF/WebP quality is 65, 80, 85 (default) or a custom integer 1–100. PNG does not use this quality setting. Lossless PNG encoding preserves the prepared raster; crop and resize still change its pixels and dimensions.

Processing is local and sequential, with up to 10 images, 40 MB and 50 megapixels per file. Source images are not uploaded to an Optima server. Each image keeps separate settings and finished results during the current page session. The smallest available AVIF/WebP file is initially selected for each new result; users can override that selection. Selected results download as separate files.

## HTML Content Editor

Paste and load block code, add blocks or fragments, and supply shared Site CSS/JS. Edit detected text, links, image URLs, ALT, video URLs and posters; inspect the combined Preview and video gallery, then copy the edited block code.

There is no project save/reopen UI. Copy your result before leaving the page. Preview executes user scripts in an isolated iframe and may fetch external resources. Use trusted code; browser-side editing does not guarantee that user HTML makes no network requests.

## Stack

Next.js, React, TypeScript and browser WebAssembly. Active codecs include @jsquash/avif, @jsquash/oxipng and @discourse/heic. The site uses static export; image optimization needs no application backend.

## Local development

Requires Node.js 22.13.0 or later and npm. Existing commands:

- npm ci — install locked dependencies.
- npm run dev — local development server.
- npm run build — production static export.
- npm run lint — ESLint.
- npm test — build, then test suites.

These commands are documentation, not confirmation that they have been run. Some legacy suites have separate fixture/build assumptions; see the current verification workflow for the release checks.

## Product and privacy

[Product description](docs/PRODUCT.md), [privacy policy](https://tinymods.ru/privacy), [concise AI context](https://tinymods.ru/llms.txt) and [full AI context](https://tinymods.ru/llms-full.txt).

Analytics starts only after consent. Cookie settings can be changed on the privacy page. The tools do not provide accounts, cloud project storage or a public API.
