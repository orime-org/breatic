// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Every product email renders in each of the five languages, in the branded
 * layout (#286).
 *
 * Three things are pinned. Every `server.mail.*` key in `en.json` exists in the
 * other four catalogs — `tRich` falls back to English for a missing key, so a
 * gap would ship an English line inside a translated mail without failing
 * anything else. And every builder renders in every language with hostile
 * names: markup can come only from the catalog, so a name carrying `<b>`,
 * `&`, `*`, `_` or a backtick shows as those characters, escaped once. And
 * every mail carries the same layout: the configured logo, the English
 * slogan, a heading, a button only when there is something to do, and the
 * footer — each in the recipient's language except the slogan, the product's
 * own names and the social links —
 * with a plain-text part saying the same thing.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeAll, describe, it, expect, vi } from "vitest";

vi.mock("@server/config/limits.js", () => ({
  getDecisionWindowDays: () => 3,
}));

import { getMailLayout, loadLocales, MONOREPO_ROOT } from "@breatic/core";
import {
  buildStudioInvitationMail,
  buildProjectInvitationMail,
  buildStudioTransferMail,
  buildProjectTransferMail,
  buildRoleUpgradeRequestMail,
  buildProjectJoinRequestMail,
  buildMembershipEndedMail,
  buildStorageQuotaExceededMail,
} from "@server/utils/notification-mail.js";
import { escapeHtml, type RenderedMail } from "@server/utils/mail-shell.js";
import { buildSignupCodeMail, buildTokenLinkMail } from "@server/modules/auth/auth-mail.js";

loadLocales();

const LOCALES = ["en", "zh-CN", "zh-TW", "ja", "ko"] as const;
const SIGNUP_CODE = "048213";
const NAME = "A<b>&_*`x";
const ESCAPED = "A&lt;b&gt;&amp;_*`x";
const LINK = "https://app.test/decision?token=t";
const SLOGAN = "An AI operating system for content creators";
const WITH_ACTION = [
  "studioInvite", "projectInvite", "studioTransfer", "projectTransfer",
  "roleUpgrade", "projectJoin", "passwordReset",
];

/**
 * Reads the `server.mail` subtree of one catalog.
 * @param locale - The catalog's locale code.
 * @returns The subtree.
 */
function mailCatalog(locale: string): Record<string, unknown> {
  const raw = readFileSync(resolve(MONOREPO_ROOT, `locales/${locale}.json`), "utf-8");
  const parsed = JSON.parse(raw) as { server: { mail: Record<string, unknown> } };
  return parsed.server.mail;
}

/**
 * Reads one `server.mail` entry of one catalog.
 * @param locale - The catalog's locale code.
 * @param key - The entry's key under `server.mail`.
 * @returns The raw catalog value.
 */
function catalogValue(locale: string, key: string): unknown {
  return mailCatalog(locale)[key];
}

/**
 * Lists the dotted leaf keys of a nested object.
 * @param node - The object to walk.
 * @param prefix - The path so far.
 * @returns Every leaf key, sorted.
 */
function leafKeys(node: Record<string, unknown>, prefix = ""): string[] {
  return Object.entries(node)
    .flatMap(([key, value]) =>
      typeof value === "object" && value !== null
        ? leafKeys(value as Record<string, unknown>, `${prefix}${key}.`)
        : [`${prefix}${key}`],
    )
    .sort();
}

/**
 * Builds all ten mails in one language, with hostile names everywhere a name goes.
 * @param locale - The recipient's language.
 * @returns Each mail by kind.
 */
