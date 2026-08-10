// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Chat routes — conversational AI with SSE streaming.
 *
 * Provides endpoints for chat messages, skill commands, and
 * conversation CRUD. Streaming responses use Server-Sent Events
 * via Hono's streaming helper.
 */

import { Hono } from "hono";
import { stream } from "hono/streaming";
import { validate } from "@server/middleware/validate.js";

import {
  chatMessageSchema,
  skillCommandSchema,
  chatConversationsQuerySchema,
  chatOpenSchema,
} from "@server/routes/schemas.js";
import { requireAuth } from "@server/middleware/auth.js";
import type { AuthVariables } from "@server/middleware/auth.js";
import { conversationService } from "@server/modules";
import { memoryService } from "@server/modules";
import { attachmentService } from "@server/modules";
import { projectService } from "@server/modules";
import { MainAgent } from "@server/agent/main-agent.js";
import { serializeSSE } from "@server/agent/types.js";
import { runWithContext } from "@breatic/core";
import { compressForContext } from "@server/agent/message-compressor.js";
import { getAgentConfig } from "@breatic/core";
import { assertSkillUsable } from "@breatic/domain";
import type { ChatAttachedChip } from "@breatic/shared";

/**
 * Format the user's attached canvas chips as a structured prelude to
 * the chat message (spec/07 §10.18.2 v13 — chat-message-level snapshot).
 *
 * Chips are independent C1 copies fixed at attach-time on the frontend;
 * here we serialize them into a prose section the LLM sees alongside
 * the user's plain text. The LLM receives one combined user message:
 * the context block followed by the user's raw text. When chips is
 * empty (default for non-v13 clients) this is a no-op pass-through.
 * @param chips - The canvas chips attached to the message, each carrying a name, type, and data snapshot.
 * @param message - The user's raw chat text.
 * @returns The message unchanged when no chips are attached; otherwise a combined prelude block of serialized chips followed by the user message.
 */
function formatChipsForLLM(
  chips: readonly ChatAttachedChip[],
  message: string,
): string {
  if (!chips || chips.length === 0) return message;
  const sections = chips
    .map(
      (c) =>
        `### ${c.name} (type: ${c.type})\n${JSON.stringify(c.data_snapshot, null, 2)}`,
    )
    .join("\n\n");
  return `## Attached Space content (snapshot — later canvas edits do not mutate these)\n\n${sections}\n\n## User message\n\n${message}`;
}

const chat = new Hono<{ Variables: AuthVariables }>();

chat.use("*", requireAuth);

/**
 * `POST /chat/message` — send a message and receive an SSE stream.
 *
 * Takes the conversation the client names, instantiates the MainAgent, and
 * streams SSE events from `agent.chat()` to the client. It never creates one:
 * `POST /chat/open` is the single place a conversation appears on the user's
 * behalf, so an id that no longer resolves is refused here rather than
 * quietly replaced with a new conversation the client does not know about.
 * @param c - Hono context with validated `chatMessageSchema` body
 * @returns SSE text/event-stream response
 */
chat.post("/message", validate("json", chatMessageSchema), async (c) => {
  const user = c.get("user");
  const body = c.req.valid("json");

  // Cross-tenant guard: the client-supplied project_id must belong to the
  // authenticated user. Checked here first so every downstream call (memory,
  // history, SSE) runs against a confirmed-owned project. Chat is a
  // creative-write action (v10 §7.2.1) — view-only members are refused.
  await projectService.assertAccess(body.project_id, user.id, "editor");

  // The conversation id comes from the client, so it is checked before a word
  // is written to it: this user's, this project's, and not deleted.
  const conversation = await conversationService.assertWritable(
    body.conversation_id,
    user.id,
    body.project_id,
  );

  // Build request context for this turn
  const agentCfg = getAgentConfig();
  const memoryContext = await memoryService.buildContext(
    user.id, conversation.id, body.project_id, "agent_chat",
  );
  const conv = await conversationService.getConversation(conversation.id);
  const lastTurn = conv?.lastConsolidatedTurn ?? 0;
  const rawHistory = await conversationService.getMessagesForLlm(conversation.id, lastTurn);
  const compressedHistory = compressForContext(rawHistory, agentCfg.full_detail_turns);

  c.header("Content-Type", "text/event-stream");
  c.header("Cache-Control", "no-cache");
  c.header("Connection", "keep-alive");

  // Spec §10.18.2 v13: attach chips into the user message before the
  // LLM call. Chips are pre-frozen C1 snapshots (deep copies from the
  // frontend at attach time), so subsequent canvas mutations don't
  // affect the chat history.
  const messageWithChips = formatChipsForLLM(body.attached_chips, body.message);

  // The first ring of the stop chain, and the only one that can hear the
  // client leave. It cannot be inferred from the writes: `StreamingApi.write`
  // catches and discards the error a dead socket produces, so a loop that only
  // watched its writes would stream into nothing for as long as the model kept
  // talking. See `routes/text-tools.ts`, which does the same for its own
  // stream.
  const stopped = new AbortController();

  return stream(c, async (s) => {
    s.onAbort(() => {
      stopped.abort();
    });
    await runWithContext(
      { userId: user.id, conversationId: conversation.id, projectId: body.project_id, memoryContext, compressedHistory },
      async () => {
        const agent = new MainAgent();
        for await (const event of agent.chat(
          messageWithChips,
          body.resource_list,
          stopped.signal,
        )) {
          await s.write(serializeSSE(event));
        }
      },
    );
  });
});

/**
 * `POST /chat/skill` — execute a skill command via SSE stream.
 *
 * Same streaming pattern as `/message`, but uses
 * `agent.handleSkillCommand()` for skill-specific execution.
 * @param c - Hono context with validated `skillCommandSchema` body
 * @returns SSE text/event-stream response
 */
