import assert from "node:assert/strict";
import test from "node:test";

import { createBrowserZip } from "../app/lib/browser-zip.ts";

test("browser ZIP stores selected files with UTF-8 paths", async () => {
  const archive = await createBrowserZip([
    { name: "01-photo/photo-600.webp", blob: new Blob(["webp"]) },
    { name: "02-фото/photo-800.avif", blob: new Blob(["avif"]) },
  ]);
  const bytes = new Uint8Array(await archive.arrayBuffer());
  const text = new TextDecoder().decode(bytes);

  assert.equal(archive.type, "application/zip");
  assert.equal(new DataView(bytes.buffer).getUint32(0, true), 0x04034b50);
  assert.match(text, /01-photo\/photo-600\.webp/);
  assert.match(text, /02-фото\/photo-800\.avif/);
  assert.equal(
    new DataView(bytes.buffer).getUint32(bytes.byteLength - 22, true),
    0x06054b50,
  );
});
