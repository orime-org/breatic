// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * share-invite-mail builder unit tests.
 *
 * Pure-function builder — no mocks needed. Asserts:
 *   - the right `to` field (the invitee)
 *   - subject contains inviter + project name (subject scan is the
 *     first thing the recipient reads — must include scope)
 *   - html escapes user-controlled fields (XSS guard for HTML mail)
 *   - single-use + 7-day language is always present (post-2026-05-28
 *     spec: email-invite is always single-use)
 */

import { describe, it, expect } from "vitest";
import { buildShareInviteMail } from "./share-invite-mail.js";

describe("buildShareInviteMail", () => {
  it("addresses the invitee + inviter + project + role in subject/body", () => {
    const mail = buildShareInviteMail({
      inviteeEmail: "new@example.com",
      inviterName: "Owner",
      projectName: "Q1",
      inviteLink: "https://breatic.ai/invite/abc",
      role: "view",
    });
    expect(mail.to).toBe("new@example.com");
    expect(mail.subject).toContain("Owner");
    expect(mail.subject).toContain("Q1");
    expect(mail.html).toContain("view");
    expect(mail.html).toContain("https://breatic.ai/invite/abc");
  });

  it("always uses single-use + 7-day language (email-invite is always single-use post-2026-05-28 spec)", () => {
    const mail = buildShareInviteMail({
      inviteeEmail: "n@e.com",
      inviterName: "O",
      projectName: "P",
      inviteLink: "https://breatic.ai/invite/x",
      role: "edit",
    });
    expect(mail.html).toContain("single-use");
    expect(mail.html).toContain("7 days");
  });

  it("escapes HTML in inviter/project/role (XSS guard)", () => {
    const mail = buildShareInviteMail({
      inviteeEmail: "n@e.com",
      inviterName: "<b>boom</b>",
      projectName: "<script>",
      inviteLink: "https://breatic.ai/invite/x",
      role: "view",
    });
    expect(mail.html).not.toContain("<b>boom</b>");
    expect(mail.html).not.toContain("<script>");
    expect(mail.html).toContain("&lt;b&gt;");
    expect(mail.html).toContain("&lt;script&gt;");
  });
});
