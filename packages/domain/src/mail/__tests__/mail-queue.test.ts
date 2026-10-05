// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, it, expect, vi } from "vitest";

import type * as CoreModule from "@breatic/core";

const queueAdd = vi.hoisted(() => vi.fn());
const createQueue = vi.hoisted(() => vi.fn(() => ({ add: queueAdd })));
const JOB_OPTS = {
  attempts: 3,
  backoff: { type: "jitter" as const },
  removeOnComplete: { age: 3600, count: 1000 },
  removeOnFail: { age: 86400, count: 1000 },
};

vi.mock("@breatic/core", async (importOriginal) => ({
  ...(await importOriginal<typeof CoreModule>()),
  createQueue,
  defaultJobOpts: () => JOB_OPTS,
}));

import { MAIL_QUEUE, enqueueMail } from "@domain/mail/mail-queue.js";

describe("enqueueMail", () => {
  it("puts the mail and its log context on the mail queue with the shared retry options", async () => {
    const job = {
      mail: { to: "x@example.com", subject: "s", html: "<p>h</p>" },
      ctx: { userId: "u1", subject: "studio_transfer" },
    };

    await enqueueMail(job);
    await enqueueMail(job);

    expect(createQueue).toHaveBeenCalledTimes(1);
    expect(createQueue).toHaveBeenCalledWith(MAIL_QUEUE);
    expect(queueAdd).toHaveBeenCalledWith("send", job, JOB_OPTS);
  });
});
