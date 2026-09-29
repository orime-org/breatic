// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, it, expect, vi } from "vitest";

// Three, not the seven the repo ships — a hardcoded footer would pass a mock
// that agreed with the shipped value. Mutable so the one-day case (the only
// place the singular "day" is produced) can be exercised too.
const decisionWindow = vi.hoisted(() => ({ days: 3 }));
vi.mock("@server/config/limits.js", () => ({
  getDecisionWindowDays: () => decisionWindow.days,
}));

import {
  buildStudioInvitationMail,
  buildProjectInvitationMail,
  buildStudioTransferMail,
  buildProjectTransferMail,
  buildRoleUpgradeRequestMail,
} from "@server/utils/notification-mail.js";
import { loadLocales } from "@breatic/core";

loadLocales();

// One builder per flow, five flows. Subjects are plain text (email headers)
// so raw names are fine there; bodies are HTML so every user field is escaped,
// and every footer states the answering window it was given rather than a
// number of its own.

describe("buildStudioInvitationMail", () => {
  it("targets the invitee, names the studio + role, and escapes body fields", async () => {
    const mail = await buildStudioInvitationMail({
      locale: "en",
      inviteeEmail: "invitee@example.com",
      inviterName: "Alice <b>",
      studioName: "Team & Co",
      role: "maintainer",
      inviteLink: "https://app.test/decision?token=abc",
    });
    expect(mail.to).toBe("invitee@example.com");
    expect(mail.subject).toContain("Team & Co");
    expect(mail.subject).toContain("Alice");
    expect(mail.html).toContain("Alice &lt;b&gt;");
    expect(mail.html).toContain("Team &amp; Co");
    expect(mail.html).not.toContain("Alice <b>");
    expect(mail.html).toContain("join the studio");
    expect(mail.html).toMatch(/<code[^>]*>Maintainer<\/code>/);
    expect(mail.html).toContain("https://app.test/decision?token=abc");
    expect(mail.html).toContain("Open the invitation");
  });
});

describe("buildProjectInvitationMail", () => {
  it("targets the invitee, names the project + role, and escapes body fields", async () => {
    const mail = await buildProjectInvitationMail({
      locale: "en",
      inviteeEmail: "invitee@example.com",
      inviterName: "Bob <i>",
      projectName: "Launch & Grow",
      role: "editor",
      inviteLink: "https://app.test/decision?token=xyz",
    });
    expect(mail.to).toBe("invitee@example.com");
    expect(mail.subject).toContain("Launch & Grow");
    expect(mail.subject).toContain("Bob");
    expect(mail.html).toContain("Bob &lt;i&gt;");
    expect(mail.html).toContain("Launch &amp; Grow");
    expect(mail.html).not.toContain("Bob <i>");
    expect(mail.html).toContain("collaborate on the project");
    expect(mail.html).toMatch(/<code[^>]*>Editor<\/code>/);
    expect(mail.html).toContain("https://app.test/decision?token=xyz");
    expect(mail.html).toContain("Open the invitation");
  });
});

describe("buildStudioTransferMail", () => {
  it("targets the recipient, names the studio, escapes body fields, points at the app", async () => {
    const mail = await buildStudioTransferMail({
      locale: "en",
      recipientEmail: "new-admin@example.com",
      initiatorName: "Alice <b>",
      studioName: "Team & Co",
      decisionLink: "https://app.test/studio/team-co",
    });
    expect(mail.to).toBe("new-admin@example.com");
    expect(mail.subject).toContain("Team & Co");
    expect(mail.subject).toContain("Alice");
    expect(mail.html).toContain("Alice &lt;b&gt;");
    expect(mail.html).toContain("Team &amp; Co");
    expect(mail.html).not.toContain("Alice <b>");
    expect(mail.html).toMatch(/make you <code[^>]*>Admin<\/code> of the studio/);
    expect(mail.html).toContain("https://app.test/studio/team-co");
    expect(mail.html).toContain("Review this transfer");
    expect(mail.html.toLowerCase()).toContain("this transfer request expires in 3 days");
  });
});

describe("buildProjectTransferMail", () => {
  it("targets the recipient, names the project, escapes body fields, points at the app", async () => {
    const mail = await buildProjectTransferMail({
      locale: "en",
      recipientEmail: "new-owner@example.com",
      initiatorName: "Bob <i>",
      projectName: "Launch & Grow",
      decisionLink: "https://app.test/project/launch-grow-123",
    });
    expect(mail.to).toBe("new-owner@example.com");
    expect(mail.subject).toContain("Launch & Grow");
    expect(mail.subject).toContain("Bob");
    expect(mail.html).toContain("Bob &lt;i&gt;");
    expect(mail.html).toContain("Launch &amp; Grow");
    expect(mail.html).not.toContain("Bob <i>");
    expect(mail.html).toMatch(/make you <code[^>]*>Owner<\/code> of the project/);
    expect(mail.html).toContain("https://app.test/project/launch-grow-123");
    expect(mail.html).toContain("Review this transfer");
    expect(mail.html.toLowerCase()).toContain("this transfer request expires in 3 days");
  });
});

