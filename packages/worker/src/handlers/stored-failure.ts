// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What a failed run's row is given to hold.
 *
 * Its own module because two writers settle the same row: the handler's
 * failure path, and the crash net that settles rows for a worker that died
 * before reaching it. A row holding a code in one case and a sentence in the
 * other would be two answers to one question, and the reader opening that
 * list cannot tell which writer they got.
 */

import { understandFailureMessage } from "@worker/handlers/understand-failure.js";

/**
 * What a failed run's row is given to hold.
 *
 * A read's failures are ours to name — the capability classifies them and
 * each class already has a code of ours — so the row holds the code and the
 * reader is told it in their own language. A provider's own error text is
 * not one of those: it is what the provider said, and it travels as itself.
 * @param taskType - What kind of run this was.
 * @param err - Whatever it threw.
 * @param sourceUrl - The address a read was handed, which names its asset.
 * @returns What the row stores.
 */
export function storedFailure(
  taskType: string,
  err: unknown,
  sourceUrl?: string,
): string {
  if (taskType === "understand") return understandFailureMessage(err, sourceUrl);
  return err instanceof Error ? err.message : String(err);
}
