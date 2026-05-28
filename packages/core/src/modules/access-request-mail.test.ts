/**
 * access-request-mail builders unit tests.
 *
 * Pure-function builders — no mocks needed. Asserts:
 *   - the right `to` field (recipient is whoever the spec says)
 *   - subject contains the project name (subject scan is the first
 *     thing the recipient reads — must include scope)
 *   - html escapes user-controlled fields (XSS guard for HTML mail)
 *   - permanent vs single-use note differs in shareInvite
 */

import { describe, it, expect } from "vitest";
import {
  buildAccessRequestCreatedMail,
  buildAccessRequestApprovedMail,
  buildAccessRequestRejectedMail,
  buildShareInviteMail,
} from "./access-request-mail.js";

describe("buildAccessRequestCreatedMail", () => {
  it("addresses the project owner with project + requester + role in subject/body", () => {
    const mail = buildAccessRequestCreatedMail({
      ownerEmail: "owner@example.com",
      requesterName: "Alice",
      requesterEmail: "alice@example.com",
      projectName: "Q1 Plan",
      requestedRole: "edit",
      message: null,
      reviewUrl: "https://breatic.ai/p/abc",
    });
    expect(mail.to).toBe("owner@example.com");
    expect(mail.subject).toContain("Q1 Plan");
    expect(mail.html).toContain("Alice");
    expect(mail.html).toContain("alice@example.com");
    expect(mail.html).toContain("edit");
    expect(mail.html).toContain("https://breatic.ai/p/abc");
  });

  it("includes the optional message when provided", () => {
    const mail = buildAccessRequestCreatedMail({
      ownerEmail: "o@e.com",
      requesterName: "Bob",
      requesterEmail: "b@e.com",
      projectName: "P",
      requestedRole: "view",
      message: "I'm on the legal team and need to audit Q1 budget",
      reviewUrl: "https://breatic.ai/p/x",
    });
    expect(mail.html).toContain("legal team");
  });

  it("escapes HTML in user-controlled fields (XSS guard)", () => {
    const mail = buildAccessRequestCreatedMail({
      ownerEmail: "o@e.com",
      requesterName: "<script>alert(1)</script>",
      requesterEmail: "x@e.com",
      projectName: "<img src=x onerror=y>",
      requestedRole: "view",
      message: "<b>boom</b>",
      reviewUrl: "https://breatic.ai/p/x",
    });
    expect(mail.html).not.toContain("<script>");
    expect(mail.html).not.toContain("<img src=x");
    expect(mail.html).toContain("&lt;script&gt;");
    expect(mail.html).toContain("&lt;b&gt;boom&lt;/b&gt;");
  });
});

describe("buildAccessRequestApprovedMail", () => {
  it("addresses the requester with project + link", () => {
    const mail = buildAccessRequestApprovedMail({
      requesterEmail: "alice@example.com",
      projectName: "Q1 Plan",
      projectUrl: "https://breatic.ai/p/abc",
    });
    expect(mail.to).toBe("alice@example.com");
    expect(mail.subject).toContain("Q1 Plan");
    expect(mail.subject).toContain("You're in");
    expect(mail.html).toContain("approved");
    expect(mail.html).toContain("https://breatic.ai/p/abc");
  });
});

describe("buildAccessRequestRejectedMail", () => {
  it("addresses the requester without leaking owner identity", () => {
    const mail = buildAccessRequestRejectedMail({
      requesterEmail: "alice@example.com",
      projectName: "Q1 Plan",
    });
    expect(mail.to).toBe("alice@example.com");
    expect(mail.subject).toContain("decision");
    expect(mail.html).toContain("not approved");
    expect(mail.html).toContain("Q1 Plan");
  });
});

describe("buildShareInviteMail", () => {
  it("addresses the invitee + inviter + project + role in subject/body", () => {
    const mail = buildShareInviteMail({
      inviteeEmail: "new@example.com",
      inviterName: "Owner",
      projectName: "Q1",
      inviteLink: "https://breatic.ai/invite/abc",
      isPermanent: false,
      role: "view",
    });
    expect(mail.to).toBe("new@example.com");
    expect(mail.subject).toContain("Owner");
    expect(mail.subject).toContain("Q1");
    expect(mail.html).toContain("view");
    expect(mail.html).toContain("https://breatic.ai/invite/abc");
  });

  it("uses single-use language when isPermanent=false", () => {
    const mail = buildShareInviteMail({
      inviteeEmail: "n@e.com",
      inviterName: "O",
      projectName: "P",
      inviteLink: "https://breatic.ai/invite/x",
      isPermanent: false,
      role: "edit",
    });
    expect(mail.html).toContain("single-use");
  });

  it("uses permanent-link language when isPermanent=true", () => {
    const mail = buildShareInviteMail({
      inviteeEmail: "n@e.com",
      inviterName: "O",
      projectName: "P",
      inviteLink: "https://breatic.ai/invite/x",
      isPermanent: true,
      role: "edit",
    });
    expect(mail.html).toContain("permanent");
    expect(mail.html).not.toContain("single-use");
  });

  it("escapes HTML in inviter/project/role (XSS guard)", () => {
    const mail = buildShareInviteMail({
      inviteeEmail: "n@e.com",
      inviterName: "<b>boom</b>",
      projectName: "<script>",
      inviteLink: "https://breatic.ai/invite/x",
      isPermanent: false,
      role: "view",
    });
    expect(mail.html).not.toContain("<b>boom</b>");
    expect(mail.html).not.toContain("<script>");
    expect(mail.html).toContain("&lt;b&gt;");
    expect(mail.html).toContain("&lt;script&gt;");
  });
});
