// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Chat routes — conversational AI with SSE streaming.
 *
 * Provides endpoints for chat messages and conversation CRUD. A run's frames
 * are read as Server-Sent Events from `GET /chat/conversations/:id/stream`,
 * which replays the run's resumable stream (inner#1717).
 */

import { accountActivityRepo } from "@breatic/core";
import { reportCollaboratorFirstAction } from "@breatic/core";
import { Hono } from "hono";
import type { Context } from "hono";
import { randomUUID } from "node:crypto";
import { runAfterReply } from "@server/utils/after-reply.js";
import { holdsOnlyStorableText } from "@server/utils/storable-text.js";
import { validate } from "@server/middleware/validate.js";
import { runOnce } from "@server/middleware/run-once.js";
import { rateLimitFor } from "@server/middleware/rate-limit.js";

import {
  idempotencyKeyHeaderSchema,
  chatMessageSchema,
  chatConversationsQuerySchema,
  chatOpenSchema,
  chatCreateConversationSchema,
  chatRenameConversationSchema,
  chatSetModelSchema,
  chatEarlierMessagesQuerySchema,
  agentInstructionsQuerySchema,
  agentInstructionsSaveSchema,
  chatRunningQuerySchema,
  idParamSchema,
  attachmentParamSchema,
  chatProjectBodySchema,
  chatStopSchema,
  chatQueueParamSchema,
} from "@server/routes/schemas.js";
import { requireAuth } from "@server/middleware/auth.js";
import { acceptTransferBody } from "@server/middleware/transfer-body.js";
import type { AuthVariables } from "@server/middleware/auth.js";
import { conversationService } from "@server/modules";
import { attachmentService } from "@server/modules";
import { agentInstructionsService } from "@server/modules";
import { runningTurnsService } from "@server/modules";
import { projectService } from "@server/modules";
import { precheckCredits } from "@server/modules";
import { SMALLEST_CREDIT } from "@breatic/domain";
import { startRun, stopChannel } from "@server/agent/chat-run.js";
import { runStreams } from "@server/agent/run-stream.js";
import { isShuttingDown } from "@server/agent/shutdown-flag.js";
import { takenMessageOf, userMessageData } from "@server/agent/taken-message.js";
import { chatQueue, type QueueItem } from "@server/modules/chat-queue/chat-queue.service.js";
import { toUiMessages } from "@server/modules/conversation/message-part-mapping.js";
import { AppError, getRedis, logger, getAgentConfig, NotFoundError, ValidationError } from "@breatic/core";
import { attachmentSection, getActiveLocale, messageLength, referenceCount, t } from "@breatic/shared";
import type { ChatAttachedChip, ChatPendingItem, ChatSpaceContext, SpaceRequestAnswer } from "@breatic/shared";

/**
 * Refuse a message whose words, attachments or Spaces are past their limits.
 *
 * Two limits, measured apart: the words on what the user typed, the
 * attachments on the section the model is sent them in. A long question does
 * not shrink what may be attached, and an attached document does not eat
 * into what may be typed.
 *
 * Refused rather than trimmed. A silently shortened question leaves the
 * user unable to see what went missing, reading an answer to something they
 * did not ask.
 *
 * The Spaces are cut to their limits by the browser, so only a client that
 * skipped that reaches these checks.
 * @param message - What the user typed.
 * @param chips - What the user attached.
 * @param space - The project's Spaces and the one the user has open.
 * @param shared - The user's answer to a request to read Spaces, if this is one.
 * @throws {AppError} With 422 when the words, the number of references, the
 *   number of attached items, the attachments' length, the open Space's
 *   content or its blocks' text, a shared Space's content, or the number of
 *   Spaces listed is over its limit.
 */
