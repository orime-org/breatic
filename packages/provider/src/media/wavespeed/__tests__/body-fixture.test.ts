// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { catalog, shipped } from "../../../config/__tests__/shipped.js";
import { buildBody } from "../../body.js";
import { ADDED_AFTER_FREEZE, DEPARTURES, OFF_WAVESPEED } from "./departures.js";

interface BodyFixture {
  cases: { model: string; params: Record<string, unknown>; prompt: string; body: Record<string, unknown> }[];
}

/** What the worker sent before provider for each case, frozen in test/fixtures before the move. */
const fixture = JSON.parse(readFileSync(resolve(__dirname, "../../../../test/fixtures/upstream-body.json"), "utf8")) as BodyFixture;

/** Every model's WaveSpeed binding, from the binding files the configuration migration writes. */
const bindings = new Map(Object.entries(shipped().media.models).flatMap(([model, { upstreams }]) => upstreams.filter((b) => b.upstream === "wavespeed").map((b) => [model, b] as const)));

/** Params the application writes into the prompt (`into_prompt`); a run never sends them as fields. */
const intoPrompt = new Map(catalog().models.flatMap((model) => {
  const fields = Object.entries(model.params as Record<string, { into_prompt?: string; upstream?: string }>).filter(([, p]) => p.into_prompt !== undefined).map(([name, p]) => p.upstream ?? name);
  return fields.length === 0 ? [] : [[model.name, new Set(fields)] as const];
}));

/**
 * The body before provider as the binding now writes it: the departures applied.
 * @param model - The model.
 * @param body - The body before provider.
 * @returns The body the binding is expected to build.
 */
function expectedBody(model: string, body: Record<string, unknown>): Record<string, unknown> {
  const departure = DEPARTURES[model] ?? {};
  const omitted = new Set([...(departure.omit ?? []), ...(intoPrompt.get(model) ?? [])]);
  return Object.fromEntries(
    Object.entries(body).filter(([field]) => !omitted.has(field)).map(([field, value]) => [
      departure.rename?.[field] ?? field,
      field === "prompt" && typeof value === "string" && departure.prompt !== undefined ? departure.prompt(value) : value,
    ]),
  );
}

const liveCases = fixture.cases.filter((c) => !OFF_WAVESPEED.has(c.model));

describe("buildBody — the WaveSpeed body before provider on every case, departures applied", () => {
  it("has a WaveSpeed binding for every model WaveSpeed still serves", () => {
    expect([...new Set(liveCases.map((c) => c.model))].filter((m) => !bindings.has(m))).toEqual([]);
  });

  it("binds no model WaveSpeed no longer serves", () => {
    expect([...OFF_WAVESPEED].filter((m) => bindings.has(m))).toEqual([]);
  });

  it.each(liveCases.map((c, i) => [`${i} ${c.model}`, c] as const))("%s", (_label, c) => {
    expect(buildBody(bindings.get(c.model)!, { params: c.params, prompt: c.prompt })).toEqual(expectedBody(c.model, c.body));
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

describe("a param the catalog gained after the code before provider was frozen", () => {
  it("is sent to WaveSpeed under its own name", () => {
    const binding = bindings.get("minimax-speech-2.8-hd")!;
    const body = buildBody(binding, { params: { voice_id: "Wise_Woman", language_boost: "Chinese,Yue" }, prompt: "hello" });
    expect(body).toMatchObject({ text: "hello", voice_id: "Wise_Woman", language_boost: "Chinese,Yue" });
  });

  it("sends a voice described in words as WaveSpeed's voice design takes it", () => {
    const binding = bindings.get("qwen3-tts-voice-design")!;
    const body = buildBody(binding, { params: { voice_description: "A calm narrator", language: "English" }, prompt: "hello" });
    expect(body).toEqual({ text: "hello", voice_description: "A calm narrator", language: "English" });
  });

  it("keeps the rig switch off a Tripo generation's own body", () => {
    for (const model of ["tripo-h3.1-t23d", "tripo-h3.1-i23d", "tripo-h3.1-multiview"]) {
      const body = buildBody(bindings.get(model)!, { params: { rig_skeleton: true }, prompt: "a knight" });
      expect(body, model).not.toHaveProperty("rig_skeleton");
    }
  });
});

describe("the body fixture samples every input the bindings read", () => {
  it("carries every bound param with a value in some case of its model, except those an extra step serves or the comparison omits", () => {
    const unsampled: string[] = [];
    for (const [model, binding] of bindings) {
      const served = new Set([
        ...(binding.extra_steps ?? []).map((step) => step.for_param),
        ...(DEPARTURES[model]?.omit ?? []),
        ...(ADDED_AFTER_FREEZE[model] ?? []),
      ]);
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
        if (!fixture.cases.some((c) => c.model === model && c.prompt.includes(`{{ref:${name}:`))) unsampled.push(`${model}.${name}`);
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
  "veed/clean-audio",
  "recraft-ai/recraft-v4-style/text-to-image",
]);

describe("WaveSpeed bindings stay live", () => {
  it("bind no model to a WaveSpeed id that was delisted", () => {
    const steps = [...bindings.values()].flatMap((b) => [b.model_id, ...(b.extra_steps ?? []).map((s) => s.endpoint)]);
    expect(steps.filter((id) => DELISTED_WAVESPEED_IDS.has(id))).toEqual([]);
  });
});