async function allMails(locale: string): Promise<Record<string, RenderedMail>> {
  const mails = {
    studioInvite: buildStudioInvitationMail({
      locale, inviteeEmail: "to@example.test", inviterName: NAME, studioName: NAME,
      role: "maintainer", inviteLink: LINK,
    }),
    projectInvite: buildProjectInvitationMail({
      locale, inviteeEmail: "to@example.test", inviterName: NAME, projectName: NAME,
      role: "editor", inviteLink: LINK,
    }),
    studioTransfer: buildStudioTransferMail({
      locale, recipientEmail: "to@example.test", initiatorName: NAME, studioName: NAME,
      decisionLink: LINK,
    }),
    projectTransfer: buildProjectTransferMail({
      locale, recipientEmail: "to@example.test", initiatorName: NAME, projectName: NAME,
      decisionLink: LINK,
    }),
    roleUpgrade: buildRoleUpgradeRequestMail({
      locale, ownerEmail: "to@example.test", requesterName: NAME, projectName: NAME,
      requestedRole: "editor", message: NAME, decisionLink: LINK,
    }),
    projectJoin: buildProjectJoinRequestMail({
      locale, ownerEmail: "to@example.test", requesterName: NAME, projectName: NAME,
      message: NAME, decisionLink: LINK,
    }),
    membershipEnded: buildMembershipEndedMail({
      locale, recipientEmail: "to@example.test", tierLabel: "PRO",
    }),
    storageFull: buildStorageQuotaExceededMail({
      locale, recipientEmail: "to@example.test", studioName: NAME,
    }),
    passwordReset: buildTokenLinkMail("password_reset", {
      locale, to: "to@example.test", url: LINK, expiresInSeconds: 3600,
    }),
    signupCode: buildSignupCodeMail({
      locale, to: "to@example.test", code: SIGNUP_CODE, expiresInSeconds: 600,
    }),
  };
  const built = await Promise.all(Object.values(mails));
  return Object.fromEntries(Object.keys(mails).map((kind, i) => [kind, built[i]!]));
}

const KINDS = [...WITH_ACTION, "membershipEnded", "storageFull", "signupCode"];

describe("mail catalogs", () => {
  const english = leafKeys(mailCatalog("en"));

  it.each(LOCALES.filter((l) => l !== "en"))("%s has every server.mail key en has", (locale) => {
    expect(leafKeys(mailCatalog(locale))).toEqual(english);
  });
});

