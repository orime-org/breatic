// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Shared mail-result logger.
 *
 * The library layer writes no logs (`core/infra/mailer.ts` returns a
 * SendMailResult instead). Which line a result calls for is core's
 * `describeMailResult`, shared with the worker's mail handler; this writes it
 * with the request's context.
 */

import type { SendMailResult } from "@breatic/core";
import { describeMailResult, logger } from "@breatic/core";

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
  const line = describeMailResult(result);
  if (line) logger[line.level]({ ...ctx, ...line.fields }, line.msg);
}
