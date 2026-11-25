// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * A run that failed on an account's own key (inner#1953), as its task row stores it and as the queue treats it:
 * every lane (a generation, a mini-tool, a reading) stores the key's own code naming the upstream and why. Our key is
 * never tried instead, so a lasting failure settles at once and a passing one is left to the queue's next attempt on
 * the same key. A key failure is recognised by its `kind` wherever it sits on the cause chain.
 */

import { describe, expect, it } from "vitest";
import { readTaskFailure } from "@breatic/shared";

import { MediaRunFailed } from "@worker/handlers/media-run.js";
import { understandFailureCode, verdictStands } from "@worker/handlers/understand-failure.js";
import { storedFailure } from "@worker/handlers/stored-failure.js";

/**
 * A key failure as provider or the key reader reports it, optionally wrapped once.
 * @param kind - The kind.
 * @param extra - Why, and the upstream.
 * @param wrapped - Whether it arrives as the cause of another error.
 * @returns The error.
 */
function keyFailure(kind: string, extra: Record<string, unknown> = {}, wrapped = false): Error {
  const inner = Object.assign(new Error(kind), { kind, ...extra });
  return wrapped ? new Error("the call failed", { cause: inner }) : inner;
}

const CASES = [
  ["account_key_failed", { reason: "no_balance", upstream: "fal" }],
  ["account_key_failed", { reason: "invalid", upstream: "wavespeed" }],
  ["account_key_failed", { reason: "model_not_found", upstream: "sandbase" }],
  ["account_key_failed", { reason: "rate_limited", upstream: "openrouter" }],
  ["account_key_missing", {}],
  ["upstream_unavailable", { upstream: "sandbase" }],
] as const;

describe("a key failure's verdict stands when it lasts", () => {
  it.each(CASES)("%s %j that lasts settles at once, wrapped or not", (kind, extra) => {
    expect(verdictStands(keyFailure(kind, { ...extra, lasting: true }))).toBe(true);
    expect(verdictStands(keyFailure(kind, { ...extra, lasting: true }, true))).toBe(true);
  });

  it.each([
    ["account_key_failed", { reason: "rate_limited", upstream: "openrouter" }],
    ["upstream_unavailable", { upstream: "openrouter" }],
  ] as const)("%s %j that passes leaves the queue to try again on the same key, wrapped or not", (kind, extra) => {
    expect(verdictStands(keyFailure(kind, { ...extra, lasting: false }))).toBe(false);
    expect(verdictStands(keyFailure(kind, { ...extra, lasting: false }, true))).toBe(false);
  });

  it("reads a key failure that does not say whether it lasts as lasting", () => {
    expect(verdictStands(keyFailure("account_key_missing"))).toBe(true);
  });
});

describe("what a key failure's row holds", () => {
  it.each(["image", "video", "audio"])("a %s generation stores the key's code, the upstream and why", (taskType) => {
    expect(readTaskFailure(storedFailure(taskType, keyFailure("account_key_failed", { reason: "no_balance", upstream: "fal" }, true)))).toMatchObject({
      reason: "account_key_failed",
      upstream: "fal",
      keyReason: "no_balance",
    });
  });

  it("a generation whose key row was replaced or deleted stores account_key_missing", () => {
    expect(readTaskFailure(storedFailure("image", keyFailure("account_key_missing"))).reason).toBe("account_key_missing");
  });

  it("a reading stores the key's code, not the internal one", () => {
    expect(understandFailureCode(keyFailure("account_key_failed", { reason: "no_balance", upstream: "openrouter" }, true))).toBe("account_key_failed");
    expect(understandFailureCode(keyFailure("account_key_missing"))).toBe("account_key_missing");
    expect(readTaskFailure(storedFailure("understand", keyFailure("account_key_failed", { reason: "invalid", upstream: "openrouter" }), "https://cdn/a.png"))).toMatchObject({
      reason: "account_key_failed",
      upstream: "openrouter",
      keyReason: "invalid",
    });
  });

  it("an unreachable upstream stores upstream_unavailable, naming it", () => {
    expect(readTaskFailure(storedFailure("video", keyFailure("upstream_unavailable", { upstream: "sandbase" })))).toMatchObject({
      reason: "upstream_unavailable",
      upstream: "sandbase",
    });
  });

  it("names whose key it was, on a lane's own failure and on a failed media run alike", () => {
    const owner = "8b1c0f4e-0000-4000-8000-000000000002";
    const failure = keyFailure("account_key_failed", { reason: "no_balance", upstream: "fal", lasting: true }, true);
    expect(readTaskFailure(storedFailure("understand", failure, undefined, undefined, owner))).toMatchObject({ keyOwner: owner });
    const media = new MediaRunFailed(failure, [], "Seedream 5");
    expect(readTaskFailure(storedFailure("image", media, undefined, undefined, owner))).toEqual({
      reason: "account_key_failed",
      model: "Seedream 5",
      upstream: "fal",
      keyReason: "no_balance",
      keyOwner: owner,
    });
  });
});
