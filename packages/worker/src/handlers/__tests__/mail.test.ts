// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * A notification email queued by a request. The handler sends it and writes
 * down what happened; a send that throws is left to the queue to retry.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { UnrecoverableError, type Job } from "bullmq";

import type * as CoreModule from "@breatic/core";

const sendMail = vi.hoisted(() => vi.fn());

vi.mock("@breatic/core", async (importOriginal) => {
  const actual = await importOriginal<typeof CoreModule>();
  return {
    ...actual,
    sendMail,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  };
});

import { logger } from "@breatic/core";
import type { MailJob } from "@breatic/domain";
import { runMail } from "@worker/handlers/mail.js";

const MAIL = { to: "x@example.com", subject: "s", html: "<p>h</p>" };
const CTX = { userId: "u1", subject: "studio_transfer" };

/** One queued mail. */
function job(): Job<MailJob> {
  return { data: { mail: MAIL, ctx: CTX } } as Job<MailJob>;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("a mail job", () => {
  it("sends the mail and writes down that it went", async () => {
    sendMail.mockResolvedValue({ status: "sent" });

    await runMail(job());

    expect(sendMail).toHaveBeenCalledWith(MAIL);
    expect(logger.info).toHaveBeenCalledWith(CTX, "email_sent");
  });

  it("dumps the mail on the console backend", async () => {
    sendMail.mockResolvedValue({ status: "backend_console", to: MAIL.to, subject: "s", html: MAIL.html });

    await runMail(job());

    expect(logger.info).toHaveBeenCalledWith({ ...CTX, to: MAIL.to, html: MAIL.html }, "[console] email");
    expect(logger.info).not.toHaveBeenCalledWith(CTX, "email_sent");
  });

  it("warns when SMTP is not configured, without retrying", async () => {
    sendMail.mockResolvedValue({ status: "skipped", reason: "smtp_not_configured", to: MAIL.to, subject: "s" });

    await expect(runMail(job())).resolves.toBeUndefined();

    expect(logger.warn).toHaveBeenCalledWith({ ...CTX, to: MAIL.to }, "email_not_sent_smtp_not_configured");
  });

  it("throws a failed send so the queue tries again", async () => {
    const boom = Object.assign(new Error("try later"), { responseCode: 421 });
    sendMail.mockRejectedValue(boom);

    const err = await runMail(job()).catch((e: unknown) => e);
    expect(err).toBe(boom);
    expect(err).not.toBeInstanceOf(UnrecoverableError);
  });

  // RFC 5321 4.2.1: a 5yz reply is a permanent failure; sending again cannot succeed.
  it("ends a send the server refused for good, without retrying", async () => {
    sendMail.mockRejectedValue(
      Object.assign(new Error("Message failed: 554 Reject by content spam"), { responseCode: 554 }),
    );

    const err = await runMail(job()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnrecoverableError);
    expect((err as Error).message).toContain("554 Reject by content spam");
  });
});
