// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { z } from "zod";

import { LongMediaInputSchema } from "@shared/media/long-media-probe.js";
import { MediaInputDescriptorSchema } from "@shared/media/long-media-schema.js";

const sha256 = z.string().regex(/^[a-f0-9]{64}$/i);
const integerUs = z.string().regex(/^(0|-?[1-9][0-9]*)$/);
const range = z.object({ startUs: integerUs, endUs: integerUs }).strict()
  .refine((value) => BigInt(value.startUs) < BigInt(value.endUs), "Invalid media interval");

/** One logical source-time interval being added or replaced in a job plan. */
const interval = z.object({
  id: z.string().min(1),
  mediaInputId: z.string().min(1),
  descriptor: MediaInputDescriptorSchema,
  core: range,
  decode: range,
  mode: z.enum(["prepare", "adopt"]),
}).strict().refine((value) =>
  BigInt(value.decode.startUs) <= BigInt(value.core.startUs) &&
  BigInt(value.decode.endUs) >= BigInt(value.core.endUs),
"A decode window must contain its core");

/** One exact Node-issued object grant bound to a segment candidate. */
const grant = z.object({
  segmentId: z.string().min(1),
  candidateId: z.string().min(1),
  grantId: z.string().min(1),
  storageKey: z.string().min(1),
}).strict();

/** A versioned root plan or same-input replacement submitted by trusted Node. */
export const LongMediaPlanRequestSchema = z.object({
  expectedVersion: z.number().int().nonnegative().safe(),
  mutationId: z.string().min(1),
  requiredMediaInputs: z.array(LongMediaInputSchema).length(1),
  requiredMediaInputsDigest: sha256,
  mediaInputId: z.string().min(1),
  parentId: z.string().min(1).nullable(),
  intervals: z.array(interval).min(1),
  grants: z.array(grant),
}).strict().superRefine((request, context) => {
  const inputById = new Map(request.requiredMediaInputs.map((input) => [input.mediaInputId, input]));
  const intervalsById = new Map(request.intervals.map((item) => [item.id, item]));
  const grantsBySegmentId = new Map(request.grants.map((item) => [item.segmentId, item]));
  if (inputById.size !== request.requiredMediaInputs.length) {
    context.addIssue({ code: "custom", path: ["requiredMediaInputs"], message: "Duplicate media input identity" });
  }
  if (intervalsById.size !== request.intervals.length) {
    context.addIssue({ code: "custom", path: ["intervals"], message: "Duplicate interval identity" });
  }
  if (grantsBySegmentId.size !== request.grants.length) {
    context.addIssue({ code: "custom", path: ["grants"], message: "Duplicate segment grant" });
  }
  if (!inputById.has(request.mediaInputId) || request.intervals.some((item) => item.mediaInputId !== request.mediaInputId)) {
    context.addIssue({ code: "custom", path: ["mediaInputId"], message: "Plan intervals must match its required media input" });
  }
  for (const [index, item] of request.intervals.entries()) {
    const input = inputById.get(item.mediaInputId);
    if (input === undefined || JSON.stringify(input.descriptor) !== JSON.stringify(item.descriptor)) {
      context.addIssue({ code: "custom", path: ["intervals", index, "descriptor"], message: "Interval descriptor must match its probe" });
    }
    const candidateGrant = grantsBySegmentId.get(item.id);
    if ((item.mode === "prepare") !== (candidateGrant !== undefined)) {
      context.addIssue({ code: "custom", path: ["intervals", index, "mode"], message: "Prepare intervals need exactly one grant" });
    }
  }
  if (request.grants.some((item) => !intervalsById.has(item.segmentId))) {
    context.addIssue({ code: "custom", path: ["grants"], message: "Grants must reference a planned interval" });
  }
  if (new Set(request.grants.map((item) => item.candidateId)).size !== request.grants.length ||
      new Set(request.grants.map((item) => item.grantId)).size !== request.grants.length ||
      new Set(request.grants.map((item) => item.storageKey)).size !== request.grants.length) {
    context.addIssue({ code: "custom", path: ["grants"], message: "Candidate grants must have unique identities and keys" });
  }
});

/** The validated plan mutation sent to the long-media Durable Object. */
export type LongMediaPlanRequest = z.infer<typeof LongMediaPlanRequestSchema>;

/**
 * Compute the stable identity of the complete required input set for one source.
 * @param sourceFingerprint - The immutable source content hash.
 * @param profileVersion - The frozen channel-preserving conversion profile.
 * @param requiredMediaInputs - The one probe-derived complete source-file input.
 * @returns A lowercase SHA-256 digest.
 * @throws {z.ZodError} When the input list or its identities are invalid.
 * @throws {DOMException} When the runtime cannot compute SHA-256.
 */
export async function computeLongMediaInputsDigest(
  sourceFingerprint: string,
  profileVersion: string,
  requiredMediaInputs: LongMediaPlanRequest["requiredMediaInputs"],
): Promise<string> {
  const parsedInputs = z.array(LongMediaInputSchema).length(1).parse(requiredMediaInputs);
  const canonical = {
    version: 1,
    sourceFingerprint: sha256.parse(sourceFingerprint).toLowerCase(),
    profileVersion: z.string().min(1).parse(profileVersion),
    requiredMediaInputs: parsedInputs,
  };
  const bytes = new TextEncoder().encode(JSON.stringify(canonical));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Parse a trusted Node plan payload before persisting it.
 * @param value - The untrusted JSON payload.
 * @returns A strictly validated plan mutation.
 * @throws {z.ZodError} When a field, identity, grant or interval is invalid.
 */
export function readLongMediaPlanRequest(value: unknown): LongMediaPlanRequest {
  return LongMediaPlanRequestSchema.parse(value);
}
