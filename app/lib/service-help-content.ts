import { readFile } from "node:fs/promises";
import { join } from "node:path";

export type FaqItem = { question: string; answer: string };
export type HelpBlock = { kind: "paragraph" | "heading" | "subheading"; text: string } | { kind: "list"; ordered: boolean; items: string[] };
export type ServiceHelpContent = Record<"image-optimizer" | "html-content-editor", { instruction: HelpBlock[]; faq: FaqItem[] }>;

export const IMAGE_OPTIMIZER_FAQ: FaqItem[] = [
  { question: "Какие форматы поддерживаются?", answer: "Можно загрузить HEIC, HEIF, JPEG, PNG, WebP и AVIF. JPEG поддерживается только на входе. Для фотографий создаются AVIF и WebP; режим «Скриншот» также создаёт PNG без потерь. Для прозрачного PNG доступен отдельный режим оптимизации PNG. Качество AVIF и WebP выбирается перед оптимизацией." },
  { question: "Загружаются ли файлы на сервер?", answer: "Нет. Выбранные с компьютера изображения обрабатываются локально в вашем браузере." },
  { question: "Чем отличается режим «Фото» от «Скриншота»?", answer: "«Фото» подходит для фотографий. «Скриншот» помогает сохранить чёткость текста, тонких линий и элементов интерфейса." },
  { question: "Сколько файлов можно обработать за раз?", answer: "До десяти изображений размером до 40 МБ каждое. Одной кнопкой можно скачать один или несколько выбранных результатов отдельными файлами." },
];

export const HTML_EDITOR_FAQ: FaqItem[] = [
  { question: "Почему предпросмотр отличается от страницы сайта?", answer: "Проверьте, что загружены HTML, локальные стили и JavaScript блока, а также общие стили и скрипты сайта. Сохраняйте исходный порядок блоков и частей кода." },
  { question: "Чем «Добавить код к блоку» отличается от «Добавить блок»?", answer: "Первое действие добавляет ещё одну часть кода к тому же блоку. Второе создаёт отдельный блок страницы. Все загруженные блоки показываются в одном предпросмотре." },
  { question: "Почему не работает слайдер или меню?", answer: "Для интерактивных элементов нужен их JavaScript. Добавьте его к блоку или в общий JS сайта — в соответствии с тем, где он подключён на исходной странице." },
  { question: "Что делает замок у общих стилей и скриптов?", answer: "Закреплённые общие стили и скрипты сохраняются при замене композиции и продолжают участвовать в предпросмотре." },
  { question: "Когда можно скопировать изменённый блок?", answer: "Кнопка «Скопировать код блока» появляется после изменения содержимого. Она копирует текущий код этого блока. «Сбросить» возвращает исходные значения." },
];

// Only the prepared instruction Markdown subset is needed: headings, paragraphs,
// ordered/unordered lists and inline emphasis. Parsing runs on the server at build.
export function parseInstructionMarkdown(markdown: string): HelpBlock[] {
  const blocks: HelpBlock[] = [];
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  let paragraph: string[] = [];
  const flush = () => { if (paragraph.length) blocks.push({ kind: "paragraph", text: paragraph.join(" ") }); paragraph = []; };
  for (const line of lines) {
    const text = line.trim();
    if (!text || /^#\s|^---$/.test(text)) { flush(); continue; }
    const heading = /^(#{2,3})\s+(.+)$/.exec(text);
    if (heading) { flush(); blocks.push({ kind: heading[1].length === 2 ? "heading" : "subheading", text: heading[2] }); continue; }
    const item = /^(?:(\d+)\.\s+|[-*]\s+)(.+)$/.exec(text);
    if (item) {
      flush();
      const ordered = Boolean(item[1]);
      const previous = blocks.at(-1);
      if (previous?.kind === "list" && previous.ordered === ordered) previous.items.push(item[2]);
      else blocks.push({ kind: "list", ordered, items: [item[2]] });
      continue;
    }
    paragraph.push(text);
  }
  flush();
  return blocks;
}

export async function loadServiceHelpContent(): Promise<ServiceHelpContent> {
  const [optimizer, editor] = await Promise.all([
    readFile(join(process.cwd(), "OPTIMA-IMAGE-OPTIMIZER-INSTRUCTION.md"), "utf8"),
    readFile(join(process.cwd(), "OPTIMA-HTML-EDITOR-INSTRUCTION.md"), "utf8"),
  ]);
  return {
    "image-optimizer": { instruction: parseInstructionMarkdown(optimizer), faq: IMAGE_OPTIMIZER_FAQ },
    "html-content-editor": { instruction: parseInstructionMarkdown(editor), faq: HTML_EDITOR_FAQ },
  };
}
