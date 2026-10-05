// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Best-effort notification-email sender (invite / transfer / requests / quota
 * / membership).
 *
 * The bell notification is the always-delivered path, so NOTHING done purely in
 * service of the optional email may fail the caller's request. The caller passes
 * a factory that fetches whatever the email needs (recipient lookup, one-time
 * token mint) and builds the mail; it runs inside the same try/catch as the
 * queueing, so a failure while PREPARING the mail is swallowed too. The factory
 * returns null to skip the mail (e.g. recipient gone).
 *
 * The built mail is queued for the worker, which sends it, logs the result and
 * retries a failed send, so the request does not wait on SMTP.
 *
 * Auth emails (reset / verify) do NOT use this — they are the primary channel
 * and surface their result to the caller instead of swallowing it.
 */

import type { LogMailCtx } from "@server/utils/log-mail.js";
import { logger, type SendMailOptions } from "@breatic/core";
import { enqueueMail } from "@breatic/domain";

/**
 * Prepare (inside the best-effort boundary) and queue a notification email;
 * never throws. Any failure preparing OR queueing is swallowed and logged.
 * @param buildMail - Async factory that fetches what the email needs and builds
 *   it; return null to skip it. Runs INSIDE the swallow so a fetch/mint
 *   failure never fails the caller's request.
 * @param ctx - Correlation context (recipient user id + mail subject tag),
 *   carried on the job into the worker's log lines.
 */
export async function sendBestEffortMail(
  buildMail: () => Promise<SendMailOptions | null>,
  ctx: LogMailCtx,
): Promise<void> {
  try {
    const mail = await buildMail();
    if (!mail) return;
    await enqueueMail({ mail, ctx });
  } catch (err) {
    logger.error(
      { err, subject: ctx.subject, userId: ctx.userId },
      "mail_enqueue_failed",
    );
  }
}
