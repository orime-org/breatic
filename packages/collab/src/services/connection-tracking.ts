// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Connection-cap tracking policy (#1421, #88).
 *
 * Decides which connections are recorded in the cross-instance registry for
 * the per-document ceiling. This is the CALLER-side policy the registry
 * deliberately does not own (the registry is a pure counter).
 *
 * THE TWO SIDES ASK DIFFERENT QUESTIONS, and that asymmetry is deliberate:
 *
 *   - The `connected` hook registers, and asks {@link shouldRegisterConnection}
 *     — which documents count AND whether this connection may write. Only
 *     writable connections take a seat, because what the ceiling limits is
 *     how many may write at once (#88).
 *   - The `onDisconnect` hook unregisters, and asks {@link shouldTrackConnection}
 *     — documents only. It CANNOT ask about writability: `onDisconnectPayload`
 *     has no `connectionConfig` (@hocuspocus/server 4.6.0). It does not need
 *     to, because removing a member that was never added is a no-op, so
 *     unregistering unconditionally is both correct and idempotent.
 *
 * The direction of the asymmetry is what keeps this safe: everything
 * registered is a subset of everything the unregister side visits, so a
 * member can be dropped but never stranded. Registering somewhere the
 * unregister side does not reach is what would leak, and a test pins that it
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
 * This is the unregister side's predicate; the register side adds writability
 * on top of it — see {@link shouldRegisterConnection}.
 * @param documentName - Hocuspocus document name.
 * @returns true only for Space content docs (canvas / document / timeline).
 */
export function shouldTrackConnection(documentName: string): boolean {
  const parsed = parseDocName(documentName);
  return parsed !== null && parsed.kind !== "meta";
}

/**
 * Whether this particular connection takes one of the document's seats.
 *
 * A seat is a WRITABLE connection. A read-only one does not consume the
 * ceiling: it cannot change anything, and counting it meant a document with a
 * ceiling of 2 was full once an owner and a viewer were looking at it, while
 * the next editor — who should have had the second seat — was pushed to
 * read-only. That was invisible while the ceiling was a flat 100.
 *
 * One flag covers every way a connection ends up read-only (the viewer role,
 * the document already being full, a tier that could not be resolved) because
 * the auth hook has folded all of them into `connectionConfig.readOnly` before
 * this is asked, and that is the same object the framework hands the
 * `connected` hook.
 * @param documentName - Hocuspocus document name.
 * @param readOnly - This connection's settled `connectionConfig.readOnly`.
 * @returns true only for a writable connection to a Space content doc.
 */
export function shouldRegisterConnection(
  documentName: string,
  readOnly: boolean,
): boolean {
  return !readOnly && shouldTrackConnection(documentName);
}
