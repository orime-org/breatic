// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import { z } from "zod";

/** Finite owned JSON at the persistence boundary. */
export type MiniToolStepJson = null | boolean | number | string | MiniToolStepJson[] | { [key: string]: MiniToolStepJson };
const jsonObject = z.record(z.string(), z.json());
const fingerprint = z.string().regex(/^[a-f0-9]{64}$/);

/** One submit intent and only the evidence received for that specific attempt. */
export const miniToolStepAttemptSchema = z.strictObject({
  attemptId: z.uuid(), preparedAt: z.iso.datetime({ precision: 6 }), requestFingerprint: fingerprint,
  resolution: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("unresolved") }),
    z.strictObject({ kind: z.literal("identity"), predictionId: z.string().min(1) }),
    z.strictObject({ kind: z.literal("rejected"), error: jsonObject }),
    z.strictObject({ kind: z.literal("not_sent"), error: jsonObject }),
  ]),
});
export type MiniToolStepAttempt = z.infer<typeof miniToolStepAttemptSchema>;

/** Execution-owned facts; plans and expense records remain sibling owner fields. */
export const miniToolStepStateSchema = z.strictObject({
  schemaVersion: z.literal(1),
  scope: z.strictObject({ taskId: z.uuid(), stepId: z.uuid(), kind: z.enum(["generate", "container_job"]), endpoint: z.string().min(1), itemIndex: z.number().int().nullable() }),
  deadlineAt: z.number().int().positive().nullable(), requestBody: jsonObject.nullable(), requestFingerprint: fingerprint.nullable(),
  chargeTo: z.enum(["user", "platform"]).nullable(), creditMultiplier: z.number().nonnegative().nullable(),
  attempts: z.array(miniToolStepAttemptSchema),
  result: z.strictObject({ outcome: z.enum(["done", "failed"]), result: jsonObject, error: jsonObject.nullable() }).nullable(),
  error: jsonObject.nullable(),
  conflicts: z.array(z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("identity"), attemptId: z.uuid(), canonicalId: z.string().min(1).nullable(), candidateId: z.string().min(1) }),
    z.strictObject({ kind: z.literal("result"), result: jsonObject }),
    z.strictObject({ kind: z.literal("closed_identity"), attemptId: z.uuid(), candidateId: z.string().min(1) }),
  ])),
});
export type MiniToolStepState = z.infer<typeof miniToolStepStateSchema>;

/**
 * Check whether all declared submit intents have their own resolved identity or rejection.
 * @param state - The complete persisted execution facts.
 * @returns Whether unresolved submit or identity-conflict facts still require reconciliation.
 * @throws {never} Never.
 */
export function hasUnresolvedMiniToolStepAttempts(state: MiniToolStepState): boolean {
  return state.attempts.some((attempt) => attempt.resolution.kind === "unresolved") ||
    state.conflicts.some((conflict) => conflict.kind === "identity" || conflict.kind === "closed_identity");
}
