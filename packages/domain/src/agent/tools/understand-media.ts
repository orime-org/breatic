// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Media understanding tool — ask one question about ordered images, video and audio.
 *
 * The model supplies source addresses in input order. This tool selects the
 * model, backend and credential for the shared understanding capability.
 *
 * Nothing here interprets a failure into a retry. A call that came back empty
 * says so and says what stopped it, and a file that is too large says how large
 * is allowed, and how large it is when the far side stated it — both are things
 * the model can act on, and only it
 * knows whether a different question or a different file is available.
 */

import { tool, type Tool } from "ai";
import { z } from "zod";
import { budgetDeadlineFrom, getAgentConfig, getRawEnvVar, getUnderstandConfig } from "@breatic/core";
import { FAILURE_LINES, type FailureLine, type LongMediaSourceReference } from "@breatic/shared";
import { isStop, stoppedByUser, toolFailed, turnedAway } from "@domain/agent/tools/failure.js";
import { usageContextSchema } from "@domain/agent/tools/usage-context.js";
import type { UsageContext } from "@domain/agent/tools/usage-context.js";
import type { SaveToStorage } from "@domain/agent/tools/save-image.js";
import type { RegisteredLongMediaSegment } from "@domain/understand/index.js";
import {
  AUDIO_FORMAT_NAMES,
  IMAGE_FORMAT_NAMES,
  LongMediaBatchFailureError,
  longMediaOperationId,
  openLongMediaBatchOperation,
  LongMediaBatchIncompleteError,
  LongMediaCancellationError,
  MediaUnavailable,
  UNDERSTAND_PINS,
  advanceLongMediaSegmentation,
  cancelLongMediaSegmentation,
  understandMediaAt,
  understandMediaInBatches,
  UnderstandRefused,
  VIDEO_FORMAT_NAMES,
} from "@domain/understand/index.js";

/** One ordered batch and its shared question. */
interface UnderstandMediaInput {
  items: Array<{ url: string }>;
  question: string;
}

/**
 * What to tell the model when a type is one this endpoint will not take.
 *
 * A format refused for being the wrong format reaches the same kind as a pdf,
 * because both mean the address cannot be carried — but the sentences cannot
 * be the same. "That is not audio" is false about a voice memo and leaves the
 * model with no move, while naming what the endpoint does take is something it
 * can pass on. The tests here are exact rather than guesses: a type settles to
 * a kind before its format is judged, so `audio/` at this point can only be
 * audio whose format was refused.
 * @param declaredType - The type it was settled as, when one was settled.
 * @returns The sentence for the model.
 */
function unsupportedSentence(declaredType: string | undefined): string {
  if (declaredType === undefined) {
    return (
      "That address does not say what it holds, and its name does not either, so it " +
      "cannot be treated as an image, a video or audio."
    );
  }
  if (declaredType.startsWith("audio/")) {
    return (
      `That address holds ${declaredType}, which this model cannot listen to. ` +
      `It takes ${AUDIO_FORMAT_NAMES}. Tell the user to convert it.`
    );
  }
  if (declaredType.startsWith("video/")) {
    return (
      `That address holds ${declaredType}, which this model cannot watch. ` +
      `It takes ${VIDEO_FORMAT_NAMES}. Tell the user to convert it.`
    );
  }
  if (declaredType.startsWith("image/")) {
    return (
      `That address holds ${declaredType}, which this model cannot look at. ` +
      `It takes ${IMAGE_FORMAT_NAMES}. Tell the user to convert it.`
    );
  }
  return `That address holds ${declaredType}, which is not an image, a video or audio.`;
}

/**
 * What to tell the model when an address could not be turned into media.
 *
 * Exhaustive over the kinds rather than a chain ending in a catch-all: a kind
 * added without a sentence of its own would otherwise inherit whichever one
 * happens to be last, and say something false about it.
 * @param err - What the fetch refused with.
 * @returns The sentence for the model, and the line a reader is shown.
 */
