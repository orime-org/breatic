// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Conversation service — business logic for conversations and messages.
 *
 * Enforces ownership checks at the service layer before delegating
 * to the conversation repository.
 */

import * as conversationRepo from "@server/modules/conversation/conversation.repo.js";
import * as messageRepo from "@server/modules/conversation/conversation-message.repo.js";
import * as projectService from "@server/modules/project/project.service.js";
import * as projectRepo from "@server/modules/project/project.repo.js";
import { t } from "@breatic/shared";
import { db, NotFoundError, ForbiddenError, getAgentConfig } from "@breatic/core";
import type { ConversationEntity, MessageData } from "@breatic/shared";

/**
 * Validate that a conversation exists and belongs to the given user.
 * @param conversationId - Conversation UUID
 * @param userId - Requesting user UUID
 * @returns The validated conversation entity
 * @throws {NotFoundError} if conversation does not exist
 * @throws {ForbiddenError} if userId does not match the conversation owner
 */
async function validateOwnership(
  conversationId: string,
  userId: string,
): Promise<ConversationEntity> {
  const conv = await conversationRepo.getConversation(conversationId);
  if (!conv) throw new NotFoundError(t("server.error.not_found"));
  if (conv.userId !== userId) throw new ForbiddenError(t("server.error.forbidden"));
  return conv;
}

/**
 * Assert that the given user may access the given conversation.
 *
 * Shared entry point for REST route handlers that need to reject cross-tenant
 * reads (e.g. conversation attachment listings) before doing any work.
 * Discards the returned entity so call sites read as an assertion rather than
 * a fetch.
 * @param conversationId - Conversation UUID from untrusted client input
 * @param userId - Authenticated user UUID from the session
 * @throws {NotFoundError} if conversation does not exist
 * @throws {ForbiddenError} if the user does not own the conversation
 */
export async function assertAccess(
  conversationId: string,
  userId: string,
): Promise<void> {
  await validateOwnership(conversationId, userId);
}

/** Title a conversation carries until something better is known. */
const NEW_TITLE = "New conversation";

/**
 * Open chat in a project: the list, plus whatever the user was last saying.
 *
 * This is the client's single entry point into a project's chat, and the only
 * place a conversation is created on the user's behalf. It creates one when the
 * project has none, so a client always leaves here holding an id — which is why
 * sending a message can require one rather than having a creation path of its
 * own.
 *
 * Access is judged as a WRITE. It creates, so a member who may only read the
 * project must not get through, or a look-only visit leaves a conversation
 * behind in someone else's project.
 *
 * "What the user was last saying" is computed, never stored. Storing it would
 * mean one value per (user, project), and a user with two tabs on two
 * conversations has two states that one value cannot hold — which is why the
 * previous design was withdrawn.
 * @param userId - The signed-in user
 * @param projectId - Project being opened
 * @returns This user's conversations in this project, and the most recently
 *   used one together with its messages
 * @throws {NotFoundError} if the caller is not a member of the project
 * @throws {ForbiddenError} if they are a member but may only read
 */
