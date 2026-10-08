// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The one check every endpoint that only our own backend may call makes.
 */

/** What the check reads. */
interface SecretEnv {
  INGEST_SHARED_SECRET: string;
}

/**
 * Whether two secrets are the same, without leaking where they diverge.
 * @param a - One secret.
 * @param b - The other.
 * @returns True when they match.
 */
function secretsMatch(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let differing = 0;
  for (let i = 0; i < a.length; i += 1) {
    differing |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return differing === 0;
}

/**
 * Whether this request comes from our own backend.
 *
 * A ticket and a session token both travel to the browser, so neither says
 * anything about who is asking. The secret is the one thing only our servers
 * hold, and it is what the endpoints that must not be reachable from a page
 * ask for.
 * @param request - The request to judge.
 * @param env - The Worker's bindings.
 * @returns True when the request carries our shared secret.
 */
export function fromOurBackend(request: Request, env: SecretEnv): boolean {
  const secret = request.headers.get("x-ingest-secret");
  return secret !== null && secretsMatch(secret, env.INGEST_SHARED_SECRET);
}
