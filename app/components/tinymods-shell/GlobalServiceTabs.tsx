"use client";

import Link from "next/link";
import Image from "next/image";
import { useState, type MouseEvent } from "react";
import ServiceHelpDrawer from "./ServiceHelpDrawer";
import type { HelpBlock, ServiceHelpContent } from "../../lib/service-help-content";
import { usePathname } from "next/navigation";
import {
  getTinymodsServiceByPathname,
  normalizeTinymodsPathname,
  TINYMODS_SERVICES,
  type TinymodsService,
} from "../../lib/tinymods-services";
import styles from "./TinymodsToolsShell.module.css";

type GlobalServiceTabsProps = {
  helpContent?: ServiceHelpContent;
  selectedServiceId?: TinymodsService["id"];
  onServiceClick?: (event: MouseEvent<HTMLAnchorElement>, service: TinymodsService) => void;
};

export default function GlobalServiceTabs({ onServiceClick, helpContent, selectedServiceId }: GlobalServiceTabsProps) {
  const [helpView, setHelpView] = useState<"instruction" | "faq" | null>(null);
  const pathname = usePathname();
  const currentPathname = normalizeTinymodsPathname(pathname);
  const activeService = TINYMODS_SERVICES.find(service => service.id === selectedServiceId)
    ?? getTinymodsServiceByPathname(pathname);
  const content = helpContent?.[activeService.id];
  const theme = activeService.id === "html-content-editor" ? "editor" : "optima";

  return (
    <nav
      className={styles.tabs}
      aria-label="Сервисы Tinymods"
    >
      <Link className={styles.brandLink} href="/" aria-label="Tinymods — главная">
        <Image src="/brand/tinymods-logo.svg?v=da2261dccb4d" alt="" width={1961} height={385} />
      </Link>
      <div className={styles.tabScroller}>
        {TINYMODS_SERVICES.map((service) => {
          const active = service.id === activeService.id;
          const current = currentPathname === service.href
            || (service.href !== "/" && currentPathname.startsWith(`${service.href}/`));

          return (
            <Link
              key={service.id}
              className={active ? `${styles.tab} ${styles.activeTab}` : styles.tab}
              href={service.href}
              data-ui-theme={service.id === "html-content-editor" ? "editor" : undefined}
              aria-current={current ? "page" : undefined}
              onClick={(event) => onServiceClick?.(event, service)}
            >
              {active ? <span className={styles.tabAccent} aria-hidden="true" /> : null}
              <span className={styles.fullTitle}>{service.title}</span>
              <span className={styles.shortTitle}>{service.shortTitle}</span>
            </Link>
          );
        })}
      </div>
      {content ? <div className={styles.helpActions} aria-label="Справка текущего инструмента">
        <button type="button" onClick={() => setHelpView("instruction")} aria-haspopup="dialog" aria-controls="service-help-panel">ИНСТРУКЦИЯ</button>
        <button type="button" onClick={() => setHelpView("faq")} aria-haspopup="dialog" aria-controls="service-help-panel">ВОПРОС-ОТВЕТ</button>
      </div> : null}
      <ServiceHelpDrawer open={Boolean(content && helpView)} onClose={() => setHelpView(null)} id="service-help-panel" theme={theme}
        title={helpView === "faq" ? "Вопрос-ответ" : `Инструкция · ${activeService.shortTitle}`}
        navigation={<div className={styles.helpPanelTabs} role="group" aria-label="Раздел справки">
          <button type="button" aria-pressed={helpView === "instruction"} onClick={() => setHelpView("instruction")}>Инструкция</button>
          <button type="button" aria-pressed={helpView === "faq"} onClick={() => setHelpView("faq")}>Вопрос-ответ</button>
        </div>}
      >
        {content && helpView === "instruction" ? <InstructionBlocks blocks={content.instruction} /> : content?.faq.map(item => (
          <details key={item.question}><summary>{item.question}</summary><p>{item.answer}</p></details>
        ))}
      </ServiceHelpDrawer>
    </nav>
  );
}

function emphasis(text: string) {
  return text.split(/(\*\*[^*]+\*\*)/g).map((part, index) => part.startsWith("**")
    ? <strong key={index}>{part.slice(2, -2)}</strong> : part);
}

function InstructionBlocks({ blocks }: { blocks: HelpBlock[] }) {
  return blocks.map((block, index) => {
    if (block.kind === "heading") return <h3 key={index}>{emphasis(block.text)}</h3>;
    if (block.kind === "subheading") return <h4 key={index}>{emphasis(block.text)}</h4>;
    if (block.kind === "list") {
      const items = block.items.map((item, itemIndex) => <li key={itemIndex}>{emphasis(item)}</li>);
      return block.ordered ? <ol key={index}>{items}</ol> : <ul key={index}>{items}</ul>;
    }
    return <p key={index}>{emphasis(block.text)}</p>;
  });
}