function assertSayable(
  message: string,
  chips: readonly ChatAttachedChip[],
  space: ChatSpaceContext,
  shared: SpaceRequestAnswer | undefined,
): void {
  const {
    user_message_max_chars,
    user_message_max_references,
    attachment_max_chars,
    attachment_max_items,
    current_space_max_chars,
    space_list_max_items,
  } = getAgentConfig();
  // Measured the way the box shows it: a reference is the one block the
  // user sees, not the longer marker it is written as.
  const said = messageLength(chips, message);
  if (said > user_message_max_chars) {
    throw new ValidationError(
      t("server.chat.message_too_long", {
        limit: user_message_max_chars,
        actual: said,
      }),
    );
  }
  const references = referenceCount(chips, message);
  if (references > user_message_max_references) {
    throw new ValidationError(
      t("server.chat.references_too_many", { limit: user_message_max_references, actual: references }),
    );
  }
  if (chips.length > attachment_max_items) {
    throw new ValidationError(
      t("server.chat.attachments_too_many", { limit: attachment_max_items, actual: chips.length }),
    );
  }
  const attached = attachmentSection(chips).length;
  if (attached > attachment_max_chars) {
    throw new ValidationError(
      t("server.chat.attachments_too_long", { limit: attachment_max_chars, actual: attached }),
    );
  }
  const listed = space.spaces?.length ?? 0;
  if (listed > space_list_max_items) {
    throw new ValidationError(t("server.chat.spaces_too_many", { limit: space_list_max_items, actual: listed }));
  }
  const loaded = space.current_space?.state === "loaded" ? space.current_space : undefined;
  // The blocks' plain text rides beside the content for the document proposal
  // to check against (inner#1509); it is held to the same limit.
  const blocksText = loaded?.blocks?.reduce((sum, block) => sum + block.text.length, 0) ?? 0;
  const content = Math.max(loaded?.content.length ?? 0, blocksText);
  if (content > current_space_max_chars) {
    throw new ValidationError(
      t("server.chat.current_space_too_long", { limit: current_space_max_chars, actual: content }),
    );
  }
  // Each Space the user shared is read and cut the way the open one is
  // (inner#1552), so each is held to the same limit.
  for (const one of shared?.decision === "shared" ? shared.spaces : []) {
    if (one.state === "read" && one.content.length > current_space_max_chars) {
      throw new ValidationError(
        t("server.chat.shared_space_too_long", { name: one.name, limit: current_space_max_chars, actual: one.content.length }),
      );
    }
  }
}

/**
 * The waiting area: the queue, as much of each message as a page draws.
 * @param queue - The queue's items.
 * @returns The items a page is given.
 */
function pendingOf(queue: readonly QueueItem[]): ChatPendingItem[] {
  return queue.map((item) => userMessageData(takenMessageOf(item)));
}

/**
 * Run work as after-reply work while the request waits for it, so a shutdown
 * waits for it too before it closes the pools (inner#1717).
 * @param ctx - Log context naming the work.
 * @param fn - The work.
 * @returns What the work returned.
 */
function heldThroughShutdown<T>(ctx: Record<string, unknown>, fn: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    runAfterReply(ctx, async () => {
      try {
        resolve(await fn());
      } catch (err) {
        reject(err);
      }
    });
  });
}

/**
 * Hand back a conversation held for a card's answer that was then refused:
 * messages sent meanwhile get a run, otherwise the card waits again.
 * @param conversationId - The conversation.
 * @param projectId - Its project.
 * @param userId - Who answered.
 * @param runId - The run the answer held it for.
 * @param awaiting - The card that was waiting when it was held.
 */
async function handBack(conversationId: string, projectId: string, userId: string, runId: string, awaiting: string | null): Promise<void> {
  const next = await chatQueue().giveBack(conversationId, runId, awaiting);
  if (next !== null) startRun({ conversationId, projectId, userId, runId: next, entrance: { kind: "head" } });
}

/**
 * The answer a card is given while the server shuts down: try again shortly.
 * @param c - The request.
 * @returns The response.
 */
function shuttingDown(c: Context<{ Variables: AuthVariables }>): Response {
  return c.json({ error: { code: 503, message: t("server.chat.shutting_down"), reason: "shutting_down" } }, 503);
}

const chat = new Hono<{ Variables: AuthVariables }>();

chat.use("*", requireAuth);

