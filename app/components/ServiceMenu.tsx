"use client";

import { usePathname } from "next/navigation";
import Link from "next/link";
import { useEffect, useState } from "react";

const SERVICES = [
  {
    href: "/",
    number: "01",
    title: "Оптимизатор фото",
    description: "PNG и JPG → AVIF / WebP",
    icon: "◫",
  },
  {
    href: "/png-to-svg",
    number: "02",
    title: "PNG → SVG",
    description: "Иконки и простая графика",
    icon: "◇",
  },
];

export default function ServiceMenu() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const previousOverflow = document.body.style.overflow;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  return (
    <>
      <button
        className="service-menu-trigger"
        type="button"
        aria-expanded={open}
        aria-controls="service-menu-drawer"
        onClick={() => setOpen(true)}
      >
        <i aria-hidden="true">
          <span />
          <span />
          <span />
          <span />
        </i>
        <b>Сервисы</b>
      </button>

      {open ? (
        <div className="service-menu-backdrop" role="presentation" onMouseDown={() => setOpen(false)}>
          <aside
            className="service-menu-drawer"
            id="service-menu-drawer"
            aria-label="Сервисы Оптимы"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <header>
              <Link className="brand" href="/" aria-label="Оптима — главная" onClick={() => setOpen(false)}>
                <span className="brand-mark" aria-hidden="true">O</span>
                <span>
                  <strong>Оптима</strong>
                  <small>Инструменты для сайта</small>
                </span>
              </Link>
              <button type="button" aria-label="Закрыть меню" onClick={() => setOpen(false)}>×</button>
            </header>

            <div className="service-menu-heading">
              <p>Выберите задачу</p>
              <h2>Один сайт.<br /><em>Разные инструменты.</em></h2>
            </div>

            <nav aria-label="Список сервисов">
              {SERVICES.map((service) => {
                const active = pathname === service.href;
                return (
                  <Link
                    key={service.href}
                    className={active ? "is-active" : ""}
                    href={service.href}
                    aria-current={active ? "page" : undefined}
                    onClick={() => setOpen(false)}
                  >
                    <span className="service-menu-number">{service.number}</span>
                    <i aria-hidden="true">{service.icon}</i>
                    <span>
                      <strong>{service.title}</strong>
                      <small>{service.description}</small>
                    </span>
                    <b aria-hidden="true">→</b>
                  </Link>
                );
              })}
            </nav>

            <footer>
              <span><i aria-hidden="true" /> Файлы остаются в браузере</span>
              <small>Новые инструменты будут появляться здесь</small>
            </footer>
          </aside>
        </div>
      ) : null}
    </>
  );
}
