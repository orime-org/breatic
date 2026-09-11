// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * search_images — find pictures, and hand back the row the panel draws.
 *
 * One call does both halves. The structured answer is what the panel reads to
 * draw the squares; `toModelOutput` renders the same answer as text for the
 * model. Nothing is copied between the two, so nothing can be copied wrongly:
 * an address the panel draws from is the address the service sent.
 *
 * What the model is handed carries no addresses at all. It has no use for one
 * -- it does not pass them on -- and two long URLs per result would be most of
 * the text. It is told, in that text, that it has not seen the pictures: it
 * has their titles and nothing else, and a reply comparing what is in them is
 * a reply the reader can see is invented.
 */
import { tool, type Tool } from "ai";
import { z } from "zod";
import { env, getAgentConfig } from "@breatic/core";
import { FAILURE_LINES, reasonOf, toolFailureOf } from "@breatic/shared";

import { braveJson } from "@domain/agent/tools/brave.js";
import {
  clip,
  isStop,
  keepInside,
  nextMovesFor,
  notOurPayloadReason,
  onOneLine,
  reason,
  unreachableReason,
  stoppedByUser,
  toolFailed,
} from "@domain/agent/tools/failure.js";
import type { FailureVoice } from "@domain/agent/tools/failure.js";

/**
 * How this tool names what it does, in the sentences it fails with.
 *
 * Distinct from `web_search`'s throughout. A reader told "search is
 * unavailable" because an image search failed is told something false about a
 * capability that is working.
 */
const VOICE: FailureVoice = {
  act: "image search",
  results: "images",
  retrying: "Searching for images once more",
  elsewhere: "search for a different subject",
  attempting: "Searching for images matching",
};

/** What the model may do once one of this tool's calls has failed. */
const MOVES = nextMovesFor(VOICE);

/**
 * How much of a title and a source reach the model.
 *
 * Both are the page's own words about itself, and a page is free to make
 * either as long as it likes. What the model needs from them is enough to
 * tell one result from another; the rest is context spent on nothing, and it
 * is spent again every turn the result is replayed.
 */
const TITLE_CHARS = 200;
const SOURCE_CHARS = 80;

/**
 * What the model may ask this tool for.
 *
 * `count` carries its default and its ceiling here rather than in the tool
 * body, so the range and the value chosen inside it are one statement the SDK
 * enforces. It is not read from configuration: this schema is built when the
 * module is imported, which is before any configuration exists.
 *
 * The ceiling is what a row of squares is worth asking for. Past it the extra
 * results are ones nobody scrolls to, and every one of them is text the model
 * reads.
 */
const inputSchema = z.object({
  query: z.string().trim().min(1).describe("What to find pictures of"),
  count: z
    .number()
    .int()
    .min(1)
    .max(20)
    .default(8)
    .describe("How many images to ask for (1-20)"),
});

/** One picture the search found, as both consumers read it. */
export interface ImageResult {
  /** Where the panel draws it from: the service's own proxy, 500px wide. */
  thumbnailUrl: string;
  /** The picture itself, where the site that published it hosts it. */
  imageUrl?: string;
  /** The page it was found on. */
  pageUrl?: string;
  /** What the page called it. */
  title: string;
  /** Where it was found, when the service said. */
  source?: string;
  /** How wide the thumbnail is. */
  thumbnailWidth?: number;
  /** How tall the thumbnail is. */
  thumbnailHeight?: number;
  /** How wide the original is. */
  imageWidth?: number;
  /** How tall the original is. */
  imageHeight?: number;
}

/** What one image search found. */
export interface ImageSearchAnswer {
  /** What was searched for, as it was sent. */
  query: string;
  /** What came back, in the order the service ranked it. */
  images: ImageResult[];
  /**
   * How many entries the service sent, readable or not.
   *
   * Absent on a row stored before this field existed, which the rendering
   * reads as "as many as are listed".
   *
   * A count the model reads as the whole is what makes "only three exist" a
   * wrong answer: entries this tool could not draw from are dropped, and
   * without this the model is told fewer were found than were.
   */
  sent?: number;
}

