<h1 align="center">Breatic</h1>

<p align="center"><strong>Der KI-Arbeitsbereich für Kreativteams mit Zusammenarbeit in Echtzeit.</strong></p>
<p align="center">Online verfügbar · Quellcode einsehbar · Desktop-Browser</p>

<p align="center">
  <a href="https://breatic.ai/?utm_source=github&amp;utm_medium=referral&amp;utm_campaign=repository_listing_202610&amp;utm_content=readme_website_de">Website</a> ·
  <a href="https://breatic.ai/login?utm_source=github&amp;utm_medium=referral&amp;utm_campaign=repository_listing_202610&amp;utm_content=readme_de">Breatic testen</a> ·
  <a href="https://youtu.be/mc1XAqtJD_M">45-Sekunden-Demo (Englisch)</a> ·
  <a href="docs/USAGE.md">Anleitung (Englisch)</a> ·
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
  <strong>Deutsch</strong> · <a href="README-FR.md">Français</a> · <a href="README-AR.md">العربية</a> · <a href="README-RU.md">Русский</a> · <a href="README-UK.md">Українська</a> · <a href="README-TR.md">Türkçe</a> · <a href="README-TH.md">ภาษาไทย</a>
</p>

---

Bringe Briefing, Szenen und Medien in einem Project zusammen. Schreibe in Document Spaces, erzeuge und verfeinere Inhalte in Canvas Spaces und arbeite mit einem KI-Agenten und deinem Team im Kontext der Produktion.

Der gehostete Dienst bietet einen kostenlosen Starter-Tarif. Credits für die KI-Generierung werden separat gekauft und sind nicht in Mitgliedschaften enthalten. Siehe [Preise und Credits][hosted-pricing].

![Bildvarianten eines Cafés auf dem Breatic-Canvas neben dem Projektchat; englische Oberfläche](docs/images/readme/workspace-en.png)

## Was du damit machen kannst

| Funktion | Einsatz |
| --- | --- |
| **Projects mit mehreren Spaces** | Briefing, Szenen und kreative Alternativen in eigenen Tabs organisieren. |
| **Document Spaces** | Drehbücher, Einstellungen und Produktionslisten mit formatiertem Text verfassen. |
| **Canvas Spaces** | Referenzen und Medien auf einer unendlichen Arbeitsfläche anordnen; Inhalte mit Prompts, Modellen und Referenzen erzeugen und verfeinern. |
| **3D (DEV)** | Integrierte Objekte in einer gemeinsamen Szene platzieren sowie Position, Drehung und Skalierung bearbeiten. |
| **Timeline (DEV)** | Videos aus dem Project oder lokal hochgeladene Videos auf gemeinsamen Spuren anordnen: Clips verschieben, trimmen, teilen, duplizieren und löschen, eigene Änderungen rückgängig machen und die Sequenz abspielen. Eine Web Animation beschreiben, von DeepSeek erstellen lassen, in der Ausführungsliste verfolgen und das Ergebnis als Clips einfügen, die im Takt der Timeline laufen. Videos und Web Animations aller Spuren laufen als übereinanderliegende Ebenen gemeinsam; eine Ebene in der Vorschau auswählen, um sie zu verschieben, zu skalieren, zu strecken oder zu drehen, oder Position und Größe eingeben. Am Ende der Wiedergabeleiste das Seitenverhältnis aus sieben Vorgaben wählen (16:9, 9:16, 1:1, 4:3, 4:5, 2:3, 21:9); die Ebenen behalten ihren Platz im Bild. |
| **KI-Agent im Projekt** | Ideen besprechen, Dokument- und Canvas-Kontext bereitstellen und Vorschläge zusammen mit deinen Materialien prüfen. |
| **Zusammenarbeit in Echtzeit** | Teammitglieder einladen, Berechtigungen festlegen und synchronisierte Canvases, Dokumente, 3D-Szenen und Timelines bearbeiten. |

Unterstützte Medien sind Bilder, Videos, Audio und 3D-Dateien. Die Generierung hängt von den eingerichteten Anbietern und dem Modellzugang ab. Canvas und Document sind verfügbar; 3D und Timeline tragen die Kennzeichnung **DEV**. Die Timeline unterstützt derzeit Bearbeitung und Vorschau von Videos und Web Animations auf mehreren Bildspuren; Web Animation steht nur in Installationen zur Verfügung, die sie aktivieren. Weitere Medientypen und Videoexport sind geplant. Modellgenerierung und Anmerkungen innerhalb der 3D-Szene sind in Entwicklung.

## Änderungen gemeinsam prüfen

Halte Entscheidungen direkt neben der Arbeit fest. Ein Teammitglied kann die gemeinsame kreative Richtung ändern, während das Team zwei Szenenbilder vergleicht. Der Agent kann eine Überarbeitung vorschlagen, bevor eine Textpassage ersetzt wird. Das Team entscheidet, was bleibt.

![Gemeinsame kreative Richtung neben zwei Szenenbildern; englische Oberfläche](docs/images/readme/shared-direction.png)

![Textvorschlag mit Aktionen zum Kommentieren und Ersetzen; englische Oberfläche](docs/images/readme/agent-review.png)

Die Aufnahmen stammen aus einem echten Beispielprojekt; Geschichte und Szenenmaterial dienen der Veranschaulichung.

## Ein kreativer Ablauf: ein 30-Sekunden-Video für ein Café

Ein **Studio** enthält Projekte und Assets. Ein **Project** bündelt eine Produktion; seine **Spaces** teilen die Arbeit nach Szene, Ergebnis oder kreativer Richtung auf.

