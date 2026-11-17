// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A long recording read in batches runs every batch on the key set its caller resolved for the paying account
 * (inner#1953): no batch falls back to our keys, and a failure of the account's key stops the reading as itself.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { KeySet } from "@breatic/provider";

const understandMediaAtMock = vi.fn();
vi.mock("@domain/understand/understand-at.js", () => ({
  understandMediaAt: (...args: unknown[]) => understandMediaAtMock(...args),
}));

import { understandMediaInBatches } from "@domain/understand/understand-segment-batches.js";

const ACCOUNT: KeySet = { owner: "account", keyOf: (upstream: string) => (upstream === "openrouter" ? "sk-or-v1-acct" : undefined) };

const request = {
  question: "Describe the recording.",
  maxBytes: 5,
  fetchTimeoutMs: 30_000,
  minBytesPerSec: 65_536,
  readFloorMs: 5_000,
  timeoutMs: 180_000,
  model: "google/gemini-3.8-flash",
  maxOutputTokens: 2048,
  maxItems: 2,
  onBilled: vi.fn(),
};

/** Four segments the limits above put into two batches. */
const segments = [
  { url: "https://media.example/0.mp3", ledgerType: "audio/mpeg", sizeBytes: 3, startUs: "0", endUs: "300000000" },
  { url: "https://media.example/1.mp3", ledgerType: "audio/mpeg", sizeBytes: 2, startUs: "300000000", endUs: "600000000" },
  { url: "https://media.example/2.mp3", ledgerType: "audio/mpeg", sizeBytes: 2, startUs: "600000000", endUs: "900000000" },
  { url: "https://media.example/3.mp3", ledgerType: "audio/mpeg", sizeBytes: 1, startUs: "900000000", endUs: "1200000000" },
];

beforeEach(() => {
  understandMediaAtMock.mockReset();
  understandMediaAtMock.mockResolvedValue({ text: "An interval.", finishReason: "stop", kind: "audio", kinds: ["audio", "audio"] });
});

describe("understandMediaInBatches on a key set", () => {
  it("hands every batch the key set it was given", async () => {
    await understandMediaInBatches({ ...request, keys: ACCOUNT }, segments);

    expect(understandMediaAtMock).toHaveBeenCalledTimes(2);
    for (const [batch] of understandMediaAtMock.mock.calls as [{ keys?: unknown }][]) expect(batch.keys).toBe(ACCOUNT);
  });

  it("hands no batch a key set when none was resolved, so our keys are used", async () => {
    await understandMediaInBatches(request, segments);

    for (const [batch] of understandMediaAtMock.mock.calls as [{ keys?: unknown }][]) expect(batch.keys).toBeUndefined();
  });

  it("stops at the first batch whose account key fails, keeping the key's own kind on the chain", async () => {
    understandMediaAtMock.mockRejectedValueOnce(Object.assign(new Error("Insufficient credits"), { kind: "account_key_failed", reason: "no_balance", upstream: "openrouter" }));

    const thrown = await understandMediaInBatches({ ...request, keys: ACCOUNT }, segments).then(() => undefined, (err: unknown) => err);

    expect(understandMediaAtMock).toHaveBeenCalledTimes(1);
    expect((thrown as { cause?: { kind?: unknown } }).cause?.kind).toBe("account_key_failed");
  });
});
