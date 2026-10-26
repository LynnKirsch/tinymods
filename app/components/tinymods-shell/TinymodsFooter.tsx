import Image from "next/image";
import Link from "next/link";
import { CookieSettingsButton } from "../CookieConsent";
import styles from "./TinymodsFooter.module.css";

export default function TinymodsFooter({ theme }: { theme: "optima" | "editor" }) {
  return (
    <div className={styles.surface} data-ui-theme={theme}>
      <footer className="release-footer" data-tinymods-footer={theme}>
        <div className="footer-contact">
          <p>Остались вопросы по сервису, или вы хотите свой собственный сервис под свои задачи?</p>
          <a href="https://vk.ru/lynn.kirsch" target="_blank" rel="noreferrer">
            Напишите в ВК
          </a>
        </div>
        <div className="footer-legal">
          <Link className="brand" href="/" aria-label="Tinymods — главная">
            <Image src="/brand/tinymods-logo.svg?v=1a069a98abb4" alt="" width={1997} height={385} />
          </Link>
          <div className="footer-operator">
            <strong>ИП Кирюшкина Е.В.</strong>
            <span>ИНН 423400473018</span>
            <span>ОГРНИП 323220200088967</span>
          </div>
          <nav aria-label="Юридические документы">
            <a href="/privacy">Политика обработки персональных данных</a>
            <CookieSettingsButton />
          </nav>
          <p className="footer-copyright">
            © 2026 Tinymods. Сервис, дизайн и материалы защищены авторским правом.
          </p>
        </div>
      </footer>
    </div>
  );
}
