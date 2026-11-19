// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import type { MiniToolPlanPixelRect } from "@shared/upload/mini-tool-plan-types.js";

/** A candidate still awaiting registered thumbnail and persistent person identity. */
export interface AnalysisFaceCandidate {
  detectionIndex: number;
  faceBox: { x: number; y: number; width: number; height: number };
  pixelCrop?: MiniToolPlanPixelRect;
}
/** One frame a detector saw, named by its index and time. */
export interface AnalysisFrame { frameIndex: number; pts: number }
/** A cut on a named frame, independent of a detector's nominal fps. */
export interface AnalysisSceneCut extends AnalysisFrame { detectionScore: number }

/**
 * Recognize actual finite numeric results without coercing strings or null.
 * @param value - A field returned across the detector boundary.
 * @returns Whether it is a finite number.
 * @throws {never} Never.
 */
function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Convert YuNet pixel rectangles into owned normalized face candidates.
 * @param detections - The actual fifteen-value detector rows, or its null result.
 * @param dimensions - The dimensions of the analyzed BGR frame.
 * @param dimensions.width - Source pixel width.
 * @param dimensions.height - Source pixel height.
 * @param includePixelCrop - Whether display analysis retains its original integer pixel selection.
 * @returns Intersecting faces in original detection order.
 * @throws {TypeError} When geometry or a detector row is malformed.
 */
export function readYuNetFaces(detections: unknown, dimensions: { width: number; height: number }, includePixelCrop = false): AnalysisFaceCandidate[] {
  const { width, height } = dimensions;
  if (![width, height].every((value) => Number.isSafeInteger(value) && value > 0)) throw new TypeError("Expected positive integral analysis geometry");
  if (detections === null) return [];
  if (!Array.isArray(detections)) throw new TypeError("Expected YuNet detector rows or null");
  const candidates: AnalysisFaceCandidate[] = [];
  for (let detectionIndex = 0; detectionIndex < detections.length; detectionIndex += 1) {
    const row: unknown = detections[detectionIndex];
    if (!Array.isArray(row) || row.length !== 15 || !row.every(isFiniteNumber)) throw new TypeError("Expected a finite fifteen-number YuNet row");
    const left = Math.max(0, row[0]!);
    const top = Math.max(0, row[1]!);
    const right = Math.min(width, row[0]! + row[2]!);
    const bottom = Math.min(height, row[1]! + row[3]!);
    if (right <= left || bottom <= top) continue;
    const x = left / width;
    const y = top / height;
    const pixelX = Math.floor(left);
    const pixelY = Math.floor(top);
    candidates.push({ detectionIndex, faceBox: {
      x, y,
      width: Math.min((right - left) / width, 1 - x),
      height: Math.min((bottom - top) / height, 1 - y),
    }, ...(includePixelCrop ? { pixelCrop: {
      x: pixelX, y: pixelY, width: Math.ceil(right) - pixelX, height: Math.ceil(bottom) - pixelY,
    } } : {}) });
  }
  return candidates;
}

/**
 * Map returned detector cut indices through the frozen source-frame ledger.
 * @param observations - Owned detector-index and content_val observations.
 * @param sourceFrames - Source frames in the detector's exact input order.
 * @returns Cuts carrying original source identities and timestamps.
 * @throws {TypeError} When an observation, metric or frozen mapping is invalid.
 */
export function readSceneCutObservations(observations: unknown, sourceFrames: readonly AnalysisFrame[]): AnalysisSceneCut[] {
  if (sourceFrames.length === 0) throw new TypeError("Expected a complete nonempty source mapping");
  const sourceIndices = new Set<number>();
  for (const frame of sourceFrames) {
    if (!Number.isSafeInteger(frame.frameIndex) || frame.frameIndex < 0 || !isFiniteNumber(frame.pts) || sourceIndices.has(frame.frameIndex)) {
      throw new TypeError("Expected unique source indices and finite source timestamps");
    }
    sourceIndices.add(frame.frameIndex);
  }
  if (!Array.isArray(observations)) throw new TypeError("Expected scene cut observations");
  const seenCuts = new Set<number>();
  return observations.map((value: unknown) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError("Expected an owned scene observation");
    const raw = value as Record<string, unknown>;
    const index = raw.detectorFrameIndex;
    const score = raw.detectionScore;
    if (typeof index !== "number" || !Number.isSafeInteger(index) || index < 0 || index >= sourceFrames.length || seenCuts.has(index)) {
      throw new TypeError("Scene cut does not identify one unique mapped detector frame");
    }
    if (!isFiniteNumber(score)) throw new TypeError("Scene cut lacks its finite content metric");
    seenCuts.add(index);
    const source = sourceFrames[index]!;
    return { frameIndex: source.frameIndex, pts: source.pts, detectionScore: score };
  });
}