/**
 * A number off the service's payload, or nothing.
 * @param value - Whatever was in that field.
 * @returns The number, when it is one.
 */
function sizeOf(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Read one picture out of the service's payload, or nothing.
 *
 * An entry without a thumbnail is dropped. The square is drawn from that
 * address and nothing else -- an entry without one is an entry the panel has
 * nothing to put in the row, and a broken image is worse than one result
 * fewer. Everything else is taken as it comes: a result the service said less
 * about than usual is still a picture, and dropping it would report fewer
 * than were found -- or, when every entry is sparse, report the service as
 * broken.
 * @param item - One entry of the service's `results`.
 * @returns The picture, or null when this entry cannot be read.
 */
function readImage(item: unknown): ImageResult | null {
  if (item === null || typeof item !== "object") return null;
  const entry = item as {
    title?: unknown;
    url?: unknown;
    source?: unknown;
    thumbnail?: { src?: unknown; width?: unknown; height?: unknown };
    properties?: { url?: unknown; width?: unknown; height?: unknown };
  };

  const thumbnailUrl = entry.thumbnail?.src;
  // An empty address ends the same way as none at all: the square is drawn
  // from it, and an empty one draws nothing while holding its place.
  if (typeof thumbnailUrl !== "string" || thumbnailUrl === "") return null;

  return {
    thumbnailUrl,
    imageUrl: typeof entry.properties?.url === "string" ? entry.properties.url : undefined,
    pageUrl: typeof entry.url === "string" ? entry.url : undefined,
    title: typeof entry.title === "string" ? entry.title : "",
    source: typeof entry.source === "string" ? entry.source : undefined,
    thumbnailWidth: sizeOf(entry.thumbnail?.width),
    thumbnailHeight: sizeOf(entry.thumbnail?.height),
    imageWidth: sizeOf(entry.properties?.width),
    imageHeight: sizeOf(entry.properties?.height),
  };
}

/**
 * Render an image search for the model to read.
 *
 * Titles and sources come from the pages themselves, so both go through
 * `onOneLine`: everything printed here is a line, and a line terminator inside
 * a title puts whatever follows where this tool's own lines live -- a page
 * could otherwise write an entry of its own into what reads as the result
 * list.
 *
 * Addresses are left out. The model does not pass them on, and two per result
 * would be the bulk of this text.
 * @param answer - What the search found.
 * @returns The text handed to the model.
 */
export function renderImagesForModel(answer: ImageSearchAnswer): string {
  const query = keepInside(onOneLine(answer.query));
  if (answer.images.length === 0) {
    return reason(
      `No images for: ${query}. The search ran and came back with nothing.`,
      MOVES.searchElsewhere,
    );
  }

  // One count, stated once. Saying how many are listed and then how many
  // arrived puts two answers to "how many came back" in one message.
  const sent = answer.sent ?? answer.images.length;
  const counted =
    answer.images.length === sent
      ? `${String(sent)} images came back.`
      : `${String(answer.images.length)} of ${String(sent)} images came back with an address ` +
        "this tool could draw from.";
  const header =
    `Results for: ${query}\n` +
    `${counted} You have not seen these pictures -- you have their titles and nothing else -- ` +
    "so do not describe, rank or compare what is in them.\n";

  const lines = answer.images.map((image, i) => {
    const title = clip(keepInside(onOneLine(image.title)), TITLE_CHARS);
    const source = image.source
      ? ` (${clip(keepInside(onOneLine(image.source)), SOURCE_CHARS)})`
      : "";
    // A line that is a number and nothing else says less than the header just
    // promised, which was that the model has their titles.
    const named = `${title}${source}`.trim() || "(untitled)";
    return `${String(i + 1)}. ${named}`;
  });

  return [header, ...lines].join("\n");
}

/**
 * Find pictures with Brave's image endpoint.
 *
 * Answers with what the panel draws; `toModelOutput` says how that same answer
 * reads as text. Requires the `BRAVE_SEARCH_API_KEY` environment variable --
 * the same key `web_search` uses, which the service accepts on this endpoint
 * too (measured 2026-09-11).
 */
export const imageSearch: Tool<z.infer<typeof inputSchema>, ImageSearchAnswer> = tool({
  description:
    "Find pictures. One call both searches and returns what it found. Write the query the way " +
    "an image search takes one -- subject, style, lighting, composition. You will be told the " +
    "titles of what came back; you will not see the pictures themselves.",
  inputSchema,
  // What the panel reads about a running call. The key is resolved by the web
  // package, which cannot import this one -- the SDK carries this field onto
  // the UI message part, so the name of the line and the tool that shows it
  // stay in one place.
  metadata: { runningLine: "chat.tool.searchingImages" },
  // The SDK's own conversion, which is what a running turn reaches. The
  // request assembler renders stored history through the same function, so a
  // replayed turn reads exactly as the running one did.
  toModelOutput: ({ output }) => ({ type: "text", value: renderImagesForModel(output) }),
  execute: async (
    { query: asked, count },
    { abortSignal }: { abortSignal?: AbortSignal },
  ): Promise<ImageSearchAnswer> => {
    // The query is the model's to write, and everything printed back to it
    // sits on a line of its own. A query carrying a line terminator would open
    // a line where this tool's own text lives.
    const query = onOneLine(asked);
    // Printed back to the model in every sentence below. A page can ask the
    // model to search for a marker, and the answer would carry it through.
    const shown = keepInside(query);

    const apiKey = env.BRAVE_SEARCH_API_KEY;
    if (!apiKey) {
      // Defensive: `buildToolSet` leaves this tool out of the set entirely when
      // the key is missing, so a turn should never reach here. The reader's
      // line is the one for a failure nothing described, because a line of its
      // own would exist for this branch alone.
      throw toolFailed(
        reason(
          "Image search is not available on this deployment: it has no search credentials.",
          MOVES.stop,
        ),
        FAILURE_LINES.generic,
      );
    }

    const { image_search_timeout_ms: budgetMs } = getAgentConfig();

    try {
      const url = new URL("https://api.search.brave.com/res/v1/images/search");
      url.searchParams.set("q", query);
      url.searchParams.set("count", String(count));

      const data = await braveJson({
        url,
        apiKey,
        voice: VOICE,
        query: shown,
        budgetMs,
        ...(abortSignal ? { abortSignal } : {}),
      });

      // A search that found nothing answers with `results` present and empty.
      // A body without it is the service answering something other than this
      // endpoint's payload -- a moved schema, or something else in its place.
      // Calling that "found nothing" would report an absence of pictures when
      // what happened is an answer this side could not read.
      const found: unknown = (data as { results?: unknown } | null)?.results;
      if (!Array.isArray(found)) {
        throw toolFailed(notOurPayloadReason(VOICE, shown), FAILURE_LINES.upstream);
      }
      if (found.length === 0) return { query, images: [], sent: 0 };

      const images = found
        .map((item) => readImage(item))
        .filter((image): image is ImageResult => image !== null);
      // Results arrived and not one of them could be read: the answer is the
      // endpoint's payload in name only.
      if (images.length === 0) {
        throw toolFailed(notOurPayloadReason(VOICE, shown), FAILURE_LINES.upstream);
      }

      return { query, images, sent: found.length };
    } catch (err: unknown) {
      // Every throw above passes straight through: each already says what
      // happened, and rewriting one here would replace a specific reason with
      // this general one.
      if (toolFailureOf(err) !== undefined) throw err;
      if (isStop(err, abortSignal)) throw stoppedByUser();

      throw toolFailed(
        unreachableReason(VOICE, shown, reasonOf(err)),
        FAILURE_LINES.unreachable,
      );
    }
  },
});
