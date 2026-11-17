// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What a failed run's row is given to hold.
 *
 * Its own module because two writers settle the same row: the handler's
 * failure path, and the crash net that settles rows for a worker that died
 * before reaching it. A row holding a code in one case and a sentence in the
 * other would be two answers to one question, and the user opening that
 * list cannot tell which writer they got.
 */

import { understandFailureMessage } from "@worker/handlers/understand-failure.js";
import { MediaRunFailed } from "@worker/handlers/media-run.js";
import { accountKeyFailureIn } from "@breatic/provider";
import { DeadlinePassed, encodeTaskFailure } from "@breatic/shared";

/**
 * What a failed run's row is given to hold.
 *
 * A read's failures are ours to name — the capability classifies them and
 * each class already has a code of ours — so the row holds the code and the
 * user is told it in their own language. A provider's own error text is
 * not one of those: it is what the provider said, and it travels as itself.
 * @param taskType - What kind of run this was.
 * @param err - Whatever it threw.
 * @param sourceUrl - The address a read was handed, which names its asset.
 * @param reading - Which reading this was, when it was not an understanding (inner#856).
 * @returns What the row stores.
 */
export function storedFailure(
  taskType: string,
  err: unknown,
  sourceUrl?: string,
  reading?: "transcribe",
): string {
  // Running out of the two hours means the same thing whatever the task was.
  if (err instanceof DeadlinePassed) return err.message;
  // An account's own key failed or is gone (inner#1953), in any lane: the row names the key's code, the upstream and
  // why, so the user knows which key to top up or change. A failed media run already wrote it naming its model.
  const keyFailure = err instanceof MediaRunFailed ? undefined : accountKeyFailureIn(err);
  if (keyFailure !== undefined) {
    return encodeTaskFailure(keyFailure.kind, { upstream: keyFailure.upstream, keyReason: keyFailure.reason, reading });
  }
  if (taskType === "understand") return understandFailureMessage(err, sourceUrl, reading);
  return err instanceof Error ? err.message : String(err);
}
