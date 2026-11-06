// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * inner#1306 test plan §97 D19-2 (frames-split §7.11 fresh row 「否则拒绝并告诉用户原因」; D17-1, D18-1, D23-5): the eight lip-sync
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
};

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
});
