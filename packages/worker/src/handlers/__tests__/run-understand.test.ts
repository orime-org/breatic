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

vi.mock("@breatic/domain", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@breatic/domain")>();
  return { ...actual, understandMediaAt: vi.fn() };
});
vi.mock("@breatic/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@breatic/core")>();
  return { ...actual, getRawEnvVar: vi.fn(() => "test-key") };
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

  it("lets the capability's own failures through as they are", async () => {
    vi.mocked(understandMediaAt).mockRejectedValue(new MediaUnavailable("too-large", {}));

    await expect(runUnderstand(PARAMS)).rejects.toBeInstanceOf(
      MediaUnavailable,
    );
  });
});
