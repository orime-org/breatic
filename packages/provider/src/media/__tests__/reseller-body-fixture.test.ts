// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { catalog, coveredValues, shipped } from "../../config/__tests__/shipped.js";
import { missingRequired, type SchemaSnapshot } from "../../config/upstream-schema.js";
import { takes, type SampleRun } from "./reseller-bodies.js";

/** The reviewed request bodies of one reseller binding (`scripts/provider-reseller-bodies.ts`). */
interface BodySample {
  model: string;
  upstream: string;
  model_id: string;
  /** The first run is the one the application sends: every param at its default, the sources the model needs at a sample url and a voice from the upstream's list. */
  runs: SampleRun[];
  /** Values of a param that the binding takes in no run, each refused on the default run. */
  untaken?: { param: string; value: unknown }[];
  /** Each extra step on the first run that makes it (`run`, an index into `runs`), as the runner sent it (reseller-body-runner.integration.test.ts). */
  steps: { kind: string; endpoint: string; run: number; body: Record<string, unknown> }[];
}

const BODIES = resolve(__dirname, "../../../test/fixtures/bodies");
const config = shipped();
const catalogModels = catalog().models;
const offered = new Map(catalogModels.map((m) => [m.name, m.params as Record<string, { values?: unknown[]; min?: number; max?: number; accepts?: string; fill?: string }>]));
/** Per model, the params of which a run must carry at least one, per mode, as the catalog lists them. */
const sourceGroups = new Map(catalogModels.map((m) => [m.name, m.source_groups ?? []] as const));
const cases = Object.entries(config.media.models).flatMap(([model, { upstreams }]) => upstreams.filter((b) => b.upstream !== "wavespeed").map((binding) => ({ model, binding })));
/**
 * The committed sample of a binding.
 * @param upstream - The upstream.
 * @param model - Our model.
 * @returns The sample, or undefined when none is committed.
 */
function sampleOf(upstream: string, model: string): BodySample | undefined {
  const path = resolve(BODIES, upstream, `${model}.json`);
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as BodySample) : undefined;
}

describe.each(cases)("the request bodies of $model on $binding.upstream", ({ model, binding }) => {
  const sample = sampleOf(binding.upstream, model);

  it("have a committed sample", () => {
    expect(sample, `test/fixtures/bodies/${binding.upstream}/${model}.json`).toBeDefined();
    expect(sample?.model_id).toBe(binding.model_id);
  });
  if (sample === undefined) return;

  it("show only runs the binding takes", async () => {
    const refused: string[] = [];
    for (const run of sample.runs) if (!(await takes(model, binding, run.params, run.prompt))) refused.push(JSON.stringify(run.params));
    expect(refused).toEqual([]);
  });

  it("send every field the upstream requires, as a run the application sends does", () => {
    const path = resolve(__dirname, "../../../test/fixtures/upstream-schemas", binding.upstream, `${binding.model_id}.json`);
    const snapshot = JSON.parse(readFileSync(path, "utf8")) as SchemaSnapshot;
    const missing = sample.runs.flatMap((run) => missingRequired(snapshot, run.body).map((field) => `${field} in ${JSON.stringify(run.params)}`));
    expect(missing).toEqual([]);
  });

  it("start from a run the application sends, carrying the material the model's first source group needs", () => {
    const group = sourceGroups.get(model)?.[0];
    if (group === undefined) return;
    const first = sample.runs[0]!.params;
    expect(group.any_of.filter((p) => first[p] !== undefined && first[p] !== null), JSON.stringify(group)).not.toEqual([]);
  });

  it("start from a run carrying each param the panel always sends, the text the editor holds", () => {
    const first = sample.runs[0]!.params;
    const editor = Object.entries(offered.get(model) ?? {}).filter(([, p]) => p.fill === "editor").map(([name]) => name);
    expect(editor.filter((name) => typeof first[name] !== "string" || first[name] === "")).toEqual([]);
  });

  it("sample each source at a url named by its param, of the kind it accepts", () => {
    const EXTENSIONS: Record<string, string> = { image: "(png|jpe?g|webp)", video: "mp4", audio: "mp3" };
    const wrong: string[] = [];
    for (const [name, param] of Object.entries(offered.get(model) ?? {})) {
      const ext = param.accepts === undefined ? undefined : EXTENSIONS[param.accepts];
      if (ext === undefined) continue;
      const pattern = new RegExp(`/${name}\\.${ext}$`);
      const values = sample.runs.map((r) => r.params[name]);
      for (const value of values) {
        for (const url of (Array.isArray(value) ? value : [value]).filter((v): v is string => typeof v === "string")) {
          if (!pattern.test(url)) wrong.push(`${name}=${url}`);
        }
      }
    }
    expect([...new Set(wrong)]).toEqual([]);
  });

  it("write each reference into the prompt the way the binding's mentions name it, in some run", () => {
    const unshown = Object.keys(binding.mentions ?? {}).filter((param) => {
      const drop = binding.drops?.[param];
      if (Array.isArray(drop) && drop.length === 0) return false;
      return !sample.runs.some((r) => r.prompt.includes(`<<ref:${param}:`) && r.params[param] !== undefined && r.params[param] !== null);
    });
    expect(unshown).toEqual([]);
  });

  it("cover every value of every param the binding sends, or show the binding refuses it", async () => {
    const uncovered: string[] = [];
    const base = sample.runs[0]!;
    for (const name of Object.keys(binding.params ?? {})) {
      const present = sample.runs.map((r) => r.params[name]).filter((v) => v !== undefined && v !== null);
      const untaken = (sample.untaken ?? []).filter((u) => u.param === name);
      for (const u of untaken) {
        if (await takes(model, binding, { ...base.params, [name]: u.value }, base.prompt)) uncovered.push(`${name}=${JSON.stringify(u.value)} is listed as untaken but the binding takes it`);
      }
      if (present.length === 0 && untaken.length === 0) uncovered.push(name);
      for (const value of coveredValues(name, offered.get(model)?.[name], binding)) {
        if (!present.some((v) => String(v) === String(value)) && !untaken.some((u) => String(u.value) === String(value))) uncovered.push(`${name}=${JSON.stringify(value)}`);
      }
    }
    expect(uncovered).toEqual([]);
  });
});
