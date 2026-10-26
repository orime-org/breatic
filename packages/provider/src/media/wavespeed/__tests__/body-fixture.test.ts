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

/** Every model's WaveSpeed binding, from the binding files the configuration migration writes (design 4.5). */
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

describe("buildBody — equal to today's WaveSpeed body on every case (design 13.2)", () => {
  it("has a WaveSpeed binding for every model in the fixture", () => {
    expect([...new Set(fixture.cases.map((c) => c.model))].filter((m) => !bindings.has(m))).toEqual([]);
  });

  it.each(fixture.cases.map((c, i) => [`${i} ${c.model}`, c] as const))("%s", (_label, c) => {
    expect(buildBody(bindings.get(c.model)!, { params: c.params, prompt: c.prompt })).toEqual(c.body);
  });
});

/** WaveSpeed model ids delisted in the 2026-07-15 catalog audit (moved from the worker's model-config-liveness test). */
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

