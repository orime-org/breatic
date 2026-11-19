// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { accountKeyFailureIn } from "@breatic/provider";

/**
 * What a failed stream's last frame says about an account key's failure (inner#1953): which kind, which upstream, why
 * and whose key it was, so the page can tell the user to top up or replace the key, or to ask whoever holds it. Empty
 * for any other failure.
 * @param err - What the run failed with.
 * @param keyOwner - The account the run's key row belongs to.
 * @returns The frame's fields.
 */
export function keyFailureFrame(err: unknown, keyOwner?: string): Record<string, string> {
  const facts = accountKeyFailureIn(err);
  if (facts === undefined) return {};
  return {
    reason: facts.kind,
    ...(facts.upstream === undefined || facts.upstream === "" ? {} : { upstream: facts.upstream }),
    ...(facts.reason === undefined ? {} : { keyReason: facts.reason }),
    ...(keyOwner === undefined ? {} : { keyOwner }),
  };
}
