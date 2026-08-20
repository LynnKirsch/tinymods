import ImageOptimizer from "./components/ImageOptimizer";
import { CookieConsent, CookieSettingsButton } from "./components/CookieConsent";

const SITE_URL = "https://tinymods.ru";

type FaqItem = {
  question: string;
  answer: string;
  code?: string;
};

const PICTURE_EXAMPLE = `<picture>
  <source
    type="image/avif"
    srcset="photo-800.avif 800w, photo-1600.avif 1600w"
    sizes="(max-width: 767px) 100vw, 800px">
  <source
    type="image/webp"
    srcset="photo-800.webp 800w, photo-1600.webp 1600w"
    sizes="(max-width: 767px) 100vw, 800px">
  <img
    src="photo-800.webp"
    width="800"
    height="600"
    alt="Описание изображения"
    loading="lazy"
    decoding="async">
</picture>`;

const FAQ_ITEMS: FaqItem[] = [
  {
    question: "Какие форматы поддерживаются?",
    answer:
      "Можно загрузить HEIC, HEIF, JPEG, PNG, WebP и AVIF. Для фото сервис готовит AVIF и WebP, для скриншотов — PNG без потерь и WebP с повышенным запасом качества.",
  },
  {
    question: "Загружаются ли файлы на сервер?",
    answer:
      "Нет. Выбранные с компьютера изображения обрабатываются локально в вашем браузере. ZIP также собирается на устройстве.",
  },
  {
    question: "Чем отличается режим «Фото» от «Скриншота»?",
    answer:
      "«Фото» ищет минимальный вес без заметной потери деталей. «Скриншот» использует более строгий порог сходства и повышенный запас качества для текста, тонких линий и элементов интерфейса.",
  },
  {
    question: "Какой формат для сайта легче: AVIF или WebP?",
    answer:
      "Единственного победителя для любой картинки нет: AVIF часто получается легче при сопоставимом качестве, но на отдельных изображениях WebP может дать лучший результат. Современные версии основных браузеров поддерживают оба формата. Надёжнее подготовить сразу AVIF и WebP и подключить их через тег <picture>: браузер сам возьмёт первый поддерживаемый вариант. В Optima вес и качество обоих файлов можно сравнить до скачивания.",
  },
  {
    question: "Зачем копировать код <picture> и что в нём содержится?",
    answer:
      "После оптимизации кнопка копирует готовую HTML-разметку для активного изображения и только отмеченных размеров. В режиме «Фото» сначала указан AVIF, затем WebP, а тег <img> служит запасным вариантом; для скриншота используются WebP и PNG. Атрибут srcset перечисляет размеры файлов, sizes сообщает браузеру ширину изображения в макете, width и height сохраняют место под кадр, а loading=\"lazy\" откладывает загрузку изображения за пределами первого экрана. Текст alt нужно заменить на настоящее описание картинки.",
    code: PICTURE_EXAMPLE,
  },
  {
    question: "Сколько файлов можно обработать за раз?",
    answer:
      "До восьми изображений размером до 40 МБ каждое. Их можно скачать отдельно либо собрать в один ZIP с папкой для каждого исходника.",
  },
];

const STRUCTURED_DATA = {
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "Organization",
      "@id": `${SITE_URL}/#organization`,
      name: "Optima",
      legalName: "ИП Кирюшкина Елена Владимировна",
      taxID: "423400473018",
      url: SITE_URL,
      sameAs: ["https://vk.ru/lynn.kirsch"],
    },
    {
      "@type": "WebSite",
      "@id": `${SITE_URL}/#website`,
      url: SITE_URL,
      name: "Optima Image Optimizer",
      alternateName: "Оптима",
      inLanguage: "ru-RU",
      publisher: { "@id": `${SITE_URL}/#organization` },
    },
    {
      "@type": "WebApplication",
      "@id": `${SITE_URL}/#application`,
      name: "Optima — умный оптимизатор изображений для сайта",
      url: SITE_URL,
      description:
        "Браузерный сервис для сжатия и конвертации фотографий и скриншотов в AVIF, WebP и lossless PNG без загрузки исходников на сервер.",
      applicationCategory: "MultimediaApplication",
      applicationSubCategory: "Image optimizer",
      operatingSystem: "Любая операционная система с современным браузером",
      browserRequirements: "Требуется современный браузер с поддержкой JavaScript",
      provider: { "@id": `${SITE_URL}/#organization` },
      isAccessibleForFree: true,
      offers: {
        "@type": "Offer",
        price: "0",
        priceCurrency: "RUB",
        availability: "https://schema.org/InStock",
      },
      featureList: [
        "Сжатие изображений для сайта",
        "Конвертация PNG, JPEG и HEIC в AVIF и WebP",
        "Lossless PNG для скриншотов",
        "Пакетная обработка до восьми файлов",
        "Локальная обработка в браузере",
        "Скачивание отдельных файлов и ZIP",
      ],
      image: `${SITE_URL}/og.png`,
      inLanguage: "ru-RU",
    },
    {
      "@type": "FAQPage",
      "@id": `${SITE_URL}/#faq`,
      mainEntity: FAQ_ITEMS.map((item) => ({
        "@type": "Question",
        name: item.question,
        acceptedAnswer: {
          "@type": "Answer",
          text: item.answer,
        },
      })),
    },
  ],
};

