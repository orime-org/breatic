// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * Whether asking again could change a failure of an account's key travels on the error itself (inner#1953), so every
 * caller reads the one answer accountFailureOf gave instead of working it out again.
 */

import { describe, expect, it } from "vitest";
import { AccountKeyFailure, accountKeyFailureIn, NoUpstreamAvailable } from "../errors.js";
import { deploymentKeySet, llmFailureOn } from "../keys.js";
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

describe("the edges of reading a key failure (inner#1953)", () => {
  it("names no upstream in the message of a failure that was given none", () => {
    expect(new AccountKeyFailure("m", "account_key_failed", { reason: "invalid" }).message).toBe("The upstream failed m on the account's key: invalid");
  });

  it("finds no key failure on an error whose chain carries none", () => {
    expect(accountKeyFailureIn(new Error("plain", { cause: new Error("also plain") }))).toBeUndefined();
  });

  it("hands an account's key failure on as it is, and leaves a route that ran out on missing keys alone", () => {
    const turn = llmFailureOn(accountKeys({ openrouter: "acct-or" }), "m", "openrouter", () => null);
    const failure = new AccountKeyFailure("m", "account_key_failed", { upstream: "openrouter", reason: "no_balance" });
    expect(turn(failure)).toBe(failure);
    const ranOut = new NoUpstreamAvailable("m", [{ upstream: "deepseek", kind: "missing_key", envVar: "DEEPSEEK_API_KEY" }]);
    expect(turn(ranOut)).toBe(ranOut);
  });

  it("holds no deployment key for an upstream the configuration does not name", () => {
    const keys = deploymentKeySet({ upstreams: {} }, () => "never-read");
    expect(keys.keyOf("nope")).toBeUndefined();
  });
});