describe.each(LOCALES)("every mail in %s", (locale) => {
  let mails: Record<string, RenderedMail> = {};
  beforeAll(async () => {
    mails = await allMails(locale);
  });

  it.each(KINDS)("%s renders from the catalog with names escaped once", (kind) => {
    const mail = mails[kind]!;
    expect(mail.to).toBe("to@example.test");
    for (const text of [mail.subject, mail.html, mail.text]) {
      expect(text).not.toContain("server.mail.");
      expect(text).not.toContain("&amp;amp;");
    }
    expect(mail.html).not.toContain("<b>&");
    expect(mail.html).not.toContain("A<b>");
    if (mail.html.includes("A&")) expect(mail.html).toContain(ESCAPED);
  });

  it("shows the sign-up code in both the HTML and the text part", () => {
    const mail = mails.signupCode!;
    expect(mail.html).toContain(`>${SIGNUP_CODE}</div>`);
    expect(mail.text.split("\n")).toContain(SIGNUP_CODE);
  });

  it("puts the links, bold names and roles where the catalog marks them", () => {
    expect(mails.studioInvite!.html).toContain(`<strong>${ESCAPED}</strong>`);
    expect(mails.studioInvite!.html).toMatch(/<code[^>]*>Maintainer<\/code>/);
    expect(mails.projectInvite!.html).toMatch(/<code[^>]*>Editor<\/code>/);
    expect(mails.roleUpgrade!.html).toContain(`<em>${ESCAPED}</em>`);
    expect(mails.roleUpgrade!.html).toMatch(/<code[^>]*>Editor<\/code>/);
    expect(mails.studioTransfer!.html).toMatch(/<code[^>]*>Admin<\/code>/);
  });

  it.each(KINDS)("%s is laid out with the logo, slogan, heading and footer", (kind) => {
    const { html } = mails[kind]!;
    expect(html).toContain(`<html lang="${locale}"`);
    expect(html).toContain(`src="${getMailLayout().logoUrl}"`);
    expect(html).toContain(SLOGAN);
    expect(html).toContain(String(catalogValue(locale, "footer")));
    expect(html).not.toContain("%%");
  });

  it.each(KINDS)("%s is headed by its subject line, escaped", (kind) => {
    const mail = mails[kind]!;
    const heading = mail.subject.replace(/^Breatic - /, "");
    expect(mail.html).toContain(`>${escapeHtml(heading)}</`);
    expect(mail.text.split("\n")[0]).toBe(heading);
  });

  it.each(KINDS)("%s has a button exactly when there is something to do", (kind) => {
    const buttons = mails[kind]!.html.split(`href="${LINK}"`).length - 1;
    expect(buttons).toBe(WITH_ACTION.includes(kind) ? 1 : 0);
  });

  it.each(WITH_ACTION)("%s centres its button", (kind) => {
    const html = mails[kind]!.html;
    const button = html.indexOf(`href="${LINK}"`);
    const cell = html.lastIndexOf("<td", html.lastIndexOf("<table", button));
    expect(html.slice(cell, html.indexOf(">", cell))).toContain('align="center"');
  });

  it.each(KINDS)("%s ends with the help, social, legal and copyright rows", (kind) => {
    const { html, text } = mails[kind]!;
    const layout = getMailLayout();
    // The marketing site serves English at its root and every other language
    // under /<locale>/ (checked against https://breatic.ai, 2026-09-29).
    const site = locale === "en" ? layout.siteUrl : `${layout.siteUrl}/${locale}`;
    const legal = catalogValue(locale, "legal") as Record<string, string>;
    const year = new Date().getUTCFullYear();
    for (const [page, word] of [["about", legal.about], ["terms", legal.terms], ["privacy", legal.privacy]]) {
      expect(html).toContain(`href="${site}/${page}/"`);
      expect(html).toContain(`>${word}</a>`);
      expect(text).toContain(`${site}/${page}/`);
    }
    expect(html).toContain(`href="${site}/tutorials/"`);
    expect(html).toContain(`href="mailto:${layout.contactEmail}"`);
    expect(text).toContain(`${site}/tutorials/`);
    expect(text).toContain(layout.contactEmail);
    for (const { label, url } of layout.social) {
      expect(html).toContain(`href="${url}"`);
      expect(html).toContain(`>${label}</a>`);
      expect(text).toContain(url);
    }
    expect(html).toContain(`© ${year} Orime, Inc.`);
    expect(text).toContain(`© ${year} Orime, Inc.`);
  });

  // WCAG 2.2 SC 2.5.8: the social and legal rows are lists of links, so a link
  // wrapped onto the next line must sit 24px from the one above it, and no
  // link may split across two lines.
  it.each(KINDS)("%s wraps footer links whole, on 24px lines", (kind) => {
    const { html } = mails[kind]!;
    const footer = html.slice(html.indexOf(`href="mailto:${getMailLayout().contactEmail}"`));
    const anchors = [...footer.matchAll(/<a href="[^"]*" style="([^"]*)">/g)].map((m) => m[1]!);
    expect(anchors.length).toBeGreaterThanOrEqual(getMailLayout().social.length + 3);
    for (const style of anchors) expect(style).toContain("white-space:nowrap");
    const rows = [...footer.matchAll(/<div\s+style="([^"]*)"\s*><a /g)].map((m) => m[1]!.replace(/\s/g, ""));
    expect(rows).toHaveLength(2);
    for (const style of rows) expect(style).toContain("line-height:24px");
  });

  // Korean separates words with spaces and keeps each word whole across a
  // line end; Chinese and Japanese break between any two characters.
  it.each(KINDS)("%s keeps words whole exactly when the language spaces them", (kind) => {
    const styles = [...mails[kind]!.html.matchAll(/<div\s+style="([^"]*)"/g)]
      .map((m) => m[1]!.replace(/\s/g, ""))
      .filter((style) => /font-size:(12|13|15|20)px;/.test(style));
    expect(styles.length).toBeGreaterThanOrEqual(8);
    for (const style of styles) {
      if (locale === "ko") {
        expect(style).toContain("word-break:keep-all");
        expect(style).toContain("overflow-wrap:break-word");
      } else {
        expect(style).not.toContain("keep-all");
      }
    }
  });

  it.each(KINDS)("%s fills at least one screen with the page colour", (kind) => {
    expect(mails[kind]!.html).toMatch(/min-height:\s*100vh/);
  });

  it.each(KINDS)("%s has a plain-text part saying the same thing", (kind) => {
    const text = mails[kind]!.text;
    expect(text).not.toMatch(/<\/?(strong|code|em|a|p|table)\b/);
    expect(text).toContain(String(catalogValue(locale, "footer")));
    if (WITH_ACTION.includes(kind)) expect(text).toContain(LINK);
    expect(text).not.toMatch(/&(lt|gt|amp|quot|#39);/);
  });

  it("puts the names in the plain-text part as typed", () => {
    expect(mails.storageFull!.text).toContain(NAME);
  });

  it.each(KINDS)("%s previews its first sentence in the inbox list, ahead of the header", (kind) => {
    const { html, text } = mails[kind]!;
    const preview = /<div style="display:none;[^"]*">([^<]*)<\/div>/.exec(html);
    expect(preview?.index).toBeLessThan(html.indexOf(SLOGAN));
    expect(preview?.[1]).not.toBe("");
    // The body block of the text part opens with the first sentence.
    expect(escapeHtml(text.split("\n\n")[1]!).startsWith(preview![1]!)).toBe(true);
  });

  // Aliyun DirectMail refuses a message whose link text is the bare address
  // ("554 Reject by content spam"), measured against the verification mail.
  it.each(KINDS)("%s labels its link with words, never the address", (kind) => {
    expect(mails[kind]!.html).not.toContain(`>${LINK}</a>`);
  });
});

describe("the inbox preview is the first sentence alone", () => {
  it.each(LOCALES)("%s keeps a requester's message out of the preview", async (locale) => {
    const mail = await buildRoleUpgradeRequestMail({
      locale, ownerEmail: "to@example.test", requesterName: "Bob", projectName: "Rocket",
      requestedRole: "editor", message: "PREVIEW-PROBE", decisionLink: LINK,
    });
    const beforeHeader = mail.html.slice(0, mail.html.indexOf(SLOGAN));
    expect(beforeHeader).not.toContain("PREVIEW-PROBE");
    expect(mail.text).toContain("PREVIEW-PROBE");
  });
});

describe("sentences are joined the way each language writes them", () => {
  const joined = async (locale: string): Promise<string> => {
    const mail = await buildProjectJoinRequestMail({
      locale, ownerEmail: "to@example.test", requesterName: "Bob",
      projectName: "Rocket", message: "Please", decisionLink: LINK,
    });
    return mail.text.split("\n\n")[1]!;
  };

  it.each(["zh-CN", "zh-TW", "ja"])("%s puts no space after the full stop", async (locale) => {
    expect(await joined(locale)).not.toMatch(/。\s/);
  });

  it.each(["en", "ko"])("%s puts one space between the sentences", async (locale) => {
    expect(await joined(locale)).toMatch(/\. \S/);
  });
});

describe("the language actually changes", () => {
  it("renders each language's own words, not English", async () => {
    const words: Record<string, string> = {
      "zh-CN": "邀请", "zh-TW": "邀請", ja: "招待", ko: "초대",
    };
    for (const [locale, word] of Object.entries(words)) {
      const { studioInvite } = await allMails(locale);
      expect(studioInvite!.html).toContain(word);
      expect(studioInvite!.html).not.toContain("invited you");
    }
  });

  it("counts days and hours with the plural rules of the language", async () => {
    const en = await allMails("en");
    expect(en.studioInvite!.html).toContain("expires in 3 days");
    expect(en.passwordReset!.html).toContain("expires in 1 hour.");
    expect(en.signupCode!.html).toContain("expires in 10 minutes.");
    expect((await allMails("zh-CN")).projectJoin!.html).toContain("3 天");
  });

  it("leaves the reason out when none was given", async () => {
    const mail = await buildProjectJoinRequestMail({
      locale: "en", ownerEmail: "to@example.test", requesterName: "Bob",
      projectName: "Rocket", message: "   ", decisionLink: LINK,
    });
    expect(mail.html).not.toContain("They said");
    expect(mail.text).not.toContain("They said");
  });
});
