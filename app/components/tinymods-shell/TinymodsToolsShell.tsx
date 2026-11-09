import type { ReactNode } from "react";
import ServiceCurtainTransition from "./ServiceCurtainTransition";
import styles from "./TinymodsToolsShell.module.css";
import { loadServiceHelpContent } from "../../lib/service-help-content";

export default async function TinymodsToolsShell({ children }: Readonly<{ children: ReactNode }>) {
  const helpContent = await loadServiceHelpContent();
  return (
    <div className={styles.shell}>
      <ServiceCurtainTransition helpContent={helpContent}>
        <div className={styles.content}>{children}</div>
      </ServiceCurtainTransition>
    </div>
  );
}
