import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import sharp from "sharp";

const photos = [
  ["woodland", "Nature photograph", "Woodland04_(27300059989).jpg",
    "USDA NRCS Montana, US public domain", "acd7d786cd9765a07d8808e001272438df039175"],
  ["mesa-sunrise", "Sky and landscape photograph", "Mesa_Arch_sunrise_(51331749665).jpg",
    "US National Park Service, US public domain", "3044d9ba19883beb06ac15f71d3fb552ccea885c"],
  ["colorful-house", "Saturated color photograph", "Building-house-colorful-colourful_(24326172585).jpg",
    "Pixel.la, CC0 1.0", "8f4aa152f16ca804a0a41586aca209e3cb2fc1a9"],
  ["portrait", "Portrait photograph", "Commander_Eileen_Collins_-_GPN-2000-001177.jpg",
    "NASA / Robert Markowitz, US public domain", "8387fb6e92d07202c0584c730a054cb022fa60a2"],
].map(([id, category, file, license, sha1]) => ({ id, group: "photo", category, file, license, sha1 }));

const synthetic = [
  { id: "fine-text", group: "screenshot", category: "Web UI with small labels" },
  { id: "dashboard", group: "screenshot", category: "Web UI with buttons and charts" },
  { id: "sharp-edges", group: "graphic", category: "Illustration with hard color boundaries" },
  { id: "gradient-texture", group: "graphic", category: "Gradient with fine woven texture" },
  { id: "transparency", group: "alpha", category: "Transparent graphic", alpha: true },
];

export function fixtures(stage) {
  return stage === "smoke" ? [synthetic[0], synthetic[4]] : [...photos, ...synthetic];
}

function graphic(id) {
  const colors = ["#ee1745", "#00a250", "#093bea", "#fff52c"];
  if (id === "fine-text") {
    const rows = Array.from({ length: 17 }, (_, index) => {
      const y = 111 + 24 * index;
      const label = ["Queue running", "Ready for upload", "Review required", "Cache updated"][index % 4];
      return '<rect x="32" y="' + (y - 15) + '" width="704" height="23" fill="' + (index % 2 ? "#eff5ff" : "#fff") + '"/>' +
        '<text x="44" y="' + y + '" font-size="12" fill="#172343">image-' + (12241 + index) + '.avif</text>' +
        '<text x="206" y="' + y + '" font-size="11" fill="' + colors[index % 3] + '">' + label + '</text>' +
        '<text x="540" y="' + y + '" font-size="13" fill="#202d40">800 × 560</text>' +
        '<path d="M 660 ' + y + ' h 64" stroke="' + colors[index % 3] + '"/>';
    }).join("");
    return '<rect width="768" height="544" fill="#e3ebfa"/><rect width="768" height="71" fill="#14243f"/>' +
      '<text x="32" y="45" font-size="24" fill="#fff">Asset library</text>' + rows;
  }
  if (id === "dashboard") {
    return '<rect width="768" height="544" fill="#101725"/><rect x="30" y="97" width="708" height="411" rx="10" fill="#1d2b42"/>' +
      colors.map((color, index) => {
        const points = Array.from({ length: 12 }, (_, point) =>
          (54 + point * 58) + "," + (250 + index * 43 + (point * (61 + index * 13)) % 68)).join(" ");
        return '<rect x="' + (30 + 181 * index) + '" y="30" width="157" height="42" rx="6" fill="' + color + '"/>' +
          '<text x="' + (43 + 181 * index) + '" y="56" font-size="14" fill="#101725">Channel ' + (index + 1) + '</text>' +
          '<polyline points="' + points + '" fill="none" stroke="' + color + '" stroke-width="' + (index + 1) + '"/>';
      }).join("") + '<text x="54" y="144" font-size="21" fill="#fff">Encoding throughput</text>';
  }
  if (id === "sharp-edges") {
    return '<rect width="768" height="544" fill="#008f4c"/><path d="M30 490 L390 36 L740 490Z" fill="#ea1b39"/>' +
      '<circle cx="384" cy="290" r="130" fill="#152bda"/>' + Array.from({ length: 30 }, (_, index) => {
        const x = 100 + index * 19;
        return '<path d="M' + x + ' 170 v230" stroke="' + colors[index % 4] + '" stroke-width="' + (1 + index % 3) + '"/>';
      }).join("");
  }
  if (id === "gradient-texture") {
    return '<defs><linearGradient id="sky" x2="0.7" y2="1"><stop stop-color="#151856"/><stop offset=".52" stop-color="#375fad"/>' +
      '<stop offset="1" stop-color="#ff995f"/></linearGradient><pattern id="weave" width="7" height="6" patternUnits="userSpaceOnUse">' +
      '<path d="M0 0h7M0 3h7M0 0v6M4 0v6" stroke="#efdbc0" stroke-opacity=".23"/></pattern></defs>' +
      '<rect width="768" height="544" fill="url(#sky)"/><path d="M0 360Q300 255 768 410V544H0Z" fill="url(#weave)"/>';
  }
  return '<defs><linearGradient id="fade"><stop stop-color="#ed1830"/><stop offset="1" stop-color="#ed1830" stop-opacity="0"/></linearGradient></defs>' +
    '<circle cx="270" cy="275" r="180" fill="#0d48ed" fill-opacity=".7"/><rect x="244" y="150" width="460" height="220" fill="url(#fade)"/>' +
    '<path d="M24 275h710" stroke="#04a655" stroke-width="3"/><text x="42" y="330" font-size="23" fill="#e04310">Transparency and fine edges</text>';
}

async function downloadPhoto(fixture) {
  const directory = createHash("md5").update(fixture.file).digest("hex").slice(0, 2);
  const source = "https://commons.wikimedia.org/wiki/File:" + encodeURIComponent(fixture.file);
  const download = "https://upload.wikimedia.org/wikipedia/commons/" + directory[0] + "/" + directory + "/" + encodeURIComponent(fixture.file);
  const response = await fetch(download, {
    headers: { "User-Agent": "TinymodsAVIFResearch/1.0 (https://github.com/LynnKirsch/tinymods)" },
    signal: AbortSignal.timeout(35_000),
  });
  assert.equal(response.status, 200, download);
  const image = Buffer.from(await response.arrayBuffer());
  assert.ok(image.length <= 12 * 1024 * 1024, fixture.id + ": download limit");
  assert.equal(createHash("sha1").update(image).digest("hex"), fixture.sha1, fixture.id + ": original SHA-1");
  return { image, provenance: { source, download, license: fixture.license, sha1: fixture.sha1,
    sha256: createHash("sha256").update(image).digest("hex"), sourceBytes: image.length } };
}

export async function prepare(fixture, stage) {
  const edge = stage === "smoke" ? 320 : 960;
  let pipeline;
  let provenance;
  if (fixture.file) {
    const { image, provenance: photoProvenance } = await downloadPhoto(fixture);
    pipeline = sharp(image).autoOrient().resize(edge, edge, { fit: "inside", withoutEnlargement: true });
    provenance = photoProvenance;
  } else {
    const width = stage === "smoke" ? 320 : 768;
    const height = Math.round(width * 544 / 768);
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + width + '" height="' + height +
      '" viewBox="0 0 768 544" font-family="DejaVu Sans, sans-serif">' + graphic(fixture.id) + '</svg>';
    pipeline = sharp(Buffer.from(svg));
    provenance = { source: "Deterministic SVG generator in avif-chroma-fixtures.mjs" };
  }
  const { data, info } = await pipeline.toColourspace("srgb").ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  assert.equal(info.channels, 4);
  return { data, width: info.width, height: info.height, provenance };
}
