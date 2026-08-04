// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect } from "vitest";

import {
  buildStudioInvitationMail,
  buildProjectInvitationMail,
  buildStudioTransferMail,
  buildProjectTransferMail,
  buildRoleUpgradeRequestMail,
} from "@server/utils/notification-mail.js";

// One builder per flow, five flows. Subjects are plain text (email headers)
// so raw names are fine there; bodies are HTML so every user field is escaped,
// and every footer states the answering window it was given rather than a
// number of its own.

describe("buildStudioInvitationMail", () => {
  it("targets the invitee, names the studio + role, and escapes body fields", () => {
    const mail = buildStudioInvitationMail({
      inviteeEmail: "invitee@example.com",
      inviterName: "Alice <b>",
      studioName: "Team & Co",
      role: "maintainer",
      inviteLink: "https://app.test/decision?token=abc",
      windowDays: 7,
    });
    expect(mail.to).toBe("invitee@example.com");
    expect(mail.subject).toContain("Team & Co");
    expect(mail.subject).toContain("Alice");
    expect(mail.html).toContain("Alice &lt;b&gt;");
    expect(mail.html).toContain("Team &amp; Co");
    expect(mail.html).not.toContain("Alice <b>");
    expect(mail.html).toContain("join the studio");
    expect(mail.html).toContain("maintainer");
    expect(mail.html).toContain("https://app.test/decision?token=abc");
    expect(mail.html).toContain("Open the invitation");
    expect(mail.html.toLowerCase()).toContain("accept or decline");
    expect(mail.html.toLowerCase()).toContain("invitation expires in 7 days");
  });
});

describe("buildProjectInvitationMail", () => {
  it("targets the invitee, names the project + role, and escapes body fields", () => {
    const mail = buildProjectInvitationMail({
      inviteeEmail: "invitee@example.com",
      inviterName: "Bob <i>",
      projectName: "Launch & Grow",
      role: "editor",
      inviteLink: "https://app.test/decision?token=xyz",
      windowDays: 7,
    });
    expect(mail.to).toBe("invitee@example.com");
    expect(mail.subject).toContain("Launch & Grow");
    expect(mail.subject).toContain("Bob");
    expect(mail.html).toContain("Bob &lt;i&gt;");
    expect(mail.html).toContain("Launch &amp; Grow");
    expect(mail.html).not.toContain("Bob <i>");
    expect(mail.html).toContain("collaborate on the project");
    expect(mail.html).toContain("editor");
    expect(mail.html).toContain("https://app.test/decision?token=xyz");
    expect(mail.html).toContain("Open the invitation");
    expect(mail.html.toLowerCase()).toContain("accept or decline");
    expect(mail.html.toLowerCase()).toContain("invitation expires in 7 days");
  });
});

describe("buildStudioTransferMail", () => {
  it("targets the recipient, names the studio, escapes body fields, points at the app", () => {
    const mail = buildStudioTransferMail({
      recipientEmail: "new-admin@example.com",
      initiatorName: "Alice <b>",
      studioName: "Team & Co",
      decisionLink: "https://app.test/studio/team-co",
      windowDays: 7,
    });
    expect(mail.to).toBe("new-admin@example.com");
    expect(mail.subject).toContain("Team & Co");
    expect(mail.subject).toContain("Alice");
    expect(mail.html).toContain("Alice &lt;b&gt;");
    expect(mail.html).toContain("Team &amp; Co");
    expect(mail.html).not.toContain("Alice <b>");
    expect(mail.html).toContain("make you the admin of the studio");
    expect(mail.html).toContain("https://app.test/studio/team-co");
    expect(mail.html).toContain("Review this transfer");
    expect(mail.html.toLowerCase()).toContain("to accept or decline");
    expect(mail.html.toLowerCase()).toContain("transfer request expires in 7 days");
  });
});

describe("buildProjectTransferMail", () => {
  it("targets the recipient, names the project, escapes body fields, points at the app", () => {
    const mail = buildProjectTransferMail({
      recipientEmail: "new-owner@example.com",
      initiatorName: "Bob <i>",
      projectName: "Launch & Grow",
      decisionLink: "https://app.test/project/launch-grow-123",
      windowDays: 7,
    });
    expect(mail.to).toBe("new-owner@example.com");
    expect(mail.subject).toContain("Launch & Grow");
    expect(mail.subject).toContain("Bob");
    expect(mail.html).toContain("Bob &lt;i&gt;");
    expect(mail.html).toContain("Launch &amp; Grow");
    expect(mail.html).not.toContain("Bob <i>");
    expect(mail.html).toContain("make you the owner of the project");
    expect(mail.html).toContain("https://app.test/project/launch-grow-123");
    expect(mail.html).toContain("Review this transfer");
    expect(mail.html.toLowerCase()).toContain("to accept or decline");
    expect(mail.html.toLowerCase()).toContain("transfer request expires in 7 days");
  });
});

