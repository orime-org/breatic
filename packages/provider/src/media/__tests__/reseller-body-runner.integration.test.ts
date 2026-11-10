// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { shipped } from "../../config/__tests__/shipped.js";
import { sampledCalls, type SampleRun, type SampleStep } from "./reseller-bodies.js";

/** The reviewed request bodies of one reseller binding (`scripts/provider-reseller-bodies.ts`). */
interface BodySample {
  runs: SampleRun[];
  steps: SampleStep[];
}

const BODIES = resolve(__dirname, "../../../test/fixtures/bodies");
const config = shipped();
const cases = Object.entries(config.media.models).flatMap(([model, { upstreams }]) => upstreams.filter((b) => b.upstream !== "wavespeed").map((binding) => ({ model, binding })));

describe.each(cases)("the request bodies of $model on $binding.upstream", ({ model, binding }) => {
  const path = resolve(BODIES, binding.upstream, `${model}.json`);
  const sample = existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as BodySample) : undefined;

  it("are what the runner sends for each sample run, its own call and each extra step", async () => {
    expect(sample, path).toBeDefined();
    expect(await sampledCalls(model, binding, sample!.runs)).toEqual({ runs: sample!.runs, steps: sample!.steps });
  });

  it("send each extra step only the source of the param it serves", () => {
    const wrong: string[] = [];
    for (const step of sample?.steps ?? []) {
      const param = binding.extra_steps?.find((s) => s.kind === step.kind)?.for_param;
      const value = param === undefined ? undefined : sample!.runs[step.run]!.params[param];
      const own = (Array.isArray(value) ? value : [value]).filter((v): v is string => typeof v === "string");
      for (const url of JSON.stringify(step.body).match(/https:\/\/example\.com\/[^"]+/g) ?? []) if (!own.includes(url)) wrong.push(`${step.kind} sends ${url}`);
    }
    expect(wrong).toEqual([]);
  });
});
