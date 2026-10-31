// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { groupLongMediaSegments } from "@domain/understand/segment-batches.js";
import { understandMediaAt } from "@domain/understand/understand-at.js";
import { extractPromptText } from "@breatic/shared";
import type { UnderstandAt } from "@domain/understand/types.js";
import type { LongMediaSegmentReference } from "@domain/understand/segment-batches.js";
import type { UnderstandAtAnswer } from "@domain/understand/understand-at.js";
import { longMediaInputDigest } from "@domain/understand/long-media-checkpoint.js";

/** A required long-media batch returned an answer that was not complete. */
export class LongMediaBatchIncompleteError extends Error {
  /** The finish reason returned with the incomplete answer. */
  readonly finishReason: string;

  /**
   * Build the failure for one required but incomplete batch.
   * @param finishReason - The reason the model stopped before finishing.
   */
  public constructor(finishReason: string) {
    super(`Long-media batch stopped before completion (${finishReason}).`);
    this.name = "LongMediaBatchIncompleteError";
    this.finishReason = finishReason;
  }
}

/** Source intervals completed before one required batch failed. */
export interface LongMediaBatchInterval {
  startUs: string;
  endUs: string;
}

/** The durable state returned before one batch may call the model. */
export type LongMediaBatchStart =
  | { kind: "prepared"; attemptId: string }
  | { kind: "ready"; answer: Pick<UnderstandAtAnswer, "text" | "kind" | "kinds"> }
  | { kind: "unknown" }
  | { kind: "busy" };

/** A durable attempt store for long-media batch requests. */
export interface LongMediaBatchCheckpoint {
  begin(
    batchKey: string,
    inputDigest: string,
    interval: LongMediaBatchInterval,
  ): Promise<LongMediaBatchStart>;
  markSending(batchKey: string, inputDigest: string, attemptId: string): Promise<void>;
  saveAttempt(
    batchKey: string,
    inputDigest: string,
    attemptId: string,
    answer: Pick<UnderstandAtAnswer, "text" | "kind" | "kinds">,
  ): Promise<void>;
  markUnknown(batchKey: string, inputDigest: string, attemptId: string): Promise<void>;
}

/** One required batch failed after earlier source intervals completed. */
export class LongMediaBatchFailureError extends Error {
  readonly completedIntervals: LongMediaBatchInterval[];
  readonly failedInterval: LongMediaBatchInterval;

  /**
   * Build a failure that identifies coverage without exposing partial answer text.
   * @param completedIntervals - Source intervals whose answers were checkpointed.
   * @param failedInterval - The source interval whose batch failed.
   * @param cause - The underlying request or checkpoint error.
   */
  public constructor(
    completedIntervals: LongMediaBatchInterval[],
    failedInterval: LongMediaBatchInterval,
    cause: unknown,
  ) {
    const completed = completedIntervals.map(({ startUs, endUs }) =>
      `[${formatSourceTimeUs(startUs)}, ${formatSourceTimeUs(endUs)})`).join(", ");
    super(
      `Long-media batch failed. Completed intervals: ${completed || "none"}. ` +
        `Failed interval: [${formatSourceTimeUs(failedInterval.startUs)}, ${formatSourceTimeUs(failedInterval.endUs)}).`,
      { cause },
    );
    this.name = "LongMediaBatchFailureError";
    this.completedIntervals = completedIntervals;
    this.failedInterval = failedInterval;
  }
}

/** A caller's request for one ordered long-media source. */
export interface UnderstandMediaInBatchesRequest extends Omit<UnderstandAt, "items"> {
  /** The caller's maximum media items in one model request. */
  maxItems: number;
  checkpoint?: LongMediaBatchCheckpoint;
}

/**
 * Understand source-ordered media segments in byte-limited multi-item requests.
 * @param request - The question, model and caller's request limits.
 * @param segments - Registered segments in source-time order with measured sizes.
 * @returns The ordered text and media kinds from the completed requests.
 * @throws {RangeError} When the segment list or its request limits are invalid.
 * @throws {Error} When the underlying request fails or the caller stops the operation.
 */
