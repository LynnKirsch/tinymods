export type PreviewViewportPreset = {
  id: string;
  label: string;
  shortLabel: string;
  width: number;
  height: number;
  rangeLabel: string;
};

export const PREVIEW_VIEWPORTS = [
  {
    id: "iphone",
    label: "iPhone",
    shortLabel: "iPhone",
    width: 390,
    height: 844,
    rangeLabel: "to 479",
  },
  {
    id: "phone-xl",
    label: "Phone XL",
    shortLabel: "Phone XL",
    width: 480,
    height: 854,
    rangeLabel: "480-639",
  },
  {
    id: "tablet-640",
    label: "Tablet 640",
    shortLabel: "Tablet 640",
    width: 640,
    height: 960,
    rangeLabel: "640-959",
  },
  {
    id: "tablet-landscape",
    label: "Tablet / Landscape",
    shortLabel: "Tablet / Landscape",
    width: 960,
    height: 720,
    rangeLabel: "960-1199",
  },
  {
    id: "laptop-1200",
    label: "Laptop 1200",
    shortLabel: "Laptop 1200",
    width: 1200,
    height: 800,
    rangeLabel: "1200-1439",
  },
  {
    id: "laptop-1440",
    label: "Laptop 1440",
    shortLabel: "Laptop 1440",
    width: 1440,
    height: 900,
    rangeLabel: "1440-1919",
  },
  {
    id: "full-hd",
    label: "Full HD",
    shortLabel: "Full HD",
    width: 1920,
    height: 1080,
    rangeLabel: "1920-2559",
  },
  {
    id: "two-k",
    label: "2K",
    shortLabel: "2K",
    width: 2560,
    height: 1440,
    rangeLabel: "2560+",
  },
] as const satisfies readonly PreviewViewportPreset[];

export type PreviewViewportId = (typeof PREVIEW_VIEWPORTS)[number]["id"];

export const DEFAULT_PREVIEW_VIEWPORT_ID: PreviewViewportId = "laptop-1440";

export const DEFAULT_PREVIEW_VIEWPORT =
  PREVIEW_VIEWPORTS.find((preset) => preset.id === DEFAULT_PREVIEW_VIEWPORT_ID) ??
  PREVIEW_VIEWPORTS[0];

export const PREVIEW_VIEWPORT_WIDTH = DEFAULT_PREVIEW_VIEWPORT.width;
export const PREVIEW_VIEWPORT_HEIGHT = DEFAULT_PREVIEW_VIEWPORT.height;
export const PREVIEW_VIEWPORT_LABEL = DEFAULT_PREVIEW_VIEWPORT.label;

export function previewViewportById(id: string) {
  return PREVIEW_VIEWPORTS.find((preset) => preset.id === id) ?? DEFAULT_PREVIEW_VIEWPORT;
}

export function calculatePreviewScale(
  availableWidth: number,
  availableHeight: number,
  viewportWidth: number = DEFAULT_PREVIEW_VIEWPORT.width,
  viewportHeight: number = DEFAULT_PREVIEW_VIEWPORT.height,
) {
  if (availableWidth <= 0 || availableHeight <= 0) return 1;
  if (viewportWidth <= 0 || viewportHeight <= 0) return 1;
  return Math.min(availableWidth / viewportWidth, availableHeight / viewportHeight, 1);
}
