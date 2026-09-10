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
  IMAGE_FORMAT_NAMES,
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
      // then is not something that side comes away with. The address answered
      // everything it was asked, so the reader's line is not the one that says
      // nothing answered.
      return toolFailed(
        "That file took too long to arrive. Tell the user the download did not finish.",
        FAILURE_LINES.generic,
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
 * What to tell the model when nothing came back to judge.
 *
 * Naming the address would send the model to blame a url that was fine, and
 * the endpoint has no business in a conversation.
 * @returns The sentence for the model, and the line a reader is shown.
 */
function serviceSilent(): Error {
  return toolFailed(
    "The media understanding service did not answer. Tell the user to try again shortly.",
    FAILURE_LINES.upstream,
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
      return toolFailed(
        `The service would not take this media: ${err.detail}. ` +
          "Tell the user, and do not send the same file again.",
        FAILURE_LINES.upstream,
      );
    case "unfetchable":
      // An image travels as its address and the backend fetches it, so this
      // one is about reaching the address rather than about the file. Moving
      // it somewhere reachable is the step that clears it, and it is a step
      // the sentence for a refused file forbids.
      return toolFailed(
        `The service could not reach that address: ${err.detail}. ` +
          "Tell the user to put the file somewhere the service can reach, or give another address.",
        FAILURE_LINES.upstream,
      );
    case "content-filter":
      return toolFailed(
        `The service declined to answer this question about the media: ${err.detail}. ` +
          "Asking differently may work.",
        FAILURE_LINES.upstream,
      );
    case "deployment":
      // Not a word about the file. The account, the credential and the model
      // asked for are ours, and a user told their file was rejected goes off to
      // convert something that was never looked at.
      return toolFailed(
        `Media understanding is not available right now: ${err.detail}. ` +
          "Tell the user it is unavailable, and do not blame anything they sent.",
        FAILURE_LINES.upstream,
      );
    case "transient":
      return serviceSilent();
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
          readFloorMs: config.understand_media_read_floor_ms,
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
        if (err instanceof UnderstandRefused) throw refusedFailure(err);
        // Our own request failing outright, before any answer to judge.
        throw serviceSilent();
      }

      if (answer.text.trim() === "") {
        // The length limit reached before the first word of the description is
        // not a question that went wrong: this model produces reasoning tokens
        // against the same allowance, and a differently worded question sends
        // the whole file up again for a ceiling it does not move.
        throw toolFailed(
          answer.finishReason === "length"
            ? `The model used up its whole output allowance on this ${answer.kind} before ` +
                "writing anything. Ask for something shorter."
            : `The model returned nothing about this ${answer.kind} (it stopped for ` +
                `${answer.finishReason}). Asking differently may work.`,
          FAILURE_LINES.upstream,
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

/** The media understanding tool. */
export const understandMediaTool = makeUnderstandMediaTool();
