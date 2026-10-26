import ImageOptimizer from "../components/ImageOptimizer";
import TinymodsFooter from "../components/tinymods-shell/TinymodsFooter";

const SITE_URL = "https://tinymods.ru";

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
        "Lossless PNG для фото и скриншотов",
        "Пакетная обработка до десяти файлов",
        "Локальная обработка в браузере",
        "Скачивание выбранных результатов отдельными файлами",
      ],
      image: `${SITE_URL}/og.png`,
      inLanguage: "ru-RU",
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
      <section className="release-hero" aria-labelledby="release-title">
        <h1 id="release-title">
          <span>Оптимизируйте</span>{" "}
          <span>изображения для сайта</span>
        </h1>
        <p className="hero-free">Бесплатно</p>
        <p>
          Сжимайте изображения, задавайте нужные размеры и готовьте версии для разных экранов — всё для сайта в одном инструменте.
        </p>
      </section>

      <section className="optimizer-stage" id="optimizer" aria-label="Оптимизатор изображений">
        <ImageOptimizer />
      </section>

      <section className="release-how" aria-labelledby="how-title">
        <h2 id="how-title">Как это работает</h2>
        <ol>
          <li><b>01</b><span><strong>Загрузите</strong><small>До десяти изображений одним выбором</small></span></li>
          <li><b>02</b><span><strong>Настройте</strong><small>Режим, кадр, размеры и качество</small></span></li>
          <li><b>03</b><span><strong>Скачайте</strong><small>Один или несколько выбранных файлов</small></span></li>
        </ol>
      </section>

      <TinymodsFooter theme="optima" />
    </main>
  );
}
