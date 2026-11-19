// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * inner#1306 test plan §69 U07 (frames-split design §10.12 `product-guide.ts` row, §7.12, §5.5): the guide no longer
 * describes a frame table. Video tools wait while the video is being prepared ("Preparing video…") and show the
 * presentation failure's reason; the Focus crops section says a video crop is taken in the background, uses no credits,
 * waits as a card after confirming and still reports when it finishes or fails with the panel closed; the bottom-line
 * sentence says extracting frames is free and its bottom line shows Free. The Mini-tools list is unchanged.
 */
import { describe, expect, it, beforeAll } from "vitest";
import { loadLocales } from "@breatic/core";
import { t } from "@breatic/shared";
import { VIDEO_TOOL_IDS } from "@breatic/shared/mini-tools";

import { renderProductGuide } from "@domain/agent/tools/product-guide.js";

/**
 * One section of the guide, as the model reads it.
 * @param heading - The section's heading, without the hashes.
 * @returns The section's body.
 */
function section(heading: string): string {
  return renderProductGuide().split(`## ${heading}`)[1]?.split("\n## ")[0] ?? "";
}

beforeAll(() => {
  loadLocales();
});

describe("U07 the product guide describes the frame grid's waiting and failures (§10.12)", () => {
  it("U07: video tools wait for \"Preparing video…\", not for a frame table", () => {
    const tools = section("Mini-tools");
    expect(tools).not.toMatch(/frame table/i);
    expect(tools).not.toContain(`"${t("canvas.miniTool.videoUI.loadingFrames")}"`);
    expect(tools).toContain(`"${t("canvas.miniTool.videoUI.preparingVideo")}"`);
    expect(t("canvas.miniTool.videoUI.preparingVideo")).toBe("Preparing video…");
  });

  it("U07: a presentation failure is described by its reason: temporary with Retry, too long without", () => {
    const tools = section("Mini-tools");
    expect(tools).toContain(`"${t("canvas.miniTool.videoUI.preparationFailed")}"`);
    expect(tools).toContain(`"${t("canvas.miniTool.videoUI.tooLongToPrepare")}"`);
    expect(t("canvas.miniTool.videoUI.preparationFailed")).toBe("Couldn't prepare the video");
  });

  it("U07: the bottom-line sentence says extracting frames is free and its bottom line shows Free", () => {
    const sentence = section("Mini-tools").split("The bottom line says what it costs")[1]?.split(". ")[0] ?? "";
    expect(sentence).toContain(`"${t("canvas.miniTool.video.extract-frames.label")}"`);
    expect(sentence).toContain(`"${t("canvas.miniTool.panel.free")}"`);
  });

  it("U07: Focus crops says a video crop uses no credits, waits as a card and reports even with the panel closed", () => {
    const focus = section("Focus crops");
    expect(focus).toMatch(/video[^.]*\b(no credits|free)\b/i);
    expect(focus).toMatch(/card/i);
    expect(focus).toMatch(/panel (is )?closed|clos(e|ing) the panel/i);
  });

  it("U07: the Mini-tools list still names the seven video tools", () => {
    const tools = section("Mini-tools");
    expect(VIDEO_TOOL_IDS).toHaveLength(7);
    for (const id of VIDEO_TOOL_IDS) expect(tools).toContain(t(`canvas.miniTool.video.${id.slice("video.".length)}.label`));
  });
});