chat.post("/skill", validate("json", skillCommandSchema), async (c) => {
  const user = c.get("user");
  const body = c.req.valid("json");

  // Gate the skill to end-user invocation. Not every skill is something a
  // user may fire directly — some exist only for the model to reach for
  // mid-turn. The gate is deny-by-default: a skill has to be declared
  // user-invocable to get through here.
  assertSkillUsable(body.skill_name, "chat");

  // Cross-tenant guard (same rationale as /chat/message)
  await projectService.assertAccess(body.project_id, user.id, "editor");

  // Same check as the message entrance — one client-supplied id, one rule.
  const conversation = await conversationService.assertWritable(
    body.conversation_id,
    user.id,
    body.project_id,
  );

  // Build request context
  const agentCfg = getAgentConfig();
  const memoryContext = await memoryService.buildContext(
    user.id, conversation.id, body.project_id, "agent_chat",
  );
  const conv = await conversationService.getConversation(conversation.id);
  const lastTurn = conv?.lastConsolidatedTurn ?? 0;
  const rawHistory = await conversationService.getMessagesForLlm(conversation.id, lastTurn);
  const compressedHistory = compressForContext(rawHistory, agentCfg.full_detail_turns);

  c.header("Content-Type", "text/event-stream");
  c.header("Cache-Control", "no-cache");
  c.header("Connection", "keep-alive");

  // Same first ring as `/message`. A stop wired to only one of the two
  // entrances is a way in the user cannot get out of.
  const stopped = new AbortController();

  return stream(c, async (s) => {
    s.onAbort(() => {
      stopped.abort();
    });
    await runWithContext(
      { userId: user.id, conversationId: conversation.id, projectId: body.project_id, memoryContext, compressedHistory },
      async () => {
        const agent = new MainAgent();
        for await (const event of agent.handleSkillCommand(
          body.skill_name, body.input, body.resource_list, stopped.signal,
        )) {
          await s.write(serializeSSE(event));
        }
      },
    );
  });
});

/**
 * `GET /chat/conversations` — list conversations for the current user.
 *
 * Optional `project_id` query scopes the result to one project so the
 * frontend doesn't have to client-side filter a paginated response.
 * @param c - Hono context with pagination + optional `project_id`
 * @returns Array of conversation entities
 */
chat.get(
  "/conversations",
  validate("query", chatConversationsQuerySchema),
  async (c) => {
    const user = c.get("user");
    const { limit, offset, project_id: projectId } = c.req.valid("query");
    const conversations = await conversationService.list(user.id, {
      projectId,
      limit,
      offset,
    });
    return c.json({ data: conversations });
  },
);

/**
 * `POST /chat/open` — everything the chat panel needs to render a project.
 *
 * Returns the user's conversations here plus the messages of whichever one
 * they used last, creating one when the project has none. The client holds the
 * conversation id from here on and sends it with every message, which is what
 * lets two tabs sit on two different conversations at once.
 *
 * POST rather than GET because it creates. Access is judged as a write for the
 * same reason — a view-only member must not leave a conversation behind in a
 * project they may only look at.
 * @param c - Hono context with a `project_id` body
 * @returns The conversation list and the current conversation with its messages
 * @throws {AppError} `404` if the caller is not a member, `403` if read-only
 */
chat.post("/open", validate("json", chatOpenSchema), async (c) => {
  const user = c.get("user");
  const { project_id: projectId } = c.req.valid("json");
  const result = await conversationService.openChat(user.id, projectId);
  return c.json({ data: result });
});

/**
 * `GET /chat/conversations/:id` — fetch a conversation with messages.
 * @param c - Hono context with conversation ID param
 * @returns Conversation entity and its message history
 * @throws {AppError} `404` if not found, `403` if not the owner
 */
chat.get("/conversations/:id", async (c) => {
  const user = c.get("user");
  const conversationId = c.req.param("id");
  const result = await conversationService.getWithMessages(conversationId, user.id);
  return c.json({ data: result });
});

/**
 * `DELETE /chat/conversations/:id` — delete a conversation.
 * @param c - Hono context with conversation ID param
 * @returns `200` with success message
 * @throws {AppError} `404` if not found, `403` if not the owner
 */
chat.delete("/conversations/:id", async (c) => {
  const user = c.get("user");
  const conversationId = c.req.param("id");
  await conversationService.deleteConversation(conversationId, user.id);
  return c.json({ message: "Conversation deleted" });
});

// ── Conversation attachments (reference pool) ───────────────────────

/**
 * `GET /chat/conversations/:id/attachments` — list active attachments.
 *
 * Returns all non-deleted attachments for a conversation. Used by the
 * frontend to render the @ reference candidate pool. Enforces
 * conversation ownership — without this check any logged-in user
 * could enumerate another user's attachment URLs by guessing the
 * conversation UUID.
 */
chat.get("/conversations/:id/attachments", async (c) => {
  const user = c.get("user");
  const conversationId = c.req.param("id");
  await conversationService.assertAccess(conversationId, user.id);
  const list = await attachmentService.listByConversation(conversationId);
  return c.json({ data: list });
});

/**
 * `DELETE /chat/conversations/:cid/attachments/:aid` — soft-delete.
 *
 * Marks the attachment as deleted. The DB record and underlying file
 * are retained — soft delete only hides it from the active list.
 */
chat.delete("/conversations/:cid/attachments/:aid", async (c) => {
  const user = c.get("user");
  const aid = c.req.param("aid");
  await attachmentService.softDelete(aid, user.id);
  return c.json({ data: { ok: true } });
});

export { chat as chatRoute };
