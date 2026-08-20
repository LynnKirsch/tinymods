Путевой лист Tinymods
Сборка, очистка и публикация проекта

Проект: Tinymods — браузерный оптимизатор изображений
Дата первого production-релиза: август 2026
Текущая схема: Next.js → static export → GitHub → GitHub Actions → GitHub Pages → tinymods.ru
Backend: отсутствует
Обработка изображений: локально в браузере пользователя
Регистратор домена / DNS: Beget
Статус на текущий момент: GitHub Pages опубликован, DNS для tinymods.ru успешно проверен GitHub, ожидается активация HTTPS.

1. Что было в исходной точке

Проект был собран внутри среды ChatGPT и визуально работал там как законченный сервис. После скачивания выяснилось, что исходник содержал не только приложение, но и инфраструктуру среды, в которой ChatGPT его запускал.

В проекте присутствовали:

.openai/hosting.json
build/sites-vite-plugin.ts
worker/index.ts
vite.config.ts
@cloudflare/vite-plugin
wrangler
vinext
chatgpt-auth.ts
cloudflare:workers
Drizzle / D1
examples/d1

Для самого Tinymods большая часть этого не требовалась.

Главный вывод:

Проект, работающий в preview-среде AI-конструктора, ещё не обязательно является независимым production-проектом.

В следующих проектах AI должен писать код в нормальный локальный репозиторий, а не быть средой, внутри которой живёт приложение.

2. Хронология запуска
Этап	Что сделали	Что произошло	Вывод
1. Git	Создали GitHub-репозиторий и ветку release/optimizer-v1	Исходники начали нормально версионироваться	Git подключать в самом начале проекта
2. Локальный запуск	npm ci, затем npm run dev	Windows не понимал Unix-style env-переменные	Кроссплатформенность npm scripts нужно проверять сразу
3. cross-env	Добавили cross-env	Dev-сервер заработал	Не писать платформозависимые scripts, если работа идёт на Windows
4. OpenAI dependencies	Не хватало .openai/hosting.json и build/sites-vite-plugin.ts	Пришлось восстанавливать их из исходного архива	Проект был связан с ChatGPT hosting сильнее, чем казалось
5. Локальный vinext	Dev-версия заработала	Дизайн пришлось существенно проверять и корректировать на реальных viewport	Preview AI-среды не использовать как единственный источник истины для адаптивности
6. Production build vinext	npm run build в Git Bash	Сборка прошла	Сам исходный код был в целом рабочим
7. Local production	vinext start	CSS-файл существовал в build, но локально отдавался с 404	Наличие файла в build ≠ корректная работа конкретного runtime
8. Cloudflare	Авторизовали Wrangler и начали deploy	Потребовались wrangler.jsonc и определённая форма Vite-конфига	Deployment platform надо выбирать до начала разработки
9. Cloudflare config	Динамический import Cloudflare plugin не распознавался vinext deploy	Перевели на статический import	Автоматические инструменты иногда проверяют не только поведение, но и структуру конфигурации
10. Cloudflare deploy	Worker и 25 assets успешно загрузились	Не был зарегистрирован workers.dev, deploy завершился ошибкой маршрута	Upload и публикация — разные этапы
11. Cloudflare DNS	Начали перенос NS с Beget в Cloudflare	Выяснили, что Cloudflare для российской аудитории может быть нежелательной зависимостью	Инфраструктуру выбирать с учётом географии пользователей
12. Отказ от Cloudflare	Вернули NS Beget	Решили убрать Worker вообще	Browser-only продукту backend-хостинг не нужен
13. Static export	Добавили output: "export"	Next начал собирать обычный статический сайт	Для Tinymods это оказалась правильная архитектура
14. Turbopack	npx next build долго зависал	Перешли на --webpack	Production build нужно тестировать рано; fallback builder полезен
15. TypeScript	Нашлись ошибки в старом PNG-модуле	Исправили import .ts и тип ImageData	Production build обнаруживает технический долг, который dev может скрывать
16. Старый backend	TypeScript проверял db/index.ts и Cloudflare D1	Выяснили, что базу тянул demo examples/d1	Не хранить boilerplate/demo внутри production source без необходимости
17. Static routes	manifest, sitemap, robots мешали export	Добавили dynamic = "force-static"	Metadata routes тоже должны поддерживать выбранную модель deployment
18. Финальная static build	next build --webpack	Все маршруты стали ○ Static	Сервер Tinymods действительно не требуется
19. Очистка проекта	Удалили OpenAI/Cloudflare/D1/Vite/Drizzle инфраструктуру	npm удалил около 150 пакетов	После прототипирования делать infrastructure cleanup
20. Public repo	Добавили LICENSE и README	Репозиторий сделали публичным	Public source и коммерческий продукт совместимы, но нужны лицензия и контроль секретов
21. GitHub Actions	Добавили deploy-pages.yml	Первый автоматический deployment прошёл успешно	CI/CD стоит заводить сразу после первой стабильной сборки
22. Custom domain	Настроили GitHub Pages + Beget DNS	GitHub показывает DNS check successful	Домен может оставаться у Beget, а сайт размещаться бесплатно на GitHub Pages
3. Главные ошибки и почему они возникли
Ошибка №1 — среду ChatGPT приняли за production-среду

Это была самая важная архитектурная ошибка.

Визуально проект выглядел готовым, поэтому естественно было предположить:

скачали исходник
→ npm install
→ build
→ production

Фактически было:

приложение
+
OpenAI hosting layer
+
vinext
+
Cloudflare runtime
+
служебный Worker
+
D1/R2 scaffolding

