// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Web-animation contracts both sides compute the same way (inner#1711, #1490): the source Manifest the runner writes,
 * the three execution kinds a client asks for and the input acceptance freezes, the row view every route answers,
 * where an annotation points, and the preview path token.
 */

import { z } from "zod";

import { TimelineRateSchema, type TimelineRate } from "@shared/timeline/schema.js";
import { durationToFrames } from "@shared/timeline/time.js";
import { decodeBase64Utf8, encodeBase64Utf8 } from "@shared/upload/base64.js";
import { WEB_ANIMATION_RUNTIME } from "@shared/timeline/web-animation-runtime.js";

export { WEB_ANIMATION_RUNTIME };

const positiveInteger = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);

/**
 * Where a web-animation execution is (inner#1711, #1490); only `timelineExecutionRepo.transition` moves it.
 * `awaiting_landing` is held only by rows written before #1490 and by the previous server during its deploy window.
 */
export const WebAnimationExecutionStatusSchema = z.enum(["awaiting_landing", "queued", "running", "cancelling", "succeeded", "failed", "cancelled", "expired"]);

/** A web-animation execution's status. */
export type WebAnimationExecutionStatus = z.infer<typeof WebAnimationExecutionStatusSchema>;

/** The statuses of an execution that ended without a result: it failed, was cancelled or expired. */
export const WEB_ANIMATION_FAILED_STATUSES = ["failed", "cancelled", "expired"] as const satisfies readonly WebAnimationExecutionStatus[];

const FAILED: ReadonlySet<WebAnimationExecutionStatus> = new Set(WEB_ANIMATION_FAILED_STATUSES);
/** The statuses an execution can no longer leave. */
const ENDED: ReadonlySet<WebAnimationExecutionStatus> = new Set(["succeeded", ...WEB_ANIMATION_FAILED_STATUSES]);

/** The statuses of an execution still in progress: every other one. */
export const WEB_ANIMATION_OPEN_STATUSES: readonly WebAnimationExecutionStatus[] = WebAnimationExecutionStatusSchema.options.filter((status) => !ENDED.has(status));

/**
 * Whether an execution has ended: it succeeded, failed, was cancelled or expired.
 * @param status - Its status.
 * @returns True once it can no longer change.
 * @throws {never} Never.
 */
export function webAnimationExecutionEnded(status: WebAnimationExecutionStatus): boolean {
  return ENDED.has(status);
}

/**
 * Whether an execution ended without a result: it failed, was cancelled or expired.
 * @param status - Its status.
 * @returns True when it ended and did not succeed.
 * @throws {never} Never.
 */
export function webAnimationExecutionFailed(status: WebAnimationExecutionStatus): boolean {
  return FAILED.has(status);
}
const viewport = z.object({ width: positiveInteger, height: positiveInteger }).strict();

/** The one Manifest shape a source package carries beside its `index.html`. */
export const WebAnimationManifestSchema = z.object({
  schemaVersion: z.literal(1),
  entrypoint: z.literal("index.html"),
  viewport,
  fps: TimelineRateSchema,
  durationFrames: positiveInteger,
  resources: z.array(z.object({ kind: z.literal("font-set"), version: positiveInteger }).strict()).length(1),
  runtime: z.object({ id: z.literal(WEB_ANIMATION_RUNTIME.id), version: z.literal(WEB_ANIMATION_RUNTIME.version) }).strict(),
}).strict();

/** A parsed source Manifest. */
export type WebAnimationManifest = z.infer<typeof WebAnimationManifestSchema>;

/** What the accepted execution input fixes about its result. */
export interface WebAnimationExpectation {
  viewport: { width: number; height: number };
  fps: TimelineRate;
  durationFrames: number;
  fontSetVersion: number;
}

/** Why a Manifest does not match its accepted input. */
export type WebAnimationManifestMismatch = "viewport_mismatch" | "fps_mismatch" | "duration_mismatch" | "font_set_mismatch";

/**
 * Check a Manifest against the input its execution accepted.
 * @param manifest - The parsed Manifest; only the fields the input fixes are read.
 * @param expected - The accepted viewport, fps, duration and font set.
 * @returns Null when it matches, otherwise the first field that differs.
 * @throws {never} Never.
 */
export function matchWebAnimationManifest(
  manifest: Pick<WebAnimationManifest, "viewport" | "fps" | "durationFrames" | "resources">,
  expected: WebAnimationExpectation,
): WebAnimationManifestMismatch | null {
  if (manifest.viewport.width !== expected.viewport.width || manifest.viewport.height !== expected.viewport.height) {
    return "viewport_mismatch";
  }
  if (manifest.fps.num * expected.fps.den !== expected.fps.num * manifest.fps.den) return "fps_mismatch";
  if (manifest.durationFrames !== expected.durationFrames) return "duration_mismatch";
  if (manifest.resources.some((resource) => resource.version !== expected.fontSetVersion)) return "font_set_mismatch";
  return null;
}

