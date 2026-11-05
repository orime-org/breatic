// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The text tool prompts of the document AI menu speak in text units
 * (inner#1860, design §5.1): the selection comes as numbered `<u>` tags and
 * the answer goes back the same way, one tag per unit.
 */

import { describe, expect, it } from "vitest";

import { getPromptForTool } from "@server/config/text-tools.js";

/** The tools the document AI menu runs. */
const MENU_TOOLS = ["polish", "expand", "shorten", "translate", "rewrite", "custom"] as const;

describe("text tool prompts", () => {
  it.each(MENU_TOOLS)("%s answers unit by unit with the ids it was sent", (tool) => {
    const prompt = getPromptForTool(tool);
    expect(prompt).toContain('<u id="');
    expect(prompt).toMatch(/same id/i);
    expect(prompt).not.toContain("Return Markdown with the same structure");
  });

  it.each(["polish", "shorten", "translate", "rewrite"])("%s keeps every unit to inline content", (tool) => {
    expect(getPromptForTool(tool)).toMatch(/inline/i);
  });

  it("lets expand split a paragraph unit with blank lines", () => {
    expect(getPromptForTool("expand")).toMatch(/blank line/i);
  });

  it("lets custom change structure and merge into the first unit, the others left empty", () => {
    const prompt = getPromptForTool("custom");
    expect(prompt).toMatch(/block-level Markdown/i);
    expect(prompt).toContain('<u id="2"></u>');
  });

  it.each(["summarize", "continue", "generate", "character", "storyboard", "script"])("leaves %s, which the menu does not run, without units", (tool) => {
    expect(getPromptForTool(tool)).not.toContain('<u id="');
  });
});
