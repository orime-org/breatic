// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, it, expect } from "vitest";

import { describeMailResult } from "@core/infra/mailer.js";

describe("describeMailResult", () => {
  it("leaves a sent mail to the caller's own line", () => {
    expect(describeMailResult({ status: "sent" })).toBeNull();
  });

  it("stays silent when the backend is disabled", () => {
    expect(describeMailResult({ status: "skipped", reason: "backend_disabled" })).toBeNull();
  });

  it("dumps the whole mail at info on the console backend", () => {
    expect(
      describeMailResult({ status: "backend_console", to: "a@example.test", subject: "S", html: "<p>h</p>" }),
    ).toEqual({ level: "info", msg: "[console] email", fields: { to: "a@example.test", html: "<p>h</p>" } });
  });

  it("warns when SMTP is not configured", () => {
    expect(
      describeMailResult({ status: "skipped", reason: "smtp_not_configured", to: "a@example.test", subject: "S" }),
    ).toEqual({ level: "warn", msg: "email_not_sent_smtp_not_configured", fields: { to: "a@example.test" } });
  });
});
