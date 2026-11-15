// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * #1521: every shipped input limit that a count says carries that count as its `limit`, so the application can tell the
 * user which limit a run broke; the count in `limit` is the one in `when`, read in our param names.
 */

import { describe, expect, it } from "vitest";
import { shipped } from "@provider/config/__tests__/shipped.js";

interface ShippedReject { when: string; reason: string; limit?: Record<string, unknown> }
interface ShippedBinding { upstream: string; prompt_field?: string; params?: Record<string, { field: string }>; rejects?: ShippedReject[] }
interface ShippedModel { rejects?: ShippedReject[]; upstreams: ShippedBinding[] }

/** A whole-value count of one field: `$length(F) > N`, `$length(F) < N`, optionally after a condition joined by `and`. */
const WHOLE = /^(?:.+ and )?\$length\((\w+)\) ([<>]) (\d+)$/;
/** A count of each item of a list field: `$max(L.$length(F)) > N`. */
const PER_ITEM = /^\$max\((\w+)\.\$length\(\w+\)\) > (\d+)$/;

/**
 * Each shipped reject, with how its condition's names read as ours.
 * @returns The rejects, each with its place and a namer.
 */
function shippedRejects(): { at: string; reject: ShippedReject; ours: (field: string) => string }[] {
  const models = shipped().media.models as unknown as Record<string, ShippedModel>;
  return Object.entries(models).flatMap(([model, m]) => [
    ...(m.rejects ?? []).map((reject) => ({ at: model, reject, ours: (f: string) => f })),
    ...m.upstreams.flatMap((b) => (b.rejects ?? []).map((reject) => ({
      at: `${model} on ${b.upstream}`,
      reject,
      ours: (f: string): string =>
        f === b.prompt_field ? "prompt" : (Object.entries(b.params ?? {}).find(([, bound]) => bound.field === f)?.[0] ?? f),
    }))),
  ]);
}

describe("shipped rejects", () => {
  it("carry the count their condition says, in our param names", () => {
    const wrong: string[] = [];
    for (const { at, reject, ours } of shippedRejects()) {
      const whole = WHOLE.exec(reject.when);
      const perItem = PER_ITEM.exec(reject.when);
      const want = whole
        ? { field: ours(whole[1]!), measure: "characters", [whole[2] === ">" ? "max" : "min"]: Number(whole[3]) }
        : perItem
          ? { field: ours(perItem[1]!), measure: "characters", max: Number(perItem[2]), per: "item" }
          : undefined;
      if (want !== undefined && JSON.stringify(reject.limit) !== JSON.stringify(want)) {
        wrong.push(`${at}: ${reject.when} has ${JSON.stringify(reject.limit)}, wants ${JSON.stringify(want)}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it("give Gemini 3.8's three WaveSpeed limits as the whole script, one line and the lines", () => {
    const limits = shippedRejects().filter((r) => r.at === "gemini-3.8-flash-text-to-speech on wavespeed").map((r) => r.reject.limit);
    expect(limits).toEqual([
      { field: "prompt", measure: "characters", max: 8000 },
      { field: "prompt", measure: "characters", max: 8000, per: "line" },
      { field: "prompt", measure: "lines", max: 100 },
    ]);
  });
});
