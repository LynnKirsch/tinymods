# Tinymods — Image Optimizer

**Tinymods** is a browser-based image optimization tool for websites.

It helps prepare images for the web: compress files, generate modern formats, create Retina versions, resize and crop images, and generate ready-to-use `<picture>` markup.

🌐 **Website:** https://tinymods.ru

---

## What Tinymods does

- Converts images to WebP and AVIF
- Supports JPEG, PNG, WebP, AVIF, HEIC and HEIF
- Processes images directly in the browser
- Creates standard and Retina versions
- Resizes and crops images
- Supports batch image processing
- Provides a separate workflow for screenshots
- Generates ready-to-use `<picture>` / `srcset` markup
- Allows downloading individual files or the complete result

The core image processing happens locally in the user's browser.

Uploaded images do not need to be sent to a Tinymods server for optimization.

---

## Why Tinymods

Tinymods was created to make one repetitive web-development task faster:

> prepare correctly sized, lightweight images for a website without switching between multiple tools.

Instead of separately resizing, converting, creating Retina versions and writing responsive image markup, Tinymods combines these steps into one workflow.

---

## Tech stack

- Next.js
- React
- TypeScript
- WebAssembly
- `@jsquash/avif`
- `heic2any`
- static site generation

Tinymods currently does not require a backend for image optimization.

---

## Local development

Requirements:

- Node.js 22+

Install dependencies:

```bash
npm install