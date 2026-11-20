// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What the mini-tool container posts when its run ends (inner#888 §8.1 step 4),
 * and how the Durable Object reads it.
 */

import { CONTAINER_FAILURES, type ContainerFailure } from "@shared/mini-tools/types.js";

/** A rectangle in an alpha-packed carrier's coded frame. */
interface PackedRect { x: number; y: number; width: number; height: number }
/** An alpha-packed output's plane geometry (§91 D3-3), in the alpha manifest's field names. */
export interface PackedGeometry { packedWidth: number; packedHeight: number; colorRect: PackedRect; alphaRect: PackedRect }
/** The numbers ffprobe read inside the container, per main output. */
export interface MediaOfOutput {
  width: number | null;
  height: number | null;
  durationSeconds: number | null;
  cover: { width: number | null; height: number | null } | null;
  /** Only on an alpha-packed planned output. */
  packing?: PackedGeometry;
}

/** What the container reports. */
export interface ContainerReportBody {
  ok: boolean;
  cpuUsec: number | null;
  media: Record<string, MediaOfOutput>;
  /** Why a failed run failed, when the container could name it. */
  reason?: ContainerFailure;
}

/** One explicitly indexed output's metadata, independent of Worker byte measurements. */
export interface PlanContainerOutput extends MediaOfOutput { outputIndex: number; storageKey: string }
/** What a grid count measured (§7.17 grid_count): the last decoded frame's display time and the decoded frames. */
export interface PlanContainerCount { lastVideoTime: { numerator: number; denominator: number }; sourceFrames: number }
/** The versioned report from one immutable container attempt; a grid count reports its count and no output. */
export interface PlanContainerReportBody {
  schemaVersion: 2;
  attemptId: string;
  ok: boolean;
  cpuUsec: number | null;
  outputs: PlanContainerOutput[];
  count?: PlanContainerCount;
  reason?: ContainerFailure;
}

/**
 * Read finite optional media dimensions without accepting coercions.
 * @param value - A nullable media number.
 * @returns Whether the measured value has the supported numerical domain.
 * @throws {never} Never.
 */
function mediaNumber(value: unknown): boolean {
  return value === null || (typeof value === "number" && Number.isFinite(value) && value >= 0);
}

/**
 * Whether a value is an object whose named fields are all finite numbers.
 * @param item - The untrusted value.
 * @param keys - The fields.
 * @returns Whether each is a finite number.
 * @throws {never} Never.
 */
function numbers(item: unknown, keys: readonly string[]): boolean {
  return typeof item === "object" && item !== null && keys.every((key) => {
    const field = (item as Record<string, unknown>)[key];
    return typeof field === "number" && Number.isFinite(field);
  });
}

/**
 * Whether a value has the shape of packed geometry; its plane rules are the shared schema's, checked on the job report.
 * @param value - The untrusted value.
 * @returns Whether every field is a finite number in place.
 * @throws {never} Never.
 */
function isPackedGeometry(value: unknown): value is PackedGeometry {
  if (!numbers(value, ["packedWidth", "packedHeight"])) return false;
  const raw = value as Record<string, unknown>;
  return numbers(raw.colorRect, ["x", "y", "width", "height"]) && numbers(raw.alphaRect, ["x", "y", "width", "height"]);
}

/**
 * Whether a value has the shape of a grid count: safe-integer time terms and a safe-integer frame count. Its ranges are the
 * shared report schema's, checked on the job report.
 * @param value - The untrusted value.
 * @returns Whether it is a count.
 * @throws {never} Never.
 */
function isPlanCount(value: unknown): value is PlanContainerCount {
  if (typeof value !== "object" || value === null) return false;
  const raw = value as Record<string, unknown>;
  const time = raw.lastVideoTime as Record<string, unknown> | null | undefined;
  return Number.isSafeInteger(raw.sourceFrames) && typeof time === "object" && time !== null && Number.isSafeInteger(time.numerator) && Number.isSafeInteger(time.denominator);
}

/**
 * Read one owned metadata object returned by a planned recipe.
 * @param value - The untrusted report value.
 * @returns The metadata, or null for an invalid shape.
 * @throws {never} Never.
 */
function planMedia(value: unknown): MediaOfOutput | null {
  if (typeof value !== "object" || value === null) return null;
  const raw = value as Record<string, unknown>;
  if (![raw.width, raw.height, raw.durationSeconds].every(mediaNumber)) return null;
  const cover = raw.cover;
  if (cover !== null && (typeof cover !== "object" || !mediaNumber((cover as Record<string, unknown>).width) || !mediaNumber((cover as Record<string, unknown>).height))) return null;
  if (raw.packing !== undefined && !isPackedGeometry(raw.packing)) return null;
  return { width: raw.width as number | null, height: raw.height as number | null, durationSeconds: raw.durationSeconds as number | null, cover: cover as MediaOfOutput["cover"],
    ...(raw.packing === undefined ? {} : { packing: raw.packing }) };
}

/**
 * Read a report the container posted. A cause this side does not know is
 * dropped, and the failure stays unnamed.
 * @param body - The parsed JSON body.
 * @returns The report, or null when it has no `ok`.
 */
export function readContainerReport(body: unknown): ContainerReportBody | PlanContainerReportBody | null {
  if (typeof body !== "object" || body === null) return null;
  const raw = body as Record<string, unknown>;
  if (typeof raw.ok !== "boolean") return null;
  const reason = CONTAINER_FAILURES.find((known) => known === raw.reason);
  if (raw.schemaVersion !== undefined) {
    if (raw.schemaVersion !== 2 || typeof raw.attemptId !== "string" || !Array.isArray(raw.outputs) || !mediaNumber(raw.cpuUsec)) return null;
    const outputs: PlanContainerOutput[] = [];
    for (const item of raw.outputs) {
      const media = planMedia(item);
      if (media === null) return null;
      const output = item as Record<string, unknown>;
      if (typeof output.outputIndex !== "number" || !Number.isSafeInteger(output.outputIndex) || output.outputIndex < 0 || typeof output.storageKey !== "string") return null;
      outputs.push({ outputIndex: output.outputIndex, storageKey: output.storageKey, ...media });
    }
    if (raw.count !== undefined && !isPlanCount(raw.count)) return null;
    return { schemaVersion: 2, attemptId: raw.attemptId, ok: raw.ok, cpuUsec: raw.cpuUsec as number | null, outputs,
      ...(raw.count === undefined ? {} : { count: raw.count }), ...(reason !== undefined && { reason }) };
  }
  return {
    ok: raw.ok,
    cpuUsec: typeof raw.cpuUsec === "number" ? raw.cpuUsec : null,
    media: typeof raw.media === "object" && raw.media !== null ? (raw.media as Record<string, MediaOfOutput>) : {},
    ...(reason !== undefined && { reason }),
  };
}
