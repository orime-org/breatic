// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Unified entity-id generation for the whole project.
 *
 * Lives in `@breatic/shared` so frontend and backend share ONE id
 * scheme + derivation logic instead of each hand-rolling its own (the
 * project historically scattered `nanoid`, `crypto.randomUUID`, and a
 * hand-written v5 across web / server / collab — see the follow-up to
 * migrate the rest onto these helpers).
 *
 * Backed by the `uuid` package (isomorphic + battle-tested): v11 uses
 * the global Web Crypto `crypto.getRandomValues` in both Node and the
 * browser, so it stays browser-safe (no `node:crypto` import) for the
 * shared bundle.
 */

import { v4 as uuidv4, v5 as uuidv5 } from "uuid";

/**
 * Fixed namespace for deterministic ({@link deriveId}) derivation. Any
 * constant UUID works as a v5 namespace; this one is arbitrary and MUST
 * stay constant — changing it would re-derive every derived id.
 */
const BREATIC_ID_NAMESPACE = "6ba7b811-9dad-11d1-80b4-00c04fd430c8";

/**
 * Generate a fresh random (v4) id.
 * @returns A new random UUID string
 */
export function newId(): string {
  return uuidv4();
}

/**
 * Derive a deterministic (v5) id from a name string.
 *
 * The same `name` always yields the same id — used where independent
 * processes must agree on an id without coordinating (e.g. collab
 * deriving a project's default Space id so concurrent first-loads across
 * instances converge to ONE Space).
 * @param name - The stable input the id is derived from (e.g. a project id)
 * @returns A deterministic UUID string for `name`
 */
export function deriveId(name: string): string {
  return uuidv5(name, BREATIC_ID_NAMESPACE);
}