/**
 * `POST /chat/message` — send a message, or answer the card a turn waits at.
 *
 * A message joins the conversation's queue (inner#1717). When no run holds
 * the conversation it opens one, and the answer waits for that run's opening
 * stage, so the page finds the message in the history and the run's stream to
 * attach to; otherwise the running run reads it at its next step. The answer
 * is the status and the waiting area as JSON; the run's frames are read from
 * `GET /chat/conversations/:id/stream`. It never creates a conversation:
 * `POST /chat/open` is the single place a conversation appears on the user's
 * behalf, so an id that no longer resolves is refused here rather than
 * quietly replaced with a new conversation the client does not know about.
 * @param c - Hono context with validated `chatMessageSchema` body
 * @returns The send's status and the waiting area as JSON
 */
chat.post("/message", acceptTransferBody("chat_message"), validate("json", chatMessageSchema), async (c) => {
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

  assertSayable(body.message, body.attached_chips, body, body.shared_spaces);
  // A message is stored when its run opens, and a run reads what it takes in
  // as it goes: text the store refuses would fail every run that tried.
  if (!holdsOnlyStorableText(body)) {
    logger.warn({ userId: user.id, conversationId: conversation.id }, "chat_message_unstorable");
    throw new ValidationError(t("server.error.validation"));
  }

  // A turn needs a balance above zero to start (#296). Payments off: no check.
  // Checked before an answer is taken, so a refused answer leaves the card
  // waiting.
  await precheckCredits(body.project_id, user.id, SMALLEST_CREDIT);

  // A message in the project's Agent chat is a collaboration action (inner#1442
  // §4.8). Reported alongside the turn; it never rejects.
  void reportCollaboratorFirstAction({ projectId: body.project_id, userId: user.id, action: "agent" });

  // An answer to a card resumes the turn that asked: a questionnaire's
  // (inner#1542) or a request to read Spaces (inner#1552). Both are taken,
  // refused and resumed alike; only how the answer is held to the call differs.
  const { answer, shared_spaces: sharedSpaces } = body;
  // The model is settled before an answer is taken, so nothing about it can
  // refuse a request after the card's answer is already gone (#1363). A
  // resumed turn runs on the model it started on.
  const resumed = answer?.toolCallId ?? sharedSpaces?.toolCallId;
  const modelId =
    resumed === undefined
      ? await conversationService.modelForMessage(conversation, user.id, body.model)
      : await conversationService.modelForResume(conversation, user.id, resumed);
  const card =
    answer !== undefined
      ? { toolCallId: answer.toolCallId, take: () => conversationService.answerAsk(conversation.id, answer, { userId: user.id, projectId: body.project_id }) }
      : sharedSpaces !== undefined
        ? {
          toolCallId: sharedSpaces.toolCallId,
          take: () => conversationService.answerSpaceRequest(conversation.id, sharedSpaces, { userId: user.id, projectId: body.project_id }),
        }
        : undefined;
  if (card !== undefined) {
    const ctx = { userId: user.id, conversationId: conversation.id, projectId: body.project_id, task: "chat_card_answer" };
    // The shutdown flag, the resume, the answer and the run's opening stage
    // are one piece of after-reply work: a shutdown that lands anywhere in it
    // waits for the run to write its failed ending before the pools close.
    return heldThroughShutdown(ctx, async () => {
      if (isShuttingDown()) return shuttingDown(c);
      // The conversation is held before the answer is taken, so an answer
      // refused as busy leaves the card waiting for the run that holds it.
      const runId = randomUUID();
      const resumed = await chatQueue().resume(conversation.id, runId);
      if (resumed.status === "busy") {
        return c.json({ error: { code: 409, message: t("server.chat.turn_busy"), reason: "turn_busy" } }, 409);
      }
      const taken = await card.take().catch(async (err: unknown) => {
        await handBack(conversation.id, body.project_id, user.id, runId, resumed.awaiting);
        throw err;
      });
      if (taken.kind !== "answered") await handBack(conversation.id, body.project_id, user.id, runId, resumed.awaiting);
      if (taken.kind === "missing") throw new NotFoundError(t("server.chat.ask_not_found"));
      if (taken.kind === "mismatch") {
        logger.warn({ userId: user.id, conversationId: conversation.id, reason: taken.reason }, "chat_answer_mismatch");
        throw new ValidationError(t("server.chat.answer_mismatch"));
      }
      if (taken.kind === "settled") {
        // How the call now stands rides in the error envelope, where the
        // page's API client reads it, so the card draws what the store holds.
        return c.json(
          { error: { code: 409, message: t("server.chat.ask_already_answered"), call: { status: taken.status, output: taken.output } } },
          409,
        );
      }
      const { running } = await startRun({
        conversationId: conversation.id,
        projectId: body.project_id,
        userId: user.id,
        runId,
        entrance: {
          kind: "card",
          toolCallId: card.toolCallId,
          output: taken.output,
          turnIndex: taken.turnIndex,
          ...(body.time_zone === undefined ? {} : { timeZone: body.time_zone }),
          space: body,
          ...(modelId === undefined ? {} : { modelId }),
          locale: getActiveLocale(),
        },
      }).opened;
      return c.json({ data: { status: "start", pending: pendingOf(await chatQueue().pending(conversation.id)), running } });
    });
  }

  if (await conversationService.messageIdRefused(conversation.id, body.id!)) {
    logger.warn({ userId: user.id, conversationId: conversation.id, messageId: body.id }, "chat_message_id_taken");
    return c.json({ error: { code: 409, message: t("server.error.conflict"), reason: "message_id_taken" } }, 409);
  }
  await accountActivityRepo.recordActivity({ userId: user.id, projectId: body.project_id, kind: "agent_started" });
  const { project_id: _project, conversation_id: _conversation, ...said } = body;
  const item: QueueItem = {
    ...said,
    id: body.id!,
    sentAt: new Date().toISOString(),
    userId: user.id,
    acceptLanguage: getActiveLocale(),
  };
  const queued = await chatQueue().enqueue(conversation.id, item);
  if (queued.status === "full") {
    return c.json({ error: { code: 409, message: t("server.chat.queue_full"), reason: "queue_full" } }, 409);
  }
  if (queued.status === "start") {
    const { running } = await startRun({
      conversationId: conversation.id,
      projectId: body.project_id,
      userId: user.id,
      runId: queued.runId,
      entrance: { kind: "head" },
    }).opened;
    return c.json({ data: { status: "start", pending: pendingOf(await chatQueue().pending(conversation.id)), running } });
  }
  const { active } = await chatQueue().peek(conversation.id);
  return c.json({ data: { status: queued.status, pending: pendingOf(queued.queue), running: active !== null } });
});

