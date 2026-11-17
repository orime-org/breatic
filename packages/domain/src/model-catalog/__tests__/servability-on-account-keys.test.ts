// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The submit-time checks on the key set resolved for the paying account (inner#1953): whether a run can be served,
 * and what it is estimated at are answered on the account's keys when it has them, so a
 * model the deployment did not configure but the account did is servable, and a deployment key the account did not
 * choose never counts. These read the real config files.
 */

import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { KeySet, Route } from "@breatic/provider";

import { estimateModelCredits, llmServability, servability } from "../model-catalog.js";
import { restoreProcessEnv, useEnvWithKeys } from "./catalog-env.js";

/** A media model bound on WaveSpeed and fal. */
const IMAGE = "gpt-image-2.5-sunburst-text-to-image";
const FLASH = "deepseek/deepseek-v4.1-flash-1017";
const ON_FAL: Route = { mode: "upstream", upstream: "fal" };
const DEFAULT: Route = { mode: "default" };

/**
 * An account's key set.
 * @param keys - Its keys by upstream.
 * @returns The set.
 */
const accountKeys = (keys: Record<string, string>): KeySet => ({ owner: "account", keyOf: (upstream: string) => keys[upstream] });

type WithKeys = {
  servability(model: string, route: Route, keys?: KeySet): ReturnType<typeof servability>;
  llmServability(model: string, use: "call" | "understand", route: Route, keys?: KeySet): ReturnType<typeof llmServability>;
  estimateModelCredits(model: string, input: Parameters<typeof estimateModelCredits>[1], route: Route, keys?: KeySet): ReturnType<typeof estimateModelCredits>;
};
const on = { servability, llmServability, estimateModelCredits } as unknown as WithKeys;

beforeEach(() => {
  restoreProcessEnv();
});

afterAll(() => {
  restoreProcessEnv();
});

describe("a media model on an account's key", () => {
  it("is servable on the upstream the account chose though the deployment configured none", () => {
    useEnvWithKeys([]);
    expect(servability(IMAGE, ON_FAL)).toMatchObject({ servable: false });
    expect(on.servability(IMAGE, ON_FAL, accountKeys({ fal: "acct-fal" }))).toEqual({ servable: true });
  });

  it("is not servable on an upstream only the deployment has a key for", () => {
    useEnvWithKeys(["WAVESPEED_API_KEY", "FAL_KEY"]);
    expect(on.servability(IMAGE, { mode: "upstream", upstream: "wavespeed" }, accountKeys({ fal: "acct-fal" }))).toMatchObject({ servable: false });
  });

  it("is estimated on the account's upstream when the deployment configured none", async () => {
    useEnvWithKeys([]);
    expect(await estimateModelCredits(IMAGE, { params: {}, prompt: "a fox" }, ON_FAL)).toBeUndefined();
    expect(await on.estimateModelCredits(IMAGE, { params: {}, prompt: "a fox" }, ON_FAL, accountKeys({ fal: "acct-fal" }))).toMatchObject({ credits: expect.any(Number) });
  });
});

describe("a language model on an account's OpenRouter key", () => {
  it("is servable though the deployment configured no key", () => {
    useEnvWithKeys([]);
    expect(llmServability(FLASH, "call", DEFAULT)).toMatchObject({ servable: false });
    expect(on.llmServability(FLASH, "call", DEFAULT, accountKeys({ openrouter: "sk-or-acct" }))).toEqual({ servable: true });
  });

  it("is not servable on the deployment's DeepSeek key when the account's set has only OpenRouter", () => {
    useEnvWithKeys(["DEEPSEEK_API_KEY"]);
    expect(on.llmServability(FLASH, "call", { mode: "upstream", upstream: "deepseek" }, accountKeys({ openrouter: "sk-or-acct" }))).toMatchObject({ servable: false });
  });
});
