// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Whether asking again could change a failure of an account's key travels on the error itself (inner#1953), so every
 * caller reads the one answer accountFailureOf gave instead of working it out again.
 */

import { describe, expect, it } from "vitest";
import { AccountKeyFailure, accountKeyFailureIn } from "../errors.js";
import { llmFailureOn } from "../keys.js";
import type { Failure } from "../routing/decide.js";
import { accountKeys } from "./keys-harness.js";

/** An error the test's classifier reads as the failure it carries. */
class Classified extends Error {
  constructor(readonly failure: Failure) {
    super(failure.kind);
  }
}

const classify = (error: unknown): Failure | null => (error instanceof Classified ? error.failure : null);
const onAccount = llmFailureOn(accountKeys({ openrouter: "sk-or-user" }), "m", "openrouter", classify);

describe("an account key failure says whether it lasts", () => {
  it.each<[string, Failure, boolean]>([
    ["a revoked key", { kind: "http_status", status: 401 }, true],
    ["an empty balance", { kind: "insufficient_balance" }, true],
    ["a model the key cannot reach", { kind: "model_not_found" }, true],
    ["the key's rate limit", { kind: "http_status", status: 429 }, false],
    ["the upstream's own 503", { kind: "http_status", status: 503 }, false],
    ["a request that never left", { kind: "not_sent" }, false],
  ])("%s", (_, failure, lasting) => {
    const turned = onAccount(new Classified(failure));
    expect(turned).toBeInstanceOf(AccountKeyFailure);
    expect((turned as AccountKeyFailure).lasting).toBe(lasting);
    expect(accountKeyFailureIn(new Error("wrapped", { cause: turned }))?.lasting).toBe(lasting);
  });

  it("reads a key set that reaches no upstream as lasting", () => {
    expect(new AccountKeyFailure("m", "account_key_missing").lasting).toBe(true);
    expect(accountKeyFailureIn(new AccountKeyFailure("m", "account_key_missing"))?.lasting).toBe(true);
  });

  it("reads an error that carries only a kind, as a key row that is gone does, as lasting", () => {
    expect(accountKeyFailureIn(Object.assign(new Error("gone"), { kind: "account_key_missing" }))?.lasting).toBe(true);
  });
});