/**
 * `POST /chat/conversations/:id/sync` — where the conversation stands, opening
 * a run for what waits when none holds it (inner#1717).
 *
 * The page shown in the Agent column asks every `next_sync_ms`. A run is opened
 * here for what a run that died, or a run refused for credits, left behind;
 * the credit check runs only when a run would open, so a conversation with
 * nothing waiting is never told it is out of credits.
 * @param c - Hono context with the conversation id and `{ project_id }`
 * @returns The waiting area, whether a run is running, whether a card waits,
 *   why a run could not open, and when to ask again.
 */
chat.post(
  "/conversations/:id/sync",
  rateLimitFor("chat-sync", "user"),
  validate("param", idParamSchema),
  validate("json", chatProjectBodySchema),
  async (c) => {
    const user = c.get("user");
    const { project_id: projectId } = c.req.valid("json");
    await projectService.assertAccess(projectId, user.id, "editor");
    const conversation = await conversationService.assertWritable(c.req.param("id"), user.id, projectId);
    const queue = chatQueue();
    const next_sync_ms = getAgentConfig().chat_sync_interval_ms;
    const seen = await queue.peek(conversation.id);
    if (seen.active === null && !seen.awaiting && seen.work && !isShuttingDown()) {
      try {
        await precheckCredits(projectId, user.id, SMALLEST_CREDIT);
      } catch (err) {
        if (!(err instanceof AppError) || err.statusCode !== 402) throw err;
        return c.json({
          data: { pending: pendingOf(await queue.pending(conversation.id)), running: false, awaiting: false, blocked: "credits", next_sync_ms },
        });
      }
      const claimed = await queue.claim(conversation.id);
      if (claimed.status === "start") {
        const { running } = await startRun({
          conversationId: conversation.id,
          projectId,
          userId: user.id,
          runId: claimed.runId,
          entrance: { kind: "head" },
        }).opened;
        return c.json({ data: { pending: pendingOf(await queue.pending(conversation.id)), running, awaiting: false, next_sync_ms } });
      }
    }
    const now = await queue.peek(conversation.id);
    return c.json({
      data: { pending: pendingOf(await queue.pending(conversation.id)), running: now.active !== null, awaiting: now.awaiting, next_sync_ms },
    });
  },
);

