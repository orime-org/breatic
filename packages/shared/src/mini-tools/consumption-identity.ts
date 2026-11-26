// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import { z } from "zod";
import { hashMiniToolValue } from "@shared/mini-tools/canonical-value.js";

/** The upstream work a consumption pays for: one container job. */
export const miniToolConsumptionIdentitySchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("container"), containerClass: z.string().min(1), jobId: z.string().min(1), chunkIndex: z.number().int().nonnegative() }),
]);

export type MiniToolConsumptionIdentity = z.infer<typeof miniToolConsumptionIdentitySchema>;

const scopeSchema = z.strictObject({
  taskId: z.string().uuid(),
  stepId: z.string().uuid(),
  identity: miniToolConsumptionIdentitySchema,
});

/**
 * Identifies one consumption within its persistent parent task and step.
 * @param input - The persistent scope and actual upstream identity.
 * @returns The versioned consumption digest.
 * @throws {z.ZodError} When the scope or upstream identity is invalid.
 * @throws {DOMException} When the platform cannot compute SHA-256.
 */
export function miniToolConsumptionKey(input: z.infer<typeof scopeSchema>): Promise<string> {
  return hashMiniToolValue({ schemaVersion: 1, ...scopeSchema.parse(input) });
}