export default function Home() {
  return (
    <main className="release-page" id="top">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(STRUCTURED_DATA) }}
      />
      <header className="release-header">
        <a className="brand" href="#top" aria-label="Оптима — наверх">
          <span className="brand-mark" aria-hidden="true">O</span>
          <span>
            <strong>Оптима</strong>
            <small>Image Optimizer</small>
          </span>
        </a>
        <nav aria-label="Навигация по странице">
          <a href="#optimizer">Оптимизатор</a>
          <a href="#faq">FAQ</a>
        </nav>
      </header>

      <section className="release-hero" aria-labelledby="release-title">
        <p className="release-eyebrow">Image Optimizer · обработка без сервера</p>
        <h1 id="release-title">
          <span>Умный оптимизатор</span>
          <span>изображений для сайта</span>
        </h1>
        <p>
          Сжимайте фотографии и скриншоты, конвертируйте PNG, JPEG и HEIC в
          лёгкие AVIF, WebP и lossless PNG — прямо в браузере без загрузки на сервер.
        </p>
        <p className="accepted-formats" aria-label="Поддерживаемые исходные форматы">
          Принимаем <strong>PNG</strong><span>·</span><strong>JPEG</strong><span>·</span>
          <strong>HEIC / HEIF</strong><span>·</span><strong>WebP</strong><span>·</span><strong>AVIF</strong>
        </p>
        <div className="privacy-note" role="note">
          <span aria-hidden="true">●</span>
          <p><strong>Файлы остаются на вашем устройстве.</strong> Обработка и сборка ZIP происходят локально.</p>
        </div>
      </section>

      <section className="optimizer-stage" id="optimizer" aria-label="Оптимизатор изображений">
        <ImageOptimizer />
      </section>

      <section className="release-how" aria-labelledby="how-title">
        <h2 id="how-title">Как это работает</h2>
        <ol>
          <li><b>01</b><span><strong>Загрузите</strong><small>До восьми изображений одним выбором</small></span></li>
          <li><b>02</b><span><strong>Настройте</strong><small>Режим, кадр, размеры и Retina</small></span></li>
          <li><b>03</b><span><strong>Скачайте</strong><small>Отдельные файлы или локальный ZIP</small></span></li>
        </ol>
      </section>

      <section className="release-faq" id="faq" aria-labelledby="faq-title">
        <div className="release-faq-heading">
          <h2 id="faq-title">Частые вопросы</h2>
        </div>
        <div className="faq-list">
          {FAQ_ITEMS.map((item, index) => (
            <details key={item.question} open={index === 0}>
              <summary><span>{item.question}</span><i aria-hidden="true">+</i></summary>
              <div className="faq-answer">
                <p>{item.answer}</p>
                {item.code ? (
                  <div className="faq-code-example">
                    <span>Пример готового кода</span>
                    <pre><code>{item.code}</code></pre>
                  </div>
                ) : null}
              </div>
            </details>
          ))}
        </div>
      </section>

      <footer className="release-footer">
        <div className="footer-contact">
          <p>Остались вопросы по сервису, или вы хотите свой собственный сервис под свои задачи?</p>
          <a href="https://vk.ru/lynn.kirsch" target="_blank" rel="noreferrer">
            Напишите мне в ВК
          </a>
        </div>
        <div className="footer-legal">
          <a className="brand" href="#top" aria-label="Оптима — наверх">
            <span className="brand-mark" aria-hidden="true">O</span>
            <span><strong>Оптима</strong><small>Image Optimizer</small></span>
          </a>
          <div className="footer-operator">
            <strong>ИП Кирюшкина Е.В.</strong>
            <span>ИНН 423400473018</span>
            <span>ОГРНИП 323220200088967</span>
          </div>
          <nav aria-label="Юридические документы">
            <a href="/privacy">Политика обработки персональных данных</a>
            <CookieSettingsButton />
          </nav>
          <p className="footer-copyright">
            © 2026 Optima. Сервис, дизайн и материалы защищены авторским правом.
          </p>
        </div>
      </footer>
      <CookieConsent />
    </main>
  );
}