// Annotated so a kind written into an object keeps its literal type in the emitted declarations.
const CREATE = "web_animation_create" as const;
const MODIFY = "web_animation_modify" as const;
const EXPORT = "web_animation_export" as const;

/** The three kinds of web-animation execution. */
export const WebAnimationExecutionKindSchema = z.enum([CREATE, MODIFY, EXPORT]);

/** One kind of web-animation execution. */
export type WebAnimationExecutionKind = z.infer<typeof WebAnimationExecutionKindSchema>;

const OriginSchema = z.enum(["timeline", "web_animation_space"]);

/** Where an execution was asked for: a Motion Space, or a Timeline before #1490 (and an older tab still open). */
export type WebAnimationExecutionOrigin = z.infer<typeof OriginSchema>;

const engine = z.literal("deepseek");
const aspect = z.enum(["16:9", "9:16", "1:1"]);
const keyed = { spaceId: z.uuid(), actionId: z.uuid() };
const createFields = { prompt: z.string().min(1), engine, aspect, durationSeconds: positiveInteger };
const modifyFields = { baseSourceVersionId: z.uuid(), instruction: z.string().min(1), engine, aspect, durationSeconds: positiveInteger };
const exportFields = { sourceVersionId: z.uuid() };

const kindedRequest = z.discriminatedUnion("kind", [
  z.object({ ...keyed, kind: z.literal(CREATE), ...createFields }).strict(),
  z.object({ ...keyed, kind: z.literal(MODIFY), ...modifyFields }).strict(),
  z.object({ ...keyed, kind: z.literal(EXPORT), ...exportFields }).strict(),
]);

/**
 * What an older Timeline tab still submits: a create without `kind`, with the Timeline document's frame rate.
 * Accepted only through the deploy window; the next release requires `kind` (#1490 design §4.1, §12).
 */
const legacyCreateRequest = z.object({ ...keyed, ...createFields, fps: TimelineRateSchema }).strict();

/**
 * What a client asks to run, read with where it was asked from. An older tab's kind-less body is a Timeline create
 * and its frame rate is dropped: the server freezes the configured one.
 */
export const WebAnimationExecutionRequestSchema = z.union([
  kindedRequest.transform((request) => ({ ...request, origin: "web_animation_space" as const })),
  legacyCreateRequest.transform(({ fps: _fps, ...request }) => ({ ...request, kind: CREATE, origin: "timeline" as const })),
]);

/** A read execution request. */
export type WebAnimationExecutionRequest = z.infer<typeof WebAnimationExecutionRequestSchema>;

const frozenCreate = z.object({ ...createFields, fps: TimelineRateSchema }).strict();
const frozenModify = z.object({ ...modifyFields, fps: TimelineRateSchema }).strict();
const frozenExport = z.object({
  ...exportFields,
  width: positiveInteger,
  height: positiveInteger,
  fps: TimelineRateSchema,
  durationFrames: positiveInteger,
  /** The key acceptance minted for the video; the cover's is `coverKeyFor(videoKey)`. */
  videoKey: z.string().min(1).max(500),
}).strict();

/** The input acceptance freezes, by kind; the row stores it without `kind`, which lives in its own column. */
export const WebAnimationExecutionInputSchema = z.discriminatedUnion("kind", [
  frozenCreate.extend({ kind: z.literal(CREATE) }),
  frozenModify.extend({ kind: z.literal(MODIFY) }),
  frozenExport.extend({ kind: z.literal(EXPORT) }),
]);

/** A frozen execution input, with its kind. */
export type WebAnimationExecutionInput = z.infer<typeof WebAnimationExecutionInputSchema>;

/**
 * The one reader of a stored row's input: the kind column decides, whatever the jsonb holds.
 * @param row - The row's kind and stored input.
 * @param row.kind - Its kind column.
 * @param row.input - Its input jsonb.
 * @returns The input with its kind.
 * @throws {z.ZodError} When the stored input does not fit its kind.
 */
export function executionInputOf(row: { kind: WebAnimationExecutionKind; input: unknown }): WebAnimationExecutionInput {
  return WebAnimationExecutionInputSchema.parse({ ...(row.input as Record<string, unknown>), kind: row.kind });
}

/** The phases a running execution reports. */
export const WebAnimationPhaseSchema = z.enum(["writing", "validating", "saving", "rendering"]);

const requestRef = z.object({ executionId: z.uuid(), request: z.string() }).strict();
const exportRef = z.object({ executionId: z.uuid(), status: WebAnimationExecutionStatusSchema }).strict();
const isoTime = z.string().min(1);

