import type { Metadata } from "next";
import HtmlContentEditor from "../../components/html-content-editor/HtmlContentEditor";

export const metadata: Metadata = {
  title: "HTML Content Editor — Tinymods",
  alternates: { canonical: "/html-content-editor" },
  openGraph: {
    title: "HTML Content Editor — Tinymods",
    description: "Браузерный редактор текстов, ссылок и изображений в готовом HTML-коде без изменения CSS и JS.",
    url: "/html-content-editor",
    type: "website",
    locale: "ru_RU",
  },
  description:
    "Браузерный редактор текстов, ссылок и изображений в готовом HTML-коде без изменения CSS и JS.",
};

export default function HtmlContentEditorPage() {
  return <HtmlContentEditor />;
}