1. **Briefing schreiben:** Geschichte, Zielgruppe, Dialog und Bildsprache in einem Document Space festhalten.
2. **Mit dem Agenten arbeiten:** relevanten Kontext im Chat bereitstellen, Einstellungen besprechen und Vorschläge prüfen.
3. **Szenen entwickeln:** in Canvas Spaces ein eingerichtetes Modell wählen, Prompts und Referenzen ergänzen und Varianten vergleichen.
4. **Prüfen und übergeben:** gemeinsam passende Assets auswählen und für die Produktion herunterladen.

Spaces können etwa „Auftakt · 0–10 s“, „Hauptszene · 10–20 s“ und „Schluss · 20–30 s“ heißen. Diese Namen dienen der Planung; sie legen keine Clipdauer fest und erstellen keinen fertigen Film. Verwende Timeline für Anordnung und Vorschau und deinen Videoeditor für Fertigstellung und Export. Siehe das [bebilderte Beispiel (Englisch)](docs/USAGE.md#example-from-a-brief-to-a-visual).

<a id="get-started"></a>

## Einstieg

- **Gehostetes Produkt:** [Breatic öffnen][hosted-app], im Desktop-Browser registrieren oder anmelden.
- **Eigene Installation:** [Anleitung für persönliche Nutzung und LAN (Englisch)](self-host/LOCAL.md).
- **Entwicklung:** [Entwicklungsumgebung einrichten (Englisch)](self-host/DEVELOPMENT.md).

Richte dein persönliches Studio ein, erstelle ein Project und füge über **+** Document, Canvas, 3D oder Timeline Spaces hinzu. Beginne mit einem Briefing, lade Referenzen hoch oder platziere integrierte 3D-Objekte. Die [Anleitung (Englisch)](docs/USAGE.md) enthält auch [Tastenkürzel](docs/USAGE.md#keyboard-shortcuts).

### Vor dem Selbsthosting

Die Installation verwendet veröffentlichte Docker-Images für Web, API, Hintergrundaufgaben und Zusammenarbeit sowie PostgreSQL und Redis. Uploads und Medienverarbeitung benötigen einen Ingest Worker und einen Mediencontainer in **deinem Cloudflare-Konto**; gespeichert wird in deinem R2-Bucket. KI-Aufrufe verwenden deine Anbieterkonten und Kontingente.

Dies ist keine Offline- oder vollständig lokale Installation. LAN-Zugriff benötigt vertrauenswürdiges HTTPS. Cloud-Dienste und Modellaufrufe können Kosten verursachen; SMTP, Google-Anmeldung, Stripe-Zahlungen und Suche sind optionale Integrationen. Folge der Anleitung zur Cloud-Einrichtung und Prüfung. Der einmalige Node/pnpm/Wrangler-Schritt dient dem Deployment; für die normale Nutzung läuft kein Entwicklungsserver.

## Status, Hilfe und Beiträge

Der gehostete Dienst ist verfügbar und wird weiterentwickelt; die genannten DEV-Markierungen und Grenzen gelten weiterhin. Veröffentlichte Versionen stehen unter [Releases](https://github.com/orime-org/breatic/releases).

[Fehler melden](https://github.com/orime-org/breatic/issues/new?template=bug_report.yml) · [Funktion vorschlagen](https://github.com/orime-org/breatic/issues/new?template=feature_request.yml) · [Discord](https://discord.gg/Yeu6A4aejN)

Sicherheitslücken bitte gemäß [SECURITY.md](SECURITY.md) vertraulich melden. Das Projekt verwendet TypeScript, React/Vite, Hono, PostgreSQL, Redis/BullMQ und Hocuspocus/Yjs sowie einen separaten Cloudflare Worker für Uploads.

[Mitwirken](CONTRIBUTING.md) · [Architektur](docs/ARCHITECTURE.md) · [Tests](docs/TEST-MANDATE.md)

[Website](https://breatic.ai) · [X](https://x.com/breatic_ai) · [YouTube](https://www.youtube.com/@breatic_ai) · [Instagram](https://www.instagram.com/breatic_ai)

## Lizenz und erlaubte Nutzung

Der Quellcode von Breatic ist unter der [Elastic License 2.0](LICENSE) (Elastic-2.0) verfügbar. Du darfst ihn lesen, ändern, weitergeben und für dich oder innerhalb deiner Organisation ausführen, auch für kommerzielle Arbeit. Du darfst Breatic Dritten nicht als gehosteten oder verwalteten Dienst anbieten. Maßgeblich sind die vollständigen Lizenzbedingungen.

Name und Logo sind Marken von Orime, Inc. und nicht von dieser Lizenz erfasst; siehe [TRADEMARKS.md](TRADEMARKS.md). Die Lizenz schränkt die mit Breatic erstellten Inhalte nicht ein.

### Generierte Inhalte

Betreiber und Nutzer einer Instanz sind dafür verantwortlich, dass generierte Inhalte geltendes Recht einhalten — etwa Urheber-, Marken-, Datenschutz- und Persönlichkeitsrecht sowie Vorgaben zur Inhaltsmoderation. Sie müssen die Rechte an ihren Eingaben und deren weiterer Nutzung besitzen und Inhalte im jeweiligen Nutzungskontext moderieren. Orime, Inc. übernimmt keine Gewähr für Richtigkeit, Rechtmäßigkeit, Originalität oder Sicherheit generierter Inhalte.

Komponenten Dritter und ihre Hinweise sind in [THIRD-PARTY.md](THIRD-PARTY.md) dokumentiert.

[hosted-app]: https://breatic.ai/login?utm_source=github&utm_medium=referral&utm_campaign=repository_listing_202610&utm_content=readme_de
[hosted-pricing]: https://breatic.ai/pricing/?utm_source=github&utm_medium=referral&utm_campaign=repository_listing_202610&utm_content=readme_pricing_de

© 2026 Orime, Inc.
