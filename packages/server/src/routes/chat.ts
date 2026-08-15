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
import type { Context } from "hono";
import { stream } from "hono/streaming";
import { validate } from "@server/middleware/validate.js";

import {
  chatMessageSchema,
  skillCommandSchema,
  chatConversationsQuerySchema,
  chatOpenSchema,
  chatCreateConversationSchema,
  chatRenameConversationSchema,
  chatEarlierMessagesQuerySchema,
} from "@server/routes/schemas.js";
import { requireAuth } from "@server/middleware/auth.js";
import type { AuthVariables } from "@server/middleware/auth.js";
import { conversationService } from "@server/modules";
import { attachmentService } from "@server/modules";
import { projectService } from "@server/modules";
import { MainAgent } from "@server/agent/main-agent.js";
import { serializeSSE, SSEEventType } from "@server/agent/types.js";
import type { SSEEvent } from "@server/agent/types.js";
import { runWithContext, logger, getAgentConfig } from "@breatic/core";
import { assertSkillUsable } from "@breatic/domain";
import { SSE_HEARTBEAT_INTERVAL_MS } from "@breatic/shared";
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

/**
 * Stream one turn to the client, whichever entrance asked for it.
 *
 * Both entrances owe the client the same things — the same context to run
 * against, the same headers, the same way out, the same proof the connection
 * is alive — and differ only in which of the agent's two methods produces the
 * events. Written once so a fix to any of those is a fix to both; the last
 * time they were written twice, one of them was missing the way out.
 * @param c - The request being answered.
 * @param turn - Who is speaking, and where. All of it already checked.
 * @param turn.userId - The authenticated user.
 * @param turn.conversationId - Their conversation, confirmed writable.
 * @param turn.projectId - The project it belongs to, confirmed theirs.
 * @param events - Starts the turn. Called inside the request context, and
 *   handed the signal that is raised when the client goes away.
 * @returns The SSE response.
 */
async function streamTurn(
  c: Context<{ Variables: AuthVariables }>,
  turn: { userId: string; conversationId: string; projectId: string },
  events: (signal: AbortSignal) => AsyncGenerator<SSEEvent>,
): Promise<Response> {
  c.header("Content-Type", "text/event-stream");
  c.header("Cache-Control", "no-cache");
  c.header("Connection", "keep-alive");

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

    // Say the connection is alive on a schedule, because a turn that is
    // thinking looks exactly like a turn that is dead: an open socket with
    // nothing on it. Not awaited — a beat is worth nothing late, and waiting
    // on it would put the model's own output behind it. Interleaving is not a
    // risk: `write` encodes the whole frame and hands it over in one call, so
    // a beat cannot land inside a chunk.
    /** Say it once. */
    const sayAlive = (): void => {
      void s.write(serializeSSE({ event: SSEEventType.HEARTBEAT, data: {} }));
    };
    // Once as soon as there is a socket to say it on, before the schedule
    // starts. The reader's browser began counting at the press, and the
    // network and the two checks before this made no sound on that clock; a
    // first beat one whole interval later spends the client's whole budget
    // on the work this turn does before it can speak, and a turn that is
    // doing fine gets killed for it.
    sayAlive();
    const beat = setInterval(sayAlive, SSE_HEARTBEAT_INTERVAL_MS);

    try {
      await runWithContext(
        { userId: turn.userId, conversationId: turn.conversationId, projectId: turn.projectId },
        async () => {
          for await (const event of events(stopped.signal)) {
            await s.write(serializeSSE(event));
          }
        },
      );
    } catch (err) {
      // A turn can die before it says anything -- storing the message, reading
      // the memories, compressing the history, assembling the agent. Left to
      // the framework, that ends the stream cleanly: the browser cannot tell it
      // from a turn that finished, so it leaves an empty reply on screen with
      // nothing to explain it, and the log gets a bare stack trace with no user
      // and no conversation on it.
      logger.error(
        {
          err,
          userId: turn.userId,
          conversationId: turn.conversationId,
          projectId: turn.projectId,
        },
        "chat_turn_failed",
      );
      // What the client does with this is show one line and let the reader
      // press send again. The sentence is not read: the browser writes its own.
      await s.write(
        serializeSSE({
          event: SSEEventType.ERROR,
          data: { message: "The turn could not be run." },
        }),
      );
    } finally {
      // However the turn ended. A timer left running holds the process open
      // and writes to a stream nobody is reading.
      clearInterval(beat);
    }
  });
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

  // Spec §10.18.2 v13: attach chips into the user message before the
  // LLM call. Chips are pre-frozen C1 snapshots (deep copies from the
  // frontend at attach time), so subsequent canvas mutations don't
  // affect the chat history.
  const messageWithChips = formatChipsForLLM(body.attached_chips, body.message);

  return streamTurn(
    c,
    { userId: user.id, conversationId: conversation.id, projectId: body.project_id },
    (signal) => new MainAgent().chat(messageWithChips, body.resource_list, signal),
  );
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

  return streamTurn(
    c,
    { userId: user.id, conversationId: conversation.id, projectId: body.project_id },
    (signal) =>
      new MainAgent().handleSkillCommand(
        body.skill_name,
        body.input,
        body.resource_list,
        signal,
      ),
  );
});

