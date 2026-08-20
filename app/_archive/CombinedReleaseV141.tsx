import ImageOptimizer from "../components/ImageOptimizer";

/**
 * Archived composition of the combined product before Release 1.0.
 * It is intentionally outside the public route tree. The PNG → SVG source
 * remains in components/lib and the complete prior deployment stays preserved.
 */
export default function CombinedReleaseV141() {
  return (
    <main>
      <header className="topbar">
        <a className="brand" href="#top" aria-label="Умный оптимизатор — наверх">
          <span className="brand-mark" aria-hidden="true">O</span>
          <span><strong>Оптима</strong><small>image lab · MVP 1.4</small></span>
        </a>
        <a className="topbar-link" href="#how-it-works">Как это работает <span>↘</span></a>
      </header>
      <section className="hero" id="top">
        <div className="hero-copy">
          <p className="eyebrow"><span /> Умная подготовка изображений для сайта</p>
          <h1>Каждый кадр.<br />Лучший вес для<br /><em>каждого экрана.</em></h1>
          <p className="hero-lead">
            Архивная композиция объединённого сервиса до выделения оптимизатора
            в самостоятельный продукт.
          </p>
        </div>
        <ImageOptimizer />
      </section>
    </main>
  );
}
