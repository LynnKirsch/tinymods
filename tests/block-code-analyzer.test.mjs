import assert from "node:assert/strict";
import test from "node:test";
import { analyzeBlockCode } from "../app/lib/block-code-analyzer.ts";

test("finds image container widths in CSS media queries", () => {
  const analysis = analyzeBlockCode(`
    <div class="photo-card"><img class="photo" src="photo.jpg"></div>
    <style>
      .photo-card { width: 1200px; }
      .photo { width: 100%; }
      @media (max-width: 960px) { .photo-card { width: 720px; } }
      @media (max-width: 640px) { .photo-card { width: 360px; } }
    </style>
  `);

  assert.deepEqual(
    analysis.sizes.map(({ width, screen }) => ({ width, screen })),
    [
      { width: 360, screen: "до 640px" },
      { width: 720, screen: "до 960px" },
      { width: 1200, screen: "Основной экран" },
    ],
  );
});

test("finds responsive Tilda data attributes", () => {
  const analysis = analyzeBlockCode(`
    <div
      class="tn-elem"
      data-elem-type="image"
      data-field-width-value="1200"
      data-field-widthunits-value="px"
      data-field-width-res-960-value="720"
      data-field-widthunits-res-960-value="px"
      data-field-width-res-480-value="360"
      data-field-widthunits-res-480-value="px"
    ></div>
  `);

  assert.deepEqual(
    analysis.sizes.map(({ width }) => width),
    [360, 720, 1200],
  );
});

test("uses the Tilda parent width for a background image", () => {
  const analysis = analyzeBlockCode(`
    <div class="tn-elem" data-elem-type="shape" style="width: 1200px">
      <div class="tn-atom t-bgimg" style="background-image:url(photo.avif)"></div>
    </div>
  `);

  assert.deepEqual(analysis.sizes.map(({ width }) => width), [1200]);
});

test("calculates fluid CSS Grid card widths for every breakpoint", () => {
  const analysis = analyzeBlockCode(`
    <style>
      .hvoya-exp-section { width: 100%; padding: 30px 15px; }
      .hvoya-exp-grid {
        width: 100%; display: grid; gap: 14px;
        grid-template-columns: repeat(2, minmax(0, 1fr));
      }
      .hvoya-exp-card img { width: 100%; height: 100%; object-fit: cover; }
      @media (max-width: 479px) {
        .hvoya-exp-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
      }
      @media (min-width: 480px) and (max-width: 639px) {
        .hvoya-exp-section { padding-left: 30px; padding-right: 30px; }
        .hvoya-exp-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
      }
      @media (min-width: 640px) and (max-width: 959px) {
        .hvoya-exp-section { padding-left: 30px; padding-right: 30px; }
        .hvoya-exp-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 14px; }
      }
      @media (min-width: 960px) and (max-width: 1199px) {
        .hvoya-exp-section { padding-left: 30px; padding-right: 30px; }
        .hvoya-exp-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 22px; }
      }
      @media (min-width: 1200px) and (max-width: 1919px) {
        .hvoya-exp-section { padding: 40px 60px; }
        .hvoya-exp-grid { grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 22px; }
      }
      @media (min-width: 1920px) and (max-width: 2559px) {
        .hvoya-exp-section { padding-left: 90px; padding-right: 90px; }
        .hvoya-exp-grid { grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 20px; }
      }
      @media (min-width: 2560px) {
        .hvoya-exp-section { padding: 56px 120px; }
        .hvoya-exp-grid { grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 26px; }
      }
    </style>
    <section class="hvoya-exp-section">
      <div class="hvoya-exp-grid">
        <a class="hvoya-exp-card"><img src="photo.webp" alt=""></a>
      </div>
    </section>
  `);

  assert.deepEqual(
    analysis.sizes.map(({ width }) => width),
    [219, 284, 291, 365, 434, 561, 580],
  );
  assert.match(analysis.sizes[3].screen, /960–1199px/);
  assert.ok(analysis.warnings.some((warning) => warning.includes("меняется")));
});
