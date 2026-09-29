// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, it, expect, vi, beforeEach } from "vitest";

const logger = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }));
vi.mock("@breatic/core", () => ({ logger }));

import { logMailResult } from "@server/utils/log-mail.js";

describe("logMailResult", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("leaves a sent mail to the caller's own line", () => {
    logMailResult({ status: "sent" }, { userId: "u1", subject: "studio_invite" });
    expect(logger.info).not.toHaveBeenCalled();
  });

  it("warns when SMTP is not configured", () => {
    logMailResult(
      { status: "skipped", reason: "smtp_not_configured", to: "a@example.test", subject: "S" },
      { userId: "u1", subject: "password_reset" },
    );
    expect(logger.warn).toHaveBeenCalledWith(
      { userId: "u1", subject: "password_reset", to: "a@example.test" },
      "email_not_sent_smtp_not_configured",
    );
  });

  it("stays silent when the backend is disabled", () => {
    logMailResult({ status: "skipped", reason: "backend_disabled" }, { subject: "x" });
    expect(logger.info).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });
});
