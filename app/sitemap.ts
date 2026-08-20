import type { MetadataRoute } from "next";

const SITE_URL = "https://tinymods.ru";

export default function sitemap(): MetadataRoute.Sitemap {
  return [
    {
      url: SITE_URL,
      lastModified: new Date("2026-08-20T00:00:00.000Z"),
      changeFrequency: "monthly",
      priority: 1,
    },
    {
      url: `${SITE_URL}/privacy`,
      lastModified: new Date("2026-08-20T00:00:00.000Z"),
      changeFrequency: "yearly",
      priority: 0.35,
    },
  ];
}
