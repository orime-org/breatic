// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import type { MediaBinding } from "../../../config/schema.js";
import { buildBody } from "../../body.js";

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

/** Models WaveSpeed no longer serves (absent from `/api/v3/models` on 2026-11-01): they carry no WaveSpeed binding. */
const OFF_WAVESPEED: ReadonlySet<string> = new Set(["meshy6-t23d", "veed-clean-audio", "recraft-v4-style-text-to-image", "sfx-1.6-extend-audio"]);

/**
 * Where a binding departs from today's body on purpose, by model: a field renamed to the
 * name WaveSpeed's schema gives it (WaveSpeed takes both and echoes the schema's name,
 * probed 2026-11-01), or a field left out because WaveSpeed's schema has none and it
 * ignores the field (inner#1872, inner#1873).
 */
const DEPARTURES: Readonly<Record<string, { rename?: Record<string, string>; omit?: string[] }>> = {
  "flux-3-start-end-to-video": { rename: { start_image: "image", end_image: "last_image" } },
  "muse-image-edit": { rename: { image_urls: "images" } },
  "wan-3.0-text-to-video": { rename: { enable_audio: "generate_audio" } },
  "wan-3.0-image-to-video": { rename: { enable_audio: "generate_audio" } },
  "wan-3.0-reference-to-video": { rename: { enable_audio: "generate_audio" } },
  "elevenlabs-v3": { omit: ["similarity"] },
  "sfx-1.6-text-to-audio": { omit: ["ambience"] },
  "hunyuan3d-v3-i23d": { omit: ["prompt"] },
  "hunyuan3d-v3.1-rapid": { omit: ["prompt"] },
};

/** Params the application writes into the prompt (`into_prompt`); a run never sends them as fields. */
const intoPrompt = new Map<string, Set<string>>();
for (const file of ["image", "video", "audio", "tts"]) {
  const catalog = parse(readFileSync(resolve(ROOT, `config/models/${file}/models.yaml`), "utf8")) as {
    models: { name: string; params?: Record<string, { into_prompt?: string; upstream?: string }> }[];
  };
  for (const model of catalog.models) {
    const fields = Object.entries(model.params ?? {}).filter(([, p]) => p.into_prompt !== undefined).map(([name, p]) => p.upstream ?? name);
    if (fields.length > 0) intoPrompt.set(model.name, new Set(fields));
  }
}

/**
 * Today's body as the binding now writes it: the departures applied.
 * @param model - The model.
 * @param body - Today's body.
 * @returns The body the binding is expected to build.
 */
function expectedBody(model: string, body: Record<string, unknown>): Record<string, unknown> {
  const departure = DEPARTURES[model] ?? {};
  const omitted = new Set([...(departure.omit ?? []), ...(intoPrompt.get(model) ?? [])]);
  return Object.fromEntries(
    Object.entries(body).filter(([field]) => !omitted.has(field)).map(([field, value]) => [departure.rename?.[field] ?? field, value]),
  );
}

const liveCases = fixture.cases.filter((c) => !OFF_WAVESPEED.has(c.model));

describe("buildBody — today's WaveSpeed body on every case, departures applied", () => {
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
  "wavespeed-ai/meshy6/text-to-3d",
  "veed/clean-audio",
  "recraft-ai/recraft-v4-style/text-to-image",
  "mirelo-ai/sfx-1.6/extend-audio",
]);

describe("WaveSpeed bindings stay live", () => {
  it("bind no model to a WaveSpeed id that was delisted", () => {
    const steps = [...bindings.values()].flatMap((b) => [b.model_id, ...(b.extra_steps ?? []).map((s) => s.endpoint)]);
    expect(steps.filter((id) => DELISTED_WAVESPEED_IDS.has(id))).toEqual([]);
  });
});

