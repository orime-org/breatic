// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The pre-enqueue gate finds a source by what the param accepts (#269).
 *
 * Which of a model's params can carry an image is the model's to say, and it
 * says so in `accepts`. A vocabulary of vendor spellings kept beside the gate
 * answers the same question a second time, and it answers it wrong for every
 * name nobody has added to it yet: the model declares a carrier, the gate does
 * not recognise the name, and a submission that carries exactly what the run
 * needs is refused before it is ever sent.
 *
 * The model below spells its picture `portrait`, which is a name no list of
 * spellings has. A catalog of this file's own is what lets the question be
 * asked: every name in the live catalog is already in that list.
 */

import { describe, it, expect, afterEach } from "vitest";

import {
  useFixtureCatalog,
  restoreRealCatalog,
} from "@domain/model-catalog/__tests__/fixture-catalog.js";

/** A video model taking one picture, under a name of its own. */
const VIDEO = [
  "models:",
  '  - name: "own-spelling-model"',
  '    display_name: "Own Spelling Model"',
  '    mode: "i2v"',
  "    takes_prompt: true",
  "    cost_per_call: 1",
  "    generation_time: 10",
  "    providers:",
  "      - name: wavespeed",
  '        model_id: "own-spelling"',
  "        priority: 1",
  "    params:",
  "      portrait:",
  '        fill: "canvas"',
  '        accepts: "image"',
  '        description: "the picture to move"',
  "        default: null",
].join("\n");

/** What that mode declares it needs. */
const MODES = [
  "video:",
  "  modes:",
  "    i2v:",
  "      label: Image to Video",
  "      sources: [image]",
].join("\n");

/**
 * The gate, bound to a catalog of this file's own.
 * @returns Its per-model entry point.
 */
async function gateOnFixture(): Promise<
  (model: string | undefined, params: Record<string, unknown>) => boolean
> {
  await useFixtureCatalog({ modes: MODES, buckets: { video: VIDEO } });
  const { violatesSourceRequirementForModel } = await import("../model-catalog.js");
  return violatesSourceRequirementForModel;
}

describe("the pre-enqueue source gate", () => {
  afterEach(restoreRealCatalog);

  it("accepts a source riding in the param the model says accepts it", async () => {
    const violates = await gateOnFixture();

    expect(violates("own-spelling-model", { portrait: "https://example.invalid/a.png" })).toBe(
      false,
    );
  });

  it("still refuses a submission carrying nothing", async () => {
    const violates = await gateOnFixture();

    expect(violates("own-spelling-model", {})).toBe(true);
  });

  it("refuses a bare string in a param the model declares as a list", async () => {
    const listed = VIDEO.replace(
      '        accepts: "image"',
      '        accepts: "image"\n        type: "list"',
    );
    await useFixtureCatalog({ modes: MODES, buckets: { video: listed } });
    const { violatesSourceRequirementForModel } = await import("../model-catalog.js");

    expect(
      violatesSourceRequirementForModel("own-spelling-model", {
        portrait: "https://example.invalid/a.png",
      }),
    ).toBe(true);
    expect(
      violatesSourceRequirementForModel("own-spelling-model", {
        portrait: ["https://example.invalid/a.png"],
      }),
    ).toBe(false);
  });
});
