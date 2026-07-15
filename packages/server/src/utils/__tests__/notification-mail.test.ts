// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect } from "vitest";

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
    expect(mail.html.toLowerCase()).toContain("invitation expires in 7 days");
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
    expect(mail.html.toLowerCase()).toContain("transfer request expires in 7 days");
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
      studioLink: 'https://app.test/s"onmouseover="alert(1)',
    });
    expect(mail.html).toContain("&quot;onmouseover=&quot;");
    expect(mail.html).not.toContain('"onmouseover="');
  });
});
