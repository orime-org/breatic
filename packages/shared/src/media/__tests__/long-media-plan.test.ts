// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, expect, it } from "vitest";

import { LongMediaPlanRequestSchema } from "@shared/media/long-media-plan.js";

const input = {
  mediaInputId: "audio-0-0",
  descriptor: { inputKind: "audio_channel" as const, audioStreamIndex: 0, audioChannelIndex: 0 },
  sourceRange: { startUs: "0", endUs: "10000000" },
  audioRange: { startUs: "0", endUs: "10000000" },
};

const plan = {
  expectedVersion: 1,
  mutationId: "plan-mutation-1",
  requiredMediaInputs: [input],
  requiredMediaInputsDigest: "a".repeat(64),
  mediaInputId: input.mediaInputId,
  parentId: null,
  intervals: [{
    id: "audio-0-0:0:10000000",
    mediaInputId: input.mediaInputId,
    descriptor: input.descriptor,
    core: { startUs: "0", endUs: "10000000" },
    decode: { startUs: "0", endUs: "10000000" },
    mode: "prepare" as const,
  }],
  grants: [{
    segmentId: "audio-0-0:0:10000000",
    candidateId: "candidate-1",
    grantId: "grant-1",
    storageKey: "understand/operation-1/candidate-1.mp3",
  }],
};

describe("LongMediaPlanRequestSchema", () => {
  it("accepts an exact prepare candidate grant bound to one measured input interval", () => {
    expect(LongMediaPlanRequestSchema.parse(plan)).toEqual(plan);
  });

  it("rejects unknown fields and unsafe candidate grants", () => {
    expect(LongMediaPlanRequestSchema.safeParse({ ...plan, unexpected: true }).success).toBe(false);
    expect(LongMediaPlanRequestSchema.safeParse({
      ...plan,
      grants: [{ ...plan.grants[0], storageKey: "" }],
    }).success).toBe(false);
  });

  it("allows an adoption leaf without a new write grant", () => {
    const adoption = {
      ...plan,
      intervals: [{ ...plan.intervals[0], mode: "adopt" as const }],
      grants: [],
    };
    expect(LongMediaPlanRequestSchema.safeParse(adoption).success).toBe(true);
  });
});
