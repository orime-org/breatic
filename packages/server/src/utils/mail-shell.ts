// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The branded layout every product email is assembled into, and how a
 * catalog message becomes a piece of it.
 *
 * Every sentence comes from `server.mail.*` in the locale catalogs and is
 * rendered in the recipient's language. Markup comes only from the catalog:
 * `<b>`, `<code>` and `<em>` are tags there, and every parameter is escaped
 * before it is inserted into the HTML part, so a name carrying `<b>` or `&`
 * shows as those characters. The slogan and the brand name are the only words
 * that stay English.
 *
 * The layout is written once in MJML and compiled to client-safe HTML the
 * first time a mail of its shape is sent; each mail then fills in its pieces.
 * Under the card sits the footer the marketing site also carries: a help line,
 * the social links, the about / terms / privacy pages in the recipient's
 * language, the automated-message notice and the copyright.
 */

import mjml2html from "mjml";
import { getMailLayout, runWithLocale, type SendMailOptions } from "@breatic/core";
import { t, tRich } from "@breatic/shared";

const BRAND = "Breatic";
const SLOGAN = "An AI operating system for content creators";
const COMPANY = "Orime, Inc.";
const LEGAL_PAGES = ["about", "terms", "privacy"] as const;

const FONT =
  "-apple-system,'Segoe UI','PingFang SC','Hiragino Sans','Microsoft YaHei','Apple SD Gothic Neo',Helvetica,Arial,sans-serif";
const INK = "#1e1e1e";
const MUTED = "#5f5f5f";
const PAGE = "#f0f0f0";

/**
 * Escape HTML-significant chars in user-supplied strings (XSS-safe email body).
 * @param s - The raw user-supplied string to escape.
 * @returns The string with `& < > " '` replaced by their HTML entities.
 */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** One catalog message and its placeholders. */
export interface MailMessage {
  /** A `server.mail.*` key. */
  key: string;
  /** Its placeholders; strings are escaped once in HTML, numbers pass through. */
  params?: Record<string, string | number>;
}

/** What one product email says; {@link renderMail} lays it out. */
export interface MailSpec {
  /** Recipient address. */
  to: string;
  /** The subject line, which is also the heading inside the mail. */
  subject: MailMessage;
  /**
   * The sentences of the body paragraph, in order, joined as written: a
   * language that separates sentences with a space carries it in the catalog.
   */
  body: MailMessage[];
  /** The button; absent on a notice with nothing to do. */
  action?: { label: MailMessage; href: string };
  /** The gray line under the button. */
  note: MailMessage;
}

/** The pieces of one mail, rendered in its recipient's language. */
interface RenderedPieces {
  subject: string;
  heading: string;
  bodyHtml: string;
  bodyText: string;
  actionLabelHtml: string;
  actionLabelText: string;
  noteHtml: string;
  noteText: string;
  helpHtml: string;
  helpText: string;
  legal: { word: string; url: string }[];
  notice: string;
}

/**
 * Render a catalog message as HTML in the current locale.
 * @param message - The key and its placeholders.
 * @returns The HTML fragment.
 */
function toHtml(message: MailMessage): string {
  const escaped = Object.fromEntries(
    Object.entries(message.params ?? {}).map(([name, value]) => [
      name,
      typeof value === "string" ? escapeHtml(value) : value,
    ]),
  );
  return tRich(message.key, escaped, {
    b: (chunks) => `<strong>${chunks.join("")}</strong>`,
    code: (chunks) =>
      `<code style="font-family:ui-monospace,Menlo,monospace;font-size:13px;background:${PAGE};border-radius:4px;padding:2px 6px;">${chunks.join("")}</code>`,
    em: (chunks) => `<em>${chunks.join("")}</em>`,
  });
}

/**
 * Render a catalog message as plain text in the current locale.
 * @param message - The key and its placeholders.
 * @returns The text, with the catalog's tags dropped and names as typed.
 */
function toText(message: MailMessage): string {
  /**
   * Keep a tag's content and drop the tag.
   * @param chunks - The tag's rendered content.
   * @returns The content as plain text.
   */
  const plain = (chunks: string[]): string => chunks.join("");
  return tRich(message.key, message.params ?? {}, { b: plain, code: plain, em: plain });
}

/**
 * Render a link in the footer's muted style.
 * @param label - The link's words, already HTML.
 * @param href - Where it goes.
 * @returns The anchor.
 */
