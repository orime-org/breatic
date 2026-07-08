// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect, vi, beforeEach } from "vitest";

import { sendMail } from "@server/infra/mailer.js";
import { logMailResult } from "@server/utils/log-mail.js";
import { logger } from "@breatic/core";
import { sendBestEffortMail } from "@server/utils/send-best-effort-mail.js";

vi.mock("@server/infra/mailer.js", () => ({ sendMail: vi.fn() }));
vi.mock("@server/utils/log-mail.js", () => ({ logMailResult: vi.fn() }));
vi.mock("@breatic/core", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

const MAIL = { to: "x@example.com", subject: "s", html: "<p>h</p>" };
const CTX = { userId: "u1", subject: "studio_invite" };

beforeEach(() => vi.clearAllMocks());

describe("sendBestEffortMail", () => {
  it("sends the mail and routes the result through the shared log policy", async () => {
    vi.mocked(sendMail).mockResolvedValueOnce({ status: "sent" });

    await sendBestEffortMail(MAIL, CTX);

    expect(sendMail).toHaveBeenCalledWith(MAIL);
    expect(logMailResult).toHaveBeenCalledWith({ status: "sent" }, CTX);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("swallows a send failure — never rethrows, logs the error at the boundary", async () => {
    const boom = new Error("smtp exploded");
    vi.mocked(sendMail).mockRejectedValueOnce(boom);

    // Must resolve (not reject) — a failed best-effort mail must not fail the
    // caller's request (the bell notification already landed).
    await expect(sendBestEffortMail(MAIL, CTX)).resolves.toBeUndefined();

    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: boom, subject: "studio_invite", userId: "u1" }),
      "mail_send_failed",
    );
    // On the throwing path we never reach the status-based log policy.
    expect(logMailResult).not.toHaveBeenCalled();
  });
});
