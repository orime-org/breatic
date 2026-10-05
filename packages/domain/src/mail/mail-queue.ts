// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Notification mail, sent by the worker instead of inside the request.
 *
 * An invite or a transfer request used to wait on the SMTP exchange before it
 * answered — seconds on a remote server. The request now queues the built mail
 * and returns; the worker sends it and retries a failed send.
 */

import { createQueue, defaultJobOpts, type SendMailOptions } from "@breatic/core";

/** The queue the mail travels on. */
export const MAIL_QUEUE = "mail";

/** One mail, as the worker receives it. */
export interface MailJob {
  mail: SendMailOptions;
  /** Merged into every log line about this mail. */
  ctx: { userId?: string; subject: string };
}

let queue: ReturnType<typeof createQueue> | undefined;

/**
 * Put a built mail on the mail queue.
 * @param job - The mail and its log context.
 * @returns Once the queue has it.
 * @throws {unknown} When the queue's Redis cannot be reached.
 */
export async function enqueueMail(job: MailJob): Promise<void> {
  queue ??= createQueue(MAIL_QUEUE);
  await queue.add("send", job, defaultJobOpts());
}
