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

type ConsentRecord = { version: 2; choice: ConsentChoice; savedAt: number; expiresAt: number };
const CONSENT_MAX_AGE_MS = 365 * 24 * 60 * 60 * 1000;
const CONSENT_CHANGED_EVENT = "optima:consent-changed";
let sessionConsent: ConsentRecord | null = null;
let sessionOnlyConsent = false;
let expiryTimer: ReturnType<typeof setTimeout> | undefined;
let metrikaScriptLoading = false;
let metrikaScriptLoaded = false;
let consentMonitorStarted = false;

function validConsent(value: unknown): value is ConsentRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<ConsentRecord>;
  return record.version === 2 &&
    ["analytics", "necessary", "dismissed"].includes(record.choice ?? "") &&
    typeof record.savedAt === "number" && Number.isFinite(record.savedAt) &&
    typeof record.expiresAt === "number" &&
    record.savedAt <= Date.now() && record.expiresAt > Date.now() &&
    record.expiresAt === record.savedAt + CONSENT_MAX_AGE_MS;
}

function readConsentRecord(): ConsentRecord | null {
  if (sessionOnlyConsent) return validConsent(sessionConsent) ? sessionConsent : null;
  let raw: string | null;
  try { raw = window.localStorage.getItem(STORAGE_KEY); }
  catch { return validConsent(sessionConsent) ? sessionConsent : null; }
  if (!raw) return null;
  let record: unknown;
  try { record = JSON.parse(raw); } catch { record = null; }
  if (validConsent(record)) return record;
  // Legacy strings have no date: ask again rather than inventing a lifetime.
  try { window.localStorage.removeItem(STORAGE_KEY); } catch { /* Fail closed. */ }
  return null;
}

function readConsent(): ConsentChoice | null {
  return readConsentRecord()?.choice ?? null;
}

function saveConsent(choice: ConsentChoice) {
  const savedAt = Date.now();
  sessionConsent = { version: 2, choice, savedAt, expiresAt: savedAt + CONSENT_MAX_AGE_MS };
  sessionOnlyConsent = true;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(sessionConsent));
    sessionOnlyConsent = false;
  } catch {
    // Storage unavailable: retain the dated choice only for this page session.
  }
}

function stopYandexMetrika() {
  if (window.__optimaMetrikaInitialized) window.ym?.(METRIKA_ID, "destruct");
  window.__optimaMetrikaInitialized = false;
}

function initializeYandexMetrika() {
  if (readConsent() !== "analytics" || window.__optimaMetrikaInitialized) return;
  window.ym?.(METRIKA_ID, "init", {
    ssr: true,
    webvisor: true,
    clickmap: true,
    ecommerce: "dataLayer",
    referrer: document.referrer,
    url: window.location.href,
    accurateTrackBounce: true,
    trackLinks: true,
  });
  window.__optimaMetrikaInitialized = true;
}

function loadYandexMetrika() {
  if (readConsent() !== "analytics") return;
  if (metrikaScriptLoaded) { initializeYandexMetrika(); return; }
  if (metrikaScriptLoading) return;
  window.ym = window.ym || function (...args: unknown[]) {
    window.ym!.a = window.ym!.a || [];
    window.ym!.a.push(args);
  };
  window.ym.a = window.ym.a || [];
  window.ym.l = Date.now();
  const script = document.createElement("script");
  script.id = "yandex-metrika";
  script.async = true;
  script.src = "https://mc.yandex.ru/metrika/tag.js?id=" + METRIKA_ID;
  metrikaScriptLoading = true;
  script.onload = () => {
    metrikaScriptLoading = false;
    metrikaScriptLoaded = true;
    // No queued init: revocation during download cannot start a counter later.
    initializeYandexMetrika();
  };
  script.onerror = () => { metrikaScriptLoading = false; script.remove(); };
  document.head.appendChild(script);
}

function synchronizeConsent() {
  clearTimeout(expiryTimer);
  const record = readConsentRecord();
  if (record?.choice === "analytics") loadYandexMetrika();
  else stopYandexMetrika();
  if (record) {
    // Browser timers cannot represent a full year; re-check in bounded intervals.
    expiryTimer = setTimeout(synchronizeConsent, Math.min(record.expiresAt - Date.now(), 24 * 60 * 60 * 1000));
  }
  window.dispatchEvent(new Event(CONSENT_CHANGED_EVENT));
}

function startConsentMonitor() {
  if (consentMonitorStarted) return;
  consentMonitorStarted = true;
  // Retain expiry/revocation across client navigation when the banner unmounts.
  window.addEventListener("storage", event => {
    if (event.key === STORAGE_KEY || event.key === null) {
      sessionConsent = null;
      sessionOnlyConsent = false;
      synchronizeConsent();
    }
  });
  window.addEventListener("pageshow", synchronizeConsent);
  document.addEventListener("visibilitychange", synchronizeConsent);
}

export function CookieConsent() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const updateVisibility = () => setVisible(readConsent() === null);
    const openSettings = () => setVisible(true);
    window.addEventListener(CONSENT_CHANGED_EVENT, updateVisibility);
    window.addEventListener(OPEN_COOKIE_SETTINGS_EVENT, openSettings);
    startConsentMonitor();
    synchronizeConsent();
    return () => {
      window.removeEventListener(CONSENT_CHANGED_EVENT, updateVisibility);
      window.removeEventListener(OPEN_COOKIE_SETTINGS_EVENT, openSettings);
    };
  }, []);

  function allowAnalytics() {
    saveConsent("analytics");
    synchronizeConsent();
  }

  function useNecessaryOnly() {
    saveConsent("necessary");
    synchronizeConsent();
  }

  function dismissBanner() {
    // Closing settings preserves an existing explicit choice.
    if (readConsent() === null) { saveConsent("dismissed"); synchronizeConsent(); }
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

      <div className="cookie-consent-copy">
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