"use client";

import { useEffect, useState } from "react";

type ConsentValue = "all" | "necessary";

const STORAGE_KEY = "optima-cookie-consent";
const CONSENT_LIFETIME = 365 * 24 * 60 * 60 * 1000;
const CONSENT_VERSION = 1;

type StoredConsent = {
  version: number;
  value: ConsentValue;
  expiresAt: number;
};

function saveConsent(value: ConsentValue) {
  const consent: StoredConsent = {
    version: CONSENT_VERSION,
    value,
    expiresAt: Date.now() + CONSENT_LIFETIME,
  };

  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(consent));
  window.dispatchEvent(new CustomEvent("optima:consent-change", { detail: consent }));
}

function hasActiveConsent() {
  const raw = window.localStorage.getItem(STORAGE_KEY);
  if (!raw) return false;

  try {
    const consent = JSON.parse(raw) as StoredConsent;
    if (consent.version === CONSENT_VERSION && consent.expiresAt > Date.now()) return true;
  } catch {
    // A damaged preference is replaced through the normal consent flow.
  }

  window.localStorage.removeItem(STORAGE_KEY);
  return false;
}

export function CookieConsent() {
  const [isOpen, setIsOpen] = useState(false);

  useEffect(() => {
    const initialCheck = window.setTimeout(() => setIsOpen(!hasActiveConsent()), 0);

    const openSettings = () => setIsOpen(true);
    window.addEventListener("optima:open-cookie-settings", openSettings);
    return () => {
      window.clearTimeout(initialCheck);
      window.removeEventListener("optima:open-cookie-settings", openSettings);
    };
  }, []);

  if (!isOpen) return null;

  const choose = (value: ConsentValue) => {
    saveConsent(value);
    setIsOpen(false);
  };

  return (
    <aside className="cookie-consent" role="dialog" aria-modal="false" aria-labelledby="cookie-title">
      <div>
        <span className="cookie-consent-mark" aria-hidden="true">O</span>
        <div>
          <strong id="cookie-title">Настройки cookie</strong>
          <p>
            Сейчас Optima хранит только ваш выбор. Когда появится аналитика, она будет
            включаться после согласия. Изображения по-прежнему останутся в браузере.
          </p>
          <a href="/privacy#cookies">Подробнее в политике</a>
        </div>
      </div>
      <div className="cookie-consent-actions">
        <button type="button" onClick={() => choose("necessary")}>Только необходимые</button>
        <button type="button" className="is-primary" onClick={() => choose("all")}>Разрешить аналитику</button>
      </div>
    </aside>
  );
}

export function CookieSettingsButton() {
  return (
    <button
      className="cookie-settings-button"
      type="button"
      onClick={() => window.dispatchEvent(new Event("optima:open-cookie-settings"))}
    >
      Настройки cookie
    </button>
  );
}
