// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from "zod";
import { extractPromptText } from "@shared/agent/extract-prompt.js";
import { hashMiniToolValue } from "@shared/mini-tools/canonical-value.js";

const profileSchema = z.strictObject({
  id: z.string().min(1),
  version: z.string().min(1),
  weightsHash: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  params: z.record(z.string(), z.json()),
});

const gridFrame = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
/** An anchor is its grid frame number (frames-split §10.12 analysis-input.ts row). */
export const miniToolAnchorSchema = z.strictObject({ frameIndex: gridFrame });

/** A range of grid frames [start, end). */
const rangeSchema = z.strictObject({ start: gridFrame, end: gridFrame }).refine((range) => range.end > range.start);
const coordinateSchema = z.number().min(0).max(1);
const boxSchema = z.strictObject({
  x: coordinateSchema, y: coordinateSchema,
  width: z.number().positive().max(1), height: z.number().positive().max(1),
}).refine((box) => box.x + box.width <= 1 && box.y + box.height <= 1);
const regionSchema = z.strictObject({
  box: boxSchema.nullable(),
  points: z.array(z.strictObject({ x: coordinateSchema, y: coordinateSchema, label: z.enum(["positive", "negative"]) })),
});

const commonInput = {
  schemaVersion: z.literal(1),
  sourceURL: z.string().url(),
  profile: profileSchema,
};

/** Frozen dependencies, excluding downstream editing and request identities. */
export const miniToolAnalysisInputSchema = z.discriminatedUnion("kind", [
  z.strictObject({ ...commonInput, kind: z.literal("people"), anchor: miniToolAnchorSchema }),
  z.strictObject({ ...commonInput, kind: z.literal("scene_cuts"), range: rangeSchema }),
  z.strictObject({ ...commonInput, kind: z.literal("tracked_mask"), range: rangeSchema, anchor: miniToolAnchorSchema, region: regionSchema, trackingPrompt: z.string() }),
]);

export type MiniToolAnalysisInput = z.infer<typeof miniToolAnalysisInputSchema>;
export type MiniToolAnalysisKind = MiniToolAnalysisInput["kind"];

/** Inputs owned by the editable draft and the accepted analysis profile. */
export interface MiniToolAnalysisInputSource {
  kind: MiniToolAnalysisKind;
  source: { canonicalURL: string };
  profile: unknown;
  params: Record<string, unknown>;
}

/**
 * Projects the dependencies actually read by each kind of analysis.
 * @param input - Draft dependencies and the frozen analysis profile.
 * @returns The versioned dependency projection.
 * @throws {z.ZodError} When a required dependency is invalid.
 */
export function projectMiniToolAnalysisInput(input: MiniToolAnalysisInputSource): MiniToolAnalysisInput {
  const common = { schemaVersion: 1, kind: input.kind, sourceURL: input.source.canonicalURL, profile: input.profile };
  switch (input.kind) {
    case "people":
      return miniToolAnalysisInputSchema.parse({ ...common, anchor: input.params.anchor });
    case "scene_cuts":
      return miniToolAnalysisInputSchema.parse({ ...common, range: input.params.range });
    case "tracked_mask": {
      // Execution design §10.2: the prompt is cleaned as every AIGC prompt is (extractPromptText, which also trims), and an empty
      // one is the profile's default, frozen into the fingerprint, so the web and the server fingerprint the same selection.
      const prompt = typeof input.params.trackingPrompt === "string" ? extractPromptText(input.params.trackingPrompt) : input.params.trackingPrompt;
      const fallback = (input.profile as { params?: { default_prompt?: unknown } } | null)?.params?.default_prompt;
      const trackingPrompt = prompt === "" && typeof fallback === "string" ? fallback : prompt;
      return miniToolAnalysisInputSchema.parse({ ...common, range: input.params.range, anchor: input.params.anchor, region: input.params.region, trackingPrompt });
    }
  }
}

/**
 * Computes the shared identity of a frozen analysis dependency set.
 * @param input - A complete dependency projection.
 * @returns Its canonical SHA-256 fingerprint.
 * @throws {z.ZodError} When the dependencies are invalid.
 * @throws {DOMException} When the platform cannot compute SHA-256.
 */
export function fingerprintMiniToolAnalysisInput(input: unknown): Promise<string> {
  return hashMiniToolValue(miniToolAnalysisInputSchema.parse(input));
}
