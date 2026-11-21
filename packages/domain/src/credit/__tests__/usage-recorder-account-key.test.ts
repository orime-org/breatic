// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Usage of a call an account's own key paid for (inner#1953): the row is still written with what the upstream
 * charged, so the account sees its usage, but it carries 0 credits and the id of the key row that paid, and the
 * recorder's charge leaves it out. A call our key paid for in the same operation (a Kling element description on
 * the deployment's OpenRouter key beside a generation on the account's WaveSpeed key) is charged as before.
 */

import { describe, expect, it } from "vitest";

import { createUsageRecorder, type UsageRow } from "@domain/credit/usage-recorder.js";

const PRICING = { services: { brave_web_search: { per_request: 0.005 }, brave_image_search: { per_request: 0.005 } } };
const KEY_ID = "0b6c1a52-1f53-4d6a-9d43-1c0e8d2f7a11";

/**
 * A recorder opened for an operation that runs on an account's key row, writing into an array.
 * @param keyId - The account key row the operation's calls run on, or null for ours.
 * @returns The recorder and its rows.
 */
function recorderOn(keyId: string | null): { recorder: ReturnType<typeof createUsageRecorder>; rows: UsageRow[] } {
  const rows: UsageRow[] = [];
  const recorder = createUsageRecorder({
    operationKey: "turn:c1:3",
    feature: "chat_turn",
    actorUserId: "u1",
    projectId: "p1",
    pricing: PRICING,
    multiplier: 2,
    write: async (row) => void rows.push(row),
    onMissingCost: () => undefined,
    keyId,
  });
  return { recorder, rows };
}

describe("a call paid with an account's key", () => {
  it("writes its row with the dollars, 0 credits and the key row's id, and charges nothing for it", async () => {
    const { recorder, rows } = recorderOn(KEY_ID);
    recorder.recordModelCall({
      source: "model",
      model: "deepseek/deepseek-v4-pro",
      upstream: "openrouter",
      cost: { state: "known", usd: 0.5, source: "reported", payer: "account" } as never,
    });

    expect((await recorder.settleForCharge()).credits).toBe(0);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ costUsd: 0.5, credits: 0, keyId: KEY_ID, provider: "openrouter" });
  });

  it("does the same for a looked-up call the account's key paid for", async () => {
    const { recorder, rows } = recorderOn(KEY_ID);
    recorder.recordLookedUpCall({ source: "model", model: "m", upstream: "openrouter", cost: { state: "known", usd: 0.25, source: "billing", payer: "account" } as never });

    expect((await recorder.settleForCharge()).credits).toBe(0);
    expect(rows[0]).toMatchObject({ costUsd: 0.25, credits: 0, keyId: KEY_ID });
  });

  it("reads an unmarked cost in an operation on the account's key as the account's, as the lookup queue does", async () => {
    const { recorder, rows } = recorderOn(KEY_ID);
    recorder.recordModelCall({ source: "model", model: "m", upstream: "openrouter", cost: { state: "known", usd: 0.5, source: "reported" } as never });

    expect((await recorder.settleForCharge()).credits).toBe(0);
    expect(rows[0]).toMatchObject({ credits: 0, keyId: KEY_ID });
  });

  it("keeps the key row on a looked-up call whose lookup never answered", async () => {
    const { recorder, rows } = recorderOn(KEY_ID);
    recorder.recordLookedUpCall({
      source: "model",
      model: "m",
      upstream: "openrouter",
      cost: { state: "pending", payer: "account", lookup: { upstream: "openrouter", generationId: "gen-1", payer: "account" } } as never,
    });

    expect((await recorder.settleForCharge()).credits).toBe(0);
    expect(rows[0]).toMatchObject({ costSource: "missing", credits: 0, keyId: KEY_ID });
  });

  it("charges the call our key paid for in the same operation, and only that one", async () => {
    const { recorder, rows } = recorderOn(KEY_ID);
    recorder.recordModelCall({ source: "model", model: "video", upstream: "wavespeed", cost: { state: "known", usd: 1, source: "billing", payer: "account" } as never });
    recorder.recordModelCall({ source: "model", model: "google/gemini-test", upstream: "openrouter", cost: { state: "known", usd: 0.5, source: "reported", payer: "deployment" } as never });

    // 0.5 USD at multiplier 2 and 100 credits a dollar.
    expect((await recorder.settleForCharge()).credits).toBe(100);
    const byProvider = Object.fromEntries(rows.map((r) => [r.provider, r]));
    expect(byProvider.wavespeed).toMatchObject({ credits: 0, keyId: KEY_ID });
    expect(byProvider.openrouter).toMatchObject({ credits: 100, keyId: null });
  });
});

