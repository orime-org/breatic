// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What a finished prediction actually cost, read off the vendor's own answer.
 *
 * The shapes here are the response WaveSpeed really returns, captured from a
 * live TTS generation on 2026-09-03: the figure sits at
 * `data.items[].order.price`, one entry per billing line, each carrying its own
 * `billing_type`. This endpoint has no public documentation — that observation
 * is the whole specification, which is why it is written down as cases.
 *
 * Every path that answers zero says so in the log. A silent zero here is
 * indistinguishable from a free generation, and the number it produces is what
 * a charge would be taken on.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type * as sharedModule from "@breatic/shared";
import type * as coreModule from "@breatic/core";

const httpRequestMock = vi.fn();
const warnMock = vi.fn();

vi.mock("@breatic/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof sharedModule>();
  return {
    ...actual,
    httpRequest: (...args: unknown[]) => httpRequestMock(...args),
  };
});

vi.mock("@breatic/core", async (importOriginal) => {
  const actual = await importOriginal<typeof coreModule>();
  return {
    ...actual,
    getWorkerConfig: () => ({
      poll_interval: 1_000,
      poll_max_wait: 999_999,
      billing_timeout: 30_000,
    }),
    logger: {
      info: vi.fn(),
      warn: (...args: unknown[]) => warnMock(...args),
      error: vi.fn(),
      debug: vi.fn(),
    },
  };
});

import { queryBilling } from "@worker/providers/http.js";
import type { ResolvedModel } from "@worker/providers/shared.js";

const RESOLVED: ResolvedModel = {
  modelName: "elevenlabs-v3",
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

/**
 * A billing response carrying the given lines.
 * @param items - The billing lines, in the vendor's own shape.
 * @returns A 200 response.
 */
function billing(items: unknown[]): Response {
  return new Response(
    JSON.stringify({ code: 200, data: { page: 1, has_more: false, items } }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

/**
 * One deducting line at the given price.
 * @param price - What that line charged.
 * @returns A billing line.
 */
function deduct(price: number): unknown {
  return {
    access_key_name: "Breatic_Dev",
    billing_type: "deduct",
    order: { origin_price: price, price, state: "done", status: "" },
    prediction: { model_uuid: "elevenlabs/eleven-v3", status: "completed" },
  };
}

describe("queryBilling reads the vendor's real answer", () => {
  beforeEach(() => {
    httpRequestMock.mockReset();
    warnMock.mockReset();
  });

  // The figure a live 13-character TTS generation was charged.
  it("returns the price the vendor put on the prediction", async () => {
    httpRequestMock.mockResolvedValue(billing([deduct(0.0026)]));

    expect(await queryBilling(RESOLVED, "3cc24f6e")).toBe(0.0026);
    expect(warnMock).not.toHaveBeenCalled();
  });

  it("adds the lines up when one prediction was billed more than once", async () => {
    httpRequestMock.mockResolvedValue(billing([deduct(0.002), deduct(0.0006)]));

    expect(await queryBilling(RESOLVED, "t")).toBeCloseTo(0.0026, 10);
  });

  // Only what was deducted is a cost. A line of any other type is left out
  // rather than added, because adding a refund as spending states the opposite
  // of what happened.
  it("counts only the lines that deducted", async () => {
    httpRequestMock.mockResolvedValue(
      billing([
        deduct(0.0026),
        { billing_type: "refund", order: { price: 0.0026, state: "done" } },
      ]),
    );

    expect(await queryBilling(RESOLVED, "t")).toBe(0.0026);
  });

  it("says so when the vendor lists no billing line for the prediction", async () => {
    httpRequestMock.mockResolvedValue(billing([]));

    expect(await queryBilling(RESOLVED, "t")).toBe(0);
    expect(warnMock).toHaveBeenCalled();
  });

  it("says so when the vendor refuses the lookup", async () => {
    httpRequestMock.mockResolvedValue(new Response("nope", { status: 503 }));

    expect(await queryBilling(RESOLVED, "t")).toBe(0);
    expect(warnMock).toHaveBeenCalled();
  });

  it("says so when the lookup throws", async () => {
    httpRequestMock.mockRejectedValue(new Error("socket hang up"));

    expect(await queryBilling(RESOLVED, "t")).toBe(0);
    expect(warnMock).toHaveBeenCalled();
  });

  // The shape this function read for its whole life, which the vendor never
  // sent. Answering off it again would restore the silent zero.
  it("does not read the shape it used to assume", async () => {
    httpRequestMock.mockResolvedValue(
      new Response(JSON.stringify({ data: [{ price: 9.99 }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    expect(await queryBilling(RESOLVED, "t")).toBe(0);
    expect(warnMock).toHaveBeenCalled();
  });
});
