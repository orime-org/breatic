// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * What the system prompt says about the Agent's memory each turn (#1363).
 *
 * The Project part is always there: the index of entries, newest first, one
 * line each, with the migrated blocks in full until a consolidation splits
 * them, and a line counting the entries left out. With no entries it says so,
 * so the memory protocol in the base prompt always has the section it points
 * at. The conversation part is the progress note, when there is one.
 */
import { describe, expect, it } from "vitest";
import type { MemoryContext } from "@breatic/shared";
import { instructionsForAgentMemory, instructionsText } from "@domain/agent/instructions.js";

const A = "44444444-4444-4444-8444-444444444444";
const B = "55555555-5555-4555-8555-555555555555";
const M = "77777777-7777-4777-8777-777777777777";

/**
 * A memory context, empty unless a case fills it.
 * @param over - The fields a case sets.
 * @returns The context.
 */
function context(over: Partial<MemoryContext> = {}): MemoryContext {
  return { entries: [], migrated: [], olderCount: 0, progress: "", ...over };
}

describe("the memory parts of the system prompt", () => {
  it("say there are no entries yet when there are none, and leave the conversation part out", () => {
    expect(instructionsForAgentMemory("base", context())).toEqual({
      base: "base",
      project: "## Memory Entries\n\nNo entries yet.",
    });
  });

  it("list each entry on one line, id then title, in the order given", () => {
    const project = instructionsForAgentMemory(
      "base",
      context({ entries: [{ id: A, title: "Lead character: Lin Wu" }, { id: B, title: "All videos 9:16" }] }),
    ).project;

    expect(project).toBe(`## Memory Entries\n\n- ${A} · Lead character: Lin Wu\n- ${B} · All videos 9:16`);
  });

  it("put the migrated blocks first, in full, under their id and title", () => {
    const project = instructionsForAgentMemory(
      "base",
      context({
        migrated: [{ id: M, title: "Earlier project memory", content: "The project is a noir short.\nLead: Lin Wu." }],
        entries: [{ id: A, title: "Palette: teal and orange" }],
      }),
    ).project;

    expect(project).toBe(
      `## Memory Entries\n\n### ${M} · Earlier project memory\n\nThe project is a noir short.\nLead: Lin Wu.\n\n- ${A} · Palette: teal and orange`,
    );
  });

  it.each([
    [1, "1 older entry is not listed here."],
    [14, "14 older entries are not listed here."],
  ])("count the %i entries left out of the index", (olderCount, line) => {
    const project = instructionsForAgentMemory("base", context({ entries: [{ id: A, title: "t" }], olderCount })).project;

    expect(project?.endsWith(`\n\n${line}`)).toBe(true);
  });

  it("carry the progress note as the conversation part", () => {
    expect(instructionsForAgentMemory("base", context({ progress: "Settled the look; next is the storyboard." })).conversation).toBe(
      "## Conversation So Far\n\nSettled the look; next is the storyboard.",
    );
  });

  it("read as one prompt joined in order", () => {
    const parts = instructionsForAgentMemory("base", context({ entries: [{ id: A, title: "t" }], progress: "p" }));

    expect(instructionsText(parts)).toBe(`base\n\n## Memory Entries\n\n- ${A} · t\n\n## Conversation So Far\n\np`);
  });
});