const rowCommon = {
  id: z.uuid(),
  projectId: z.uuid(),
  spaceId: z.uuid(),
  actorUserId: z.string().min(1),
  actionId: z.string().min(1),
  inputHash: z.string().min(1),
  attempt: z.number().int().nonnegative(),
  fence: z.string().nullable(),
  billedCredits: z.string().nullable(),
  billedAt: isoTime.nullable(),
  origin: OriginSchema,
  status: WebAnimationExecutionStatusSchema,
  phase: WebAnimationPhaseSchema.nullable(),
  steps: z.array(z.unknown()),
  failureReason: z.string().nullable(),
  ownProject: z.boolean(),
  usageCredits: z.number().nonnegative(),
  deadlineAt: isoTime,
  createdAt: isoTime,
  updatedAt: isoTime,
  resultSourceVersionId: z.uuid().nullable(),
  resultAssetId: z.uuid().nullable(),
};

/**
 * The one shape every route answers a web-animation execution in (#1490 design §4.4): the execution row with its
 * request text, the base a modification started from, the source an export renders, and, on routes that name the
 * Motion Space the user is in, the export this result already has there.
 */
export const WebAnimationRowViewSchema = z.discriminatedUnion("kind", [
  z.object({ ...rowCommon, kind: z.literal(CREATE), engine, input: frozenCreate, request: z.string(), export: exportRef.nullable().optional() }).strict(),
  z.object({ ...rowCommon, kind: z.literal(MODIFY), engine, input: frozenModify, request: z.string(), base: requestRef, export: exportRef.nullable().optional() }).strict(),
  z.object({
    ...rowCommon, kind: z.literal(EXPORT), engine: z.null(), input: frozenExport,
    source: z.object({ executionId: z.uuid(), request: z.string(), base: requestRef.optional() }).strict(),
  }).strict(),
]);

/** One execution as the routes answer it. */
export type WebAnimationRowView = z.infer<typeof WebAnimationRowViewSchema>;

/** Where a Motion annotation points: a time in a result, and optionally a point on its frame as fractions. */
export const WebAnimationAnchorSchema = z.object({
  executionId: z.uuid(),
  timeSeconds: z.number().finite().min(0),
  point: z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) }).strict().nullable(),
}).strict();

/** A Motion annotation's anchor. */
export type WebAnimationAnchor = z.infer<typeof WebAnimationAnchorSchema>;

/**
 * Read the anchor out of a thread's metadata.
 * @param metadata - The thread's metadata, as stored.
 * @returns The anchor, or null when there is no valid one.
 * @throws {never} Never.
 */
export function readWebAnimationAnchor(metadata: unknown): WebAnimationAnchor | null {
  if (typeof metadata !== "object" || metadata === null) return null;
  const parsed = WebAnimationAnchorSchema.safeParse((metadata as Record<string, unknown>).webAnimationAnchor);
  return parsed.success ? parsed.data : null;
}

/**
 * Keep the playhead's time inside a result, as an anchor stores it.
 * @param timeSeconds - The playhead's time.
 * @param durationSeconds - The result's length.
 * @returns The time, held between 0 and the length.
 * @throws {never} Never.
 */
export function anchorTimeWithin(timeSeconds: number, durationSeconds: number): number {
  return Math.min(Math.max(timeSeconds, 0), durationSeconds);
}

/**
 * The frames an accepted input asks for: its seconds at its frozen frame rate. A placeholder clip is this long and the
 * Manifest must say the same.
 * @param input - The frozen input.
 * @param input.durationSeconds - Its length in seconds.
 * @param input.fps - Its frozen frame rate.
 * @returns The frame count.
 * @throws {RangeError} When the rate or the resulting count is invalid.
 */
export function webAnimationDurationFrames(input: { durationSeconds: number; fps: TimelineRate }): number {
  return durationToFrames(input.durationSeconds, input.fps);
}

/** The most bytes a Manifest may take; it is a few hundred. */
export const WEB_ANIMATION_MANIFEST_MAX_BYTES = 64 * 1024;

const BASE64URL = /^[A-Za-z0-9_-]+$/;

/**
 * Carry a signed payload in one URL path segment.
 * @param signed - The signed payload.
 * @returns Its unpadded base64url form.
 * @throws {never} Never.
 */
export function encodePreviewToken(signed: string): string {
  return encodeBase64Utf8(signed).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Reverse {@link encodePreviewToken}.
 * @param token - A path segment.
 * @returns The signed payload, or null when the segment is not base64url.
 * @throws {never} Never.
 */
export function decodePreviewToken(token: string): string | null {
  if (!BASE64URL.test(token)) return null;
  try {
    return decodeBase64Utf8(token.replace(/-/g, "+").replace(/_/g, "/"));
  } catch {
    // A path segment that is not base64 is not a token.
    return null;
  }
}
