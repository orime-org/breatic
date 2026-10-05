// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Send a notification email a request queued. A send that throws is left to
 * the queue to retry; what each result logs is core's `describeMailResult`.
 */

import type { Job } from "bullmq";
import { describeMailResult, logger, sendMail } from "@breatic/core";
import type { MailJob } from "@breatic/domain";

/**
 * Send one queued mail and write down what happened.
 * @param job - The queued mail.
 * @returns Nothing once the mail is handed over or skipped.
 * @throws {unknown} When the SMTP send fails, so the queue tries again.
 */
export async function runMail(job: Job<MailJob>): Promise<void> {
  const { mail, ctx } = job.data;
  const result = await sendMail(mail);
  if (result.status === "sent") logger.info({ ...ctx }, "email_sent");
  const line = describeMailResult(result);
  if (line) logger[line.level]({ ...ctx, ...line.fields }, line.msg);
}
