// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * inner#1306 test plan §97 items 3–4: the shared functions panel, admission, worker and retry share.
 *
 * - Transitions (canvas design §4 转场行; frames-split §7.14, §7.17; D11-3): a non-Cut transition lasts between one output
 *   frame and half the shorter trimmed clip; `transitionDurationBounds` answers null when that half is under one frame.
 * - Lip-sync failures (execution design §9.4; D11-5): one reason `{ kind: "lipsync", persons, shared }`; person steps are
 *   track, faces, clip, stem or gen, shared steps prepare, composite, stitch or expired; only a reason whose every person
 *   line and shared step is `timeout` or `failed` is retryable, decided by `lipsyncFailureRetryable`.
 *
 * The functions are read from the mini-tools entry by name so this file compiles before they exist.
 */
import { describe, expect, it } from "vitest";
import * as miniTools from "@shared/mini-tools/index.js";

interface Clip { clipId: string; inputId: string; in: number; out: number; transition: { kind: "cut" | "fade" | "wipeLeft" | "wipeRight"; duration: number } }
type Bounds = (clips: readonly Clip[], fps: number) => { min: number; max: number } | null;
type Schema = { safeParse: (value: unknown) => { success: boolean } };
const api = miniTools as unknown as { transitionDurationBounds: Bounds; lipsyncFailureReasonSchema: Schema; lipsyncFailureRetryable: (reason: unknown) => boolean };

/**
 * A two-clip timeline with the given trimmed lengths.
 * @param first - The first clip's trimmed seconds.
 * @param second - The second clip's trimmed seconds.
 * @returns The clips.
 */
function clips(first: number, second: number): Clip[] {
  return [
    { clipId: "50000000-0000-4000-8000-000000000001", inputId: "60000000-0000-4000-8000-000000000001", in: 1, out: 1 + first, transition: { kind: "fade", duration: 0.5 } },
    { clipId: "50000000-0000-4000-8000-000000000002", inputId: "60000000-0000-4000-8000-000000000002", in: 0, out: second, transition: { kind: "cut", duration: 0 } },
  ];
}

describe("transition duration bounds (§97 D11-3; canvas design §4, frames-split §7.17)", () => {
  it("TR01 spans one output frame to half the shorter trimmed clip", () => {
    expect(api.transitionDurationBounds(clips(4, 3), 25)).toEqual({ min: 1 / 25, max: 1.5 });
    expect(api.transitionDurationBounds(clips(2, 6), 30)).toEqual({ min: 1 / 30, max: 1 });
  });

  it("TR02 is null when half the shorter clip is under one output frame", () => {
    expect(api.transitionDurationBounds(clips(4, 3), 25)).not.toBeNull();
    expect(api.transitionDurationBounds(clips(4, 0.06), 25)).toBeNull();
  });

  it("TR03 at exactly two output frames the window is one frame wide", () => {
    expect(api.transitionDurationBounds(clips(0.08, 4), 25)).toEqual({ min: 0.04, max: 0.04 });
  });
});

const person = (category: string, step = "gen", personId = "person-1", detectionNumber = 1): Record<string, unknown> => ({ personId, detectionNumber, step, category });
const reason = (persons: Record<string, unknown>[], shared: Record<string, unknown> | null = null): Record<string, unknown> => ({ kind: "lipsync", persons, shared });

describe("lip-sync failure reason (§97 D11-5; execution design §9.4)", () => {
  it.each([
    ["one person timing out", reason([person("timeout", "track")])],
    ["two people and a shared stitch failure", reason([person("no_face", "faces"), person("stopped", "gen", "person-2", 2)], { step: "stitch", category: "failed" })],
    ["only the whole run expiring", reason([], { step: "expired", category: "timeout" })],
  ])("LF01 accepts %s", (_name, value) => {
    expect(api.lipsyncFailureReasonSchema.safeParse(value).success).toBe(true);
  });

  it.each([
    ["a shared step on a person", reason([person("failed", "prepare")])],
    ["a person step as the shared step", reason([], { step: "track", category: "failed" })],
    ["an unknown category", reason([person("lost")])],
    ["another reason kind", { ...reason([person("failed")]), kind: "segment" }],
    ["a person without its detection number", reason([{ personId: "person-1", step: "gen", category: "failed" }])],
  ])("LF02 refuses %s", (_name, value) => {
    expect(api.lipsyncFailureReasonSchema.safeParse(reason([person("failed")])).success).toBe(true);
    expect(api.lipsyncFailureReasonSchema.safeParse(value).success).toBe(false);
  });

  it.each([
    ["every person timing out or failing", reason([person("timeout"), person("failed", "clip", "person-2", 2)]), true],
    ["a shared failure beside failed people", reason([person("failed")], { step: "composite", category: "failed" }), true],
    ["only the run expiring", reason([], { step: "expired", category: "timeout" }), true],
    ["a person with no face", reason([person("no_face", "faces"), person("timeout", "gen", "person-2", 2)]), false],
    ["a rejected model", reason([person("model_rejected")]), false],
    ["a stopped person", reason([person("failed"), person("stopped", "gen", "person-2", 2)]), false],
  ] as const)("LF03 %s is retryable: %s", (_name, value, retryable) => {
    expect(api.lipsyncFailureRetryable(value)).toBe(retryable);
  });
});
