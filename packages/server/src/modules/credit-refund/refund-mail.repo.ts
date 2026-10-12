// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Data access for `refund_mail_outbox` (inner#1410 §6.5).
 */

import { refundMailOutbox } from "@breatic/core";
import type { DbTx } from "@breatic/core";

/** Which buyer email. */
export type RefundMailKind = "refund_completed" | "refund_rejected";

/**
 * Queue the automatic mail of a finishing disposition (M0, `auto`). The
 * partial unique index allows one per disposition.
 * @param operationId - The disposition.
 * @param kind - Which mail.
 * @param tx - The disposition's transaction.
 */
export async function insertAuto(
  operationId: string,
  kind: RefundMailKind,
  tx: DbTx,
): Promise<void> {
  await tx.insert(refundMailOutbox).values({ operationId, kind, origin: "auto" });
}
