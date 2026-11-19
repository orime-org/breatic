// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * inner#1306 §11.5: a vendor's per-call length limit is a reject whose condition reads `get_duration` of one of our
 * params, and it states that length as its `limit` in seconds, so the application reads the number from provider
 * (panels, admission messages, the Agent's guide) and keeps no second copy.
 */

import { describe, expect, it } from "vitest";
import { rejectSchema } from "@provider/pricing/estimate.js";
import { createProvider } from "@provider/provider.js";
import { shipped } from "@provider/config/__tests__/shipped.js";

interface ShippedReject { when: string; limit?: Record<string, unknown> }
interface ShippedModel { rejects?: ShippedReject[] }

/** A whole length of one param: `get_duration(F) > N` or `get_duration(F) < N`, optionally after `... or`. */
const LENGTH = /^get_duration\((\w+)\) ([<>]) (\d+(?:\.\d+)?)$/;

/**
 * Every model-level reject in the shipped media configuration.
 * @returns Each reject with its model.
 */
function modelRejects(): { model: string; reject: ShippedReject }[] {
  const models = shipped().media.models as unknown as Record<string, ShippedModel>;
  return Object.entries(models).flatMap(([model, m]) => (m.rejects ?? []).map((reject) => ({ model, reject })));
}

describe("seconds limits", () => {
  it("accept seconds as a measure of a param's length", () => {
    const parsed = rejectSchema.safeParse({
      when: "get_duration(video) > 60", reason: "at most 60 s",
      limit: { field: "video", measure: "seconds", max: 60 },
    });
    expect(parsed.success).toBe(true);
  });

  it("are stated by every shipped reject on one param's whole length", () => {
    const wrong: string[] = [];
    for (const { model, reject } of modelRejects()) {
      const length = LENGTH.exec(reject.when);
      if (length === null) continue;
      const want = { field: length[1], measure: "seconds", [length[2] === ">" ? "max" : "min"]: Number(length[3]) };
      if (JSON.stringify(reject.limit) !== JSON.stringify(want)) wrong.push(`${model}: ${reject.when} has ${JSON.stringify(reject.limit)}`);
    }
    expect(wrong).toEqual([]);
  });

  it("give the batch 6 models their measured per-call lengths", () => {
    const limitsOf = (model: string): unknown[] => modelRejects().filter((r) => r.model === model).map((r) => r.reject.limit);
    expect(limitsOf("bria-video-eraser-mask")).toEqual(expect.arrayContaining([
      { field: "video", measure: "seconds", min: 1 }, { field: "video", measure: "seconds", max: 5 },
    ]));
    expect(limitsOf("bria-fibo-video-background-remover")).toEqual(expect.arrayContaining([{ field: "video", measure: "seconds", max: 60 }]));
    expect(limitsOf("sam3-video-rle")).toEqual(expect.arrayContaining([{ field: "video", measure: "seconds", max: 600 }]));
  });

  it("are handed to the application by inputLimits, in the model's order", () => {
    const provider = createProvider({ config: shipped(), keyOf: () => undefined, llmMaxRetries: 0, cleanText: (text) => text });
    expect(provider.inputLimits("bria-video-eraser-mask")).toEqual([
      { field: "video", measure: "seconds", min: 1 }, { field: "video", measure: "seconds", max: 5 },
    ]);
    expect(provider.inputLimits("no-such-model")).toEqual([]);
  });
});
