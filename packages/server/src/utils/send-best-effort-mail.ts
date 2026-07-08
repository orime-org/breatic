// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Best-effort notification-email sender (invite / transfer).
 *
 * The bell notification is the always-delivered path, so a send failure must
 * NOT fail the caller's request. This wraps `sendMail` in the single try/catch
 * + logging policy that was previously copied across every notification send
 * site: on success the shared status→log policy applies; on any throw the error
 * is swallowed and logged at the application boundary.
 *
 * Auth emails (reset / verify) do NOT use this — they are the primary channel
 * and surface their result to the caller instead of swallowing it.
 */

import type { SendMailOptions } from "@server/infra/mailer.js";
import { sendMail } from "@server/infra/mailer.js";
import { logMailResult, type LogMailCtx } from "@server/utils/log-mail.js";
import { logger } from "@breatic/core";

/**
 * Send a best-effort notification email; never throws.
 * @param mail - Recipient / subject / HTML body to send.
 * @param ctx - Correlation context (recipient user id + mail subject tag) merged into the log line.
 */
export async function sendBestEffortMail(
  mail: SendMailOptions,
  ctx: LogMailCtx,
): Promise<void> {
  try {
    const result = await sendMail(mail);
    logMailResult(result, ctx);
  } catch (err) {
    logger.error(
      { err, subject: ctx.subject, userId: ctx.userId },
      "mail_send_failed",
    );
  }
}