function unavailableFailure(err: MediaUnavailable): Error {
  const item = err.itemIndex === undefined ? "" : `Item ${String(err.itemIndex)} (${err.url ?? "unknown address"}): `;
  switch (err.kind) {
    case "too-large": {
      // The size is stated only when the far side stated it. A body that
      // arrives without a length is cut off part way, and what is known then
      // is that more than the limit came, not how much.
      const size = err.bytes === undefined ? "That file is" : `That file is ${err.bytes} bytes,`;
      return toolFailed(
        `${item}${size} over the ${err.limit} byte limit, so it was not sent. ` +
          "Tell the user it is too large, and say the limit.",
        FAILURE_LINES.fileTooLarge,
      );
    }
    case "unsupported-type":
      return toolFailed(`${item}${unsupportedSentence(err.declaredType)}`, FAILURE_LINES.unsupportedType);
    case "slow":
      // No count: the read gives up on a budget, and how much had arrived by
      // then is not something that side comes away with.
      return toolFailed(
        `${item}That file took too long to arrive. Tell the user the download did not finish.`,
        FAILURE_LINES.tooSlow,
      );
    case "empty":
      return toolFailed(
        `${item}That address holds an empty file, so there was nothing to look at. ` +
          "Tell the user the file is empty.",
        FAILURE_LINES.emptyFile,
      );
    case "unreachable":
      return toolFailed(
        err.status
          ? `${item}That address answered ${err.status}, so there was nothing to look at.`
          : `${item}That address could not be reached: ${err.detail ?? "no answer"}.`,
        FAILURE_LINES.linkUnreachable,
      );
  }
}

/**
 * What to tell the model when our own request produced no answer to judge.
 *
 * Naming the address would send the model to blame a url that was fine, and
 * the endpoint has no business in a conversation.
 * @param cause - What was caught.
 * @param readerKey - Whether the service failed (`busy`) or never answered
 *   at all (`noConnection`).
 * @returns The sentence for the model, and the line a reader is shown.
 */
function serviceSilent(cause: unknown, readerKey: FailureLine): Error {
  return toolFailed(
    "The media understanding service did not answer. Tell the user to try again shortly.",
    readerKey,
    cause,
  );
}

/**
 * What to tell the model when the service would not answer the call.
 *
 * Exhaustive over the kinds, the way the sentences for an unavailable address
 * are: each kind leaves the model a different move, and a kind added without a
 * sentence of its own would take whichever move happens to be last. The move is
 * the part that matters — the same words with the wrong move attached are worse
 * than no words, since "do not send this file again" on a question the model
 * could simply reword takes away the only step that would have worked.
 * @param err - What the service refused with.
 * @returns The sentence for the model, and the line a reader is shown.
 */
function refusedFailure(err: UnderstandRefused): Error {
  switch (err.kind) {
    case "media":
      // Only 413 establishes a size reason. Other media refusals do not
      // establish whether bytes, an external image fetch or our request was
      // responsible, so both audiences receive the service's facts.
      return err.status === 413
        ? toolFailed(
          `The service would not take this media: ${err.detail}. ` +
            "Tell the user, and do not send the same file again.",
          FAILURE_LINES.fileTooLarge,
        )
        : toolFailed(
          `The service did not accept this media request: ${err.detail}. ` +
            "Tell the user it could not be processed. Use the reported reason to choose the next step; " +
            "do not guess the cause or which item failed.",
          FAILURE_LINES.refused,
        );
    case "unfetchable":
      // An image travels as its address and the backend fetches it, so this
      // one is about reaching the address rather than about the file. Moving
      // it somewhere reachable is the step that clears it, and it is a step
      // the sentence for a refused file forbids.
      return toolFailed(
        `The service could not reach that address: ${err.detail}. ` +
          "Tell the user to put the file somewhere the service can reach, or give another address.",
        FAILURE_LINES.linkUnreachable,
      );
    case "content-filter":
      return toolFailed(
        `The service declined to answer this question about the media: ${err.detail}. ` +
          "Asking differently may work.",
        FAILURE_LINES.declined,
      );
    case "deployment":
      // Not a word about the file. The account, the credential and the model
      // asked for are ours, and a user told their file was rejected goes off to
      // convert something that was never looked at.
      return toolFailed(
        `Media understanding is not available right now: ${err.detail}. ` +
          "Tell the user it is unavailable, and do not blame anything they sent.",
        FAILURE_LINES.unavailable,
      );
    case "transient":
      return serviceSilent(err, FAILURE_LINES.busy);
  }
}

