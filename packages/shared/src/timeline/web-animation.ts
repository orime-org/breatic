// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Web-animation contracts both sides compute the same way (inner#1711): the source Manifest the runner writes, the
 * create-execution input the dialog submits and the preview path token.
 */

import { z } from "zod";

import { TimelineRateSchema, type TimelineRate } from "@shared/timeline/schema.js";
import { decodeBase64Utf8, encodeBase64Utf8 } from "@shared/upload/base64.js";

/** The animation runtime every source package is built with. */
export const WEB_ANIMATION_RUNTIME = { id: "hyperframes", version: "0.8.186" } as const;

const positiveInteger = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
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

/** The creation dialog's frozen input; `fps` is the target document's frame rate. */
export const TimelineExecutionCreateInputSchema = z.object({
  spaceId: z.uuid(),
  actionId: z.uuid(),
  prompt: z.string().min(1),
  engine: z.literal("deepseek"),
  aspect: z.enum(["16:9", "9:16", "1:1"]),
  durationSeconds: positiveInteger,
  fps: TimelineRateSchema,
}).strict();

/** A parsed create-execution input. */
export type TimelineExecutionCreateInput = z.infer<typeof TimelineExecutionCreateInputSchema>;

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
