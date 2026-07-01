// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Connection-cap tracking policy (#1421).
 *
 * Decides which documents' connections are recorded in the cross-instance
 * connection registry for the per-document cap. This is the CALLER-side
 * policy the registry deliberately does not own (the registry is a pure
 * counter): the `connected` and `onDisconnect` Hocuspocus hooks both route
 * through {@link shouldTrackConnection}, so registration and unregistration
 * cover exactly the same set of documents — a mismatch would leak or
 * double-drop members.
 */

import { parseDocName } from "@breatic/shared";

/**
 * Whether a document's connections count toward the per-document cap.
 *
 * Meta docs are EXEMPT — project infrastructure everyone must connect to
 * (member list, presence, Space CRUD), never a "how many people can
 * collaborate" surface. Non-project doc names (e.g. the healthz sentinel
 * `__healthz_probe__`) parse to null and are ignored.
 * @param documentName - Hocuspocus document name.
 * @returns true only for Space content docs (canvas / document / timeline).
 */
export function shouldTrackConnection(documentName: string): boolean {
  const parsed = parseDocName(documentName);
  return parsed !== null && parsed.kind !== "meta";
}
