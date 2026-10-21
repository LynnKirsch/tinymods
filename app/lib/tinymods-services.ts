export type TinymodsService = {
  id: "image-optimizer" | "html-content-editor";
  title: string;
  shortTitle: string;
  href: "/" | "/html-content-editor";
  accent: string;
};

export const TINYMODS_SERVICES: TinymodsService[] = [
  {
    id: "image-optimizer",
    title: "Оптимизатор изображений",
    shortTitle: "Optima",
    href: "/",
    accent: "#718134",
  },
  {
    id: "html-content-editor",
    title: "Редактор HTML",
    shortTitle: "HTML",
    href: "/html-content-editor",
    accent: "#238fbc",
  },
];

export function normalizeTinymodsPathname(pathname: string) {
  const normalized = pathname.split(/[?#]/, 1)[0] || "/";
  if (normalized === "/") return normalized;
  return normalized.replace(/\/+$/, "");
}

export function getTinymodsServiceByPathname(pathname: string) {
  const normalized = normalizeTinymodsPathname(pathname);
  return (
    TINYMODS_SERVICES.find((service) => {
      if (service.href === "/") return normalized === "/";
      return normalized === service.href || normalized.startsWith(`${service.href}/`);
    }) ?? TINYMODS_SERVICES[0]
  );
}
