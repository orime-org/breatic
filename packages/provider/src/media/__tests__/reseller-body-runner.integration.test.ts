// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { shipped } from "../../config/__tests__/shipped.js";
import { runnerCalls, type SampleRun } from "./reseller-bodies.js";

/** The reviewed request bodies of one reseller binding (`scripts/provider-reseller-bodies.ts`). */
interface BodySample {
  runs: SampleRun[];
  /** Each extra step on the first run that makes it (`run`, an index into `runs`), as the runner sent it. */
  steps: { kind: string; endpoint: string; run: number; body: Record<string, unknown> }[];
}

const BODIES = resolve(__dirname, "../../../test/fixtures/bodies");
const config = shipped();
const cases = Object.entries(config.media.models).flatMap(([model, { upstreams }]) => upstreams.filter((b) => b.upstream !== "wavespeed").map((binding) => ({ model, binding })));

describe.each(cases)("the request bodies of $model on $binding.upstream", ({ model, binding }) => {
  const path = resolve(BODIES, binding.upstream, `${model}.json`);
  const sample = existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as BodySample) : undefined;

  it("are what the runner sends for each sample run, its own call and each extra step", async () => {
    expect(sample, path).toBeDefined();
    const own = binding.reused_by === undefined ? "generate" : "voice";
    const made: BodySample["steps"] = [];
    for (const [index, run] of sample!.runs.entries()) {
      const calls = await runnerCalls(model, binding, run);
      expect(calls.find((c) => c.kind === own)?.body, JSON.stringify(run.params)).toEqual(run.body);
      for (const call of calls.filter((c) => c.kind !== own)) if (!made.some((s) => s.kind === call.kind)) made.push({ ...call, run: index });
    }
    expect(sample!.steps).toEqual(made);
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
