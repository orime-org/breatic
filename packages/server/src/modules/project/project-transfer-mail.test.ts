// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect } from "vitest";

import { buildProjectTransferMail } from "@server/modules/project/project-transfer-mail.js";

describe("buildProjectTransferMail (#1611)", () => {
  it("targets the recipient, names the project in the subject, and escapes user fields in the body", () => {
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
    expect(mail.html).toContain("https://app.test/project/launch-grow-123");
    expect(mail.html.toLowerCase()).toContain("7 days");
  });
});