export async function openChat(
  userId: string,
  projectId: string,
): Promise<{
  conversations: ConversationEntity[];
  current: {
    conversation: ConversationEntity;
    messages: MessageData[];
    /** The conversation reaches back further than these messages do. */
    hasMore: boolean;
  };
}> {
  await projectService.assertAccess(projectId, userId, "editor");

  // Two locks, each covering a race the other cannot see, taken in this order
  // everywhere. Nothing else in the codebase takes the advisory lock, so no
  // cycle with the paths that take the project row is possible.
  const conversation = await db.transaction(async (tx) => {
    // 1. Asking "is there one?" and then creating leaves a gap two tabs of the
    //    same user can both walk through, each leaving an empty conversation
    //    behind. This makes the pair one indivisible step per (user, project);
    //    whoever arrives second finds the first one's conversation and uses it.
    //    Scoped to the pair rather than the project so two members opening the
    //    same project never wait on each other.
    await conversationRepo.lockChatCreation(tx, userId, projectId);

    const existing = await conversationRepo.findMostRecentlyUsed(userId, projectId, tx);
    if (existing) return existing;

    // 2. Only the branch that adds a row needs the project, which is why the
    //    lock sits here and not above: an ordinary open reads and returns
    //    without ever touching the project row. Checking the project is alive
    //    without locking it does not work — the insert's own foreign key takes
    //    FOR KEY SHARE, a delete's UPDATE takes FOR NO KEY UPDATE, and those
    //    two do not conflict, so the pair runs past each other and what commits
    //    is a live conversation on a deleted project: unreachable through chat
    //    forever, and left behind by a delete that believed it had swept the
    //    project clean. `projectInvite`, `roleUpgradeRequest` and
    //    `projectTransfer` all take this lock before adding their own rows.
    if (!(await projectRepo.lockLiveProject(projectId, tx))) {
      throw new NotFoundError(t("server.error.not_found"));
    }

    const created = await conversationRepo.createConversation(userId, NEW_TITLE, tx);
    await conversationRepo.setProjectId(created.id, projectId, tx);
    return { ...created, projectId };
  });

  const page = await messageRepo.getMessages(conversation.id);
  return {
    conversations: await conversationRepo.listConversations(userId, { projectId }),
    current: {
      conversation,
      messages: page.messages,
      // Said here rather than left for the client to discover, because the
      // only way to discover it is to ask for a page that may well be empty.
      hasMore: page.hasMore,
    },
  };
}

/**
 * Cut a first message down to something a list row can show.
 *
 * Whitespace is collapsed before measuring: a message typed across several
 * lines would otherwise become a title with a line break in the middle of it,
 * and the row would show only what came before the break.
 * @param said - What the user typed
 * @param limit - How many characters the title may run to, ellipsis included
 * @returns The title, or null when there is nothing in the message to use
 */
function titleFromMessage(said: string, limit: number): string | null {
  const collapsed = said.replace(/\s+/g, " ").trim();
  if (collapsed.length === 0) return null;
  if (collapsed.length <= limit) return collapsed;
  return `${collapsed.slice(0, limit - 1)}…`;
}

/**
 * What this conversation is called, naming it after `said` if it has none yet.
 *
 * Called once per turn, and it answers rather than returning nothing so the
 * turn can tell the client the name in the same breath as it confirms the
 * message landed. Without that the list and the header go on saying the
 * default until the reader leaves the project and comes back.
 *
 * "Has none yet" is read as "still carries the title it was created with".
 * The alternative — "this is the first message" — is wrong for a conversation
 * the owner named before saying anything in it, which is a thing they can do
 * from the moment it appears in the list.
 * @param conversationId - The conversation this turn belongs to
 * @param said - What the user just said in it
 * @returns The name it goes by from now on
 */
export async function titleForTurn(
  conversationId: string,
  said: string,
): Promise<string> {
  const conversation = await conversationRepo.getConversation(conversationId);
  // The caller has already established this conversation is writable, so a
  // miss here is not a case to handle -- but neither is it worth failing a
  // turn over a title, so the default is answered and the turn goes on.
  if (!conversation) return NEW_TITLE;
  if (conversation.title !== NEW_TITLE) return conversation.title;

  const named = titleFromMessage(said, getAgentConfig().conversation_title_max_chars);
  if (named === null) return conversation.title;
  await conversationRepo.updateTitle(conversationId, named);
  return named;
}

/**
 * Start a conversation because the user asked for one.
 *
 * The other way a conversation appears is {@link openChat}, which makes one
 * only when the project has none. The difference is not the mechanics but who
 * decided: there, the user asked to see their chat and the server had nothing
 * to show; here, the user pressed a button that says start another one. So
 * this never looks for an existing conversation — being handed the one already
 * on screen is exactly what the press was refusing.
 *
 * That distinction is what keeps "a conversation is only ever created
 * automatically in one place" true. The rule guards against an id that no
 * longer resolves quietly turning into a new conversation while the reader
 * believes they are still in the old one; a deliberate press is not that.
 *
 * Access is judged as a WRITE, same as opening: a member who may only read
 * must not leave a conversation behind in someone else's project.
 *
 * Only one lock, where {@link openChat} takes two. The second lock there makes
 * "is there one?" and "then make one" indivisible, so two tabs racing cannot
 * each leave an empty conversation behind. There is no such pair here — this
 * asks nothing before creating, so two presses producing two conversations is
 * the correct answer to two presses, not a race to be closed.
 * @param userId - The signed-in user
 * @param projectId - Project the new conversation belongs to
 * @returns The conversation that was just created
 * @throws {NotFoundError} if the caller is not a member, or the project is gone
 * @throws {ForbiddenError} if they are a member but may only read
 */
