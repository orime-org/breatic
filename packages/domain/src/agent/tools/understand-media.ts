// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Media understanding tool — look at an image, watch a video, listen to audio.
 *
 * The model gets an address from whoever it is talking to and asks this what
 * is in it. Everything about who to ask lives here: the model, the backend and
 * the credential, all handed to a capability that reads no configuration of
 * its own.
 *
 * Nothing here interprets a failure into a retry. A call that came back empty
 * says so and says what stopped it, and a file that is too large says how large
 * and how large is allowed — both are things the model can act on, and only it
 * knows whether a different question or a different file is available.
 */

import { tool, type Tool } from "ai";
import { z } from "zod";
import { getAgentConfig, getRawEnvVar } from "@breatic/core";
import { FAILURE_LINES } from "@breatic/shared";
import { isStop, stoppedByUser, toolFailed } from "@domain/agent/tools/failure.js";
import {
  AUDIO_FORMAT_NAMES,
  MediaUnavailable,
  understandMediaAt,
  UnderstandRefused,
  VIDEO_FORMAT_NAMES,
} from "@domain/understand/index.js";

/**
 * The model this tool asks, and the backend it pins.
 *
 * Both are fixed here rather than configured: they are what every measurement
 * behind this tool was taken against. The backend matters on its own — the two
 * that serve this model take different body sizes, and leaving the choice to
 * the service means a clip that worked yesterday is refused today.
 */
const MODEL = "google/gemini-3.8-flash";
const BACKEND = "google-vertex";

/** Where the service lives. */
const BASE_URL = "https://openrouter.ai/api/v1";

/** What the model may ask this tool to look at. */
const inputSchema = z.object({
  url: z.string().url().describe("Address of the image, video or audio"),
  question: z
    .string()
    .trim()
    .min(1)
    .describe("What to find out about it"),
});

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
  switch (err.kind) {
    case "too-large": {
      // The size is stated only when the far side stated it. A body that
      // arrives without a length is cut off part way, and what is known then
      // is that more than the limit came, not how much.
      const size = err.bytes === undefined ? "That file is" : `That file is ${err.bytes} bytes,`;
      return toolFailed(
        `${size} over the ${err.limit} byte limit, so it was not sent. ` +
          "Tell the user it is too large, and say the limit.",
        FAILURE_LINES.generic,
      );
    }
    case "unsupported-type":
      return toolFailed(unsupportedSentence(err.declaredType), FAILURE_LINES.generic);
    case "slow":
      // No count: the read gives up on a budget, and how much had arrived by
      // then is not something that side comes away with.
      return toolFailed(
        "That file took too long to arrive. Tell the user the download did not finish.",
        FAILURE_LINES.unreachable,
      );
    case "empty":
      // The address answered everything it was asked. Calling it unreachable
      // sends the user to check something that is working.
      return toolFailed(
        "That address holds an empty file, so there was nothing to look at. " +
          "Tell the user the file is empty.",
        FAILURE_LINES.generic,
      );
    case "unreachable":
      return toolFailed(
        err.status
          ? `That address answered ${err.status}, so there was nothing to look at.`
          : `That address could not be reached: ${err.detail ?? "no answer"}.`,
        FAILURE_LINES.unreachable,
      );
  }
}

/**
 * The media understanding tool, as a turn receives it.
 * @returns The tool.
 */
function makeUnderstandMediaTool(): Tool<z.infer<typeof inputSchema>, string> {
  return tool({
    description:
      "Look at an image, watch a video, or listen to audio at a given address and answer a " +
      "question about it. Takes one address per call.",
    inputSchema,
    // What the panel reads about a running call, resolved by the web package.
    metadata: { runningLine: "chat.tool.understanding" },
    execute: async (
      { url, question },
      { abortSignal }: { abortSignal?: AbortSignal },
    ): Promise<string> => {
      const config = getAgentConfig();
      const apiKey = getRawEnvVar("OPENROUTER_API_KEY") ?? "";
      if (!apiKey) {
        // Defensive: `buildToolSet` leaves this tool out of the set entirely
        // when the key is missing, so a turn should not reach here.
        throw toolFailed(
          "Media understanding is not available on this deployment: it has no credentials. " +
            "Tell the user, and do not try again.",
          FAILURE_LINES.generic,
        );
      }

      let answer;
      try {
        answer = await understandMediaAt({
          url,
          question,
          maxBytes: config.understand_media_max_bytes,
          fetchTimeoutMs: config.understand_media_fetch_timeout_ms,
          minBytesPerSec: config.understand_media_min_bytes_per_sec,
          timeoutMs: config.understand_media_call_timeout_ms,
          model: MODEL,
          backend: BACKEND,
          apiKey,
          baseUrl: BASE_URL,
          maxOutputTokens: config.understand_media_max_output_tokens,
          ...(abortSignal ? { signal: abortSignal } : {}),
        });
      } catch (err) {
        if (isStop(err, abortSignal)) throw stoppedByUser();
        if (err instanceof MediaUnavailable) throw unavailableFailure(err);
        if (err instanceof UnderstandRefused && err.refusedByModel) {
          throw toolFailed(
            `The model would not answer about this media: ${err.detail}`,
            FAILURE_LINES.upstream,
          );
        }
        // Everything else that ends a call without an answer — rate limiting, a
        // gateway's error page, a body that stopped part way, our own request
        // failing outright. The model is told to try again, which is the move
        // all of them call for and the opposite of the move a refusal calls
        // for. Naming the address would send it to blame a url that was fine,
        // and the endpoint has no business in a conversation.
        throw toolFailed(
          "The media understanding service did not answer. Tell the user to try again shortly.",
          FAILURE_LINES.upstream,
        );
      }

      if (answer.text.trim() === "") {
        throw toolFailed(
          `The model returned nothing about this ${answer.kind} (it stopped for ` +
            `${answer.finishReason}). Asking differently may work.`,
          FAILURE_LINES.upstream,
        );
      }

      // A truncated answer is still an answer. Saying so lets the model use
      // what came and tell the user the rest is missing, rather than present a
      // half description as the whole of what is there.
      if (answer.finishReason === "length") {
        return `${answer.text}\n\n[This description was cut off at the length limit.]`;
      }
      return answer.text;
    },
  });
}

/** The media understanding tool. */
export const understandMediaTool = makeUnderstandMediaTool();
