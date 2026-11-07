// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The text tool prompts of the document AI menu (inner#1860, design §5.1):
 * the selection is sent as Markdown and the whole answer comes back as
 * Markdown, so the fixed commands keep its structure and custom may change it.
 */

import { describe, expect, it } from "vitest";

import { getPromptForTool } from "@server/config/text-tools.js";

/** The fixed commands of the document AI menu. */
const FIXED_TOOLS = ["polish", "expand", "shorten", "translate", "rewrite"] as const;

/** The sentence asking for the same Markdown structure. */
const SAME_STRUCTURE = "Return Markdown with the same structure (headings, lists, emphasis, links) unless the task says otherwise.";

describe("text tool prompts", () => {
  it.each(FIXED_TOOLS)("%s takes and returns Markdown with the same structure", (tool) => {
    const prompt = getPromptForTool(tool);
    expect(prompt).toContain("The selected text is Markdown.");
    expect(prompt).toContain(SAME_STRUCTURE);
  });

  it("lets custom change the structure as the instruction says", () => {
    const prompt = getPromptForTool("custom");
    expect(prompt).not.toContain(SAME_STRUCTURE);
    expect(prompt).toMatch(/markdown/i);
  });

  it("lets expand write a paragraph as several", () => {
    expect(getPromptForTool("expand")).toMatch(/several paragraphs/i);
  });

  it.each([...FIXED_TOOLS, "custom", "summarize", "continue", "generate", "character", "storyboard", "script"])("asks %s for no unit tags", (tool) => {
    expect(getPromptForTool(tool)).not.toContain("<u id=");
  });
});