export async function createConversation(
  userId: string,
  projectId: string,
): Promise<ConversationEntity> {
  await projectService.assertAccess(projectId, userId, "editor");

  return db.transaction(async (tx) => {
    // Same reason as in `openChat`: without holding the project row, this
    // insert's foreign key takes FOR KEY SHARE while a delete takes FOR NO KEY
    // UPDATE, and those two do not conflict — so a live conversation can commit
    // onto a project that has just been deleted, unreachable through chat
    // forever.
    if (!(await projectRepo.lockLiveProject(projectId, tx))) {
      throw new NotFoundError(t("server.error.not_found"));
    }

    const created = await conversationRepo.createConversation(userId, NEW_TITLE, tx);
    await conversationRepo.setProjectId(created.id, projectId, tx);
    return { ...created, projectId };
  });
}

/**
 * Give a conversation the name its owner chose.
 *
 * Guarded by {@link assertWritable} rather than by an ownership check, because
 * the id arrives from the client: it has to be this user's, in this project,
 * and still there. All three answer NotFound identically — an answer that
 * distinguished them would tell a caller holding a stranger's id that the
 * conversation exists.
 * @param conversationId - Conversation id as supplied by the client
 * @param userId - The signed-in user
 * @param projectId - Project the request claims to be in
 * @param title - The new name, already trimmed and length-checked at the edge
 * @returns The conversation as it now stands
 * @throws {NotFoundError} if it is missing, deleted, owned by someone else, or
 *   belongs to a different project
 */
export async function rename(
  conversationId: string,
  userId: string,
  projectId: string,
  title: string,
): Promise<ConversationEntity> {
  const conversation = await assertWritable(conversationId, userId, projectId);
  await conversationRepo.updateTitle(conversationId, title);
  return { ...conversation, title };
}

/**
 * Read the page of a conversation that comes before the one in hand.
 * @param conversationId - Conversation UUID
 * @param userId - Requesting user UUID
 * @param beforeTurn - The oldest turn the caller already has
 * @returns That page, oldest first, and whether anything is older still
 * @throws {NotFoundError} if the conversation does not exist
 * @throws {ForbiddenError} if userId does not match the conversation owner
 */
export async function getEarlierMessages(
  conversationId: string,
  userId: string,
  beforeTurn: number,
): Promise<messageRepo.MessagePage> {
  await validateOwnership(conversationId, userId);
  return messageRepo.getMessages(conversationId, { beforeTurn });
}

/**
 * Check that a client-supplied conversation id may be written to here.
 *
 * The id arrives from outside now, so three things have to hold before a
 * message is appended: the conversation belongs to this user, it lives in this
 * project, and it still exists. The third is not an edge case — one tab holds
 * an id while the user deletes that conversation from another, and the first
 * two checks pass for it.
 *
 * All three answer NotFound, and they answer it identically on purpose: three
 * distinguishable answers would make the status code itself report which check
 * failed, so a caller holding a stranger's id could read "this one exists, it
 * is simply not yours" straight off the response.
 * @param conversationId - Conversation id as supplied by the client
 * @param userId - The signed-in user
 * @param projectId - Project the request claims to be in
 * @returns The conversation, once it has passed all three checks
 * @throws {NotFoundError} if it is missing, deleted, owned by someone else, or
 *   belongs to a different project
 */