// The link href itself must be escaped too (a malicious token/link can't break
// out of the href attribute).
describe("notification mail — link href escaping", () => {
  it("escapes a quote-bearing link so it cannot break out of the href attribute", async () => {
    const mail = await buildStudioTransferMail({
      locale: "en",
      recipientEmail: "x@example.com",
      initiatorName: "X",
      studioName: "S",
      decisionLink: 'https://app.test/s"onmouseover="alert(1)',
    });
    expect(mail.html).toContain("&quot;onmouseover=&quot;");
    expect(mail.html).not.toContain('"onmouseover="');
  });
});

// ── One link shape for all five flows (task #25) ──────────────────────
//
// Every waiting-for-an-answer email now points at the same landing page, and
// the two transfer emails used to point at the entity itself — you landed on
// the studio and still had to go find the bell. The role-upgrade email is new
// entirely: that flow had no email at all.

describe("every decision email points at the shared landing page", () => {
  const TOKEN = "b".repeat(64);
  const LINK = `https://app.test/decision?token=${TOKEN}`;

  it("the studio transfer email links to the decision page, not the studio", async () => {
    const mail = await buildStudioTransferMail({
      locale: "en",
      recipientEmail: "heir@example.com",
      initiatorName: "Alice",
      studioName: "Team & Co",
      decisionLink: LINK,
    });
    expect(mail.html).toContain(LINK);
    // The old link was `/studio/{slug}`, which leaked the slug and could not
    // be answered from.
    expect(mail.html).not.toMatch(/\/studio\/[a-z]/i);
  });

  it("the project transfer email links to the decision page, not the project", async () => {
    const mail = await buildProjectTransferMail({
      locale: "en",
      recipientEmail: "heir@example.com",
      initiatorName: "Alice",
      projectName: "Rocket",
      decisionLink: LINK,
    });
    expect(mail.html).toContain(LINK);
    expect(mail.html).not.toMatch(/\/project\/[a-z]/i);
  });

  it("the role upgrade email exists, goes to the owner, and carries the reason", async () => {
    const mail = await buildRoleUpgradeRequestMail({
      locale: "en",
      ownerEmail: "owner@example.com",
      requesterName: "Bob <script>",
      projectName: "Rocket & Co",
      requestedRole: "editor",
      message: "I keep needing to fix typos",
      decisionLink: LINK,
    });
    expect(mail.to).toBe("owner@example.com");
    expect(mail.subject).toContain("Rocket & Co");
    expect(mail.html).toContain(LINK);
    expect(mail.html).toContain("I keep needing to fix typos");
    // Same escaping rule as every other body field.
    expect(mail.html).not.toContain("<script>");
  });

  it("a role upgrade with no reason given still renders", async () => {
    const mail = await buildRoleUpgradeRequestMail({
      locale: "en",
      ownerEmail: "owner@example.com",
      requesterName: "Bob",
      projectName: "Rocket",
      requestedRole: "editor",
      message: null,
      decisionLink: LINK,
    });
    expect(mail.html).toContain(LINK);
  });
});

describe("the expiry footer follows the yaml knob", () => {
  // `decision_window_days` is a knob, and every email that states the window
  // reads it. A hardcoded 7 here contradicted the landing card the moment ops
  // turned the knob — so the mock says three, and a builder carrying its own
  // number fails against it.
  it("all five builders say the configured window, not one of their own", async () => {
    const all = await Promise.all([
      buildStudioInvitationMail({
        locale: "en",
        inviteeEmail: "a@example.com", inviterName: "A", studioName: "S",
        role: "guest", inviteLink: "https://app.test/decision?token=t",
      }),
      buildProjectInvitationMail({
        locale: "en",
        inviteeEmail: "a@example.com", inviterName: "A", projectName: "P",
        role: "viewer", inviteLink: "https://app.test/decision?token=t",
      }),
      buildStudioTransferMail({
        locale: "en",
        recipientEmail: "a@example.com", initiatorName: "A", studioName: "S",
        decisionLink: "https://app.test/decision?token=t",
      }),
      buildProjectTransferMail({
        locale: "en",
        recipientEmail: "a@example.com", initiatorName: "A", projectName: "P",
        decisionLink: "https://app.test/decision?token=t",
      }),
      buildRoleUpgradeRequestMail({
        locale: "en",
        ownerEmail: "a@example.com", requesterName: "A", projectName: "P",
        requestedRole: "editor", message: null,
        decisionLink: "https://app.test/decision?token=t",
      }),
    ]);
    for (const mail of all) {
      expect(mail.html.toLowerCase()).toContain("expires in 3 days");
      expect(mail.html.toLowerCase()).not.toContain("7 days");
    }
  });

  it("a role upgrade is not called a transfer", async () => {
    const mail = await buildRoleUpgradeRequestMail({
      locale: "en",
      ownerEmail: "a@example.com", requesterName: "A", projectName: "P",
      requestedRole: "editor", message: null,
      decisionLink: "https://app.test/decision?token=t",
    });
    // The footer used to be shared with the two transfer mails, so the owner
    // of a project read "This transfer request expires..." about a role ask.
    expect(mail.html.toLowerCase()).not.toContain("transfer");
    expect(mail.html.toLowerCase()).toContain("request expires in 3 days");
  });
});