/**
 * What to add to an answer that stopped before the model was finished.
 *
 * Keyed by the endpoint's own vocabulary, and absent for every reason that
 * means the model said what it had to say.
 */
const STOPPED_SHORT: Readonly<Record<string, string>> = {
  length: "This description was cut off at the length limit.",
  error: "This description stopped part way: the service failed while writing it.",
  content_filter: "The rest of this description was withheld by a content filter.",
};

/** The caller capabilities the media tool may use during one turn. */
interface UnderstandMediaContext extends UsageContext {
  saveToStorage?: SaveToStorage;
  studioId?: string;
  projectId?: string;
  actorUserId?: string;
  resolveCanonicalMediaSource?: (url: string) => Promise<LongMediaSourceReference | null>;
}

const understandMediaContextSchema: z.ZodType<UnderstandMediaContext> = usageContextSchema.and(z.object({
  saveToStorage: z.custom<SaveToStorage>((value) => typeof value === "function", "a save function").optional(),
  studioId: z.string().min(1).optional(),
  projectId: z.string().min(1).optional(),
  actorUserId: z.string().min(1).optional(),
  resolveCanonicalMediaSource: z.custom<NonNullable<UnderstandMediaContext["resolveCanonicalMediaSource"]>>(
    (value) => typeof value === "function",
    "a canonical media source resolver",
  ).optional(),
}));

/**
 * The media understanding tool, as a turn receives it.
 *
 * A fresh one per turn, because it carries a turn's worth of state: the gate
 * below. Kept once for the module instead, that gate would be shared by every
 * conversation on this server, and one turn reading a file would turn away
 * everyone else.
 * @param options - The main model's resolved ability to see pictures.
 * @param options.seesPictures - Whether the main model receives prepared pictures directly.
 * @returns The tool.
 * @throws {Error} when the Agent configuration cannot be loaded.
 */