export async function assertWritable(
  conversationId: string,
  userId: string,
  projectId: string,
): Promise<ConversationEntity> {
  const conversation = await conversationRepo.getConversation(conversationId);
  if (
    !conversation ||
    conversation.userId !== userId ||
    conversation.projectId !== projectId
  ) {
    throw new NotFoundError(t("server.error.not_found"));
  }
  return conversation;
}

/**
 * List conversations for a user, ordered by most recently updated.
 * @param userId - Owner user UUID
 * @param opts - Optional project scope and pagination window
 * @param opts.projectId - Optional project scope; when set, returns only
 *   conversations belonging to that project.
 * @param opts.limit - Maximum number of results (default 50)
 * @param opts.offset - Pagination offset (default 0)
 * @returns Array of conversation entities
 */
export async function list(
  userId: string,
  opts: { projectId?: string; limit?: number; offset?: number } = {},
): Promise<ConversationEntity[]> {
  return conversationRepo.listConversations(userId, opts);
}

/**
 * Fetch a conversation with the newest page of its message history.
 *
 * This is how switching conversations loads the one being switched into, so it
 * answers the same three things `/chat/open` does about its current
 * conversation — the page and whether anything comes before it. `hasMore` was
 * being read out of the repository and then dropped here, which left the panel
 * it landed in unable to know whether "load earlier" had anything to load.
 * @param conversationId - Conversation UUID
 * @param userId - Requesting user UUID
 * @returns The conversation, its newest page, and whether it reaches further
 * @throws {NotFoundError} if conversation does not exist
 * @throws {ForbiddenError} if userId does not match the conversation owner
 */
export async function getWithMessages(
  conversationId: string,
  userId: string,
): Promise<{
  conversation: ConversationEntity;
  messages: MessageData[];
  hasMore: boolean;
}> {
  const conversation = await validateOwnership(conversationId, userId);
  const page = await messageRepo.getMessages(conversationId);
  return { conversation, messages: page.messages, hasMore: page.hasMore };
}

/**
 * Fetch a conversation by id without an ownership check.
 *
 * Thin pass-through to the conversation repository so route handlers
 * reach the data layer through the service (prohibition #1). Callers
 * that need a tenancy guard must use {@link assertAccess} /
 * {@link getWithMessages} instead.
 * @param id - Conversation UUID
 * @returns The conversation entity, or null if not found / soft-deleted
 */
export async function getConversation(
  id: string,
): Promise<ConversationEntity | null> {
  return conversationRepo.getConversation(id);
}

/**
 * Get a conversation's messages formatted for LLM context.
 *
 * Thin pass-through to the conversation repository so route handlers
 * reach the data layer through the service (prohibition #1). Skips
 * already-consolidated turns and drops the flat `thinking` field, which is
 * only a view of the reasoning parts and would otherwise be read twice.
 * @param id - Conversation UUID
 * @param lastConsolidatedTurn - Turn index up to which messages are consolidated
 * @param beforeTurn - Stop short of this turn. The turn being run is not its
 *   own history: its message goes in front of the model separately, so a copy
 *   here would ask the same question twice — and would be a candidate for
 *   compression, which could shorten the very thing being asked.
 * @returns Messages from turns after the consolidated boundary
 */
export async function getMessagesForLlm(
  id: string,
  lastConsolidatedTurn = 0,
  beforeTurn?: number,
): Promise<MessageData[]> {
  return messageRepo.getMessagesForLlm(id, lastConsolidatedTurn, beforeTurn);
}

/**
 * Soft-delete a conversation after validating ownership.
 *
 * Stamps `deleted_at` on the conversation and, because the FKs are RESTRICT
 * and Postgres will not cascade, on its messages, attachments and memory
 * rows as well.
 * @param conversationId - Conversation UUID
 * @param userId - Requesting user UUID
 * @throws {NotFoundError} if conversation does not exist
 * @throws {ForbiddenError} if userId does not match the conversation owner
 */
export async function deleteConversation(
  conversationId: string,
  userId: string,
): Promise<void> {
  await validateOwnership(conversationId, userId);
  await conversationRepo.softDeleteConversation(conversationId);
}