/**
 * `GET /chat/conversations/:id/stream` — attach to the run that holds the
 * conversation, from its first frame (inner#1717).
 *
 * Read-only, so it is checked as reading the conversation is. Every frame the
 * run has written is replayed, then the rest as it comes; 204 when no run
 * holds the conversation or its stream cannot be read, and the page leaves it
 * to the next sync.
 * @param c - Hono context with the conversation id
 * @returns The run's SSE stream, or 204.
 */
chat.get("/conversations/:id/stream", validate("param", idParamSchema), async (c) => {
  const user = c.get("user");
  const conversationId = c.req.param("id");
  await conversationService.assertAccess(conversationId, user.id);
  const { active } = await chatQueue().peek(conversationId);
  if (active === null) return c.body(null, 204);
  let stream: ReadableStream<string> | null | undefined;
  try {
    stream = await runStreams().resumeExistingStream(active);
  } catch (err) {
    // Most often the run's producer is gone (`Timeout waiting for ack`); a
    // Redis failure lands here too. The page asks again at its next sync.
    logger.error({ err, userId: user.id, conversationId, runId: active }, "chat_stream_attach_failed");
    return c.body(null, 204);
  }
  if (stream === null || stream === undefined) return c.body(null, 204);
  return new Response(stream.pipeThrough(new TextEncoderStream()), {
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" },
  });
});

/**
 * `POST /chat/stop` — stop the run that holds the conversation (inner#1717).
 *
 * The user's way to stop a run (deleting the conversation and a shutdown stop
 * it too): published to the run, on whichever instance it runs; the run ends
 * as stopped and every attached page reads the mark.
 * @param c - Hono context with `{ conversation_id, project_id }`
 * @returns Whether a run was there to stop.
 */
chat.post("/stop", rateLimitFor("chat-stop", "user"), validate("json", chatStopSchema), async (c) => {
  const user = c.get("user");
  const { conversation_id: conversationId, project_id: projectId, run_id: runId } = c.req.valid("json");
  await projectService.assertAccess(projectId, user.id, "editor");
  await conversationService.assertWritable(conversationId, user.id, projectId);
  const { active } = await chatQueue().peek(conversationId);
  // A stop pressed as one run ended can land once the next run holds the
  // conversation; it was meant for the run that ended.
  if (active === null || (runId !== undefined && runId !== active)) return c.json({ data: { stopped: false } });
  await getRedis().publish(stopChannel(active), "stop");
  return c.json({ data: { stopped: true } });
});

/**
 * `DELETE /chat/conversations/:id/queue/:messageId` — take a waiting message
 * back (inner#1717).
 * @param c - Hono context with the ids and `{ project_id }`
 * @returns `removed` when it was still waiting, `taken` when a run has read
 *   it, `gone` when it is nowhere (another page took it back).
 */
