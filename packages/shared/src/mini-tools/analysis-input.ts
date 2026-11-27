// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import { z } from "zod";
import { hashMiniToolValue } from "@shared/mini-tools/canonical-value.js";

const profileSchema = z.strictObject({
  id: z.string().min(1),
  version: z.string().min(1),
  weightsHash: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  params: z.record(z.string(), z.json()),
});

const gridFrame = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
/** A range of grid frames [start, end). */
const rangeSchema = z.strictObject({ start: gridFrame, end: gridFrame }).refine((range) => range.end > range.start);

const commonInput = {
  schemaVersion: z.literal(1),
  sourceURL: z.string().url(),
  profile: profileSchema,
};

/** Frozen dependencies, excluding downstream editing and request identities. */
export const miniToolAnalysisInputSchema = z.discriminatedUnion("kind", [
  z.strictObject({ ...commonInput, kind: z.literal("scene_cuts"), range: rangeSchema }),
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
  return miniToolAnalysisInputSchema.parse({ ...common, range: input.params.range });
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
