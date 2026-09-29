// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Every product email renders in each of the five languages (#286).
 *
 * Two things are pinned. Every `server.mail.*` key in `en.json` exists in the
 * other four catalogs — `tRich` falls back to English for a missing key, so a
 * gap would ship an English line inside a translated mail without failing
 * anything else. And every builder renders in every language with hostile
 * names: markup can come only from the catalog, so a name carrying `<b>`,
 * `&`, `*`, `_` or a backtick shows as those characters, escaped once.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect, vi } from "vitest";

vi.mock("@server/config/limits.js", () => ({
  getDecisionWindowDays: () => 3,
}));

import { loadLocales, MONOREPO_ROOT, type SendMailOptions } from "@breatic/core";
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
import {
  buildPasswordResetMail,
  buildEmailVerificationMail,
} from "@server/modules/auth/auth-mail.js";

loadLocales();

const LOCALES = ["en", "zh-CN", "zh-TW", "ja", "ko"] as const;
const NAME = "A<b>&_*`x";
const ESCAPED = "A&lt;b&gt;&amp;_*`x";
const LINK = "https://app.test/decision?token=t";

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
function allMails(locale: string): Record<string, SendMailOptions> {
  return {
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
    passwordReset: buildPasswordResetMail({
      locale, to: "to@example.test", resetUrl: LINK, expiresInSeconds: 3600,
    }),
    emailVerification: buildEmailVerificationMail({
      locale, to: "to@example.test", verifyUrl: LINK, expiresInSeconds: 86400,
    }),
  };
}

describe("mail catalogs", () => {
  const english = leafKeys(mailCatalog("en"));

  it.each(LOCALES.filter((l) => l !== "en"))("%s has every server.mail key en has", (locale) => {
    expect(leafKeys(mailCatalog(locale))).toEqual(english);
  });
});

describe.each(LOCALES)("every mail in %s", (locale) => {
  const mails = allMails(locale);

  it.each(Object.keys(mails))("%s renders from the catalog with names escaped once", (kind) => {
    const mail = mails[kind]!;
    expect(mail.to).toBe("to@example.test");
    for (const text of [mail.subject, mail.html]) {
      expect(text).not.toContain("server.mail.");
      expect(text).not.toContain("&amp;amp;");
    }
    expect(mail.html).not.toContain("<b>&");
    expect(mail.html).not.toContain("A<b>");
    if (mail.html.includes("A&")) expect(mail.html).toContain(ESCAPED);
  });

  it("puts the links, bold names and roles where the catalog marks them", () => {
    expect(mails.studioInvite!.html).toContain(`<strong>${ESCAPED}</strong>`);
    expect(mails.studioInvite!.html).toContain("<code>Maintainer</code>");
    expect(mails.projectInvite!.html).toContain("<code>Editor</code>");
    expect(mails.roleUpgrade!.html).toContain(`<em>${ESCAPED}</em>`);
    expect(mails.roleUpgrade!.html).toContain("<strong>Editor</strong>");
    for (const kind of ["studioInvite", "projectTransfer", "passwordReset", "emailVerification"]) {
      expect(mails[kind]!.html).toContain(`<a href="${LINK}">`);
    }
  });
});

describe("the language actually changes", () => {
  it("renders each language's own words, not English", () => {
    const words: Record<string, string> = {
      "zh-CN": "邀请", "zh-TW": "邀請", ja: "招待", ko: "초대",
    };
    for (const [locale, word] of Object.entries(words)) {
      expect(allMails(locale).studioInvite!.html).toContain(word);
      expect(allMails(locale).studioInvite!.html).not.toContain("invited you");
    }
  });

  it("counts days and hours with the plural rules of the language", () => {
    const en = allMails("en");
    expect(en.studioInvite!.html).toContain("expires in 3 days");
    expect(en.passwordReset!.html).toContain("expires in 1 hour.");
    expect(en.emailVerification!.html).toContain("expires in 24 hours.");
    expect(allMails("zh-CN").projectJoin!.html).toContain("3 天");
  });

  it("leaves the reason out when none was given", () => {
    const mail = buildProjectJoinRequestMail({
      locale: "en", ownerEmail: "to@example.test", requesterName: "Bob",
      projectName: "Rocket", message: "   ", decisionLink: LINK,
    });
    expect(mail.html).not.toContain("They said");
  });
});
