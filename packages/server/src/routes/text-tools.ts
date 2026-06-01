/**
 * Text mini-tool route - SSE streaming AI text operations.
 *
 * Unlike AIGC mini-tools (async Worker + Yjs), text tools stream
 * results directly to the requesting client via SSE. The user
 * sees a typewriter effect and can abort mid-stream.
 */

import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { stream } from "hono/streaming";
import { zValidator } from "@hono/zod-validator";
import { textToolSchema } from "@server/routes/schemas.js";
import { requireAuth } from "@server/middleware/auth.js";
import type { AuthVariables } from "@server/middleware/auth.js";
import { textToolService } from "@server/modules";
import { logger } from "@breatic/core";

const textTools = new Hono<{ Variables: AuthVariables }>();

textTools.use(requireAuth);

/**
 * `POST /mini-tools/text` - execute a text AI tool with streaming output.
 *
 * Returns an SSE stream with events:
 * - `text_delta` - incremental text chunk
 * - `done` - generation complete, includes token count and credits used
 * - `aborted` - user cancelled, includes consumed tokens and credits
 * - `error` - tool execution failed
 */
textTools.post(
  "/",
  zValidator("json", textToolSchema),
  async (c) => {
    const user = c.get("user");
    const body = c.req.valid("json");

    const { tool, ...params } = body;

    // Idempotency: the client may send `Idempotency-Key` (per RFC draft,
    // matches what Stripe/Square expect). When set, a retry of the same
    // request bills exactly once via deductOnce. When absent, we fall back
    // to a server-generated UUID - each retry then becomes a separate
    // logical charge, which is acceptable since text tools re-generate
    // content on every call.
    const idempotencyKey = c.req.header("Idempotency-Key") ?? randomUUID();

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
        idempotencyKey,
      )) {
        if (event.type === "text_delta") {
          // Text deltas: plain text, no JSON wrapper
          await s.write(`event: text_delta\ndata: ${event.text}\n\n`);
        } else {
          // done/aborted/error: JSON with metadata
          await s.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
        }

        // Audit log moved from text-tool.service.ts per CLAUDE.md
        // "core and shared must not log" mandate (2026-05-27 PR
        // `feat/2026-05-27-collab-infra-resilience`).
        if (event.type === "done") {
          logger.info(
            {
              userId: user.id,
              tool,
              tokens: event.tokens,
              creditsUsed: event.creditsUsed,
            },
            "text_tool_completed",
          );
          if (event.tokens > 0 && event.creditsUsed === 0) {
            // creditsUsed===0 + tokens>0 = service-side deductOnce
            // threw and swallowed (insufficient credits etc.) and
            // returned 0 to keep the response un-blocked.
            logger.warn(
              { userId: user.id, tool, tokens: event.tokens },
              "text_tool_credit_deduction_failed",
            );
          }
        } else if (event.type === "aborted") {
          logger.info(
            {
              userId: user.id,
              tool,
              tokens: event.tokens,
              creditsUsed: event.creditsUsed,
            },
            "text_tool_aborted",
          );
        } else if (event.type === "error") {
          logger.error(
            { err: event.err, userId: user.id, tool },
            "text_tool_error",
          );
        }
      }
    });
  },
);

export { textTools as textToolsRoute };