chat.delete(
  "/conversations/:id/queue/:messageId",
  rateLimitFor("chat-queue-remove", "user"),
  validate("param", chatQueueParamSchema),
  validate("json", chatProjectBodySchema),
  async (c) => {
    const user = c.get("user");
    const { id, messageId } = c.req.valid("param");
    const { project_id: projectId } = c.req.valid("json");
    await projectService.assertAccess(projectId, user.id, "editor");
    await conversationService.assertWritable(id, user.id, projectId);
    return c.json({ data: { status: await chatQueue().remove(id, messageId) } });
  },
);

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
  rateLimitFor("conversation-create", "user"),
  validate("header", idempotencyKeyHeaderSchema),
  validate("json", chatCreateConversationSchema),
  runOnce("conversation"),
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
 * `GET /chat/running` — the caller's conversations in a project with an Agent
 * turn running now, on any tab or device (#1394).
 *
 * Reads only the caller's own leases, the same way `GET /chat/conversations`
 * lists only the caller's own conversations.
 * @param c - Hono context with `project_id` in the query
 * @returns `{ conversation_ids }`, each once, in no particular order
 */
chat.get("/running", validate("query", chatRunningQuerySchema), async (c) => {
  const user = c.get("user");
  const { project_id: projectId } = c.req.valid("query");
  const ids = await runningTurnsService.runningConversationIds({ userId: user.id, projectId });
  return c.json({ data: { conversation_ids: ids } });
});

/**
 * `GET /chat/instructions` — the Project's instructions for the Agent, for
 * its Owner and Editors (#1400).
 * @param c - Hono context with `project_id` in the query
 * @returns The text, who saved it last and when; empty when there are none
 * @throws {AppError} `404` for a non-member, `403` for a member who may not edit
 */
chat.get("/instructions", validate("query", agentInstructionsQuerySchema), async (c) => {
  const user = c.get("user");
  const { project_id: projectId } = c.req.valid("query");
  return c.json({ data: await agentInstructionsService.read(projectId, user.id) });
});

/**
 * `PUT /chat/instructions` — save the Project's instructions for the Agent as
 * typed; a text that is empty or only whitespace clears them (#1400).
 * @param c - Hono context with `{ project_id, text }`
 * @returns The instructions now in place
 * @throws {AppError} `404` for a non-member, `403` for a member who may not edit
 */
chat.put(
  "/instructions",
  rateLimitFor("agent-instructions", "user"),
  validate("json", agentInstructionsSaveSchema),
  async (c) => {
    const user = c.get("user");
    const { project_id: projectId, text } = c.req.valid("json");
    return c.json({ data: await agentInstructionsService.save(projectId, user.id, text) });
  },
);

/**
 * `GET /chat/models` — the models the user can pick in the chat panel, in
 * order, and the one a new conversation of theirs starts on (#1363).
 * @param c - Hono context
 * @returns The list and the starting model's id
 */
chat.get("/models", async (c) => {
  const user = c.get("user");
  return c.json({ data: await conversationService.listChatModels(user.id) });
});

/**
 * `PUT /chat/conversations/:id/model` — pick the model a conversation is
 * answered by; it becomes the user's last pick too (#1363).
 * @param c - Hono context with the conversation id in the path and a
 *   `project_id` + `model` body
 * @returns The conversation as it now stands
 * @throws {AppError} `422` for a model the deployment does not list; `404` if
 *   the conversation is missing, deleted, someone else's or in another Project
 */
chat.put(
  "/conversations/:id/model",
  validate("param", idParamSchema),
  validate("json", chatSetModelSchema),
  async (c) => {
    const user = c.get("user");
    const { project_id: projectId, model } = c.req.valid("json");
    const conversation = await conversationService.setConversationModel(c.req.param("id"), user.id, projectId, model);
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
  validate("param", idParamSchema),
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
  const { current, ...rest } = await conversationService.openChat(user.id, projectId);
  return c.json({
    data: {
      ...rest,
      current: { ...current, messages: toUiMessages(current.messages) },
    },
  });
});

/**
 * `GET /chat/conversations/:id` — fetch a conversation with messages.
 * @param c - Hono context with conversation ID param
 * @returns Conversation entity and its message history
 * @throws {AppError} `404` if not found, `403` if not the owner
 */
chat.get("/conversations/:id", validate("param", idParamSchema), async (c) => {
  const user = c.get("user");
  const conversationId = c.req.param("id");
  const { messages, ...rest } = await conversationService.getWithMessages(conversationId, user.id);
  return c.json({ data: { ...rest, messages: toUiMessages(messages) } });
});

/**
 * `GET /chat/conversations/:id/messages` — the page before the one in hand.
 *
 * How a conversation longer than one page is read: the client holds the
 * newest page from `/chat/open` and asks for what comes before it, turn by
 * turn, as the user scrolls back.
 * @param c - Hono context with conversation ID param and `before_turn` query
 * @returns That page, oldest first, and whether anything is older still
 * @throws {AppError} `404` if not found, `403` if not the owner
 */
chat.get(
  "/conversations/:id/messages",
  validate("param", idParamSchema),
  validate("query", chatEarlierMessagesQuerySchema),
  async (c) => {
    const user = c.get("user");
    const { before_turn: beforeTurn } = c.req.valid("query");
    const { messages, ...rest } = await conversationService.getEarlierMessages(
      c.req.param("id"),
      user.id,
      beforeTurn,
    );
    return c.json({ data: { ...rest, messages: toUiMessages(messages) } });
  },
);

/**
 * `DELETE /chat/conversations/:id` — delete a conversation.
 * @param c - Hono context with conversation ID param
 * @returns `200` with success message
 * @throws {AppError} `404` if not found, `403` if not the owner
 */
chat.delete("/conversations/:id", validate("param", idParamSchema), async (c) => {
  const user = c.get("user");
  const conversationId = c.req.param("id");
  await conversationService.assertAccess(conversationId, user.id);
  // Its queue first, so the run it stops opens no next run on what waited;
  // then the row; then the stop (inner#1717).
  const { active } = await chatQueue().peek(conversationId);
  await chatQueue().clear(conversationId);
  await conversationService.deleteConversation(conversationId, user.id);
  if (active !== null) await getRedis().publish(stopChannel(active), "stop");
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
chat.get(
  "/conversations/:id/attachments",
  validate("param", idParamSchema),
  async (c) => {
    const user = c.get("user");
    const conversationId = c.req.param("id");
    await conversationService.assertAccess(conversationId, user.id);
    const list = await attachmentService.listByConversation(conversationId);
    return c.json({ data: list });
  },
);

/**
 * `DELETE /chat/conversations/:cid/attachments/:aid` — soft-delete.
 *
 * Marks the attachment as deleted. The DB record and underlying file
 * are retained — soft delete only hides it from the active list.
 */
chat.delete(
  "/conversations/:cid/attachments/:aid",
  validate("param", attachmentParamSchema),
  async (c) => {
    const user = c.get("user");
    const aid = c.req.param("aid");
    await attachmentService.softDelete(aid, user.id);
    return c.json({ data: { ok: true } });
  },
);

/**
 * `GET /chat/stream-config` — the chat knobs a browser needs, from
 * `config/agent.yaml`: how often a stream says it is alive, how long the
 * attachments on one message may be and how many there may be, and how much
 * of the user's Spaces one message may carry, how long reading one Space
 * the Agent asked for may take, and how often an open conversation list asks
 * which conversations are running (#1394). The browser checks
 * attachments against those before sending and cuts the Spaces to them, so it
 * measures against the same limits the server enforces.
 *
 * How often this server says a stream is alive is the same fact as how long a
 * browser waits before deciding it is not, so it has one home and the browser
 * asks for it. Two copies, and an operator who changed this one would leave
 * every browser either declaring healthy streams dead or waiting longer than
 * it meant to -- silently, because nothing on either side would notice.
 *
 * How many beats in a row may go missing is deliberately not here. A server
 * collecting garbage can miss two in a row on a stream that is perfectly
 * healthy, so a deployment that tuned that figure down would be tuning down
 * how many working turns it kills.
 *
 * Shaped like `GET /assets/upload-config`, which serves the browser's upload
 * knobs out of `config/storage.yaml` for the same reason.
 */
chat.get("/stream-config", (c) => {
  const config = getAgentConfig();
  return c.json({
    data: {
      heartbeatIntervalMs: config.sse_heartbeat_interval_ms,
      attachmentMaxChars: config.attachment_max_chars,
      attachmentMaxItems: config.attachment_max_items,
      currentSpaceMaxChars: config.current_space_max_chars,
      spaceListMaxItems: config.space_list_max_items,
      spaceReadTimeoutMs: config.space_read_timeout_ms,
      runningPollIntervalMs: config.running_poll_interval_ms,
      syncIntervalMs: config.chat_sync_interval_ms,
    },
  });
});

export { chat as chatRoute };
