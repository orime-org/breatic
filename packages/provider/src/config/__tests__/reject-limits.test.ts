// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * #1521: every shipped input limit that a count says carries that count as its `limit`, so the application can tell the
 * user which limit a run broke; the count in `limit` is the one in `when`, read in our param names.
 */

import { describe, expect, it } from "vitest";
import { shipped } from "@provider/config/__tests__/shipped.js";

interface ShippedReject { when: string; reason: string; limit?: Record<string, unknown> }
interface ShippedBinding { upstream: string; prompt_field?: string; params?: Record<string, { field: string }>; rejects?: ShippedReject[]; dialogue?: { field: string } }
interface ShippedModel { rejects?: ShippedReject[]; upstreams: ShippedBinding[] }

/** A whole-value count of one field: `$length(F) > N`, `$length(F) < N`, optionally after a condition joined by `and`. */
const WHOLE = /^(?:.+ and )?\$length\((\w+)\) ([<>]) (\d+)$/;
/** A count of each item of a list field: `$max(L.$length(F)) > N`. */
const PER_ITEM = /^\$max\((\w+)\.\$length\(\w+\)\) > (\d+)$/;
/** A count of a list's items: `$count(L) > N`. */
const ITEMS = /^\$count\((\w+)\) > (\d+)$/;

/**
 * Each shipped reject, with how its condition's names read as ours.
 * @returns The rejects, each with its place and a namer.
 */
function shippedRejects(): { at: string; reject: ShippedReject; ours: (field: string) => string; turns?: string }[] {
  const models = shipped().media.models as unknown as Record<string, ShippedModel>;
  return Object.entries(models).flatMap(([model, m]) => [
    ...(m.rejects ?? []).map((reject) => ({ at: model, reject, ours: (f: string) => f })),
    ...m.upstreams.flatMap((b) => (b.rejects ?? []).map((reject) => ({
      at: `${model} on ${b.upstream}`,
      reject,
      ours: (f: string): string =>
        f === b.prompt_field ? "prompt" : (Object.entries(b.params ?? {}).find(([, bound]) => bound.field === f)?.[0] ?? f),
      ...(b.dialogue === undefined ? {} : { turns: b.dialogue.field }),
    }))),
  ]);
}

/**
 * The limit a condition's count states, in our names: a dialogue's turns are the script's lines.
 * @param when - The condition.
 * @param ours - Our name for one of the condition's fields.
 * @param turns - The field a dialogue's turns go under, when the binding sends them.
 * @returns The limit, or undefined when no count shape matches.
 */
function wantedLimit(when: string, ours: (field: string) => string, turns: string | undefined): Record<string, unknown> | undefined {
  const whole = WHOLE.exec(when);
  if (whole) return { field: ours(whole[1]!), measure: "characters", [whole[2] === ">" ? "max" : "min"]: Number(whole[3]) };
  const perItem = PER_ITEM.exec(when);
  if (perItem) {
    return perItem[1] === turns
      ? { field: "prompt", measure: "characters", max: Number(perItem[2]), per: "line" }
      : { field: ours(perItem[1]!), measure: "characters", max: Number(perItem[2]), per: "item" };
  }
  const items = ITEMS.exec(when);
  if (items && items[1] === turns) return { field: "prompt", measure: "lines", max: Number(items[2]) };
  return undefined;
}

describe("shipped rejects", () => {
  it("carry the count their condition says, in our param names", () => {
    const wrong: string[] = [];
    for (const { at, reject, ours, turns } of shippedRejects()) {
      const want = wantedLimit(reject.when, ours, turns);
      if (want !== undefined && JSON.stringify(reject.limit) !== JSON.stringify(want)) {
        wrong.push(`${at}: ${reject.when} has ${JSON.stringify(reject.limit)}, wants ${JSON.stringify(want)}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it("leave no condition that counts characters without the limit it states", () => {
    const silent = shippedRejects().filter(({ reject }) => reject.when.includes("$length(") && reject.limit === undefined).map(({ at, reject }) => `${at}: ${reject.when}`);
    expect(silent).toEqual([]);
  });

  it("give HappyHorse its 5000 characters and its 2500 Chinese characters as two limits", () => {
    const limits = shippedRejects().filter((r) => r.at === "happyhorse-1.1-reference-to-video" && r.reject.limit !== undefined).map((r) => r.reject.limit);
    expect(limits).toEqual([
      { field: "prompt", measure: "characters", max: 5000 },
      { field: "prompt", measure: "chinese_characters", max: 2500 },
    ]);
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
