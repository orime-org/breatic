// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Send a notification email a request queued. A send that throws is left to
 * the queue to retry, unless the server refused it for good; what each result
 * logs is core's `describeMailResult`.
 */

import { UnrecoverableError, type Job } from "bullmq";
import { describeMailResult, logger, sendMail } from "@breatic/core";
import type { MailJob } from "@breatic/domain";

/**
 * Whether the SMTP server refused the mail for good: a 5yz reply is a
 * permanent failure (RFC 5321 4.2.1), so sending it again cannot succeed.
 * @param err - What the send threw.
 * @returns True for a 5yz reply.
 */
function isPermanentRefusal(err: unknown): boolean {
  const code = (err as { responseCode?: unknown } | null)?.responseCode;
  return typeof code === "number" && code >= 500 && code < 600;
}

/**
 * Send one queued mail and write down what happened.
 * @param job - The queued mail.
 * @returns Nothing once the mail is handed over or skipped.
 * @throws {UnrecoverableError} When the SMTP server refused the mail for good.
 * @throws {unknown} When the send failed otherwise, so the queue tries again.
 */
export async function runMail(job: Job<MailJob>): Promise<void> {
  const { mail, ctx } = job.data;
  let result;
  try {
    result = await sendMail(mail);
  } catch (err) {
    if (isPermanentRefusal(err)) throw new UnrecoverableError((err as Error).message);
    throw err;
  }
  if (result.status === "sent") logger.info({ ...ctx }, "email_sent");
  const line = describeMailResult(result);
  if (line) logger[line.level]({ ...ctx, ...line.fields }, line.msg);
}
