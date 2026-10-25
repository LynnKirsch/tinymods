import type { Metadata, Viewport } from "next";
import { Onest } from "next/font/google";
import "./globals.css";

const onest = Onest({
  subsets: ["latin", "cyrillic"],
  weight: ["400", "500", "600"],
  display: "swap",
  variable: "--font-onest",
});

const SITE_URL = "https://tinymods.ru";
const SEO_TITLE = "Умный оптимизатор изображений для сайта — Optima";
const SEO_DESCRIPTION =
  "Бесплатно сжимайте и конвертируйте PNG, JPEG, HEIC, WebP и AVIF для сайта. Фото и скриншоты обрабатываются в браузере без загрузки на сервер.";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: SEO_TITLE,
  description: SEO_DESCRIPTION,
  applicationName: "Optima Image Optimizer",
  category: "technology",
  keywords: [
    "оптимизатор изображений",
    "сжать изображение для сайта",
    "конвертер HEIC",
    "PNG в WebP",
    "JPEG в AVIF",
    "оптимизация фото без потери качества",
    "сжатие скриншотов",
  ],
  alternates: {
    canonical: "/",
    languages: { "ru-RU": "/" },
  },
  robots: {
    index: true,
    follow: true,
    nocache: false,
    googleBot: {
      index: true,
      follow: true,
      "max-image-preview": "large",
      "max-snippet": -1,
      "max-video-preview": -1,
    },
  },
  openGraph: {
    type: "website",
    locale: "ru_RU",
    url: "/",
    siteName: "Optima Image Optimizer",
    title: SEO_TITLE,
    description: SEO_DESCRIPTION,
    images: [
      {
        url: "/og.png",
        width: 1200,
        height: 630,
        alt: "Умный оптимизатор изображений для сайта — Optima",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: SEO_TITLE,
    description: SEO_DESCRIPTION,
    images: ["/og.png"],
  },
  icons: {
    icon: [
      { url: "/favicon.ico?v=tinymods-v1", sizes: "16x16 32x32 48x48 64x64", type: "image/x-icon" },
      { url: "/favicon.svg?v=tinymods-v1", sizes: "any", type: "image/svg+xml" },
    ],
    shortcut: "/favicon.ico?v=tinymods-v1",
  },
  manifest: "/manifest.webmanifest",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#f4f0e8",
  colorScheme: "light",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ru" className={onest.variable}>
      <body>
        {children}
      </body>
    </html>
  );
}
