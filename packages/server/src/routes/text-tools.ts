// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Text mini-tool route - SSE streaming AI text operations.
 *
 * Unlike AIGC mini-tools (async Worker + Yjs), text tools stream
 * results directly to the requesting client via SSE. The user
 * sees a typewriter effect and can abort mid-stream.
 */

import { newId } from "@breatic/shared";
import { Hono } from "hono";
import type { StreamingApi } from "hono/utils/stream";
import { streamUntilClientLeaves } from "@server/utils/sse-stream.js";
import { validate } from "@server/middleware/validate.js";
import { rateLimitFor } from "@server/middleware/rate-limit.js";
import { textToolSchema } from "@server/routes/schemas.js";
import { requireAuth } from "@server/middleware/auth.js";
import type { AuthVariables } from "@server/middleware/auth.js";
import { precheckCredits, projectService, textToolService } from "@server/modules";
import { getTextToolsConfig } from "@server/config/text-tools.js";
import { SMALLEST_CREDIT } from "@breatic/domain";
import { ForbiddenError, NotFoundError, ValidationError, logger } from "@breatic/core";
import { t } from "@breatic/shared";

const textTools = new Hono<{ Variables: AuthVariables }>();

textTools.use(requireAuth);

/**
 * Every character a request asks the model to read, whichever fields hold
 * them.
 * @param params - The request's fields.
 * @returns Their total length.
 */
function wordsIn(params: Record<string, unknown>): number {
  return Object.values(params).reduce<number>((total, value) => {
    if (typeof value === "string") return total + value.length;
    if (Array.isArray(value)) return total + value.reduce<number>((sum, item) => sum + (typeof item === "string" ? item.length : 0), 0);
    return total;
  }, 0);
}

/**
 * Refuse a selection, a document, or a request as a whole longer than the
 * budgets in `config/text-tools.yaml`. The numbers live in the yaml alone, so
 * the check runs here rather than in the request schema (the same split as
 * chat's `assertSayable`). The whole request may hold no more than the two
 * budgets together, whichever fields the words are in.
 * @param params - The request's fields.
 * @throws {ValidationError} When anything is over its budget.
 */
function assertWithinBudgets(params: Record<string, unknown>): void {
  const { selection_max_chars, context_max_chars } = getTextToolsConfig();
  const selection = typeof params.selection === "string" ? params.selection : undefined;
  const document = typeof params.document === "string" ? params.document : undefined;
  if (selection !== undefined && selection.length > selection_max_chars) {
    throw new ValidationError(
      t("server.text_tool.selection_too_long", { limit: selection_max_chars, actual: selection.length }),
    );
  }
  if (document !== undefined && document.length > context_max_chars) {
    throw new ValidationError(
      t("server.text_tool.document_too_long", { limit: context_max_chars, actual: document.length }),
    );
  }
  const total = wordsIn(params);
  if (total > selection_max_chars + context_max_chars) {
    throw new ValidationError(
      t("server.text_tool.document_too_long", { limit: selection_max_chars + context_max_chars, actual: total }),
    );
  }
}

/**
 * Write one server-sent event.
 * @param s - The stream.
 * @param event - The event name.
 * @param data - Its payload, sent as JSON so newlines inside text survive the frame.
 * @returns When the frame is written.
 */
async function writeEvent(s: StreamingApi, event: string, data: unknown): Promise<void> {
  await s.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

/**
 * `GET /mini-tools/text/config` - the budgets the browser windows its
 * request to and the pace it shows the answer at, from
 * `config/text-tools.yaml`.
 */
textTools.get("/config", (c) => {
  const { selection_max_chars, context_max_chars, reveal_chars_per_second } = getTextToolsConfig();
  return c.json({
    data: {
      selectionMaxChars: selection_max_chars,
      contextMaxChars: context_max_chars,
      revealCharsPerSecond: reveal_chars_per_second,
    },
  });
});

/**
 * `POST /mini-tools/text` - execute a text AI tool with streaming output.
 *
 * Returns an SSE stream with events:
 * - `text_delta` - `{ text }`, an incremental text chunk
 * - `done` - generation complete, includes token count and credits used
 * - `aborted` - user cancelled, includes consumed tokens and credits
 * - `error` - tool execution failed
 */
textTools.post(
  "/",
  validate("json", textToolSchema),
  rateLimitFor("text-tool", "user"),
  async (c) => {
    const user = c.get("user");
    const body = c.req.valid("json");
    const { tool, project_id: projectId, ...params } = body;

    // Cross-tenant guard: the project in the body must be one this user may
    // write to, the same check chat makes before a turn.
    try {
      await projectService.assertAccess(projectId, user.id, "editor");
    } catch (err) {
      if (err instanceof NotFoundError || err instanceof ForbiddenError) {
        logger.warn({ userId: user.id, projectId, tool }, "text_tool_forbidden");
      }
      throw err;
    }
    try {
      assertWithinBudgets(params);
    } catch (err) {
      logger.warn({ userId: user.id, projectId, tool }, "text_tool_over_budget");
      throw err;
    }
    await precheckCredits(projectId, user.id, SMALLEST_CREDIT);

    // The key a run is recorded and charged under is minted here for every
    // request. A key from the client would let the same key be sent again,
    // and the charge for a key already billed is skipped.
    const operationKey = newId();
    let ended = false;
    return streamUntilClientLeaves(c, async (s, stopped) => {
      for await (const event of textToolService.executeTextTool(
        user.id,
        projectId,
        tool,
        params,
        stopped,
        operationKey,
      )) {
        if (event.type === "text_delta") {
          await writeEvent(s, "text_delta", { text: event.text });
          continue;
        }
        ended = true;
        if (event.type === "error") {
          // The cause stays in the log; the reader is told the run failed.
          await writeEvent(s, "error", { type: "error", message: t("server.text_tool.failed") });
          logger.error({ err: event.err, userId: user.id, projectId, tool }, "text_tool_error");
          continue;
        }
        await writeEvent(s, event.type, event);
        logger.info(
          { userId: user.id, projectId, tool, tokens: event.tokens, creditsUsed: event.creditsUsed },
          event.type === "done" ? "text_tool_completed" : "text_tool_aborted",
        );
      }
    }, async (err, s) => {
      // A throw from the run itself bypasses the app's error handler: log it,
      // and end the stream with an error event so the client is not left
      // waiting for one.
      logger.error({ err, userId: user.id, projectId, tool }, "text_tool_stream_failed");
      if (!ended && !s.closed) {
        await writeEvent(s, "error", { type: "error", message: t("server.text_tool.failed") });
      }
    });
  },
);

export { textTools as textToolsRoute };
