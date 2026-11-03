<h1 align="center">Breatic</h1>

<p align="center"><strong>Рабочее пространство с ИИ для совместного творчества в реальном времени.</strong></p>
<p align="center">Доступно онлайн · Исходный код доступен · Браузер на компьютере</p>

<p align="center">
  <a href="https://breatic.ai/?utm_source=github&amp;utm_medium=referral&amp;utm_campaign=repository_listing_202610&amp;utm_content=readme_website_ru">Сайт</a> ·
  <a href="https://breatic.ai/login?utm_source=github&amp;utm_medium=referral&amp;utm_campaign=repository_listing_202610&amp;utm_content=readme_ru">Попробовать Breatic</a> ·
  <a href="https://youtu.be/mc1XAqtJD_M">Демо за 45 с (англ.)</a> ·
  <a href="docs/USAGE.md">Руководство (англ.)</a> ·
  <a href="https://discord.gg/Yeu6A4aejN">Discord</a>
</p>

<p align="center">
  <a href="https://github.com/orime-org/breatic/releases/latest"><img alt="Latest release" src="https://img.shields.io/github/v/release/orime-org/breatic?style=flat&amp;color=blueviolet&amp;label=release&amp;display_name=tag"></a>
  <a href="LICENSE"><img alt="License: Elastic-2.0" src="https://img.shields.io/badge/license-Elastic--2.0-blue?style=flat"></a>
  <a href="https://discord.gg/Yeu6A4aejN"><img alt="Discord community" src="https://img.shields.io/badge/discord-join%20community-5865F2?style=flat&amp;logo=discord&amp;logoColor=white"></a>
  <a href="#get-started"><img alt="Quickstart guide" src="https://img.shields.io/badge/quickstart-guide-green?style=flat"></a>
</p>

<p align="center" dir="ltr">
  <a href="README.md">English</a> · <a href="README-CN.md">简体中文</a> · <a href="README-TW.md">繁體中文</a> · <a href="README-JA.md">日本語</a> · <a href="README-KO.md">한국어</a> · <a href="README-ES.md">Español</a> · <a href="README-PT-BR.md">Português</a><br>
  <a href="README-DE.md">Deutsch</a> · <a href="README-FR.md">Français</a> · <a href="README-AR.md">العربية</a> · <strong>Русский</strong> · <a href="README-UK.md">Українська</a> · <a href="README-TR.md">Türkçe</a> · <a href="README-TH.md">ภาษาไทย</a>
</p>

---

Соберите бриф, сцены и медиа в одном Project. Пишите в Document Spaces, создавайте и дорабатывайте материалы в Canvas Spaces и работайте с ИИ-агентом и коллегами, сохраняя контекст всей работы.

В облачном сервисе есть бесплатный план Starter. Кредиты для генерации с ИИ приобретаются отдельно и не включены в подписки. См. [тарифы и кредиты][hosted-pricing].

![Варианты изображений кофейни на холсте Breatic рядом с чатом проекта; английский интерфейс](docs/images/readme/workspace-en.png)

## Что можно делать

| Возможность | Применение |
| --- | --- |
| **Projects с несколькими Spaces** | Организуйте бриф, сцены и творческие варианты в отдельных вкладках. |
| **Document Spaces** | Пишите сценарии, описания кадров и производственные списки с форматированием текста. |
| **Canvas Spaces** | Размещайте референсы и медиа на бесконечном холсте; создавайте и дорабатывайте материалы с помощью запросов, моделей и референсов. |
| **3D (DEV)** | Размещайте встроенные объекты в общей сцене и меняйте их положение, поворот и масштаб. |
| **Timeline (DEV)** | Добавляйте видео из Project или загружайте локальные файлы на общую видеодорожку, задавайте начальный кадр и просматривайте последовательность. |
| **ИИ-агент в проекте** | Обсуждайте идеи, передавайте контекст документа или холста и рассматривайте предложения рядом с материалами. |
| **Совместная работа в реальном времени** | Приглашайте участников, задавайте права и работайте с синхронизированными холстами, документами, 3D-сценами и Timeline. |

Поддерживаются изображения, видео, аудио и 3D-материалы. Генерация зависит от настроенных провайдеров и доступа к моделям. Canvas и Document доступны; 3D и Timeline отмечены **DEV**. Сейчас Timeline поддерживает размещение и просмотр видео на одной видеодорожке. Многодорожечный монтаж, другие виды медиа, Web Animation и экспорт видео запланированы. Генерация с помощью моделей и аннотации внутри 3D-сцены находятся в разработке.

## Обсуждайте изменения вместе

Сохраняйте решения рядом с работой. Пока команда сравнивает два изображения сцены, участник может изменить общее творческое направление. Агент может предложить новую формулировку до замены фрагмента документа; команда решает, что сохранить.

![Общее творческое направление рядом с двумя изображениями сцены; английский интерфейс](docs/images/readme/shared-direction.png)

![Предложение правки с действиями для комментария и замены; английский интерфейс](docs/images/readme/agent-review.png)

Это снимки реального демонстрационного проекта; история и материалы служат иллюстрацией.

## Творческий процесс: 30-секундный ролик о кофейне

