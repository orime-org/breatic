// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * An understanding on the key set its caller resolved for the paying account (inner#1953): the set is handed to
 * provider with the call, and a failure of an account's key is passed on as itself, never judged into a refusal of
 * the deployment, so the task ends with the key's own sentence and the caller does not move to our key.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { NoUpstreamAvailable, UpstreamRequestRejected, type Cost, type KeySet } from "@breatic/provider";

const understand = vi.hoisted(() => vi.fn());

vi.mock("@domain/provider/instance.js", () => ({ provider: () => ({ llm: { understand } }) }));

import { understandMedia } from "@domain/understand/understand.js";
import { UnderstandRefused, type Media } from "@domain/understand/types.js";

const KNOWN: Cost = { state: "known", usd: 0.004, source: "reported" };
const AUDIO: Media = { kind: "audio", bytes: new Uint8Array([2, 3]), contentType: "audio/mpeg" };
const ACCOUNT: KeySet = { owner: "account", keyOf: (upstream: string) => (upstream === "openrouter" ? "sk-or-v1-acct" : undefined) };

const base = {
  onBilled: (): void => undefined,
  question: "What is this?",
  model: "google/gemini-3.8-flash",
  maxOutputTokens: 2048,
  timeoutMs: 180_000,
  media: [AUDIO],
};

/**
 * A key failure as provider reports it: its kind, and for a failed key why and on which upstream.
 * @param kind - The kind.
 * @param extra - Why, and the upstream.
 * @returns The error.
 */
function keyFailure(kind: string, extra: Record<string, unknown> = {}): Error {
  return Object.assign(new Error(`${kind}`), { kind, ...extra });
}

/**
 * The kind a value or its cause chain names.
 * @param value - What was thrown.
 * @returns The kind, or undefined.
 */
function kindOf(value: unknown): unknown {
  for (let current = value; typeof current === "object" && current !== null; current = (current as { cause?: unknown }).cause) {
    if ("kind" in current && typeof (current).kind === "string" && String((current as { kind: string }).kind).startsWith("account_key")) return (current as { kind: string }).kind;
  }
  return undefined;
}

beforeEach(() => {
  understand.mockReset();
  understand.mockResolvedValue({ text: "a puppy", finishReason: "stop", costs: [KNOWN], upstream: "openrouter" });
});

describe("understandMedia on a key set", () => {
  it("hands provider the key set it was given", async () => {
    await understandMedia({ ...base, keys: ACCOUNT });
    expect(understand.mock.calls[0]![2]).toBe(ACCOUNT);
  });

  it("hands provider no key set when none was resolved, so our keys are used", async () => {
    await understandMedia(base);
    expect(understand.mock.calls[0]![2]).toBeUndefined();
  });

  // provider may carry a key failure on its refusal or on its "no upstream" error; either way the key's kind is on
  // the chain, and this layer must not turn it into a refusal of the deployment.
  it.each([
    ["account_key_failed on a refusal", "account_key_failed", () => new UpstreamRequestRejected("google/gemini-3.8-flash", "openrouter", "402", [], { status: 402, cause: keyFailure("account_key_failed", { reason: "no_balance", upstream: "openrouter" }) })],
    ["account_key_failed (invalid) on a refusal", "account_key_failed", () => new UpstreamRequestRejected("google/gemini-3.8-flash", "openrouter", "401", [], { status: 401, cause: keyFailure("account_key_failed", { reason: "invalid", upstream: "openrouter" }) })],
    ["account_key_missing on no upstream", "account_key_missing", () => Object.assign(new NoUpstreamAvailable("google/gemini-3.8-flash", []), { cause: keyFailure("account_key_missing") })],
  ])("passes %s on as itself, never as a refusal of the deployment", async (_name, kind, error) => {
    understand.mockRejectedValue(error());
    const thrown = await understandMedia({ ...base, keys: ACCOUNT }).then(() => undefined, (err: unknown) => err);

    expect(thrown).not.toBeInstanceOf(UnderstandRefused);
    expect(kindOf(thrown)).toBe(kind);
    expect(understand).toHaveBeenCalledTimes(1);
  });
});
