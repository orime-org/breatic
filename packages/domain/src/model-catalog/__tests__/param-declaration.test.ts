// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What a parameter declares about how it gets filled (#269).
 *
 * A declaration that contradicts itself is worse than one that is missing:
 * the panel, the proposal tool and the enqueue gate all read it, and each
 * quietly answers around the contradiction in its own way. Refused while the
 * catalog loads, it is one message on the machine that ships the yaml.
 */

import { describe, it, expect, afterEach, vi } from "vitest";

import { assertParamDeclarations } from "../param-declaration.js";

/**
 * One model with the parameters a case wants to hold up.
 * @param params - The parameter declarations under test.
 * @param mode - The modes the model serves.
 * @returns A single-model list shaped the way the catalog holds it.
 */
function modelWith(
  params: Record<string, unknown>,
  mode: string | string[] = "i2v",
): Array<{ name: string; mode: string | string[]; params: Record<string, unknown> }> {
  return [{ name: "a-model", mode, params }];
}

describe("a parameter declaration", () => {
  it("passes when every field agrees with the model around it", () => {
    expect(() =>
      assertParamDeclarations(
        "video",
        modelWith({
          image: { fill: "canvas", accepts: "image" },
          duration: { fill: "panel" },
          keep_original_sound: { fill: "panel", when: { source: "image" } },
          end_image: { fill: "canvas", accepts: "image", modes: ["first_last"] },
          seed: { fill: "none", note: "reproducibility plumbing" },
        }, ["i2v", "first_last"]),
      ),
    ).not.toThrow();
  });

  it("is refused when a slot does not say which kind of node it takes", () => {
    expect(() => assertParamDeclarations("video", modelWith({ image: { fill: "canvas" } }))).toThrow(
      /a-model.*image.*accepts/s,
    );
  });

  it("is refused when a pool does not say which kind of node it takes", () => {
    // The gate finds a carrier by what it accepts, so a pool that says nothing
    // carries nothing and every submission through it is refused before it is
    // sent.
    expect(() => assertParamDeclarations("video", modelWith({ images: { fill: "pool" } }))).toThrow(
      /a-model.*images.*accepts/s,
    );
  });

  it("is refused when a gate names a parameter the model does not declare", () => {
    expect(() =>
      assertParamDeclarations(
        "video",
        modelWith({ keep_original_sound: { fill: "panel", when: { source: "video" } } }),
      ),
    ).toThrow(/a-model.*keep_original_sound.*video/s);
  });

  it("is refused when it limits itself to a mode the model does not serve", () => {
    expect(() =>
      assertParamDeclarations(
        "video",
        modelWith({ end_image: { fill: "canvas", accepts: "image", modes: ["first_last"] } }),
      ),
    ).toThrow(/a-model.*end_image.*first_last/s);
  });

  it("is refused when a slot is capped above the one file it can carry", () => {
    expect(() =>
      assertParamDeclarations(
        "image",
        modelWith(
          { style_images: { fill: "canvas", accepts: "image", type: "list", max_items: 3 } },
          "i2i",
        ),
      ),
    ).toThrow(/a-model.*style_images.*max_items/s);
  });

  it("is refused when it does not say how it gets filled at all", () => {
    expect(() => assertParamDeclarations("video", modelWith({ seed: {} }))).toThrow(
      /a-model.*seed.*fill/s,
    );
  });

  it("is refused when it says it has no control without saying why", () => {
    expect(() =>
      assertParamDeclarations("video", modelWith({ seed: { fill: "none" } })),
    ).toThrow(/a-model.*seed.*note/s);
  });

  it("lets the reference pool carry as many as the model says", () => {
    expect(() =>
      assertParamDeclarations(
        "image",
        modelWith(
          { images: { fill: "pool", accepts: "image", type: "list", max_items: 13 } },
          "i2i",
        ),
      ),
    ).not.toThrow();
  });
});

// 上面测的是校验函数本身。这一组测它真的接在加载路径上 —— 把那行调用从
// loader 里摘掉，上面的用例照样全绿，因为真实 yaml 今天没有一条违例。
describe("the loader refuses what these checks refuse", () => {
  afterEach(() => {
    vi.doUnmock("node:fs");
    vi.resetModules();
  });

  /**
   * A filesystem serving one modality fixture and the mode declarations.
   * @param fixture - The modality yaml this filesystem serves.
   * @returns A `node:fs` double over those two files.
   */
  function fsWith(fixture: string): Record<string, unknown> {
    const modes = ["video:", "  modes:", "    t2v:", "      label: text-to-video"].join("\n");
    return {
      readdirSync: () => ["fixture.yaml"],
      existsSync: (path: string) => String(path).endsWith("modes.yaml"),
      readFileSync: (path: string) => (String(path).endsWith("modes.yaml") ? modes : fixture),
    };
  }

  it("throws on a slot that does not say which kind of node it takes", async () => {
    vi.resetModules();
    vi.doMock("node:fs", () =>
      fsWith(
        [
          "models:",
          '  - name: "no-kind"',
          '    mode: "t2v"',
          "    takes_prompt: true",
          "    params:",
          "      image:",
          '        fill: "canvas"',
        ].join("\n"),
      ),
    );
    const mod = await import("../model-catalog.js");
    expect(() => mod.getFullModelConfig("video")).toThrow(/no-kind.*image.*accepts/s);
  });
});
