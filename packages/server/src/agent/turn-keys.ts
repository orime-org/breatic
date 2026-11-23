// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * The keys an Agent turn runs on (inner#1953), read the one way both the chat route, which admits the turn, and the
 * turn itself use.
 */

import { keyOwnerOf, keysById, resolveKeys } from "@breatic/domain";
import type { KeySet } from "@breatic/provider";

/**
 * The keys a turn runs on, or why they could not be read; undefined keys are the deployment's. `keyOwner` is the
 * account the key row belongs to, so a failure of it says whose key it was.
 */
export type TurnKeys = ({ keys: KeySet | undefined; keyId: string | null } | { failed: unknown }) & { keyOwner?: string };

/** A turn on our keys. */
export const ON_OUR_KEYS: TurnKeys = { keys: undefined, keyId: null };

/**
 * The keys of a turn: a new one runs on the keys of whoever pays for the project's Studio; a resumed one on the key row
 * its paused segment recorded, read back by id and never resolved again.
 * @param projectId - The turn's project.
 * @param resume - For a resumed turn, the row its paused segment ran on (undefined: our keys); absent for a new turn.
 * @param resume.keyId - That row.
 * @returns The keys and their row, or the failure to read them (`account_key_missing` once a resumed row is gone).
 */
export async function turnKeysOf(projectId: string, resume?: { keyId: string | undefined }): Promise<TurnKeys> {
  if (resume === undefined) {
    try {
      const resolved = await resolveKeys({ projectId }, { kind: "llm" });
      // Our keys are provider's own default, so a turn on them hands provider none.
      if (resolved.keyId === null) return ON_OUR_KEYS;
      return { keys: resolved.keys, keyId: resolved.keyId, ...(resolved.payerUserId === null ? {} : { keyOwner: resolved.payerUserId }) };
    } catch (err) {
      return { failed: err };
    }
  }
  const { keyId } = resume;
  if (keyId === undefined) return ON_OUR_KEYS;
  const keyOwner = await keyOwnerOf(keyId);
  try {
    const found = await keysById(keyId);
    return { keys: found?.keys, keyId, keyOwner };
  } catch (err) {
    return { failed: err, keyOwner };
  }
}
