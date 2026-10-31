// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Connection-cap tracking policy (#1421, #88).
 *
 * Decides which documents' connections are released from the cross-instance
 * registry on disconnect. This is CALLER-side policy the registry
 * deliberately does not own.
 *
 * THE TWO SIDES ARE DECIDED IN DIFFERENT PLACES, and that asymmetry is
 * deliberate:
 *
 *   - The `connected` hook takes a seat only when the auth hook handed the
 *     connection a ceiling (`AuthContext.seatCap` is not null). The auth hook
 *     is the one place that decides whether a connection may write and under
 *     which cap, and it gives a ceiling only to a writable connection on a
 *     Space content document. Only writable connections take a seat, because
 *     what the ceiling limits is how many may write at once (#88).
 *   - The `onDisconnect` hook unregisters, and asks {@link shouldTrackConnection}
 *     — documents only. It CANNOT ask about writability: `onDisconnectPayload`
 *     has no `connectionConfig` (@hocuspocus/server 4.6.0). It does not need
 *     to, because removing a member that was never added is a no-op, so
 *     unregistering unconditionally is both correct and idempotent.
 *
 * The direction of the asymmetry is what keeps this safe: every document
 * handed a ceiling is one the unregister side visits, so a member can be
 * dropped but never stranded. A ceiling somewhere the unregister side does
 * not reach is what would leak, and a test in `auth.test.ts` pins that it
 * cannot happen.
 */

import { parseDocName } from "@breatic/shared";

/**
 * Whether a document's connections count toward the per-document ceiling.
 *
 * Meta docs are EXEMPT — project infrastructure everyone must connect to
 * (member list, presence, Space CRUD), never a "how many people can
 * collaborate" surface. Non-project doc names (e.g. the healthz sentinel
 * `__healthz_probe__`) parse to null and are ignored.
 *
 * This is the unregister side's predicate; the auth hook hands a ceiling only
 * to writable connections on documents it covers.
 * @param documentName - Hocuspocus document name.
 * @returns true only for Space content docs (canvas / document / timeline).
 */
export function shouldTrackConnection(documentName: string): boolean {
  const parsed = parseDocName(documentName);
  return parsed !== null && parsed.kind !== "meta";
}
