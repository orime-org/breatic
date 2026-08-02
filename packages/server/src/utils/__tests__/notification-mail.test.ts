// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

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
} from "@server/utils/notification-mail.js";

// These four builders replace the former per-module builders (studio-invite,
// project-invite, studio-transfer, project-transfer). This is a pure refactor:
// each builder's output (subject / lead / link / footer / escaping) must match
// the pre-refactor behavior verbatim. Subjects are plain text (email headers)
// so raw names are fine there; bodies are HTML so every user field is escaped.

describe("buildStudioInvitationMail", () => {
  it("targets the invitee, names the studio + role, and escapes body fields", () => {
    const mail = buildStudioInvitationMail({
      inviteeEmail: "invitee@example.com",
      inviterName: "Alice <b>",
      studioName: "Team & Co",
      role: "maintainer",
      inviteLink: "https://app.test/studio-invite?token=abc",
    });
    expect(mail.to).toBe("invitee@example.com");
    expect(mail.subject).toContain("Team & Co");
    expect(mail.subject).toContain("Alice");
    expect(mail.html).toContain("Alice &lt;b&gt;");
    expect(mail.html).toContain("Team &amp; Co");
    expect(mail.html).not.toContain("Alice <b>");
    expect(mail.html).toContain("join the studio");
    expect(mail.html).toContain("maintainer");
    expect(mail.html).toContain("https://app.test/studio-invite?token=abc");
    expect(mail.html).toContain("Open the invitation");
    expect(mail.html.toLowerCase()).toContain("accept or decline");
  });
});

describe("buildProjectInvitationMail", () => {
  it("targets the invitee, names the project + role, and escapes body fields", () => {
    const mail = buildProjectInvitationMail({
      inviteeEmail: "invitee@example.com",
      inviterName: "Bob <i>",
      projectName: "Launch & Grow",
      role: "editor",
      inviteLink: "https://app.test/project-invite?token=xyz",
    });
    expect(mail.to).toBe("invitee@example.com");
    expect(mail.subject).toContain("Launch & Grow");
    expect(mail.subject).toContain("Bob");
    expect(mail.html).toContain("Bob &lt;i&gt;");
    expect(mail.html).toContain("Launch &amp; Grow");
    expect(mail.html).not.toContain("Bob <i>");
    expect(mail.html).toContain("collaborate on the project");
    expect(mail.html).toContain("editor");
    expect(mail.html).toContain("https://app.test/project-invite?token=xyz");
    expect(mail.html).toContain("Open the invitation");
    expect(mail.html.toLowerCase()).toContain("accept or decline");
  });
});

describe("buildStudioTransferMail", () => {
  it("targets the recipient, names the studio, escapes body fields, points at the app", () => {
    const mail = buildStudioTransferMail({
      recipientEmail: "new-admin@example.com",
      initiatorName: "Alice <b>",
      studioName: "Team & Co",
      studioLink: "https://app.test/studio/team-co",
    });
    expect(mail.to).toBe("new-admin@example.com");
    expect(mail.subject).toContain("Team & Co");
    expect(mail.subject).toContain("Alice");
    expect(mail.html).toContain("Alice &lt;b&gt;");
    expect(mail.html).toContain("Team &amp; Co");
    expect(mail.html).not.toContain("Alice <b>");
    expect(mail.html).toContain("make you the admin of the studio");
    expect(mail.html).toContain("https://app.test/studio/team-co");
    expect(mail.html).toContain("Open Breatic");
    expect(mail.html.toLowerCase()).toContain("check your notifications");
  });
});

describe("buildProjectTransferMail", () => {
  it("targets the recipient, names the project, escapes body fields, points at the app", () => {
    const mail = buildProjectTransferMail({
      recipientEmail: "new-owner@example.com",
      initiatorName: "Bob <i>",
      projectName: "Launch & Grow",
      projectLink: "https://app.test/project/launch-grow-123",
    });
    expect(mail.to).toBe("new-owner@example.com");
    expect(mail.subject).toContain("Launch & Grow");
    expect(mail.subject).toContain("Bob");
    expect(mail.html).toContain("Bob &lt;i&gt;");
    expect(mail.html).toContain("Launch &amp; Grow");
    expect(mail.html).not.toContain("Bob <i>");
    expect(mail.html).toContain("make you the owner of the project");
    expect(mail.html).toContain("https://app.test/project/launch-grow-123");
    expect(mail.html).toContain("Open Breatic");
    expect(mail.html.toLowerCase()).toContain("check your notifications");
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
      studioLink: 'https://app.test/s"onmouseover="alert(1)',
    });
    expect(mail.html).toContain("&quot;onmouseover=&quot;");
    expect(mail.html).not.toContain('"onmouseover="');
  });
});

/**
 * The expiry sentence reads the configured window.
 *
 * This sentence is the only place the product tells an invitee how long they
 * have. It used to be a literal in a module constant, one file away from the
 * deadline it describes — so a change to the window left the email confidently
 * stating a number nothing enforced.
 */
describe("expiry footer", () => {
  it("states the configured window, not a baked-in number", () => {
    // The mock says three days; seven is what the repo ships. An email built
    // from a hardcoded literal would still say seven here.
    const mail = buildStudioInvitationMail({
      inviteeEmail: "invitee@example.com",
      inviterName: "Ada",
      studioName: "Studio",
      role: "guest",
      inviteLink: "https://example.test/studio-invite?token=t",
    });
    expect(mail.html).toContain("expires in 3 days");
  });

  it("says 'day' rather than 'days' when the window is a single day", () => {
    // The only branch in the footer. Without this, inverting the ternary
    // leaves every other assertion in this file green.
    decisionWindow.days = 1;
    try {
      const mail = buildStudioTransferMail({
        recipientEmail: "recipient@example.com",
        initiatorName: "Ada",
        studioName: "Studio",
        studioLink: "https://example.test/studio/s",
      });
      expect(mail.html).toContain("expires in 1 day.");
    } finally {
      decisionWindow.days = 3;
    }
  });

  it("says the same thing on all four emails", () => {
    // Four builders, one sentence each. They shared two constants before; if a
    // later edit re-splits them, this catches the pair that drifted.
    const htmls = [
      buildStudioInvitationMail({
        inviteeEmail: "a@example.test", inviterName: "Ada",
        studioName: "S", role: "guest", inviteLink: "https://example.test/a",
      }).html,
      buildProjectInvitationMail({
        inviteeEmail: "a@example.test", inviterName: "Ada",
        projectName: "P", role: "viewer", inviteLink: "https://example.test/b",
      }).html,
      buildStudioTransferMail({
        recipientEmail: "a@example.test", initiatorName: "Ada",
        studioName: "S", studioLink: "https://example.test/c",
      }).html,
      buildProjectTransferMail({
        recipientEmail: "a@example.test", initiatorName: "Ada",
        projectName: "P", projectLink: "https://example.test/d",
      }).html,
    ];
    for (const html of htmls) expect(html).toContain("expires in 3 days");
  });
});
