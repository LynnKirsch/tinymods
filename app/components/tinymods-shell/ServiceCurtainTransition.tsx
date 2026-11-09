"use client";

import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { usePathname, useRouter } from "next/navigation";
import { useState, type MouseEvent, type ReactNode } from "react";
import GlobalServiceTabs from "./GlobalServiceTabs";
import { getTinymodsServiceByPathname, type TinymodsService } from "../../lib/tinymods-services";
import styles from "./TinymodsToolsShell.module.css";
import type { ServiceHelpContent } from "../../lib/service-help-content";

function isModifiedNavigation(event: MouseEvent<HTMLAnchorElement>) {
  return (
    event.button !== 0 ||
    event.metaKey ||
    event.ctrlKey ||
    event.shiftKey ||
    event.altKey
  );
}

export default function ServiceCurtainTransition({
  children, helpContent,
}: Readonly<{ children: ReactNode; helpContent?: ServiceHelpContent }>) {
  const pathname = usePathname();
  const theme = getTinymodsServiceByPathname(pathname).id === "html-content-editor" ? "editor" : "optima";
  const router = useRouter();
  const reduceMotion = useReducedMotion();
  const [settledPathname, setSettledPathname] = useState(pathname);
  const routeIsSettled = settledPathname === pathname;

  function handleServiceClick(
    event: MouseEvent<HTMLAnchorElement>,
    service: TinymodsService,
  ) {
    if (isModifiedNavigation(event) || service.href === pathname) return;

    event.preventDefault();
    router.push(service.href, { scroll: true });
  }

  return (
    <div className={styles.transitionRoot} data-ui-theme={theme}>
      <GlobalServiceTabs onServiceClick={handleServiceClick} helpContent={helpContent} />
      <div className={styles.pageStack}>
        <AnimatePresence initial={false} mode="popLayout">
          <motion.div
            key={pathname}
            className={
              routeIsSettled
                ? styles.pageLayer
                : `${styles.pageLayer} ${styles.pageLayerEntering}`
            }
            initial={reduceMotion ? { opacity: 0 } : { y: "-100dvh" }}
            animate={
              reduceMotion
                ? { opacity: 1 }
                : { y: 0, transitionEnd: { transform: "none" } }
            }
            exit={reduceMotion ? { opacity: 1 } : { y: 0 }}
            onAnimationComplete={() => setSettledPathname(pathname)}
            transition={
              reduceMotion
                ? { duration: 0.01 }
                : { duration: 0.58, ease: [0.22, 1, 0.36, 1] }
            }
          >
            {children}
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  );
}