/**
 * `GET /chat/conversations` — list conversations for the current user.
 *
 * Optional `project_id` query scopes the result to one project so the
 * frontend doesn't have to client-side filter a paginated response.
 * @param c - Hono context with pagination + optional `project_id`
 * @returns One page of conversations, and whether the list goes on past it
 */
chat.get(
  "/conversations",
  validate("query", chatConversationsQuerySchema),
  async (c) => {
    const user = c.get("user");
    const {
      limit,
      project_id: projectId,
      before_updated_at: beforeUpdatedAt,
      before_id: beforeId,
    } = c.req.valid("query");
    // Both halves or neither. Half a position is not a position -- the order
    // is over two columns, and a query given only one of them would silently
    // page through a different order than the one the rows came back in.
    const after =
      beforeUpdatedAt !== undefined && beforeId !== undefined
        ? { updatedAt: new Date(beforeUpdatedAt), id: beforeId }
        : undefined;
    const page = await conversationService.list(user.id, {
      projectId,
      limit: limit ?? getAgentConfig().conversation_page_size,
      after,
    });
    return c.json({ data: page });
  },
);

/**
 * `POST /chat/conversations` — start another conversation in a project.
 *
 * The deliberate counterpart to `POST /chat/open`: that one hands back the
 * conversation already there and only creates when there is none, which is
 * exactly what someone pressing "new conversation" is refusing. So this one
 * never looks first.
 * @param c - Hono context with a `project_id` body
 * @returns The conversation that was just created
 * @throws {AppError} `404` if the caller is not a member or the project is
 *   gone, `403` if they are a member but may only read
 */
chat.post(
  "/conversations",
  validate("json", chatCreateConversationSchema),
  async (c) => {
    const user = c.get("user");
    const { project_id: projectId } = c.req.valid("json");
    const conversation = await conversationService.createConversation(
      user.id,
      projectId,
    );
    return c.json({ data: conversation });
  },
);

/**
 * `PATCH /chat/conversations/:id` — name a conversation.
 *
 * The body carries the project as well as the title. The id in the path came
 * from the client, so three things have to hold before anything is written,
 * and one of them is which project this conversation lives in.
 * @param c - Hono context with the conversation id in the path and a
 *   `project_id` + `title` body
 * @returns The conversation as it now stands
 * @throws {AppError} `404` if it is missing, deleted, someone else's, or in a
 *   different project — one answer for all four, on purpose
 */
chat.patch(
  "/conversations/:id",
  validate("json", chatRenameConversationSchema),
  async (c) => {
    const user = c.get("user");
    const { project_id: projectId, title } = c.req.valid("json");
    const conversation = await conversationService.rename(
      c.req.param("id"),
      user.id,
      projectId,
      title,
    );
    return c.json({ data: conversation });
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
 * `GET /chat/conversations/:id/messages` — the page before the one in hand.
 *
 * How a conversation longer than one page is read: the client holds the
 * newest page from `/chat/open` and asks for what comes before it, turn by
 * turn, as the reader scrolls back.
 * @param c - Hono context with conversation ID param and `before_turn` query
 * @returns That page, oldest first, and whether anything is older still
 * @throws {AppError} `404` if not found, `403` if not the owner
 */
chat.get(
  "/conversations/:id/messages",
  validate("query", chatEarlierMessagesQuerySchema),
  async (c) => {
    const user = c.get("user");
    const { before_turn: beforeTurn } = c.req.valid("query");
    const page = await conversationService.getEarlierMessages(
      c.req.param("id"),
      user.id,
      beforeTurn,
    );
    return c.json({ data: page });
  },
);

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
