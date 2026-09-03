// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * #1960 — what a tts generation actually cost upstream.
 *
 * The transport used to return a hardcoded zero, so every tts run reported no
 * usage at all. WaveSpeed states the real figure on its billing endpoint once
 * the prediction has an id, the same way the audio transport on this vendor
 * already asks — and the number is what a usage record is made of, whether or
 * not anything is charged for it.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type * as httpModule from "@worker/providers/http.js";

import type { ResolvedModel } from "@worker/providers/shared.js";

const requestWithRetryMock = vi.fn();
const pollUntilDoneMock = vi.fn();
const queryBillingMock = vi.fn();

vi.mock("@worker/providers/http.js", async (importOriginal) => {
  const actual = await importOriginal<typeof httpModule>();
  return {
    ...actual,
    requestWithRetry: (...args: unknown[]) => requestWithRetryMock(...args),
    pollUntilDone: (...args: unknown[]) => pollUntilDoneMock(...args),
    queryBilling: (...args: unknown[]) => queryBillingMock(...args),
  };
});

import { generate } from "@worker/providers/tts/transports/wavespeed.js";

const RESOLVED: ResolvedModel = {
  modelName: "elevenlabs-v3-wavespeed",
  modelId: "elevenlabs/eleven-v3",
  providerName: "wavespeed",
  baseUrl: "https://api.wavespeed.test/v3",
  apiKey: "ws-key",
  timeout: 60,
  maxConcurrency: 5,
  costPerCall: 0,
  extraParams: {},
  litellmModel: undefined,
  tokenPrice: undefined,
  creditPrice: undefined,
};

const COMPLETED_RESULT = {
  data: { status: "completed", outputs: ["https://cdn.wavespeed.test/a.mp3"] },
};

describe("tts wavespeed reports what the run cost (#1960)", () => {
  beforeEach(() => {
    requestWithRetryMock.mockReset();
    pollUntilDoneMock.mockReset();
    queryBillingMock.mockReset();
    pollUntilDoneMock.mockResolvedValue(COMPLETED_RESULT);
    queryBillingMock.mockResolvedValue(0);
  });

  it("asks the vendor what the prediction cost, and returns that", async () => {
    requestWithRetryMock.mockResolvedValue({ data: { id: "ws-777" } });
    queryBillingMock.mockResolvedValue(0.031);

    const r = await generate("hello", RESOLVED, { text: "hello" });

    expect(queryBillingMock).toHaveBeenCalledWith(RESOLVED, "ws-777");
    expect(r.cost).toBe(0.031);
  });

  it("asks about the resumed prediction, not a fresh one", async () => {
    // A BullMQ retry skips the submit entirely, and the run it is billing for
    // is the one whose id was stored.
    const r = await generate("hello", RESOLVED, { text: "hello" }, {
      storedTaskId: "ws-resumed",
      persistTaskId: vi.fn(async () => {}),
      externalTaskId: "breatic-task-abc",
    });

    expect(requestWithRetryMock).not.toHaveBeenCalled();
    expect(queryBillingMock).toHaveBeenCalledWith(RESOLVED, "ws-resumed");
    expect(r.cost).toBe(0);
  });

  // A submit that already carries outputs leaves no prediction to look up, so
  // there is nothing to ask about — asking with the `""` sentinel would query
  // a task that does not exist.
  it("does not ask when the submit answered synchronously with no id", async () => {
    requestWithRetryMock.mockResolvedValue(COMPLETED_RESULT);

    const r = await generate("hello", RESOLVED, { text: "hello" });

    expect(queryBillingMock).not.toHaveBeenCalled();
    expect(r.cost).toBe(0);
  });
});
