// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import type { MediaBinding } from "../../../config/schema.js";
import { buildBody } from "../body.js";

interface BodyFixture {
  cases: { model: string; kind: "catalog" | "three_d"; params: Record<string, unknown>; prompt: string; body: Record<string, unknown> }[];
}

const ROOT = resolve(__dirname, "../../../../../..");

/** What today's worker sends for each case (scripts/provider-fixtures.ts). */
const fixture = JSON.parse(readFileSync(resolve(__dirname, "../../../../test/fixtures/upstream-body.json"), "utf8")) as BodyFixture;

/** Every model's WaveSpeed binding, from the binding files the configuration migration writes. */
const bindings = new Map<string, MediaBinding>();
for (const modality of ["image", "video", "audio", "tts", "three_d"]) {
  const file = parse(readFileSync(resolve(ROOT, `config/provider/media/${modality}.yaml`), "utf8")) as {
    models: Record<string, { upstreams: MediaBinding[] }>;
  };
  for (const [model, { upstreams }] of Object.entries(file.models)) {
    const wavespeed = upstreams.find((b) => b.upstream === "wavespeed");
    if (wavespeed !== undefined) bindings.set(model, wavespeed);
  }
}

describe("buildBody — equal to today's WaveSpeed body on every case", () => {
  it("has a WaveSpeed binding for every model in the fixture", () => {
    expect([...new Set(fixture.cases.map((c) => c.model))].filter((m) => !bindings.has(m))).toEqual([]);
  });

  it.each(fixture.cases.map((c, i) => [`${i} ${c.model}`, c] as const))("%s", (_label, c) => {
    expect(buildBody(bindings.get(c.model)!, { params: c.params, prompt: c.prompt })).toEqual(c.body);
  });
});

/**
 * Whether a param holds a value its binding would send.
 * @param value - The param's value in a case.
 * @param absent - The binding's absent_value, which sends nothing.
 * @returns True when the case carries it.
 */
function carried(value: unknown, absent: unknown): boolean {
  return value !== undefined && value !== null && value !== "" && value !== absent && !(Array.isArray(value) && value.length === 0);
}

describe("the body fixture samples every input the bindings read", () => {
  it("carries every bound param with a value in some case of its model, except those an extra step serves", () => {
    const unsampled: string[] = [];
    for (const [model, binding] of bindings) {
      const served = new Set((binding.extra_steps ?? []).map((step) => step.for_param));
      const cases = fixture.cases.filter((c) => c.model === model);
      for (const [name, spec] of Object.entries(binding.params ?? {})) {
        if (served.has(name)) continue;
        if (!cases.some((c) => carried(c.params[name], spec.absent_value))) unsampled.push(`${model}.${name}`);
      }
    }
    expect(unsampled).toEqual([]);
  });

  it("writes a neutral reference for every param a binding names in its mentions", () => {
    const unsampled: string[] = [];
    for (const [model, binding] of bindings) {
      for (const name of Object.keys(binding.mentions ?? {})) {
        if (!fixture.cases.some((c) => c.model === model && c.prompt.includes(`<<ref:${name}:`))) unsampled.push(`${model}.${name}`);
      }
    }
    expect(unsampled).toEqual([]);
  });
});

/** WaveSpeed model ids known to be delisted; a binding to any of them fails at submit. */
const DELISTED_WAVESPEED_IDS: ReadonlySet<string> = new Set([
  "midjourney/image-to-image",
  "midjourney/image-to-video",
  "midjourney/niji/image-to-image",
  "midjourney/niji/text-to-image",
  "midjourney/text-to-image",
  "reve/2.1/text-to-image",
  "topaz/image/enhance",
  "wavespeed-ai/rife/video-interpolation",
]);

describe("WaveSpeed bindings stay live", () => {
  it("bind no model to a WaveSpeed id that was delisted", () => {
    const steps = [...bindings.values()].flatMap((b) => [b.model_id, ...(b.extra_steps ?? []).map((s) => s.endpoint)]);
    expect(steps.filter((id) => DELISTED_WAVESPEED_IDS.has(id))).toEqual([]);
  });
});