export function makeUnderstandMediaTool(options: { seesPictures?: boolean } = {}): Tool<UnderstandMediaInput, string, UnderstandMediaContext> {
  const config = { ...getAgentConfig() };
  const inputSchema = z.object({
    items: z.array(z.object({ url: z.string().url().describe("Address of the image, video or audio") }))
      .min(1)
      .max(config.understand_media_max_items)
      .describe("Media to compare or understand, in the order to use in the answer"),
    question: z.string().trim().min(1).describe("One question about all supplied items"),
  });
  // One batch may hold several inline AV files. The SDK executes tools from
  // one step concurrently, so this per-turn gate admits only one whole batch
  // at a time and bounds its cumulative download allowance.
  //
  // Turned away rather than queued: the model plans the step, and a refusal
  // naming what to wait for lets it come back for this file having read the
  // answer to the last. Queued, it would wait on a decision it never made.
  let running = false;

  return tool({
    description:
      (options.seesPictures
        ? "Watch videos, listen to audio, compare mixed media, or inspect an original image for details missing from the supplied picture. Pictures already supplied with messages can be read directly. "
        : "Look at images, watch videos, listen to audio, or compare mixed media. ") +
      `Give one shared question and an ordered batch of 1 to ${String(config.understand_media_max_items)} items. ` +
      `Audio and video downloads together must fit the ${String(config.understand_media_max_bytes)} byte allowance. ` +
      "Images each retain the same single-file byte limit. Item numbers identify the input order. " +
      "Pictures omitted from this request's budget can be inspected here using their original source address. " +
      "Wait for this batch's answer before calling again.",
    inputSchema,
    contextSchema: understandMediaContextSchema,
    // What the panel reads about a running call, resolved by the web package.
    metadata: { runningLine: "chat.tool.understanding" },
    execute: async (
      { items, question },
      { abortSignal, context, toolCallId }: { abortSignal?: AbortSignal; context: UnderstandMediaContext; toolCallId: string },
    ): Promise<string> => {
      /**
       * Record one billed call.
       * @param costUsd - What the service said it charged, when it said.
       */
      const recordBilled = (costUsd: number | undefined): void => {
        context.usage.recordServiceCall({
          source: "tool:understand_media",
          service: UNDERSTAND_PINS.model,
          provider: "openrouter",
          requests: 1,
          ...(costUsd === undefined ? {} : { costUsd }),
        });
      };

      if (abortSignal?.aborted) throw stoppedByUser();
      const input = inputSchema.parse({ items, question });
      const apiKey = getRawEnvVar("OPENROUTER_API_KEY") ?? "";
      if (!apiKey) {
        // Defensive: `buildToolSet` leaves this tool out of the set entirely
        // when the key is missing, so a turn should not reach here.
        throw toolFailed(
          "Media understanding is not available on this deployment: it has no credentials. " +
            "Tell the user, and do not try again.",
          FAILURE_LINES.unavailable,
        );
      }

      if (running) {
        // Turned away, not failed: nothing went wrong, the model is told to wait,
        // and the reader is shown nothing for it. Past tense, and no mention of
        // a turn. This sentence is stored on the call and read again by every
        // later turn that reads the record — the same rule `web-search.ts`
        // states for its own reasons — so one saying something is running now
        // would be false by then.
        throw turnedAway(
          "Another media call was already running when this one arrived. Read that answer, " +
            "then ask about this address.",
        );
      }
      running = true;

      let answer;
      try {
        const directRequest = {
          items: input.items,
          question: input.question,
          maxBytes: config.understand_media_max_bytes,
          fetchTimeoutMs: config.understand_media_fetch_timeout_ms,
          minBytesPerSec: config.understand_media_min_bytes_per_sec,
          readFloorMs: config.understand_media_read_floor_ms,
          timeoutMs: config.understand_media_call_timeout_ms,
          model: UNDERSTAND_PINS.model,
          backend: UNDERSTAND_PINS.backend,
          apiKey,
          baseUrl: UNDERSTAND_PINS.baseUrl,
          maxOutputTokens: config.understand_media_max_output_tokens,
          ...(abortSignal ? { signal: abortSignal } : {}),
          onBilled: recordBilled,
        };
        const singleUrl = input.items.length === 1 ? input.items[0]?.url : undefined;
        let longSource: LongMediaSourceReference | null = null;
        if (singleUrl && context.resolveCanonicalMediaSource) {
          try {
            longSource = await context.resolveCanonicalMediaSource(singleUrl);
          } catch {
            // Canonical lookup only selects the long-media path; the direct path remains usable.
            longSource = null;
          }
        }
        /**
         * Decide whether the canonical single file needs the long-media path.
         * @param source - The resolved canonical media facts.
         * @returns Whether the source is oversized audio or video.
         */
        const isLongAudioOrVideo = (source: LongMediaSourceReference | null): source is LongMediaSourceReference =>
          source !== null && source.sizeBytes > config.understand_media_max_bytes &&
          (source.mimeType.startsWith("audio/") || source.mimeType.startsWith("video/"));

        if (isLongAudioOrVideo(longSource)) {
          if (!context.projectId || !context.actorUserId) throw new Error("Long-media ownership context is missing.");
          answer = await understandLongMedia({
            source: longSource,
            sourceUrl: singleUrl!,
            question: input.question,
            context,
            config,
            apiKey,
            userActionKey: toolCallId,
            signal: abortSignal,
            onBilled: recordBilled,
          });
        } else {
          try {
            answer = await understandMediaAt(directRequest);
          } catch (err) {
            if (!(err instanceof MediaUnavailable) || err.kind !== "too-large" || !singleUrl ||
              !err.declaredType || (!err.declaredType.startsWith("audio/") && !err.declaredType.startsWith("video/")) ||
              !context.saveToStorage || !context.resolveCanonicalMediaSource) throw err;
            const saved = await context.saveToStorage(singleUrl, abortSignal);
            longSource = await context.resolveCanonicalMediaSource(saved.url);
            if (!isLongAudioOrVideo(longSource)) throw err;
            if (!context.projectId || !context.actorUserId) throw new Error("Long-media ownership context is missing.");
            answer = await understandLongMedia({
              source: longSource,
              sourceUrl: saved.url,
              question: input.question,
              context,
              config,
              apiKey,
              userActionKey: toolCallId,
              signal: abortSignal,
              onBilled: recordBilled,
            });
          }
        }
      } catch (err) {
        if (err instanceof LongMediaBatchFailureError) {
          throw toolFailed(
            `${err.message} No complete description was returned. Tell the user which source intervals completed ` +
              "and which interval failed.",
            FAILURE_LINES.badAnswer,
            err,
          );
        }
        if (err instanceof LongMediaCancellationError) {
          throw toolFailed(
            "Cancellation cleanup could not be confirmed. Tell the user the long-media operation may still be " +
              "processing; do not submit the same request again yet.",
            FAILURE_LINES.busy,
            err,
          );
        }
        if (isStop(err, abortSignal)) throw stoppedByUser();
        if (err instanceof LongMediaBatchIncompleteError) {
          throw toolFailed(
            "The long media answer stopped before every required batch was complete. " +
              "Tell the user no complete description was returned.",
            FAILURE_LINES.badAnswer,
            err,
          );
        }
        if (err instanceof MediaUnavailable) throw unavailableFailure(err);
        if (err instanceof UnderstandRefused) throw refusedFailure(err);
        // Our own request failing outright, before any answer to judge.
        throw serviceSilent(err, FAILURE_LINES.noConnection);
      } finally {
        running = false;
      }

      if (answer.text.trim() === "") {
        // The length limit reached before the first word of the description is
        // not a question that went wrong: the whole allowance was spent before
        // anything was written, so a reworded question sends the same file up
        // against the same ceiling.
        throw toolFailed(
          answer.finishReason === "length"
            ? `The model used up its whole output allowance on this ${answer.kind} before ` +
                "writing anything. Ask for something shorter."
            : `The model returned nothing about this ${answer.kind} (it stopped for ` +
                `${answer.finishReason}). Asking differently may work.`,
          FAILURE_LINES.badAnswer,
        );
      }

      // An answer that stopped is still an answer. Saying so lets the model use
      // what came and tell the user the rest is missing, rather than present a
      // half description as the whole of what is there. Three ways to stop
      // short, and the note names which: the endpoint reports the provider
      // failing part way as a `finish_reason` of its own, so a half sentence
      // arrives here looking exactly like a whole one.
      const cutShort = STOPPED_SHORT[answer.finishReason];
      return cutShort ? `${answer.text}\n\n[${cutShort}]` : answer.text;
    },
  });
}

