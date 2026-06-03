// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Shared mail-result logger.
 *
 * Application boundary owns logger (per CLAUDE.md "the library layer writes no logs" - `core/infra/mailer.ts` returns SendMailResult instead of
 * logging). This helper centralizes the routing rules across the
 * auth and invite-link routes so the policy is defined once:
 *
 *   - backend_console        : info - dump full html to dev server log
 *   - skipped + smtp_not_configured : warn - ops sees the misconfig
 *   - sent / backend_disabled : no log (the caller-level audit line
 *     already covers them)
 */

import type { SendMailResult } from "@server/infra/mailer.js";
import { logger } from "@breatic/core";

export interface LogMailCtx {
  /** Recipient user id (when known) - joins audit + mail records. */
  userId?: string;
  /** Short tag describing the mail (e.g. "password_reset"). */
  subject: string;
}

/**
 * Apply the shared mail-result logging policy at the application boundary.
 * @param result - The {@link SendMailResult} returned by `sendMail`.
 * @param ctx - Correlation context (recipient user id and mail subject tag) merged into the log line.
 */
export function logMailResult(result: SendMailResult, ctx: LogMailCtx): void {
  if (result.status === "backend_console") {
    logger.info(
      { ...ctx, to: result.to, html: result.html },
      "[console] email",
    );
  } else if (
    result.status === "skipped" &&
    result.reason === "smtp_not_configured"
  ) {
    logger.warn(
      { ...ctx, to: result.to },
      "email_not_sent_smtp_not_configured",
    );
  }
}