function footerLink(label: string, href: string): string {
  return `<a href="${escapeHtml(href)}" style="color:${MUTED};text-decoration:underline;">${label}</a>`;
}

/**
 * Join footer links with a spaced middle dot.
 * @param links - The anchors, in order.
 * @returns One row of HTML.
 */
function dotted(links: string[]): string {
  return links.join(`<span style="padding:0 6px;">·</span>`);
}

/**
 * Render every piece of a mail in its recipient's language.
 * @param locale - The recipient's language; also picks the marketing site's pages.
 * @param spec - What the mail says.
 * @returns The rendered pieces.
 */
function renderPieces(locale: string, spec: MailSpec): RenderedPieces {
  const { siteUrl, siteRootLocale, contactEmail } = getMailLayout();
  const site = locale === siteRootLocale ? siteUrl : `${siteUrl}/${locale}`;
  const manualUrl = `${site}/tutorials/`;
  const heading = t(spec.subject.key, spec.subject.params);
  return {
    subject: `${BRAND} - ${heading}`,
    heading,
    bodyHtml: spec.body.map(toHtml).join(""),
    bodyText: spec.body.map(toText).join(""),
    actionLabelHtml: spec.action ? toHtml(spec.action.label) : "",
    actionLabelText: spec.action ? toText(spec.action.label) : "",
    noteHtml: toHtml(spec.note),
    noteText: toText(spec.note),
    helpHtml: tRich("server.mail.help", { email: escapeHtml(contactEmail) }, {
      manual: (chunks) => footerLink(chunks.join(""), manualUrl),
      contact: (chunks) => footerLink(chunks.join(""), `mailto:${contactEmail}`),
    }),
    helpText: tRich("server.mail.help", { email: contactEmail }, {
      manual: (chunks) => `${chunks.join("")} (${manualUrl})`,
      contact: (chunks) => chunks.join(""),
    }),
    legal: LEGAL_PAGES.map((page) => ({
      word: t(`server.mail.legal.${page}`),
      url: `${site}/${page}/`,
    })),
    notice: t("server.mail.footer"),
  };
}

/**
 * Write the MJML source of the layout, with `%%NAME%%` where each mail's
 * pieces go.
 * @param withAction - Whether the card carries a button.
 * @returns The MJML source.
 */
function layoutSource(withAction: boolean): string {
  const button = withAction
    ? `<mj-button href="%%ACTION_URL%%" align="center" padding="0 0 24px" inner-padding="11px 20px"
         background-color="${INK}" color="#ffffff" border-radius="8px" font-size="14px" font-weight="600" line-height="1">%%ACTION_LABEL%%</mj-button>`
    : "";
  const social = dotted(getMailLayout().social.map(({ label, url }) => footerLink(escapeHtml(label), url)));
  /**
   * One centred footer line.
   * @param content - The line's HTML or placeholder.
   * @param top - Space above it, in pixels.
   * @returns The MJML text element.
   */
  const footerRow = (content: string, top: number): string =>
    `<mj-text align="center" padding="${top}px 24px 0" font-size="12px" line-height="1.6" color="${MUTED}">${content}</mj-text>`;
  return `<mjml lang="%%LANG%%">
  <mj-head>
    <mj-attributes>
      <mj-all font-family="${FONT}" />
      <mj-text padding="0" color="${INK}" />
    </mj-attributes>
    <mj-style>body { min-height: 100vh; }</mj-style>
    <mj-preview>%%PREVIEW%%</mj-preview>
  </mj-head>
  <mj-body background-color="${PAGE}" width="600px">
    <mj-section padding="48px 0 24px">
      <mj-column>
        <mj-text padding="0 24px">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
            <td style="vertical-align:middle;width:28px;"><img src="${escapeHtml(getMailLayout().logoUrl)}" width="28" height="28" alt="${BRAND}" style="display:block;border-radius:6px;"></td>
            <td style="vertical-align:middle;padding-left:10px;font-size:17px;font-weight:600;line-height:1;color:${INK};white-space:nowrap;">${BRAND}</td>
            <td align="right" style="vertical-align:middle;padding-left:16px;font-size:13px;line-height:1.4;color:${MUTED};">${SLOGAN}</td>
          </tr></table>
        </mj-text>
      </mj-column>
    </mj-section>
    <mj-section background-color="#ffffff" border="1px solid rgba(30,30,30,0.12)" border-radius="12px" padding="36px 32px">
      <mj-column>
        <mj-text padding="0 0 16px" font-size="20px" font-weight="600" line-height="1.35">%%HEADING%%</mj-text>
        <mj-text padding="0 0 24px" font-size="15px" line-height="1.6">%%BODY%%</mj-text>
        ${button}
        <mj-text font-size="13px" line-height="1.6" color="${MUTED}">%%NOTE%%</mj-text>
      </mj-column>
    </mj-section>
    <mj-section padding="8px 0 56px">
      <mj-column>
        ${footerRow("%%HELP%%", 24)}
        ${footerRow(social, 12)}
        ${footerRow("%%LEGAL%%", 12)}
        ${footerRow("%%NOTICE%%", 16)}
        ${footerRow(`© %%YEAR%% ${COMPANY}`, 4)}
      </mj-column>
    </mj-section>
  </mj-body>
</mjml>`;
}