// The link href itself must be escaped too (a malicious token/link can't break
// out of the href attribute).
describe("notification mail — link href escaping", () => {
  it("escapes a quote-bearing link so it cannot break out of the href attribute", () => {
    const mail = buildStudioTransferMail({
      recipientEmail: "x@example.com",
      initiatorName: "X",
      studioName: "S",
      decisionLink: 'https://app.test/s"onmouseover="alert(1)',
      windowDays: 7,
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

  it("the studio transfer email links to the decision page, not the studio", () => {
    const mail = buildStudioTransferMail({
      recipientEmail: "heir@example.com",
      initiatorName: "Alice",
      studioName: "Team & Co",
      decisionLink: LINK,
      windowDays: 7,
    });
    expect(mail.html).toContain(LINK);
    // The old link was `/studio/{slug}`, which leaked the slug and could not
    // be answered from.
    expect(mail.html).not.toMatch(/\/studio\/[a-z]/i);
  });

  it("the project transfer email links to the decision page, not the project", () => {
    const mail = buildProjectTransferMail({
      recipientEmail: "heir@example.com",
      initiatorName: "Alice",
      projectName: "Rocket",
      decisionLink: LINK,
      windowDays: 7,
    });
    expect(mail.html).toContain(LINK);
    expect(mail.html).not.toMatch(/\/project\/[a-z]/i);
  });

  it("the role upgrade email exists, goes to the owner, and carries the reason", () => {
    const mail = buildRoleUpgradeRequestMail({
      ownerEmail: "owner@example.com",
      requesterName: "Bob <script>",
      projectName: "Rocket & Co",
      requestedRole: "editor",
      message: "I keep needing to fix typos",
      decisionLink: LINK,
      windowDays: 7,
    });
    expect(mail.to).toBe("owner@example.com");
    expect(mail.subject).toContain("Rocket & Co");
    expect(mail.html).toContain(LINK);
    expect(mail.html).toContain("I keep needing to fix typos");
    // Same escaping rule as every other body field.
    expect(mail.html).not.toContain("<script>");
  });

  it("a role upgrade with no reason given still renders", () => {
    const mail = buildRoleUpgradeRequestMail({
      ownerEmail: "owner@example.com",
      requesterName: "Bob",
      projectName: "Rocket",
      requestedRole: "editor",
      message: null,
      decisionLink: LINK,
      windowDays: 7,
    });
    expect(mail.html).toContain(LINK);
  });
});

describe("the expiry footer follows the yaml knob", () => {
  // `deferred_request_ttl_days` is a knob; every email that states the window
  // takes it from the caller. A hardcoded 7 here contradicted the landing
  // card the moment ops turned the knob.
  it("all five builders say the window they were given", () => {
    const nine = [
      buildStudioInvitationMail({
        inviteeEmail: "a@example.com", inviterName: "A", studioName: "S",
        role: "guest", inviteLink: "https://app.test/decision?token=t",
        windowDays: 9,
      }),
      buildProjectInvitationMail({
        inviteeEmail: "a@example.com", inviterName: "A", projectName: "P",
        role: "viewer", inviteLink: "https://app.test/decision?token=t",
        windowDays: 9,
      }),
      buildStudioTransferMail({
        recipientEmail: "a@example.com", initiatorName: "A", studioName: "S",
        decisionLink: "https://app.test/decision?token=t", windowDays: 9,
      }),
      buildProjectTransferMail({
        recipientEmail: "a@example.com", initiatorName: "A", projectName: "P",
        decisionLink: "https://app.test/decision?token=t", windowDays: 9,
      }),
      buildRoleUpgradeRequestMail({
        ownerEmail: "a@example.com", requesterName: "A", projectName: "P",
        requestedRole: "editor", message: null,
        decisionLink: "https://app.test/decision?token=t", windowDays: 9,
      }),
    ];
    for (const mail of nine) {
      expect(mail.html.toLowerCase()).toContain("expires in 9 days");
      expect(mail.html.toLowerCase()).not.toContain("7 days");
    }
  });

  it("a role upgrade is not called a transfer", () => {
    const mail = buildRoleUpgradeRequestMail({
      ownerEmail: "a@example.com", requesterName: "A", projectName: "P",
      requestedRole: "editor", message: null,
      decisionLink: "https://app.test/decision?token=t", windowDays: 7,
    });
    // The footer used to be shared with the two transfer mails, so the owner
    // of a project read "This transfer request expires..." about a role ask.
    expect(mail.html.toLowerCase()).not.toContain("transfer");
    expect(mail.html.toLowerCase()).toContain("request expires in 7 days");
  });
});
