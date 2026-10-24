// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, expect, it, vi } from "vitest";
import type { ModelMessage } from "ai";
import { expandAgentPictures } from "../../../../domain/src/agent/project-agent-request.js";

vi.mock("@breatic/core", () => ({ getAgentConfig: () => ({ picture_tokens_estimate: 1000 }) }));
vi.mock("@breatic/domain", () => ({
  AGENT_TOOL_PICTURE_MARKER: "[Agent pictures from tool results]",
  instructionsText: (instructions: { base: string }): string => instructions.base,
}));

import { measureMessages } from "@server/agent/payload-size.js";

const IMAGE = { type: "file" as const, data: "https://media.example/prepared.jpg", mediaType: "image/jpeg" };
const PICTURE = { label: "Attachment 1", sourceUrl: "https://source.example/raw.bin", url: IMAGE.data, mediaType: "image/jpeg", sizeBytes: 1234 };

/** A persisted JSON result, before native pictures are expanded for sending. */
function toolResult(pictures: readonly (typeof PICTURE)[]): ModelMessage {
  return {
    role: "tool",
    content: [{ type: "tool-result", toolCallId: "c1", toolName: "search_images", output: { type: "json", value: { kind: "agent-pictures-v1", text: "results", pictures: [...pictures] } } }],
  };
}

describe("picture estimates measure actual occurrences", () => {
  it("uses the configured estimate rather than the URL's serialized character length", () => {
    expect(measureMessages([{ role: "user", content: [IMAGE] }])).toBe(1000);
  });

  it("counts the same visible JPEG on each occurrence", () => {
    expect(measureMessages([{ role: "user", content: [IMAGE, IMAGE, IMAGE] }])).toBe(3000);
  });

  it("adds one estimate for each picture inside a logical tool result", () => {
    const without = measureMessages([toolResult([])]);
    expect(measureMessages([toolResult([PICTURE])]) - without).toBe(1000);
    expect(measureMessages([toolResult([PICTURE, PICTURE])]) - without).toBe(2000);
  });

  it("measures omission placeholders as ordinary text", () => {
    const text = `[Picture omitted from this request: ${PICTURE.label}; source: ${PICTURE.sourceUrl}; use understand_media to inspect it again.]`;
    expect(measureMessages([{ role: "user", content: [{ type: "text", text }] }])).toBe(text.length);
  });

  it("counts one tool picture once after deterministic user-message expansion", () => {
    const expanded = expandAgentPictures([toolResult([PICTURE])]);
    const textOnly = expanded.map((message): ModelMessage => {
      if (message.role === "tool") return toolResult([]);
      if (message.role === "user" && Array.isArray(message.content)) {
        return { ...message, content: message.content.filter((part) => part.type !== "file") };
      }
      return message;
    });

    // The baseline preserves all generated labels and source text, so the
    // difference is exactly one actual image occurrence, however the tool
    // output and its accompanying user message divide those words.
    expect(measureMessages(expanded) - measureMessages(textOnly)).toBe(1000);
  });
});
