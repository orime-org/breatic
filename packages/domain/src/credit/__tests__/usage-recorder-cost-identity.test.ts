// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * A model call may carry a stable cost identity (inner#1711 design §3.5): a Timeline execution's calls are recorded
 * as `timeline:<executionId>:<seq>`, and the row the recorder writes carries that identity so a second settlement of
 * the same call writes nothing.
 */

import { describe, it, expect } from "vitest";

import { createUsageRecorder, type UsageRow } from "@domain/credit/usage-recorder.js";

const PRICING = {
  models: {},
  services: { brave_web_search: { per_request: 0.005 } },
};

const TIMELINE_USAGE = {
  inputTokens: 1_200,
  inputTokenDetails: { noCacheTokens: 1_000, cacheReadTokens: 200 },
  outputTokens: 300,
  outputTokenDetails: { reasoningTokens: 100 },
};

/**
 * A Timeline execution's recorder whose writes land in an array.
 * @returns The recorder and the rows it wrote.
 */
function timelineRecorder(): { recorder: ReturnType<typeof createUsageRecorder>; rows: UsageRow[]; missing: UsageRow[] } {
  const rows: UsageRow[] = [];
  const missing: UsageRow[] = [];
  const recorder = createUsageRecorder({
    operationKey: "timeline:11111111-1111-4111-8111-111111111111",
    feature: "timeline_web_animation",
    actorUserId: "u1",
    projectId: "p1",
    pricing: PRICING,
    multiplier: 1,
    write: async (row) => void rows.push(row),
    onMissingCost: (row) => void missing.push(row),
  });
  return { recorder, rows, missing };
}

describe("a model call's cost identity", () => {
  it("is written on the row, with OpenRouter's reported cost taken as the provider's", async () => {
    const { recorder, rows, missing } = timelineRecorder();
    recorder.recordModelCall({
      source: "model",
      model: "deepseek/deepseek-v4.1-flash-1017",
      provider: "openrouter",
      usage: TIMELINE_USAGE,
      providerMetadata: { openrouter: { usage: { cost: 0.0125 } } },
      generationId: "gen-1",
      costIdentity: "timeline:11111111-1111-4111-8111-111111111111:1",
    });
    expect(await recorder.settle()).toBe(1.25);
    expect(rows).toEqual([
      {
        operationKey: "timeline:11111111-1111-4111-8111-111111111111",
        feature: "timeline_web_animation",
        source: "model",
        actorUserId: "u1",
        projectId: "p1",
        model: "deepseek/deepseek-v4.1-flash-1017",
        provider: "openrouter",
        inputTokens: 1_200,
        cachedInputTokens: 200,
        outputTokens: 300,
        reasoningTokens: 100,
        requestCount: null,
        costUsd: 0.0125,
        costSource: "provider",
        credits: 1.25,
        costIdentity: "timeline:11111111-1111-4111-8111-111111111111:1",
      },
    ]);
    expect(missing).toEqual([]);
  });

  it("is null on a row whose call carries none", async () => {
    const { recorder, rows } = timelineRecorder();
    recorder.recordModelCall({
      source: "model",
      model: "deepseek/deepseek-v4.1-flash-1017",
      provider: "openrouter",
      usage: TIMELINE_USAGE,
      providerMetadata: { openrouter: { usage: { cost: 0.5 } } },
    });
    recorder.recordServiceCall({ source: "container", service: "cloudflare-container:web_animation", provider: "cloudflare", requests: 1, costUsd: 0.01, costSource: "computed" });
    await recorder.settle();
    expect(rows.map((row) => row.costIdentity)).toEqual([null, null]);
  });

  it("is kept on a call recorded at zero because its cost is missing", async () => {
    const { recorder, rows, missing } = timelineRecorder();
    recorder.recordModelCall({
      source: "model",
      model: "deepseek/deepseek-v4.1-flash-1017",
      provider: "openrouter",
      usage: TIMELINE_USAGE,
      providerMetadata: undefined,
      costIdentity: "timeline:11111111-1111-4111-8111-111111111111:3",
    });
    expect(await recorder.settle()).toBe(0);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ costUsd: 0, costSource: "missing", credits: 0, costIdentity: "timeline:11111111-1111-4111-8111-111111111111:3" });
    expect(missing.map((row) => row.costIdentity)).toEqual(["timeline:11111111-1111-4111-8111-111111111111:3"]);
  });
});