describe("a call paid with our key", () => {
  it("writes its row with its credits and no key row", async () => {
    const { recorder, rows } = recorderOn(null);
    recorder.recordModelCall({ source: "model", model: "m", upstream: "openrouter", cost: { state: "known", usd: 0.5, source: "reported", payer: "deployment" } as never });

    expect((await recorder.settleForCharge()).credits).toBe(100);
    expect(rows[0]).toMatchObject({ credits: 100, keyId: null });
  });
});

describe("the canvas generation feature", () => {
  it("records a media generation's usage under its own feature", async () => {
    const rows: UsageRow[] = [];
    const recorder = createUsageRecorder({
      operationKey: "task:t1",
      feature: "canvas_generation",
      actorUserId: "u1",
      projectId: "p1",
      pricing: PRICING,
      multiplier: 1,
      write: async (row) => void rows.push(row),
      onMissingCost: () => undefined,
      keyId: KEY_ID,
    });
    recorder.recordModelCall({ source: "model", model: "seedream-5", upstream: "fal", cost: { state: "known", usd: 0.03, source: "billing", payer: "account" } as never });

    expect((await recorder.settleForCharge()).credits).toBe(0);
    expect(rows[0]).toMatchObject({ feature: "canvas_generation", credits: 0, keyId: KEY_ID });
  });
});

describe("a missing cost and the undercharge it reports (inner#1953)", () => {
  /**
   * A recorder on a key row that records which rows it reported as undercharged.
   * @param keyId - The account key row, or null for ours.
   * @returns The recorder, its rows and the reported rows.
   */
  function reporting(keyId: string | null): { recorder: ReturnType<typeof createUsageRecorder>; rows: UsageRow[]; missing: UsageRow[] } {
    const rows: UsageRow[] = [];
    const missing: UsageRow[] = [];
    const recorder = createUsageRecorder({
      operationKey: "turn:c1:3", feature: "chat_turn", actorUserId: "u1", projectId: "p1", pricing: PRICING, multiplier: 2,
      write: async (row) => void rows.push(row), onMissingCost: (row) => void missing.push(row), keyId,
    });
    return { recorder, rows, missing };
  }

  it("writes the account's missing cost at 0 and reports nothing, since nothing was owed", async () => {
    const { recorder, rows, missing } = reporting(KEY_ID);
    recorder.recordModelCall({ source: "model", model: "m", upstream: "fal", cost: { state: "missing", reason: "no billing permission", payer: "account" } as never });
    await recorder.settleForCharge();
    expect(rows[0]).toMatchObject({ costSource: "missing", credits: 0, keyId: KEY_ID });
    expect(missing).toEqual([]);
  });

  it("still reports a missing cost our keys paid beside the account's", async () => {
    const { recorder, missing } = reporting(KEY_ID);
    recorder.recordModelCall({ source: "model", model: "m", upstream: "openrouter", cost: { state: "missing", reason: "lost", payer: "deployment" } as never });
    await recorder.settleForCharge();
    expect(missing).toEqual([expect.objectContaining({ costSource: "missing", keyId: null })]);
  });
});
