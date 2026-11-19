// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * inner#1306 test plan §97 D19-2 (frames-split §7.11 fresh row 「否则拒绝并告诉用户原因」; D17-1, D18-1, D23-5): the nine lip-sync
 * admission refusals the panel shows as a toast ship in all five locales under `server.mini_tool.*`, each translation keeping
 * the placeholders its English message names, and the English text is the coordinator's.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { MONOREPO_ROOT } from "@breatic/core";

const LOCALES = ["en", "zh-CN", "zh-TW", "ja", "ko"] as const;
const ENGLISH: Readonly<Record<string, string>> = {
  lipSyncModelUnavailable: "This lip-sync model isn't available. Choose another model.",
  lipSyncDurationOutOfRange: "This model takes a result of {min}–{max} s.",
  lipSyncTrackingOutOfRange: "Person tracking takes {min}–{max} s of video.",
  lipSyncTooManyPeople: "Lip sync works with up to {max} people at a time.",
  lipSyncTooManyDialogues: "Lip sync takes up to {max} dialogue lines.",
  lipSyncPeopleRunning: "Person detection is still running. Try again when it finishes.",
  lipSyncPeopleStale: "The detected people no longer match this video. Detect people again.",
  // frames-split §5.4 派发 row: one faces, clip, stem or stitch job estimated over one chunk share.
  lipSyncStepTooLong: "This lip-sync run is too long for one processing step. Shorten the dialogue or the video.",
  // Execution design §10.2: the reversed tracking chunks over [0, anchor] exceed `encoding.max_parallel_chunks`.
  lipSyncAnchorTooLate: "The frame you detected people on is too far from the start of the video to track back in one run. Detect people on an earlier frame, or use a shorter or lower-resolution video.",
};

/** The word each locale's lip-sync panel uses for detecting people (its `canvas.miniTool.videoUI.redetectPeople` button). */
const DETECT_WORD: Readonly<Record<(typeof LOCALES)[number], string>> = { en: "detect", "zh-CN": "识别", "zh-TW": "辨識", ja: "検出", ko: "감지" };

/** The zh-CN anchor refusal the user approved, naming the panel's own action. */
const ZH_CN_ANCHOR_TOO_LATE = "识别人物的画面离视频开头太远，一次跟踪不回去。请在更靠前的画面上识别人物，或换一段更短、分辨率更低的视频。";

/**
 * One locale's lip-sync panel label for detecting people again.
 * @param locale - The locale code.
 * @returns The `canvas.miniTool.videoUI.redetectPeople` text.
 */
function redetectLabel(locale: string): string {
  const catalog = JSON.parse(readFileSync(resolve(MONOREPO_ROOT, "locales", `${locale}.json`), "utf8")) as { canvas: { miniTool: { videoUI: { redetectPeople: string } } } };
  return catalog.canvas.miniTool.videoUI.redetectPeople;
}

/**
 * One locale's `server.mini_tool` messages.
 * @param locale - The locale code.
 * @returns Its messages.
 */
function messages(locale: string): Record<string, unknown> {
  const catalog = JSON.parse(readFileSync(resolve(MONOREPO_ROOT, "locales", `${locale}.json`), "utf8")) as { server?: { mini_tool?: Record<string, unknown> } };
  return catalog.server?.mini_tool ?? {};
}

/**
 * The ICU placeholder names a message uses.
 * @param text - The message.
 * @returns Sorted names.
 */
function placeholders(text: string): string[] {
  return [...new Set([...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]!))].sort();
}

describe("lip-sync refusal copy (§97 D19-2)", () => {
  it.each(LOCALES)("%s has every lip-sync refusal with the English placeholders", (locale) => {
    const own = messages(locale);
    for (const [key, english] of Object.entries(ENGLISH)) {
      expect(typeof own[key], `${locale} server.mini_tool.${key}`).toBe("string");
      expect(placeholders(own[key] as string), `${locale} server.mini_tool.${key} placeholders`).toEqual(placeholders(english));
    }
  });

  it("en carries the fixed refusal text", () => {
    const own = messages("en");
    for (const [key, english] of Object.entries(ENGLISH)) expect(own[key], `server.mini_tool.${key}`).toBe(english);
  });

  it.each(LOCALES)("%s names the anchor refusal's way out with the panel's own detect action", (locale) => {
    const word = DETECT_WORD[locale];
    expect(redetectLabel(locale).toLowerCase(), `${locale} redetectPeople`).toContain(word);
    expect((messages(locale).lipSyncAnchorTooLate as string).toLowerCase(), `${locale} lipSyncAnchorTooLate`).toContain(word);
  });

  it("zh-CN carries the approved anchor refusal text", () => {
    expect(messages("zh-CN").lipSyncAnchorTooLate).toBe(ZH_CN_ANCHOR_TOO_LATE);
  });
});
