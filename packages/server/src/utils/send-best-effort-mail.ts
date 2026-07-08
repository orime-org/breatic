// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Best-effort notification-email sender (invite / transfer).
 *
 * The bell notification is the always-delivered path, so NOTHING done purely in
 * service of the optional email may fail the caller's request. This wraps the
 * ENTIRE email preparation + send in one try/catch + logging policy: the caller
 * passes a factory that fetches whatever the email needs (recipient lookup,
 * one-time token mint) and builds the mail — so a failure while PREPARING the
 * mail (a Redis/DB blip on the token mint or the recipient read) is swallowed
 * just like a send failure, instead of throwing out after the bell already
 * committed. The factory returns null to skip sending (e.g. recipient gone).
 *
 * Auth emails (reset / verify) do NOT use this — they are the primary channel
 * and surface their result to the caller instead of swallowing it.
 */

import type { SendMailOptions } from "@server/infra/mailer.js";
import { sendMail } from "@server/infra/mailer.js";
import { logMailResult, type LogMailCtx } from "@server/utils/log-mail.js";
import { logger } from "@breatic/core";

/**
 * Prepare (inside the best-effort boundary) and send a notification email; never
 * throws. Any failure preparing OR sending is swallowed and logged.
 * @param buildMail - Async factory that fetches what the email needs and builds
 *   it; return null to skip sending. Runs INSIDE the swallow so a fetch/mint
 *   failure never fails the caller's request.
 * @param ctx - Correlation context (recipient user id + mail subject tag) merged into the log line.
 */
export async function sendBestEffortMail(
  buildMail: () => Promise<SendMailOptions | null>,
  ctx: LogMailCtx,
): Promise<void> {
  try {
    const mail = await buildMail();
    if (!mail) return;
    const result = await sendMail(mail);
    logMailResult(result, ctx);
  } catch (err) {
    logger.error(
      { err, subject: ctx.subject, userId: ctx.userId },
      "mail_send_failed",
    );
  }
}
