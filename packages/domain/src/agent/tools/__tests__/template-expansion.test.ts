// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * A proposed node naming a template starts from it and keeps whatever the
 * agent wrote (inner#977).
 */

import { beforeAll, describe, expect, it } from "vitest";

import { loadLocales } from "@breatic/core";

import { findTemplate, templatePrompt, type ProposalNode } from "@breatic/shared";

import { expandTemplate } from "@domain/agent/tools/template-expansion.js";

beforeAll(() => {
  loadLocales();
});

const grid = findTemplate("storyboard-grid-25");
if (!grid) throw new Error("grid template missing");

/**
 * A generate node naming a template, with what the test gives it.
 * @param extra - Fields the agent wrote.
 * @returns The node as the agent sent it.
 */
function named(extra: Partial<ProposalNode> = {}): ProposalNode & { template: string } {
  return { role: "generate", type: "image", name: "Grid", template: "storyboard-grid-25", ...extra };
}

describe("expandTemplate", () => {
  it("fills the mode, model, params and prompt the agent left out", () => {
    const out = expandTemplate(named());
    expect(out).toEqual({
      ok: true,
      node: {
        role: "generate",
        type: "image",
        name: "Grid",
        mode: "i2i",
        model: "nano-banana-pro-edit-ultra",
        params: { aspect_ratio: "1:1", resolution: "4k" },
        prompt: templatePrompt(grid),
      },
    });
  });

  it("lays the agent's params over the template's while mode and model stay the template's", () => {
    const out = expandTemplate(named({ params: { resolution: "8k" } }));
    expect(out.ok && out.node.params).toEqual({ aspect_ratio: "1:1", resolution: "8k" });
  });

  it("carries none of the template's params once the agent picks another model", () => {
    const out = expandTemplate(named({ model: "gpt-image-2.5-sunburst-edit", params: { quality: "high" } }));
    expect(out.ok && out.node.model).toBe("gpt-image-2.5-sunburst-edit");
    expect(out.ok && out.node.params).toEqual({ quality: "high" });
  });

  it("carries none of the template's params once the agent picks another mode", () => {
    const out = expandTemplate(named({ mode: "t2i", model: "nano-banana-2" }));
    expect(out.ok && out.node.params).toBeUndefined();
  });

  it("keeps the prompt the agent wrote", () => {
    const prompt = [{ text: "a storyboard of a cat" }];
    const out = expandTemplate(named({ prompt }));
    expect(out.ok && out.node.prompt).toEqual(prompt);
  });

  it("refuses a template it does not have, naming the ones it does", () => {
    const out = expandTemplate({ ...named(), template: "no-such" });
    expect(out).toEqual({ ok: false, reason: expect.stringContaining("storyboard-grid-25") });
  });

  it("refuses a template on a node of another type", () => {
    const out = expandTemplate(named({ type: "video" }));
    expect(out).toEqual({ ok: false, reason: expect.stringContaining("image") });
  });
});
