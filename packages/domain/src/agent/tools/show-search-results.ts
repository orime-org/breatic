/**
 * show-search-results tool — interaction tool for surfacing search /
 * lookup results to the user as thumbnails the user can drop into
 * their canvas Space.
 *
 * Per spec/07-chat-agent.md §10.18.4 (v13 Agent rich output protocol):
 * the LLM uses this to display image / video / audio / link results
 * (typically gathered via the real `web_search` tool) as a thumbnail
 * grid. Each thumbnail has a hover "+ Add to space" button that, when
 * clicked, creates a corresponding image/video/audio node in the user's
 * active canvas Space. Node `data` carries `derivedFrom: { sourceQuery,
 * source }` for audit.
 *
 * Distinguished from `web_search` (the real tool that performs the
 * search): web_search returns raw results to the LLM; this tool packages
 * a curated subset back to the frontend for visual presentation.
 *
 * @module
 */
import { tool } from "ai";
import { z } from "zod";

/** Sentinel detected by main-agent to interrupt the loop and yield AGENT_SEARCH_RESULTS SSE event. */
export const SHOW_SEARCH_RESULTS_SENTINEL = "__SHOW_SEARCH_RESULTS__";

const resultItem = z.object({
  url: z.string().describe("Direct URL to the asset / page"),
  title: z.string().describe("Display title for the user"),
  source: z
    .string()
    .optional()
    .describe("Where the result was found (e.g. 'pinterest', 'unsplash')"),
});

const inputSchema = z.object({
  images: z.array(resultItem).optional().describe("Image thumbnail results"),
  videos: z.array(resultItem).optional().describe("Video thumbnail results"),
  audios: z.array(resultItem).optional().describe("Audio results"),
  links: z.array(resultItem).optional().describe("Plain web links (not droppable)"),
  sourceQuery: z
    .string()
    .optional()
    .describe(
      "The query that produced these results (recorded into node.derivedFrom)",
    ),
});

export const showSearchResults = tool({
  description:
    "Display search results (images / videos / audios / links) to " +
    "the user as a thumbnail grid. Each thumbnail has '+ Add to " +
    "space' which creates a corresponding canvas node. Use AFTER " +
    "you've gathered results via web_search (or similar) and want " +
    "to surface a curated subset visually. Do NOT call to embed " +
    "results inside your prose response — call this tool so the " +
    "frontend renders the grid.",
  inputSchema,
  execute: async (input: z.infer<typeof inputSchema>): Promise<string> => {
    return `${SHOW_SEARCH_RESULTS_SENTINEL}${JSON.stringify(input)}`;
  },
});
