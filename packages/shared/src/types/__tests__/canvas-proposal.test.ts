// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Which segments of a proposed node can carry a mark (#2218).
 */
import { describe, expect, it } from "vitest";
import { proposalMarkSegments, type ProposalNode } from "@shared/types/canvas-proposal";

describe("the marks of a node with shots (#2218)", () => {
  const asset = (label: string) => ({ slot: { kind: "asset" as const, label, note: "" } });

  it("reads the main prompt first, then each shot in order", () => {
    const node: ProposalNode = {
      role: "generate",
      type: "video",
      name: "The clip",
      mode: "multi_shot",
      model: "kling-v3.0-4k-text-to-video",
      takesPrompt: true,
      prompt: [{ text: "a " }, asset("a")],
      shots: [
        { prompt: [asset("b")], duration: 2 },
        { prompt: [{ text: "then " }, asset("c")], duration: 3 },
      ],
    };
    expect(proposalMarkSegments(node).filter((s) => s.slot).map((s) => s.slot?.label)).toEqual(["a", "b", "c"]);
  });
});
