// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * `takePromptOutOfParams` (#1966) — the one place the prompt leaves the params
 * bag, shared by both execution paths.
 *
 * They used to do it in opposite orders. `runAigcDirect` extracted first and
 * validated the rest; `runMiniTool` validated first and read the prompt off
 * the validated result. That difference was invisible until a model stopped
 * declaring `prompt` under `params`: `validateParams` drops keys a model does
 * not declare (silently, one `unknown_param_dropped` line), so on the
 * mini-tool path the user's words vanished on the way to the provider.
 *
 * One function, called before validation on both paths, is what makes the
 * declaration deletable at all — and what stops the two orders from drifting
 * apart again, since there is no longer a second copy to drift.
 */

import { describe, it, expect } from "vitest";

import { takePromptOutOfParams } from "@worker/handlers/prompt-params.js";

describe("takePromptOutOfParams (#1966)", () => {
  it("returns the prompt and a bag no longer carrying it", () => {
    const [prompt, rest] = takePromptOutOfParams({
      prompt: "a cat",
      aspect_ratio: "16:9",
    });
    expect(prompt).toBe("a cat");
    expect(rest).toEqual({ aspect_ratio: "16:9" });
  });

  // TTS 送的是「要念的稿子」，走的是同一个通道、键名叫 text。
  it("reads `text` when there is no `prompt`", () => {
    const [prompt, rest] = takePromptOutOfParams({
      text: "read this aloud",
      voice_id: "v1",
    });
    expect(prompt).toBe("read this aloud");
    expect(rest).toEqual({ voice_id: "v1" });
  });

  it("prefers `prompt` when both are present, and removes both", () => {
    const [prompt, rest] = takePromptOutOfParams({
      prompt: "p",
      text: "t",
      seed: 1,
    });
    expect(prompt).toBe("p");
    expect(rest).toEqual({ seed: 1 });
  });

  it("yields an empty prompt when the bag carries neither", () => {
    const [prompt, rest] = takePromptOutOfParams({ image: "http://x/y.png" });
    expect(prompt).toBe("");
    expect(rest).toEqual({ image: "http://x/y.png" });
  });

  // CLAUDE.md：AIGC prompt 一律先经 extractPromptText 去 HTML、注释和不可见
  // 字符。mini-tool 那条路此前没经过，两条路拉齐之后它也经过了。
  it("strips markup the way every AIGC prompt is required to be stripped", () => {
    const [prompt] = takePromptOutOfParams({
      prompt: "<b>bold</b> plan<!-- hidden -->",
    });
    expect(prompt).not.toContain("<b>");
    expect(prompt).not.toContain("hidden");
    expect(prompt).toContain("bold");
  });

  it("does not mutate the bag it was given", () => {
    const original = { prompt: "p", seed: 1 };
    takePromptOutOfParams(original);
    expect(original).toEqual({ prompt: "p", seed: 1 });
  });
});
