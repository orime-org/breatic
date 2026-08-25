// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

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

import { takePromptAndValidate } from "@worker/handlers/prompt-params.js";

/**
 * A validator that keeps whatever it is handed, so a case can watch the lift
 * alone. The real one drops undeclared keys — that behaviour has its own cases
 * in the second describe below.
 * @param model - Passed straight back.
 * @param params - Passed straight back.
 * @returns The pair unchanged.
 */
const keepAll = (
  model: string,
  params: Record<string, unknown>,
): [string, Record<string, unknown>] => [model, params];

/**
 * The lift, reached through the only entry point there is.
 * @param params - The params bag to lift the prompt out of.
 * @returns A `[prompt, rest]` pair.
 */
function lift(params: Record<string, unknown>): [string, Record<string, unknown>] {
  const [prompt, , rest] = takePromptAndValidate(params, "m", keepAll);
  return [prompt, rest];
}

describe("lifting the prompt out of the params bag (#1966)", () => {
  it("returns the prompt and a bag no longer carrying it", () => {
    const [prompt, rest] = lift({
      prompt: "a cat",
      aspect_ratio: "16:9",
    });
    expect(prompt).toBe("a cat");
    expect(rest).toEqual({ aspect_ratio: "16:9" });
  });

  // TTS 送的是「要念的稿子」，走的是同一个通道、键名叫 text。
  it("reads `text` when there is no `prompt`", () => {
    const [prompt, rest] = lift({
      text: "read this aloud",
      voice_id: "v1",
    });
    expect(prompt).toBe("read this aloud");
    expect(rest).toEqual({ voice_id: "v1" });
  });

  it("prefers `prompt` when both are present, and removes both", () => {
    const [prompt, rest] = lift({
      prompt: "p",
      text: "t",
      seed: 1,
    });
    expect(prompt).toBe("p");
    expect(rest).toEqual({ seed: 1 });
  });

  it("yields an empty prompt when the bag carries neither", () => {
    const [prompt, rest] = lift({ image: "http://x/y.png" });
    expect(prompt).toBe("");
    expect(rest).toEqual({ image: "http://x/y.png" });
  });

  // CLAUDE.md：AIGC prompt 一律先经 extractPromptText 去 HTML、注释和不可见
  // 字符。mini-tool 那条路此前没经过，两条路拉齐之后它也经过了。
  it("strips markup the way every AIGC prompt is required to be stripped", () => {
    const [prompt] = lift({
      prompt: "<b>bold</b> plan<!-- hidden -->",
    });
    expect(prompt).not.toContain("<b>");
    expect(prompt).not.toContain("hidden");
    expect(prompt).toContain("bold");
  });

  it("does not mutate the bag it was given", () => {
    const original = { prompt: "p", seed: 1 };
    lift(original);
    expect(original).toEqual({ prompt: "p", seed: 1 });
  });

});

// 顺序本身就是那个 bug（#1967）：校验会把模型没声明的键静默丢掉，所以
// 「先校验、再从校验结果里读提示词」等于要求每个模型都声明一个 `prompt`
// 参数 —— 而那个声明本次正好被删光了。两条执行路各自把两步写在自己身上，
// 于是其中一条写反了。合成一次调用之后，调用方没有顺序可写。
describe("takePromptAndValidate", () => {
  /** A validator shaped like the real one: it drops what the model does not declare. */
  const dropUndeclared =
    (declared: string[]) =>
    (model: string, params: Record<string, unknown>): [string, Record<string, unknown>] => {
      const kept: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(params)) {
        if (declared.includes(k)) kept[k] = v;
      }
      return [model, kept];
    };

  it("gets the prompt through a model that declares no prompt param", () => {
    const [prompt, model, validated] = takePromptAndValidate(
      { prompt: "a drone shot over a canyon", image: "http://x/y.png", bogus: 1 },
      "kling-o3-pro",
      dropUndeclared(["image"]),
    );
    expect(prompt).toBe("a drone shot over a canyon");
    expect(model).toBe("kling-o3-pro");
    expect(validated).toEqual({ image: "http://x/y.png" });
  });

  it("never hands the prompt to the validator, so it cannot be dropped there", () => {
    const seen: Record<string, unknown>[] = [];
    takePromptAndValidate({ prompt: "p", text: "t", seed: 3 }, "m", (model, params) => {
      seen.push(params);
      return [model, params];
    });
    expect(seen).toHaveLength(1);
    expect("prompt" in seen[0]!).toBe(false);
    expect("text" in seen[0]!).toBe(false);
    expect(seen[0]).toEqual({ seed: 3 });
  });

  it("passes through the model name the validator resolved to", () => {
    const [, model] = takePromptAndValidate({}, "asked-for", () => ["resolved-to", {}]);
    expect(model).toBe("resolved-to");
  });
});
