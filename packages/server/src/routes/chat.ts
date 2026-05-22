/**
 * Chat routes — conversational AI with SSE streaming.
 *
 * Provides endpoints for chat messages, skill commands, and
 * conversation CRUD. Streaming responses use Server-Sent Events
 * via Hono's streaming helper.
 */

import { Hono } from "hono";
import { stream } from "hono/streaming";
import { zValidator } from "@hono/zod-validator";

import {
  chatMessageSchema,
  skillCommandSchema,
  chatConversationsQuerySchema,
} from "./schemas.js";
import { requireAuth } from "../middleware/auth.js";
import type { AuthVariables } from "../middleware/auth.js";
import { conversationService } from "@breatic/core";
import { conversationRepo } from "@breatic/core";
import { memoryService } from "@breatic/core";
import { attachmentService } from "@breatic/core";
import { projectService } from "@breatic/core";
import { MainAgent } from "../agent/main-agent.js";
import { serializeSSE } from "../agent/types.js";
import { runWithContext } from "@breatic/core";
import { compressForContext } from "../agent/message-compressor.js";
import { getAgentConfig } from "@breatic/core";
import { getSkillRegistry } from "@breatic/core";
import { ForbiddenError, NotFoundError } from "@breatic/core";
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
 * Gets or creates a conversation, instantiates the MainAgent,
 * and streams SSE events from `agent.chat()` to the client.
 *
 * @param c - Hono context with validated `chatMessageSchema` body
 * @returns SSE text/event-stream response
 */
chat.post("/message", zValidator("json", chatMessageSchema), async (c) => {
  const user = c.get("user");
  const body = c.req.valid("json");

  // Cross-tenant guard: client-supplied project_id must belong to the
  // authenticated user. `getOrCreate` also re-validates on conversation
  // creation, but we check here first so that every downstream call
  // (memory, history, SSE) runs against a confirmed-owned project.
  if (body.project_id) {
    // Chat is a creative-write action (v10 §7.2.1) — view-only
    // members cannot send chat messages or invoke skills.
    await projectService.assertAccess(body.project_id, user.id, "edit");
  }

  const conversation = await conversationService.getOrCreate(
    user.id,
    body.conversation_id,
    body.message,
    body.project_id,
  );

  // Build request context (shared by MainAgent + SubAgents)
  const agentCfg = getAgentConfig();
  const memoryContext = await memoryService.buildContext(
    user.id, conversation.id, body.project_id, "agent_chat",
  );
  const conv = await conversationRepo.getConversation(conversation.id);
  const lastTurn = conv?.lastConsolidatedTurn ?? 0;
  const rawHistory = await conversationRepo.getMessagesForLlm(conversation.id, lastTurn);
  const compressedHistory = compressForContext(rawHistory, agentCfg.full_detail_turns);

  c.header("Content-Type", "text/event-stream");
  c.header("Cache-Control", "no-cache");
  c.header("Connection", "keep-alive");

  // Spec §10.18.2 v13: attach chips into the user message before the
  // LLM call. Chips are pre-frozen C1 snapshots (deep copies from the
  // frontend at attach time), so subsequent canvas mutations don't
  // affect the chat history.
  const messageWithChips = formatChipsForLLM(body.attached_chips, body.message);

  return stream(c, async (s) => {
    await runWithContext(
      { userId: user.id, conversationId: conversation.id, projectId: body.project_id, memoryContext, compressedHistory },
      async () => {
        const agent = new MainAgent();
        for await (const event of agent.chat(messageWithChips, body.resource_list)) {
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
 *
 * @param c - Hono context with validated `skillCommandSchema` body
 * @returns SSE text/event-stream response
 */
chat.post("/skill", zValidator("json", skillCommandSchema), async (c) => {
  const user = c.get("user");
  const body = c.req.valid("json");

  // Gate the skill to end-user invocation. Skills that grant dangerous
  // tools (read_file/write_file/edit_file/run_script) MUST be marked
  // `user_invocable: false` in their metadata so this check rejects
  // them — otherwise any authenticated user could drive the agent into
  // arbitrary file read/write on the server. See security notes in
  // skills/skill_creator/metadata.json.
  const registry = getSkillRegistry();
  if (!registry.get(body.skill_name)) {
    throw new NotFoundError(`Skill '${body.skill_name}' not found`);
  }
  if (!registry.canUserInvoke(body.skill_name)) {
    throw new ForbiddenError(`Skill '${body.skill_name}' is not user-invocable`);
  }

  // Cross-tenant guard (same rationale as /chat/message)
  if (body.project_id) {
    // Chat is a creative-write action (v10 §7.2.1) — view-only
    // members cannot send chat messages or invoke skills.
    await projectService.assertAccess(body.project_id, user.id, "edit");
  }

  const conversation = await conversationService.getOrCreate(
    user.id,
    body.conversation_id,
    body.input,
    body.project_id,
  );

  // Build request context
  const agentCfg = getAgentConfig();
  const memoryContext = await memoryService.buildContext(
    user.id, conversation.id, body.project_id, "agent_chat",
  );
  const conv = await conversationRepo.getConversation(conversation.id);
  const lastTurn = conv?.lastConsolidatedTurn ?? 0;
  const rawHistory = await conversationRepo.getMessagesForLlm(conversation.id, lastTurn);
  const compressedHistory = compressForContext(rawHistory, agentCfg.full_detail_turns);

  c.header("Content-Type", "text/event-stream");
  c.header("Cache-Control", "no-cache");
  c.header("Connection", "keep-alive");

  return stream(c, async (s) => {
    await runWithContext(
      { userId: user.id, conversationId: conversation.id, projectId: body.project_id, memoryContext, compressedHistory },
      async () => {
        const agent = new MainAgent();
        for await (const event of agent.handleSkillCommand(
          body.skill_name, body.input, body.resource_list,
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
 *
 * @param c - Hono context with pagination + optional `project_id`
 * @returns Array of conversation entities
 */
chat.get(
  "/conversations",
  zValidator("query", chatConversationsQuerySchema),
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
 * `GET /chat/conversations/:id` — fetch a conversation with messages.
 *
 * @param c - Hono context with conversation ID param
 * @returns Conversation entity and its message history
 * @throws `404` if not found, `403` if not the owner
 */
chat.get("/conversations/:id", async (c) => {
  const user = c.get("user");
  const conversationId = c.req.param("id");
  const result = await conversationService.getWithMessages(conversationId, user.id);
  return c.json({ data: result });
});

/**
 * `DELETE /chat/conversations/:id` — delete a conversation.
 *
 * @param c - Hono context with conversation ID param
 * @returns `200` with success message
 * @throws `404` if not found, `403` if not the owner
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