/**
 * Advance a long-media Container job and understand its registered segments in request-sized batches.
 * @param input - The canonical source, turn capabilities and model request.
 * @param input.source - The canonical R2 asset facts.
 * @param input.sourceUrl - The canonical asset URL the Worker may read.
 * @param input.question - The user's understanding question.
 * @param input.context - The turn's ownership and storage capabilities.
 * @param input.config - The caller's byte, item and request limits.
 * @param input.apiKey - The model provider key.
 * @param input.userActionKey - The stable SDK tool-call identity for retries.
 * @param input.signal - The turn cancellation signal, when present.
 * @param input.onBilled - The per-request billing recorder.
 * @returns The combined understanding answer in source-time order.
 * @throws {Error} When processing fails, the user stops waiting, or the call budget expires.
 */
async function understandLongMedia(input: {
  source: LongMediaSourceReference;
  sourceUrl: string;
  question: string;
  context: UnderstandMediaContext;
  config: ReturnType<typeof getAgentConfig>;
  apiKey: string;
  userActionKey: string;
  signal?: AbortSignal;
  onBilled: (costUsd: number | undefined) => void;
}): Promise<Awaited<ReturnType<typeof understandMediaAt>>> {
  if (!input.context.projectId || !input.context.actorUserId) throw new Error("Long-media ownership context is missing.");
  const deadlineAt = budgetDeadlineFrom(Date.now());
  const operationId = longMediaOperationId("agent_turn", input.context.usage.operation.operationKey, input.userActionKey);
  let segments: RegisteredLongMediaSegment[];
  try {
    while (true) {
      if (input.signal?.aborted) throw stoppedByUser();
      const progress = await advanceLongMediaSegmentation({
        source: input.source,
        sourceUrl: input.sourceUrl,
        actorUserId: input.context.actorUserId,
        projectId: input.context.projectId,
        operationId,
        deadlineAt,
        maxSourceBytes: input.config.understand_media_max_bytes,
        ...(input.signal ? { signal: input.signal } : {}),
      });
      if (progress.kind === "ready") {
        segments = progress.segments;
        break;
      }
      if (Date.now() >= deadlineAt) throw new Error("The long-media operation exceeded its configured deadline.");
      await new Promise<void>((resolve) => setTimeout(resolve, 1_000));
    }
    const durableOperation = await openLongMediaBatchOperation({
      actorUserId: input.context.actorUserId,
      projectId: input.context.projectId,
      originKind: "agent_turn",
      originKey: input.context.usage.operation.operationKey,
      userActionKey: input.userActionKey,
      source: input.source,
      question: input.question,
      model: UNDERSTAND_PINS.model,
      deadlineAt: new Date(deadlineAt),
    }, getUnderstandConfig().long_media.operation_lease_ms);
    try {
      const answer = await understandMediaInBatches({
        question: input.question,
        maxBytes: input.config.understand_media_max_bytes,
        maxItems: input.config.understand_media_max_items,
        fetchTimeoutMs: input.config.understand_media_fetch_timeout_ms,
        minBytesPerSec: input.config.understand_media_min_bytes_per_sec,
        readFloorMs: input.config.understand_media_read_floor_ms,
        timeoutMs: input.config.understand_media_call_timeout_ms,
        model: UNDERSTAND_PINS.model,
        backend: UNDERSTAND_PINS.backend,
        apiKey: input.apiKey,
        baseUrl: UNDERSTAND_PINS.baseUrl,
        maxOutputTokens: input.config.understand_media_max_output_tokens,
        checkpoint: durableOperation.checkpoint,
        signal: input.signal ? AbortSignal.any([input.signal, durableOperation.signal]) : durableOperation.signal,
        onBilled: input.onBilled,
      }, segments);
      await durableOperation.complete();
      return answer;
    } finally {
      await durableOperation.release();
    }
  } catch (err) {
    if (!input.signal?.aborted) throw err;
    let cleanupError = err instanceof LongMediaCancellationError ? err : undefined;
    try {
      await cancelLongMediaSegmentation(operationId, deadlineAt);
    } catch (cause) {
      cleanupError = cleanupError === undefined
        ? new LongMediaCancellationError(cause)
        : new LongMediaCancellationError(new AggregateError([cleanupError, cause]));
    }
    if (cleanupError !== undefined) throw cleanupError;
    throw stoppedByUser();
  }
}
