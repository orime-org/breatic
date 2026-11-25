// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * Sending a stateless signal on a meta document this instance holds. An instance that holds no connection to the
 * Project has no document loaded and sends nothing; the instances that do hold one send it to theirs.
 */

import type { Hocuspocus } from "@hocuspocus/server";
import { createLogger } from "@breatic/core";
import type { AuthContext } from "@collab/hooks/auth.js";

const logger = createLogger("meta-signal");

/** A stateless signal as a meta document's connections parse it: its type and what goes with it. */
export interface MetaSignal {
  readonly t: string;
  readonly [key: string]: unknown;
}

/**
 * Send a signal on one loaded meta document, to the connections `filter` picks. A failure is logged and does not stop
 * the caller.
 * @param hocuspocus - This instance's Hocuspocus server.
 * @param docName - The meta document.
 * @param signal - The signal, as its connections parse it.
 * @param filter - Which connections get it; all when absent.
 */
export function relayOnMetaDoc(
  hocuspocus: Hocuspocus,
  docName: string,
  signal: MetaSignal,
  filter?: (context: AuthContext | undefined) => boolean,
): void {
  const doc = hocuspocus.documents?.get(docName);
  if (!doc) return;
  try {
    doc.relayStateless(JSON.stringify(signal), filter && ((connection) => filter(connection.context as AuthContext | undefined)));
  } catch (err) {
    logger.warn({ err, docName, signal: signal.t }, "meta_signal_relay_failed");
  }
}
