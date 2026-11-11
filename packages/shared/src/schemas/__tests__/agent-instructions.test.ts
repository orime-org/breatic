// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The Project instructions contract (#1400): one plain text per Project, at
 * most `AGENT_INSTRUCTIONS_MAX_CHARS` characters as TypeScript counts them
 * (`.length`, UTF-16 code units), so the editor's counter and the server agree.
 * Imported from the main entry, because that is what other packages resolve.
 */

import { describe, it, expect } from "vitest";

import {
  AGENT_INSTRUCTIONS_MAX_CHARS,
  agentInstructionsQuerySchema,
  agentInstructionsSaveSchema,
} from "@shared/index.js";

const projectId = "11111111-1111-4111-8111-111111111111";

/**
 * Whether a save body with this text passes the schema.
 * @param text - The instructions text.
 * @returns True when the schema accepts it.
 */
function accepts(text: string): boolean {
  return agentInstructionsSaveSchema.safeParse({ project_id: projectId, text }).success;
}

describe("agentInstructionsSaveSchema — the length limit", () => {
  it("sets the limit at 10000 characters", () => {
    expect(AGENT_INSTRUCTIONS_MAX_CHARS).toBe(10_000);
  });

  it("accepts 9999 and 10000 characters and rejects 10001", () => {
    expect(accepts("a".repeat(9_999))).toBe(true);
    expect(accepts("a".repeat(10_000))).toBe(true);
    expect(accepts("a".repeat(10_001))).toBe(false);
  });

  it("counts a surrogate pair as two characters, as .length does", () => {
    const emoji = "\u{1F600}";
    expect(emoji.length).toBe(2);
    expect(accepts(emoji.repeat(5_000))).toBe(true);
    expect(accepts(emoji.repeat(5_000) + "a")).toBe(false);
  });

  it("accepts an empty text, which is how a user clears the instructions", () => {
    expect(accepts("")).toBe(true);
  });

  it("keeps the text exactly as sent, surrounding spaces and newlines included", () => {
    const text = "  \n keep me \n\n ";
    const parsed = agentInstructionsSaveSchema.parse({ project_id: projectId, text });
    expect(parsed.text).toBe(text);
  });
});

describe("agentInstructionsSaveSchema / agentInstructionsQuerySchema — project_id", () => {
  it("rejects a project_id that is not a uuid", () => {
    expect(agentInstructionsSaveSchema.safeParse({ project_id: "nope", text: "x" }).success).toBe(false);
    expect(agentInstructionsQuerySchema.safeParse({ project_id: "nope" }).success).toBe(false);
  });

  it("accepts a uuid project_id", () => {
    expect(agentInstructionsQuerySchema.parse({ project_id: projectId }).project_id).toBe(projectId);
  });

  it("rejects a save without text", () => {
    expect(agentInstructionsSaveSchema.safeParse({ project_id: projectId }).success).toBe(false);
  });
});
