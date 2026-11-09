import type { MetadataRoute } from "next";
import { SITE_URL } from "./lib/site-url";

export const dynamic = "force-static";

export default function sitemap(): MetadataRoute.Sitemap {
  return [
    {
      url: SITE_URL,
      lastModified: new Date("2026-08-20T00:00:00.000Z"),
      changeFrequency: "monthly",
      priority: 1,
    },
    {
      url: `${SITE_URL}/html-content-editor`,
      lastModified: new Date("2026-09-05T00:00:00.000Z"),
      changeFrequency: "monthly",
      priority: 0.6,
    },
    {
      url: `${SITE_URL}/privacy`,
      lastModified: new Date("2026-08-20T00:00:00.000Z"),
      changeFrequency: "yearly",
      priority: 0.35,
    },
  ];
}
