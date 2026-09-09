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
import { isStop, reasonOf, stoppedByUser, toolFailed } from "@domain/agent/tools/failure.js";
import { MediaUnavailable, understandMediaAt, UnderstandRefused } from "@domain/understand/index.js";

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
 * What to tell the model when an address could not be turned into media.
 * @param err - What the fetch refused with.
 * @returns The sentence for the model, and the line a reader is shown.
 */
function unavailableFailure(err: MediaUnavailable): Error {
  if (err.kind === "too-large") {
    // The size is stated only when the far side stated it. A body that arrives
    // without a length is cut off part way, and what is known then is that more
    // than the limit came, not how much.
    const size = err.bytes === undefined ? "That file is" : `That file is ${err.bytes} bytes,`;
    return toolFailed(
      `${size} over the ${err.limit} byte limit, so it was not sent. ` +
        "Tell the user it is too large, and say the limit.",
      FAILURE_LINES.generic,
    );
  }
  if (err.kind === "unsupported-type") {
    return toolFailed(
      err.declaredType
        ? `That address holds ${err.declaredType}, which is not an image, a video or audio.`
        : "That address does not say what it holds, and its name does not either, so it " +
            "cannot be treated as an image, a video or audio.",
      FAILURE_LINES.generic,
    );
  }
  if (err.kind === "slow") {
    // No count: the read gives up on a budget, and how much had arrived by
    // then is not something that side comes away with.
    return toolFailed(
      "That file took too long to arrive. Tell the user the download did not finish.",
      FAILURE_LINES.unreachable,
    );
  }
  return toolFailed(
    err.status
      ? `That address answered ${err.status}, so there was nothing to look at.`
      : `That address could not be reached: ${err.detail ?? "no answer"}.`,
    FAILURE_LINES.unreachable,
  );
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
        if (err instanceof UnderstandRefused) {
          throw toolFailed(
            `The model would not answer about this media: ${err.detail}`,
            FAILURE_LINES.upstream,
          );
        }
        throw toolFailed(`That address could not be read: ${reasonOf(err)}.`, FAILURE_LINES.unreachable);
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
