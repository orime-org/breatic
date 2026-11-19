// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import { trackingClips } from "@breatic/shared/mini-tools";
import { lipsyncPersonStepKeys, lipsyncSharedStepKeys, lipsyncStepKey, type LipSyncPerson } from "../lipsync-admission.js";

const PLAN = "f".repeat(64);
const PERSON: LipSyncPerson = { personId: "person-1", detectionNumber: 1, anchor: { frameIndex: 0 }, anchorFaceBox: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 } };
const RANGE = { start: 0, end: 90 };

// Execution design §10.2 last paragraph: the people analysis has one anchor, so the forward and reversed clips are shared by
// every person and follow trackingClips; at anchor 0 the forward clip is the existing preparation and starts no job.
describe("lip-sync tracking steps follow trackingClips (execution design §10.2)", () => {
  it.each([
    ["the first frame", 0, [], ["track:fwd"]],
    ["a middle frame", 45, ["prepare:fwd", "prepare:rev"], ["track:fwd", "track:rev"]],
    ["the last frame", 89, ["prepare:rev"], ["track:rev"]],
  ] as const)("LT01 an anchor on %s freezes its shared preparations and each person's tracks and join", (_case, anchor, preparations, tracks) => {
    const clips = trackingClips(RANGE, anchor);
    const shared = lipsyncSharedStepKeys(PLAN, 2, clips);
    expect(Object.keys(shared).sort()).toEqual([...preparations, "composite:0", "composite:1", "stitch"].sort());
    for (const step of preparations) expect(shared[step]).toBe(lipsyncStepKey(PLAN, null, step));
    const person = lipsyncPersonStepKeys(PLAN, { ...PERSON, anchor: { frameIndex: anchor } }, clips);
    expect(Object.keys(person).sort()).toEqual([...tracks, "track_join", "faces", "clip", "stem", "gen"].sort());
    for (const [step, key] of Object.entries(person)) expect(key).toBe(lipsyncStepKey(PLAN, PERSON.personId, step));
  });

  it("LT02 a retry keeps the keys its original run froze", () => {
    const stepKeys = { "track:fwd": "a".repeat(64), track_join: "b".repeat(64), faces: "c".repeat(64), clip: "d".repeat(64), stem: "e".repeat(64), gen: "0".repeat(64) };
    expect(lipsyncPersonStepKeys(PLAN, { ...PERSON, stepKeys }, trackingClips(RANGE, 0))).toEqual(stepKeys);
  });
});