const compiled = new Map<boolean, Promise<string>>();

/**
 * Compile the layout once per shape (with or without a button).
 * @param withAction - Whether the card carries a button.
 * @returns The layout's HTML, with `%%NAME%%` placeholders left in it.
 * @throws {Error} When the MJML source does not validate.
 */
function layoutHtml(withAction: boolean): Promise<string> {
  let html = compiled.get(withAction);
  if (!html) {
    html = mjml2html(layoutSource(withAction), { validationLevel: "strict" }).then(
      (result) => result.html,
    );
    compiled.set(withAction, html);
  }
  return html;
}

/**
 * Put each mail's pieces into the layout's placeholders.
 * @param layout - The compiled layout.
 * @param values - HTML for each placeholder, already escaped.
 * @returns The finished HTML.
 * @throws {Error} When the layout names a placeholder no value was given for.
 */
function fillLayout(layout: string, values: Record<string, string>): string {
  return layout.replace(/%%([A-Z_]+)%%/g, (_, name: string) => {
    const value = values[name];
    if (value === undefined) throw new Error(`mail layout placeholder ${name} has no value`);
    return value;
  });
}

/**
 * Write the plain-text part: the same pieces, in the same order.
 * @param pieces - The rendered pieces.
 * @param href - The button's link, when there is one.
 * @param year - The copyright year.
 * @returns The text part.
 */
function plainText(pieces: RenderedPieces, href: string | undefined, year: number): string {
  const links = [...getMailLayout().social.map(({ label, url }) => ({ word: label, url })), ...pieces.legal]
    .map(({ word, url }) => `${word}: ${url}`)
    .join("\n");
  return [
    pieces.heading,
    pieces.bodyText,
    href === undefined ? null : `${pieces.actionLabelText}\n${href}`,
    pieces.noteText,
    `--\n${pieces.helpText}`,
    links,
    `${pieces.notice}\n© ${year} ${COMPANY}`,
  ]
    .filter((block): block is string => block !== null)
    .join("\n\n");
}

/**
 * Lay out one product email in its recipient's language.
 * @param locale - The recipient's language.
 * @param spec - What the mail says.
 * @returns `SendMailOptions` (to / subject / html / text) for `sendMail`.
 * @throws {Error} When the layout does not compile.
 */
export async function renderMail(locale: string, spec: MailSpec): Promise<SendMailOptions> {
  const pieces = runWithLocale(locale, () => renderPieces(locale, spec));
  const href = spec.action?.href;
  const year = new Date().getUTCFullYear();
  const layout = await layoutHtml(href !== undefined);
  return {
    to: spec.to,
    subject: pieces.subject,
    html: fillLayout(layout, {
      LANG: escapeHtml(locale),
      HEADING: escapeHtml(pieces.heading),
      PREVIEW: escapeHtml(pieces.bodyText),
      BODY: pieces.bodyHtml,
      ACTION_URL: escapeHtml(href ?? ""),
      ACTION_LABEL: pieces.actionLabelHtml,
      NOTE: pieces.noteHtml,
      HELP: pieces.helpHtml,
      LEGAL: dotted(pieces.legal.map(({ word, url }) => footerLink(escapeHtml(word), url))),
      NOTICE: escapeHtml(pieces.notice),
      YEAR: String(year),
    }),
    text: plainText(pieces, href, year),
  };
}
