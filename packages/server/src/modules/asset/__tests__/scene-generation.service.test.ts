// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * A 3D generation refused for a text setting written too short (inner#1825):
 * the sentence names the setting the way the dialog's control does.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

const { planSceneGeneration, servability, resolveProjectImageInputs } = vi.hoisted(() => ({
  planSceneGeneration: vi.fn(),
  servability: vi.fn(),
  resolveProjectImageInputs: vi.fn(),
}));

vi.mock("@breatic/domain", () => ({
  estimateTaskCredits: vi.fn(),
  planSceneGeneration,
  resolveProjectImageInputs,
  sceneTaskService: {},
  servability,
  llmServability: vi.fn(),
}));

import { resetLocales, setLocale, setLocaleMessages } from "@breatic/shared";

import { checkSubmission } from "@server/modules/asset/scene-generation.service.js";

afterEach(() => {
  resetLocales();
  vi.clearAllMocks();
});

/** The English catalog, as the server reads it. */
const EN = (): Record<string, unknown> =>
  JSON.parse(readFileSync(resolve(import.meta.dirname, "../../../../../../locales/en.json"), "utf8")) as Record<string, unknown>;

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

  it("refuses a model no upstream here can serve before anything is held, naming the variables it needs", async () => {
    setLocaleMessages("en", EN());
    setLocale("en");
    planSceneGeneration.mockReturnValue({
      ok: true,
      entry: { name: "tripo-h3.1-t23d", display_name: "Tripo H3.1" },
      params: {},
      prompt: "a chair",
      imageParam: null,
    });
    servability.mockReturnValue({ servable: false, reason: "unconfigured", envVars: ["TRIPO_API_KEY", "WAVESPEED_API_KEY"] });

    const refused = await checkSubmission("p", { mode: "t23d", model: "tripo-h3.1-t23d", prompt: "a chair", params: {} } as never)
      .catch((error: unknown) => error);

    expect(servability).toHaveBeenCalledWith("tripo-h3.1-t23d", undefined);
    expect(refused).toMatchObject({ statusCode: 503, message: "Tripo H3.1 is not set up on this deployment: it needs TRIPO_API_KEY, WAVESPEED_API_KEY." });
    expect(resolveProjectImageInputs).not.toHaveBeenCalled();
  });
});
