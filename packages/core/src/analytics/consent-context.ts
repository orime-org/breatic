// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The consent snapshot of the browser behind the current request.
 *
 * The server's consent middleware opens this context from the
 * `breatic_consent` cookie, the same way the locale middleware opens the
 * locale context, so a service deep in the call stack can ask whether the
 * request it serves may be measured without the choice being threaded through
 * every signature (inner#1442 design §4.4.5).
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { NO_CONSENT, type ConsentSnapshot } from "@breatic/shared";

const store = new AsyncLocalStorage<ConsentSnapshot>();

/**
 * Run a request with the given consent in scope.
 * @param consent - The browser's choice, already parsed.
 * @param fn - The request handler.
 * @returns Whatever the handler returns.
 */
export function runWithConsent<T>(consent: ConsentSnapshot, fn: () => T): T {
  return store.run(consent, fn);
}

/**
 * The consent of the request being served.
 * @returns The snapshot in scope; {@link NO_CONSENT} outside any request.
 */
export function currentConsent(): ConsentSnapshot {
  return store.getStore() ?? NO_CONSENT;
}
