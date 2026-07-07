// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect } from "vitest";

import { buildStudioTransferMail } from "@server/modules/studio/studio-transfer-mail.js";

describe("buildStudioTransferMail (#1612)", () => {
  it("targets the recipient, names the studio in the subject, and escapes user fields in the body", () => {
    const mail = buildStudioTransferMail({
      recipientEmail: "new-admin@example.com",
      initiatorName: "Alice <b>",
      studioName: "Team & Co",
      studioLink: "https://app.test/studio/team-co",
    });
    expect(mail.to).toBe("new-admin@example.com");
    // Subject is plain text (not HTML) — raw names are fine there.
    expect(mail.subject).toContain("Team & Co");
    expect(mail.subject).toContain("Alice");
    // Body is HTML — every user-supplied field is escaped (XSS-safe).
    expect(mail.html).toContain("Alice &lt;b&gt;");
    expect(mail.html).toContain("Team &amp; Co");
    expect(mail.html).not.toContain("Alice <b>");
    // The link to open the app + find the bell.
    expect(mail.html).toContain("https://app.test/studio/team-co");
    // Sets the accept/decline expectation (via the bell) + a 7-day expiry hint.
    expect(mail.html.toLowerCase()).toContain("7 days");
  });
});
