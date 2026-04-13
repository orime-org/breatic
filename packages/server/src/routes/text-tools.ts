/**
 * Text mini-tool route — SSE streaming AI text operations.
 *
 * Unlike AIGC mini-tools (async Worker + Yjs), text tools stream
 * results directly to the requesting client via SSE. The user
 * sees a打字机 effect and can abort mid-stream.
 */

import { Hono } from "hono";
import { stream } from "hono/streaming";
import { zValidator } from "@hono/zod-validator";
import { textToolSchema } from "./schemas.js";
import { requireAuth } from "../middleware/auth.js";
import type { AuthVariables } from "../middleware/auth.js";
import { textToolService } from "@breatic/core";

const textTools = new Hono<{ Variables: AuthVariables }>();

textTools.use(requireAuth);

/**
 * `POST /mini-tools/text` — execute a text AI tool with streaming output.
 *
 * Returns an SSE stream with events:
 * - `text_delta` — incremental text chunk
 * - `done` — generation complete, includes token count and credits used
 * - `aborted` — user cancelled, includes consumed tokens and credits
 * - `error` — tool execution failed
 */
textTools.post(
  "/",
  zValidator("json", textToolSchema),
  async (c) => {
    const user = c.get("user");
    const body = c.req.valid("json");

    const { tool, ...params } = body;

    // Set SSE headers
    c.header("Content-Type", "text/event-stream");
    c.header("Cache-Control", "no-cache");
    c.header("Connection", "keep-alive");

    // AbortController for client disconnect detection
    const abortController = new AbortController();

    return stream(c, async (s) => {
      // Detect client disconnect
      s.onAbort(() => {
        abortController.abort();
      });

      for await (const event of textToolService.executeTextTool(
        user.id,
        tool,
        params as Record<string, unknown>,
        abortController.signal,
      )) {
        if (event.type === "text_delta") {
          // Text deltas: plain text, no JSON wrapper
          await s.write(`event: text_delta\ndata: ${event.text}\n\n`);
        } else {
          // done/aborted/error: JSON with metadata
          await s.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
        }
      }
    });
  },
);

export { textTools as textToolsRoute };
