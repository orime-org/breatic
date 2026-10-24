// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { z } from "zod";
import type { AgentPictureSpec } from "@shared/upload/agent-picture-types.js";
export type { AgentPictureSpec, AgentPictureRead } from "@shared/upload/agent-picture-types.js";

/** Versioned static JPEG encoding contract, independent from display previews. */
export const agentPictureSpecSchema = z.object({
  version: z.literal(1),
  longEdge: z.number().int().positive(),
  quality: z.number().int().min(1).max(100),
});

/** Validates that successful preparation carries usable measured facts. */
export const agentPictureReadSchema = z.union([
  z.object({
    outcome: z.enum(["generated", "existing"]),
    sizeBytes: z.number().int().positive(),
    mediaType: z.literal("image/jpeg"),
  }),
  z.object({ outcome: z.enum(["none", "failed"]) }),
]);

/**
 * Derive a versioned JPEG key from the registered source's canonical key.
 * @param sourceKey - The source asset's registered storage key.
 * @param spec - The complete encoding contract.
 * @returns The immutable derived object's key.
 * @throws {never} Never.
 */
export function agentPictureKeyFor(sourceKey: string, spec: AgentPictureSpec): string {
  return `${sourceKey}.agent-v${spec.version}-${spec.longEdge}-q${spec.quality}.jpg`;
}