Поэтому после скачивания пришлось отделять сам продукт от среды его создания.

Ошибка №2 — deployment выбрали слишком поздно

До конца разработки не было окончательного решения:

Cloudflare?
VPS?
Beget?
GitHub Pages?

Из-за этого инфраструктура диктовала нам дополнительные действия уже после завершения интерфейса.

Для следующих проектов вопрос

«Где это будет работать в production?»

нужно решить до серьёзной разработки.

Ошибка №3 — адаптивность проверялась преимущественно в preview

В результате реальный Chrome на:

479
640
960
1200
1440
1920
2560 px

показал отличия, которые не были очевидны внутри preview.

Следующее правило:

Дизайн считается проверенным только после теста реального localhost в обычном браузере.

Preview ChatGPT/Figma/AI — только вспомогательный просмотр.

Ошибка №4 — слишком много инфраструктуры осталось от boilerplate

В production-проекте лежали:

D1
Drizzle
Cloudflare Worker
examples
chatgpt-auth
OpenAI hosting
R2 hooks

хотя приложение ими не пользовалось.

Это не только увеличивает проект. Такое содержимое начинает влиять на:

TypeScript
build
dependency tree
security surface
deployment
4. Самое важное архитектурное открытие по Tinymods

Tinymods не обрабатывает изображения на сервере.

Настоящая архитектура выглядит так:

GitHub Pages
      ↓
отдаёт HTML / CSS / JS / WASM
      ↓
браузер пользователя
      ↓
пользователь выбирает изображения
      ↓
AVIF / WebP / resize / crop
выполняются локально
      ↓
пользователь скачивает результат

Поэтому здесь:

VPS — не нужен
Node server — не нужен
Cloudflare Worker — не нужен
PostgreSQL — не нужен
D1 — не нужен

Это позволяет иметь почти нулевую стоимость инфраструктуры.

5. Итоговая production-архитектура Tinymods
VS Code
   │
   │ разработка
   ↓
Git
   ↓
GitHub repository
   │
   │ push в main
   ↓
GitHub Actions
   │
   ├─ npm ci
   ├─ npm run build
   └─ получает out/
          ↓
     GitHub Pages
          ↓
      tinymods.ru

DNS:

tinymods.ru


A → 185.199.108.153
A → 185.199.109.153
A → 185.199.110.153
A → 185.199.111.153


www
CNAME → lynnkirsch.github.io.

Почтовые MX/TXT Beget остаются отдельно и при смене сайта не затрагиваются.

6. Production build, который оказался правильным

next.config.ts:

import type { NextConfig } from "next";


const nextConfig: NextConfig = {
  output: "export",
  trailingSlash: true,


  images: {
    unoptimized: true,
  },
};


export default nextConfig;

Сборка:

npm run build

Фактически:

next build --webpack

Результат:

out/

Именно содержимое out/ представляет production-сайт.

Очень важный критерий успешной сборки:

✓ Compiled successfully
✓ Finished TypeScript
✓ Generating static pages


○ (Static) prerendered as static content
7. Новый стандарт для следующих проектов

Вот этот маршрут я бы теперь использовала как обязательный шаблон работы:

Создать проект сразу локально в VS Code. AI помогает писать код, но рабочая копия проекта с первого дня находится на компьютере.
Сразу создать Git-репозиторий. Первый commit — практически после создания каркаса.
Определить архитектуру до разработки: static / frontend + API / full backend.
Если вся вычислительная логика может выполняться в браузере — не заводить backend без причины.
Сразу определить production hosting.

Уже на раннем этапе добиться рабочего:

npm run build

Проверять проект одновременно через:

localhost development
production build
Адаптивность проверять в обычном Chrome на реальных viewport.
Не наращивать десятки media queries до создания базовой системы контейнеров, typography scale и clamp().
Перед релизом проводить cleanup:
unused packages
examples
boilerplate
old auth
old deployment configs
secrets
dead components
Production должен обновляться только через Git → CI/CD, а не ручным копированием файлов.
Держать main deployable: всё, что находится в main, должно собираться.
Для серьёзной новой функции использовать отдельную ветку:
feature/...
release/...
Перед публикацией public repository проверять:
.env
API keys
tokens
credentials
private URLs
license
README
После стабильного релиза создавать GitHub Release/tag:
v1.0.0
8. Как выбирать инфраструктуру дальше

Теперь у нас есть очень простой критерий.

Browser-only инструмент

Например текущий Image Optimizer:

Static Next.js
+
GitHub Pages

Практически бесплатно.

Инструмент с небольшим API

Например будущий сервис, которому понадобится один внешний AI API:

Frontend
+
небольшой backend/API

Backend можно держать отдельно от frontend.

Настоящий серверный продукт

Например распознавание видео, ffmpeg, Whisper, база, очередь задач:

Frontend
        ↓
API
        ↓
VPS
├─ Docker
├─ backend
├─ PostgreSQL
├─ ffmpeg
└─ workers/queues

Вот тогда VPS имеет смысл.

9. Что получилось хорошо

Несмотря на всю сегодняшнюю цепочку, результат очень полезный.

Мы не просто «кое-как опубликовали сайт». Мы выяснили, что Tinymods может быть гораздо проще первоначальной архитектуры:

было:


OpenAI → vinext → Vite → Cloudflare Worker → DNS


стало:


Next.js → static build → GitHub Pages

И при этом пользовательская функциональность не уменьшилась.

Это очень хороший принцип для будущих micro SaaS:

инфраструктура должна быть настолько простой, насколько позволяет продукт, но не проще его реальных требований.

Для текущего Tinymods это практически идеальный вариант.