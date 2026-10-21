"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import styles from "./ServiceHelpDrawer.module.css";

type DrawerProps = {
  open: boolean;
  onClose: () => void;
  id: string;
  title: string;
  theme: "optima" | "editor";
  navigation?: ReactNode;
  children: ReactNode;
};

function OpenDrawer({ onClose, id, title, theme, navigation, children }: Omit<DrawerProps, "open">) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [closing, setClosing] = useState(false);

  useEffect(() => { onCloseRef.current = onClose; }, [onClose]);

  const requestClose = useCallback(() => {
    if (timerRef.current !== null) return;
    setClosing(true);
    const delay = window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 180;
    timerRef.current = setTimeout(() => onCloseRef.current(), delay);
  }, []);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const bodyOverflow = document.body.style.overflow;
    const rootOverflow = document.documentElement.style.overflow;
    document.body.style.overflow = "hidden";
    document.documentElement.style.overflow = "hidden";
    dialog.showModal();
    closeRef.current?.focus();
    return () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
      dialog.close();
      document.body.style.overflow = bodyOverflow;
      document.documentElement.style.overflow = rootOverflow;
      if (trigger?.isConnected) trigger.focus({ preventScroll: true });
    };
  }, []);

  return createPortal(
    <dialog
      ref={dialogRef}
      id={id}
      className={`${styles.drawer}${closing ? ` ${styles.closing}` : ""}`}
      data-ui-theme={theme}
      aria-modal="true"
      aria-labelledby={`${id}-title`}
      onCancel={(event) => { event.preventDefault(); requestClose(); }}
      onMouseDown={(event) => {
        if (event.target !== event.currentTarget) return;
        const rect = event.currentTarget.getBoundingClientRect();
        if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) requestClose();
      }}
      onKeyDown={(event) => {
        if (event.key !== "Tab") return;
        const focusable = Array.from(event.currentTarget.querySelectorAll<HTMLElement>(
          'button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary, [tabindex="0"]',
        )).filter((element) => element.getClientRects().length > 0);
        const first = focusable[0];
        const last = focusable.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }}
    >
      <header className={styles.header}>
        <div className={styles.heading}>
          <div><p className={styles.eyebrow}>Справка Optima</p><h2 id={`${id}-title`}>{title}</h2></div>
          <button ref={closeRef} className={styles.close} type="button" onClick={requestClose} aria-label="Закрыть справку">
            <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="m6 6 12 12M18 6 6 18" /></svg>
          </button>
        </div>
        {navigation}
      </header>
      <div className={styles.body}>{children}</div>
    </dialog>,
    document.body,
  );
}

export default function ServiceHelpDrawer({ open, ...props }: DrawerProps) {
  return open && typeof document !== "undefined" ? <OpenDrawer {...props} /> : null;
}
