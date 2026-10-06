// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, it, expect, vi, beforeEach } from "vitest";

import { logger } from "@breatic/core";
import { enqueueMail } from "@breatic/domain";
import { sendBestEffortMail } from "@server/utils/send-best-effort-mail.js";

vi.mock("@breatic/core", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock("@breatic/domain", () => ({ enqueueMail: vi.fn() }));

const MAIL = { to: "x@example.com", subject: "s", html: "<p>h</p>" };
const CTX = { userId: "u1", subject: "studio_invite" };

beforeEach(() => vi.clearAllMocks());

describe("sendBestEffortMail", () => {
  // The request no longer waits on SMTP: the mail is handed to the worker.
  it("builds the mail and queues it with its log context", async () => {
    await sendBestEffortMail(async () => MAIL, CTX);

    expect(enqueueMail).toHaveBeenCalledWith({ mail: MAIL, ctx: CTX });
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("swallows a queueing failure and logs it at the boundary", async () => {
    const boom = new Error("redis down");
    vi.mocked(enqueueMail).mockRejectedValueOnce(boom);

    // The bell notification already landed; the request must not fail.
    await expect(sendBestEffortMail(async () => MAIL, CTX)).resolves.toBeUndefined();

    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: boom, subject: "studio_invite", userId: "u1" }),
      "mail_enqueue_failed",
    );
  });

  it("swallows a prepare failure too", async () => {
    const boom = new Error("token mint failed");

    await expect(
      sendBestEffortMail(async () => {
        throw boom;
      }, CTX),
    ).resolves.toBeUndefined();

    expect(enqueueMail).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: boom, subject: "studio_invite", userId: "u1" }),
      "mail_enqueue_failed",
    );
  });

  it("queues nothing when the factory returns null", async () => {
    await sendBestEffortMail(async () => null, CTX);

    expect(enqueueMail).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });
});
