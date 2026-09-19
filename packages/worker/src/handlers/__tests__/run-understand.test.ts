// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What the canvas's understand task runs (#2175).
 *
 * The capability lives in `@breatic/domain` and the agent's tool calls the
 * same one: getting the media and asking about it is one order of steps with
 * one set of limits, and a second assembly of it here would classify failures
 * its own way. So this path supplies the figures and hands over.
 *
 * What comes back is text, and text is what the node gets. Nothing about this
 * run produces an asset, so nothing here reaches for a URL.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import type * as DomainModule from "@breatic/domain";
import type * as CoreModule from "@breatic/core";

vi.mock("@breatic/domain", async (importOriginal) => {
  const actual = await importOriginal<typeof DomainModule>();
  return { ...actual, understandMediaAt: vi.fn() };
});
/**
 * What the deployment's multiplier is worth in these cases.
 *
 * `env` is a Proxy that refuses to be read before `initCore` has run, which
 * a test process never does. One is the schema's own default, so the
 * assertions below read as the plain dollars-to-cents conversion.
 *
 * Hoisted because the factory below is: `vi.mock` is lifted above every
 * import, and a plain `const` read from inside it is read before it exists.
 */
const MULTIPLIER = vi.hoisted(() => 1);

vi.mock("@breatic/core", async (importOriginal) => {
  const actual = await importOriginal<typeof CoreModule>();
  return {
    ...actual,
    getRawEnvVar: vi.fn(() => "test-key"),
    env: { CREDIT_MULTIPLIER: MULTIPLIER },
  };
});

import { MediaUnavailable, understandMediaAt } from "@breatic/domain";

import { runUnderstand } from "@worker/handlers/dispatch.js";

const PARAMS = {
  source_type: "image",
  source_url: "https://assets.invalid/image/a.png",
};

describe("running one understand task", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(understandMediaAt).mockResolvedValue({
      text: "A red bicycle against a brick wall.",
      finishReason: "stop",
      kind: "image",
    });
  });

  it("hands the address and the ceilings to the shared capability", async () => {
    await runUnderstand(PARAMS);

    expect(vi.mocked(understandMediaAt)).toHaveBeenCalledWith(
      expect.objectContaining({
        url: PARAMS.source_url,
        maxBytes: expect.any(Number),
        fetchTimeoutMs: expect.any(Number),
        minBytesPerSec: expect.any(Number),
        readFloorMs: expect.any(Number),
        timeoutMs: expect.any(Number),
        maxOutputTokens: expect.any(Number),
        question: expect.any(String),
        model: expect.any(String),
        apiKey: "test-key",
        baseUrl: expect.any(String),
      }),
    );
  });

  it("carries the text back as the content one node gets", async () => {
    const [result] = await runUnderstand(PARAMS);

    expect(result).toMatchObject({
      outputs: [{ content: "A red bicycle against a brick wall." }],
    });
  });

  // An answer of nothing is a run that finished having put nothing on the
  // node. Writing it would replace whatever the reader had with an empty
  // node while the count says the run succeeded.
  it("refuses an empty answer rather than writing it", async () => {
    vi.mocked(understandMediaAt).mockResolvedValue({
      text: "",
      finishReason: "stop",
      kind: "image",
    });

    await expect(runUnderstand(PARAMS)).rejects.toThrow();
  });

  // The run is gated on credits before it goes out, so it has to be charged
  // after. What it charges is what the service said it took, converted the
  // one way every other transport's cost is: dollars to cents, times the
  // deployment's multiplier.
  it("charges what the service said the call cost", async () => {
    vi.mocked(understandMediaAt).mockResolvedValue({
      text: "A red bicycle.",
      finishReason: "stop",
      kind: "image",
      costUsd: 0.0037,
    });

    const [, credits] = await runUnderstand(PARAMS);

    expect(credits).toBeCloseTo(0.0037 * 100 * MULTIPLIER, 10);
  });

  // A service that answered without saying what it cost has not said zero.
  // Charging zero would be this path inventing a figure; the run is recorded
  // uncharged and reconciliation is where an unpriced run belongs.
  it("charges nothing when the service did not say what it cost", async () => {
    const [, credits] = await runUnderstand(PARAMS);

    expect(credits).toBe(0);
  });

  it("lets the capability's own failures through as they are", async () => {
    vi.mocked(understandMediaAt).mockRejectedValue(new MediaUnavailable("too-large", {}));

    await expect(runUnderstand(PARAMS)).rejects.toBeInstanceOf(
      MediaUnavailable,
    );
  });
});
