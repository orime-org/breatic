// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * A 3D generation refused for a text setting written too short (inner#1825):
 * the sentence names the setting the way the dialog's control does.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

const planSceneGeneration = vi.hoisted(() => vi.fn());

vi.mock("@breatic/domain", () => ({
  estimateTaskCredits: vi.fn(),
  planSceneGeneration,
  resolveProjectImageInputs: vi.fn(),
  sceneTaskService: {},
}));

import { resetLocales, setLocale, setLocaleMessages } from "@breatic/shared";

import { checkSubmission } from "@server/modules/asset/scene-generation.service.js";

afterEach(() => {
  resetLocales();
});

describe("checkSubmission", () => {
  it("names a text setting emptied below its least length by its control's label, not its param name", async () => {
    setLocaleMessages("en", JSON.parse(readFileSync(resolve(import.meta.dirname, "../../../../../../locales/en.json"), "utf8")) as Record<string, unknown>);
    setLocale("en");
    planSceneGeneration.mockReturnValue({
      ok: false,
      problem: { kind: "violation", violation: { param: "negative_prompt", rule: "min_length", length: 0, min: 1 } },
    });

    const refused = await checkSubmission("p", { mode: "t23d", model: "m", prompt: "a chair", params: {} } as never).catch((error: unknown) => error);

    const label = JSON.parse(readFileSync(resolve(import.meta.dirname, "../../../../../../locales/en.json"), "utf8")).canvas.generatePanel.param.negative_prompt as string;
    expect(String((refused as Error).message)).toBe(`Fill in ${label} first`);
    expect(String((refused as Error).message)).not.toContain("negative_prompt");
  });
});