export async function understandMediaInBatches(
  request: UnderstandMediaInBatchesRequest,
  segments: readonly LongMediaSegmentReference[],
): Promise<UnderstandAtAnswer> {
  if (segments.length === 0) throw new RangeError("Long media understanding requires at least one segment.");

  const batches = groupLongMediaSegments(segments, {
    maxBytes: request.maxBytes,
    maxItems: request.maxItems,
  });
  const { maxItems: _maxItems, checkpoint, ...understandRequest } = request;
  const texts: string[] = [];
  const kinds: UnderstandAtAnswer["kinds"] = [];
  let kind: UnderstandAtAnswer["kind"] | undefined;
  let finishReason = "stop";

  const completedIntervals: LongMediaBatchInterval[] = [];
  for (const [batchIndex, batch] of batches.entries()) {
    request.signal?.throwIfAborted();
    const first = batch[0]!;
    const last = batch[batch.length - 1]!;
    const inputDigest = longMediaInputDigest({
      question: request.question,
      model: request.model,
      backend: request.backend,
      maxOutputTokens: request.maxOutputTokens,
      promptVersion: "long-media-batch-v1",
      batch: batch.map(({ url, ledgerType, sizeBytes, startUs, endUs }) => ({
        url, ledgerType, sizeBytes, startUs, endUs,
      })),
    });
    const timeline = batch.map(({ startUs, endUs }, index) =>
      `item ${String(index + 1)}: [${formatSourceTimeUs(startUs)}, ${formatSourceTimeUs(endUs)})`).join("; ");
    const batchKey = `${String(batchIndex)}:${first.startUs}:${last.endUs}`;
    const interval = { startUs: first.startUs, endUs: last.endUs };
    let answer: Pick<UnderstandAtAnswer, "text" | "kind" | "kinds" | "finishReason">;
    try {
      const start = checkpoint
        ? await checkpoint.begin(batchKey, inputDigest, interval)
        : { kind: "prepared" as const, attemptId: "" };
      if (start.kind === "ready") {
        answer = { ...start.answer, finishReason: "stop" };
      } else if (start.kind === "unknown") {
        throw new Error("The long-media batch outcome is unknown; the model request was not repeated.");
      } else if (start.kind === "busy") {
        throw new Error("The long-media batch is already owned by another active attempt.");
      } else {
        try {
          const freshAnswer = await understandMediaAt({
            ...understandRequest,
            ...(checkpoint ? {
              onRequestSending: () => checkpoint.markSending(batchKey, inputDigest, start.attemptId),
            } : {}),
            question: extractPromptText(
              "These ordered media items are segments from one original media file. Their original source-time " +
                `intervals, in item order, are: ${timeline}. Use the original timeline when referring to times; ` +
                "each segment's local 00:00 is not the source's 00:00.\n\nQuestion: " + request.question,
            ),
            items: batch.map(({ url, ledgerType }) => ledgerType === undefined ? { url } : { url, ledgerType }),
          });
          if (freshAnswer.finishReason !== "stop") throw new LongMediaBatchIncompleteError(freshAnswer.finishReason);
          if (checkpoint) {
            await checkpoint.saveAttempt(batchKey, inputDigest, start.attemptId, {
              text: freshAnswer.text,
              kind: freshAnswer.kind,
              kinds: freshAnswer.kinds,
            });
          }
          answer = freshAnswer;
        } catch (cause) {
          if (checkpoint) await checkpoint.markUnknown(batchKey, inputDigest, start.attemptId);
          throw cause;
        }
      }
    } catch (cause) {
      throw new LongMediaBatchFailureError(
        completedIntervals,
        { startUs: first.startUs, endUs: last.endUs },
        cause,
      );
    }
    kind ??= answer.kind;
    kinds.push(...answer.kinds);
    texts.push(
      `Original source interval: [${formatSourceTimeUs(first.startUs)}, ${formatSourceTimeUs(last.endUs)}).\n${answer.text}`,
    );
    finishReason = answer.finishReason;
    completedIntervals.push({ startUs: first.startUs, endUs: last.endUs });
  }

  if (kind === undefined) throw new RangeError("Long media understanding did not produce a media batch.");
  return { text: texts.join("\n\n"), finishReason, kind, kinds };
}

/**
 * Format an integer microsecond timestamp as a signed source-timeline timecode.
 * @param value - The source timestamp in integer microseconds.
 * @returns A timecode with six fractional digits.
 * @throws {RangeError} When the timestamp is not an integer string.
 */
function formatSourceTimeUs(value: string): string {
  if (!/^(0|-?[1-9][0-9]*)$/.test(value)) throw new RangeError("Source timestamps must be integer microseconds.");
  const timestampUs = BigInt(value);
  const sign = timestampUs < 0n ? "-" : "";
  const absoluteUs = timestampUs < 0n ? -timestampUs : timestampUs;
  const hours = absoluteUs / 3_600_000_000n;
  const minutes = (absoluteUs / 60_000_000n) % 60n;
  const seconds = (absoluteUs / 1_000_000n) % 60n;
  const microseconds = absoluteUs % 1_000_000n;
  return `${sign}${hours.toString().padStart(2, "0")}:${minutes.toString().padStart(2, "0")}:` +
    `${seconds.toString().padStart(2, "0")}.${microseconds.toString().padStart(6, "0")}`;
}
