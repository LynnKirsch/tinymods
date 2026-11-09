import TinymodsToolsShell from "../components/tinymods-shell/TinymodsToolsShell";
import { CookieConsent } from "../components/CookieConsent";

export default function ToolsLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <>
    <TinymodsToolsShell>{children}</TinymodsToolsShell>
    <CookieConsent />
  </>;
}
