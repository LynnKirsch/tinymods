import TinymodsToolsShell from "../components/tinymods-shell/TinymodsToolsShell";

export default function ToolsLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <TinymodsToolsShell>{children}</TinymodsToolsShell>;
}
