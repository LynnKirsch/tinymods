import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Optima — умный оптимизатор изображений",
    short_name: "Optima",
    description:
      "Сжатие и конвертация изображений для сайта прямо в браузере.",
    start_url: "/",
    display: "standalone",
    background_color: "#f4f0e8",
    theme_color: "#17211d",
    lang: "ru-RU",
    icons: [
      {
        src: "/favicon.svg",
        sizes: "any",
        type: "image/svg+xml",
        purpose: "any",
      },
    ],
  };
}
