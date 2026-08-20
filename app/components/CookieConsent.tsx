"use client";

import { useEffect, useState } from "react";

const METRIKA_ID = 111792380;
const STORAGE_KEY = "optima-cookie-consent-v1";
const OPEN_COOKIE_SETTINGS_EVENT = "optima:open-cookie-settings";

type ConsentChoice = "analytics" | "necessary" | "dismissed";

declare global {
  interface Window {
    ym?: {
      (...args: unknown[]): void;
      a?: unknown[][];
      l?: number;
    };
    __optimaMetrikaInitialized?: boolean;
  }
}

function readConsent(): ConsentChoice | null {
  try {
    const value = window.localStorage.getItem(STORAGE_KEY);

    if (
      value === "analytics" ||
      value === "necessary" ||
      value === "dismissed"
    ) {
      return value;
    }

    return null;
  } catch {
    return null;
  }
}

function saveConsent(choice: ConsentChoice) {
  try {
    window.localStorage.setItem(STORAGE_KEY, choice);
  } catch {
    // Если localStorage недоступен, просто закрываем баннер в текущей сессии.
  }
}

function loadYandexMetrika() {
  if (typeof window === "undefined") return;

  if (window.__optimaMetrikaInitialized) return;

  window.__optimaMetrikaInitialized = true;

  window.ym =
    window.ym ||
    function (...args: unknown[]) {
      window.ym!.a = window.ym!.a || [];
      window.ym!.a.push(args);
    };

  window.ym.l = Date.now();

  const scriptSrc = `https://mc.yandex.ru/metrika/tag.js?id=${METRIKA_ID}`;

  const existingScript = Array.from(document.scripts).find(
    (script) => script.src === scriptSrc,
  );

  if (!existingScript) {
    const script = document.createElement("script");

    script.id = "yandex-metrika";
    script.async = true;
    script.src = scriptSrc;

    document.head.appendChild(script);
  }

  window.ym(METRIKA_ID, "init", {
    ssr: true,
    webvisor: true,
    clickmap: true,
    ecommerce: "dataLayer",
    referrer: document.referrer,
    url: window.location.href,
    accurateTrackBounce: true,
    trackLinks: true,
  });
}

export function CookieConsent() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const consent = readConsent();

    if (consent === "analytics") {
      loadYandexMetrika();
      setVisible(false);
    } else if (consent === "necessary" || consent === "dismissed") {
      setVisible(false);
    } else {
      setVisible(true);
    }

    const openSettings = () => {
      setVisible(true);
    };

    window.addEventListener(
      OPEN_COOKIE_SETTINGS_EVENT,
      openSettings,
    );

    return () => {
      window.removeEventListener(
        OPEN_COOKIE_SETTINGS_EVENT,
        openSettings,
      );
    };
  }, []);

  function allowAnalytics() {
    saveConsent("analytics");
    loadYandexMetrika();
    setVisible(false);
  }

  function useNecessaryOnly() {
    saveConsent("necessary");
    setVisible(false);
  }

  function dismissBanner() {
    saveConsent("dismissed");
    setVisible(false);
  }

  if (!visible) return null;

  return (
    <aside
      className="cookie-consent"
      aria-label="Настройки cookie"
      role="dialog"
      aria-live="polite"
    >
      <button
        className="cookie-consent-close"
        type="button"
        onClick={dismissBanner}
        aria-label="Закрыть настройки cookie"
        title="Закрыть"
      >
        ×
      </button>

      <div>
        <span className="cookie-consent-mark" aria-hidden="true">
          O
        </span>

        <div>
          <strong>Настройки cookie</strong>

          <p>
            Optima сохраняет ваш выбор на устройстве. Яндекс Метрика
            включается только после вашего согласия. Изображения
            по-прежнему обрабатываются локально в браузере.
          </p>

          <a href="/privacy">
            Подробнее в политике
          </a>
        </div>
      </div>

      <div className="cookie-consent-actions">
        <button
          type="button"
          onClick={useNecessaryOnly}
        >
          Только необходимые
        </button>

        <button
          type="button"
          className="is-primary"
          onClick={allowAnalytics}
        >
          Разрешить аналитику
        </button>
      </div>
    </aside>
  );
}

export function CookieSettingsButton() {
  function openSettings() {
    window.dispatchEvent(
      new CustomEvent(OPEN_COOKIE_SETTINGS_EVENT),
    );
  }

  return (
    <button
      type="button"
      className="cookie-settings-button"
      onClick={openSettings}
    >
      Настройки cookie
    </button>
  );
}