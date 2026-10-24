// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadLocales, runWithLocale } from "@breatic/core";
import { t } from "@breatic/shared";
import {
  buildProjectSignupInvitationMail,
  buildStudioSignupInvitationMail,
} from "@server/utils/notification-mail.js";

const window = vi.hoisted(() => ({ days: 3 }));
vi.mock("@server/config/limits.js", () => ({
  getDecisionWindowDays: () => window.days,
}));

loadLocales();

const TOKEN = "b".repeat(64);
const LINK = `https://app.test/register?invite=${TOKEN}`;
const LOCALES = ["en", "zh-CN", "zh-TW", "ja", "ko"] as const;

beforeEach(() => {
  window.days = 3;
});

describe("signup invitation mail", () => {
  it.each(LOCALES)("renders the project invitation in the requested %s locale", async (locale) => {
    const mail = await buildProjectSignupInvitationMail({
      locale,
      inviteeEmail: "new@example.test",
      inviterName: "Alice",
      projectName: "Launch",
      role: "editor",
      inviteLink: LINK,
    });
    const subject = runWithLocale(locale, () => t("server.mail.project_signup_invite.subject", {
      inviter: "Alice", project: "Launch",
    }));
    const action = runWithLocale(locale, () => t("server.mail.project_signup_invite.action"));
    const expiry = runWithLocale(locale, () => t("server.mail.expiry.invitation", { days: 3 }));

    expect(mail.to).toBe("new@example.test");
    expect(mail.subject).toBe(`Breatic - ${subject}`);
    expect(mail.subject).not.toContain("server.mail.");
    expect(mail.text).toContain("Alice");
    expect(mail.text).toContain("Launch");
    expect(mail.text).toContain(action);
    expect(mail.text).toContain(expiry);
    expect(mail.html).toContain(LINK);
    expect(mail.html).toMatch(/<code[^>]*>Editor<\/code>/);
    expect(mail.html).not.toContain("server.mail.");
  });

  it.each(LOCALES)("renders the Studio invitation in the requested %s locale", async (locale) => {
    const mail = await buildStudioSignupInvitationMail({
      locale,
      inviteeEmail: "new@example.test",
      inviterName: "Alice",
      studioName: "Creative Team",
      role: "maintainer",
      inviteLink: LINK,
    });
    const subject = runWithLocale(locale, () => t("server.mail.studio_signup_invite.subject", {
      inviter: "Alice", studio: "Creative Team",
    }));
    const action = runWithLocale(locale, () => t("server.mail.studio_signup_invite.action"));
    const expiry = runWithLocale(locale, () => t("server.mail.expiry.invitation", { days: 3 }));

    expect(mail.to).toBe("new@example.test");
    expect(mail.subject).toBe(`Breatic - ${subject}`);
    expect(mail.subject).not.toContain("server.mail.");
    expect(mail.text).toContain("Alice");
    expect(mail.text).toContain("Creative Team");
    expect(mail.text).toContain(action);
    expect(mail.text).toContain(expiry);
    expect(mail.html).toContain(LINK);
    expect(mail.html).toMatch(/<code[^>]*>Maintainer<\/code>/);
    expect(mail.html).not.toContain("server.mail.");
  });

  it("escapes project names, inviter names and the registration link", async () => {
    const mail = await buildProjectSignupInvitationMail({
      locale: "en", inviteeEmail: "new@example.test", inviterName: "Alice <script>",
      projectName: "Launch & Grow", role: "viewer",
      inviteLink: 'https://app.test/register?invite=t"onmouseover="alert(1)',
    });

    expect(mail.subject).toContain("Alice <script>");
    expect(mail.subject).toContain("Launch & Grow");
    expect(mail.html).toContain("Alice &lt;script&gt;");
    expect(mail.html).toContain("Launch &amp; Grow");
    expect(mail.html).not.toContain("Alice <script>");
    expect(mail.html).toContain("&quot;onmouseover=&quot;");
    expect(mail.html).not.toContain('"onmouseover="');
    expect(mail.html).toMatch(/<code[^>]*>Viewer<\/code>/);
  });

  it("escapes Studio names and renders the guest role", async () => {
    const mail = await buildStudioSignupInvitationMail({
      locale: "en", inviteeEmail: "new@example.test", inviterName: "Alice <b>",
      studioName: "Team & Co", role: "guest", inviteLink: LINK,
    });

    expect(mail.html).toContain("Alice &lt;b&gt;");
    expect(mail.html).toContain("Team &amp; Co");
    expect(mail.html).not.toContain("Alice <b>");
    expect(mail.html).toMatch(/<code[^>]*>Guest<\/code>/);
  });

  it("reads the configured one-day answering window for both invitation kinds", async () => {
    window.days = 1;
    const mails = await Promise.all([
      buildProjectSignupInvitationMail({
        locale: "en", inviteeEmail: "new@example.test", inviterName: "Alice",
        projectName: "Launch", role: "viewer", inviteLink: LINK,
      }),
      buildStudioSignupInvitationMail({
        locale: "en", inviteeEmail: "new@example.test", inviterName: "Alice",
        studioName: "Team", role: "guest", inviteLink: LINK,
      }),
    ]);

    for (const mail of mails) {
      expect(mail.text).toContain("expires in 1 day");
      expect(mail.text).not.toContain("7 days");
    }
  });
});