**Studio** объединяет проекты и материалы. **Project** собирает одну работу; его **Spaces** разделяют её по сценам, результатам или творческим направлениям.

1. **Напишите бриф:** в Document Space опишите историю, аудиторию, диалоги и визуальный стиль.
2. **Поработайте с агентом:** добавьте нужный контекст в чат, обсудите кадры и оцените предложения.
3. **Создайте сцены:** в Canvas Spaces выберите настроенную модель, добавьте запросы и референсы, сравните варианты.
4. **Проверьте и передайте:** выберите материалы вместе с коллегами и скачайте их для производства.

Spaces можно назвать «Начало · 0–10 с», «Основная сцена · 10–20 с» и «Финал · 20–30 с». Названия нужны для планирования: они не задают длительность клипов и не собирают готовое видео автоматически. Используйте Timeline для размещения и просмотра, а видеоредактор — для завершения и экспорта. См. [иллюстрированный пример (англ.)](docs/USAGE.md#example-from-a-brief-to-a-visual).

<a id="get-started"></a>

## Начало работы

- **Облачный продукт:** [откройте Breatic][hosted-app] в браузере на компьютере и зарегистрируйтесь или войдите.
- **Своя установка:** следуйте [руководству для личного использования и LAN (англ.)](self-host/LOCAL.md).
- **Разработка:** см. [настройку среды разработки (англ.)](self-host/DEVELOPMENT.md).

Настройте личный Studio, создайте Project и кнопкой **+** добавьте Document, Canvas, 3D или Timeline Spaces. Начните с брифа, загрузите референсы или разместите встроенные 3D-объекты. В [руководстве (англ.)](docs/USAGE.md) есть [сочетания клавиш](docs/USAGE.md#keyboard-shortcuts).

### Перед самостоятельным размещением

Установка использует опубликованные Docker-образы для веб-интерфейса, API, фоновых задач и совместной работы, а также PostgreSQL и Redis. Загрузка и обработка медиа выполняются через Ingest Worker и медиаконтейнер в **вашем аккаунте Cloudflare**, файлы хранятся в вашем бакете R2. Вызовы ИИ используют ваши аккаунты провайдеров и квоты.

Это не автономная и не полностью локальная установка. Для LAN нужен доверенный HTTPS. Облачные службы и модели могут быть платными; SMTP, вход через Google, платежи Stripe и поиск — необязательные интеграции. Настройте и проверьте облако по руководству. Первоначальный шаг Node/pnpm/Wrangler относится к развёртыванию, а не к запуску сервера разработки для повседневного использования.

## Статус, помощь и участие

Облачный сервис доступен, разработка продолжается; указанные выше отметки DEV и ограничения остаются в силе. См. [опубликованные версии](https://github.com/orime-org/breatic/releases).

[Сообщить об ошибке](https://github.com/orime-org/breatic/issues/new?template=bug_report.yml) · [Предложить функцию](https://github.com/orime-org/breatic/issues/new?template=feature_request.yml) · [Discord](https://discord.gg/Yeu6A4aejN)

Об уязвимостях сообщайте конфиденциально согласно [SECURITY.md](SECURITY.md). Проект использует TypeScript, React/Vite, Hono, PostgreSQL, Redis/BullMQ и Hocuspocus/Yjs, а для загрузок — отдельный Cloudflare Worker.

[Участие](CONTRIBUTING.md) · [Архитектура](docs/ARCHITECTURE.md) · [Тестирование](docs/TEST-MANDATE.md)

[Сайт](https://breatic.ai) · [X](https://x.com/breatic_ai) · [YouTube](https://www.youtube.com/@breatic_ai) · [Instagram](https://www.instagram.com/breatic_ai)

## Лицензия и разрешённое использование

Исходный код Breatic доступен по [Elastic License 2.0](LICENSE) (Elastic-2.0). Вы можете читать, изменять, распространять и запускать Breatic для себя или внутри своей организации, в том числе для коммерческой работы. Нельзя предоставлять Breatic третьим лицам как размещённый или управляемый сервис. Полные условия приведены в лицензии.

Название и логотип — товарные знаки Orime, Inc., не охватываемые лицензией; см. [TRADEMARKS.md](TRADEMARKS.md). Лицензия не ограничивает контент, который вы создаёте с помощью Breatic.

### Сгенерированный контент

Операторы и пользователи каждой установки отвечают за соблюдение применимого законодательства, включая авторские права, товарные знаки, конфиденциальность, защиту данных, диффамацию и модерацию; за права на исходные материалы и их дальнейшее использование; за модерацию в своём контексте. Orime, Inc. не гарантирует точность, законность, оригинальность или безопасность сгенерированного контента.

Сторонние компоненты и уведомления описаны в [THIRD-PARTY.md](THIRD-PARTY.md).

[hosted-app]: https://breatic.ai/login?utm_source=github&utm_medium=referral&utm_campaign=repository_listing_202610&utm_content=readme_ru
[hosted-pricing]: https://breatic.ai/pricing/?utm_source=github&utm_medium=referral&utm_campaign=repository_listing_202610&utm_content=readme_pricing_ru

© 2026 Orime, Inc.
