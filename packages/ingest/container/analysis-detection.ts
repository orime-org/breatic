// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

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
