// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The records one turn lends the agent's record tools (inner#1469).
 *
 * Bound to the turn's user, project, conversation, turn index and Spaces, all
 * of which come from the server's own state for the turn; the model only
 * names a conversation, node or Space name and how far to page. Every read checks
 * first that the user is still a member of the project, and a conversation
 * the model names must be the user's own, in this project, and live. What
 * comes back is only what the user sees on screen.
 */

import { createHash } from "node:crypto";

import {
  decodeActivityCursor,
  encodeActivityCursor,
  ForbiddenError,
  getAgentConfig,
  NotFoundError,
  type ActivityCursor,
} from "@breatic/core";
import { MAX_TURN_INDEX, nodeHistoryService, nodeTaskService, RecordsRefused, type ProjectRecords } from "@breatic/domain";
import type { ChatSpace, ConversationEntity } from "@breatic/shared";
import { projectService, studioService } from "@server/modules";
import { countProjectActivities, listProjectActivities } from "@server/modules/activity/projectActivity.service.js";
import * as conversationRepo from "@server/modules/conversation/conversation.repo.js";
import * as messageRepo from "@server/modules/conversation/conversation-message.repo.js";

/**
 * What starts a cursor each list gives, so a cursor passed to another list is
 * refused rather than read as a position in it.
 */
const CURSOR_TAG = { conversations: "conv.", search: "search.", activity: "activity." } as const;

/** Which list a cursor belongs to. */
type CursorList = keyof typeof CURSOR_TAG;

/**
 * What a list's cursors start with. A search's carries a short hash of its
 * terms and conversation, the activity feed's one of its Space filter, so a
 * cursor passed back with another query or filter is refused rather than read
 * as a position in a list it never came from.
 * @param list - The list.
 * @param scope - The query or filter the list was read with; none for the conversation list.
 * @returns The prefix.
 * @throws {never} Never.
 */
function cursorPrefix(list: CursorList, scope?: unknown): string {
  if (scope === undefined) return CURSOR_TAG[list];
  const hash = createHash("sha256").update(JSON.stringify(scope)).digest("hex").slice(0, 12);
  return `${CURSOR_TAG[list]}${hash}.`;
}

/**
 * A cursor read back, or undefined for the first page.
 * @param prefix - What the list's cursors start with.
 * @param cursor - The cursor the model passed.
 * @returns The raw cursor and the position after which the page starts.
 * @throws {RecordsRefused} `bad_cursor` when a cursor is given that no page of this list, query or filter gave.
 */
function readCursor(prefix: string, cursor: string | undefined): { raw: string; after: ActivityCursor } | undefined {
  if (cursor === undefined) return undefined;
  if (!cursor.startsWith(prefix)) throw new RecordsRefused("bad_cursor");
  const raw = cursor.slice(prefix.length);
  const after = decodeActivityCursor(raw);
  if (after === null) throw new RecordsRefused("bad_cursor");
  return { raw, after };
}

/** What the records are bound to: this turn, as the server holds it. */
export interface RecordsTurn {
  userId: string;
  projectId: string;
  /** The conversation the turn runs in. */
  conversationId: string;
  /** The turn now running, which no read reaches. */
  turnIndex: number;
  /** The project's Spaces as this turn's message lists them. */
  spaces: readonly ChatSpace[];
}

/**
 * The records for one turn.
 * @param turn - The turn they are bound to.
 * @returns The reads.
 * @throws {never} Never; the reads it returns throw.
 */
export function projectRecordsFor(turn: RecordsTurn): ProjectRecords {
  const { userId, projectId, conversationId, turnIndex } = turn;

  /**
   * Refuse every read once the user is not a member of the project.
   * @returns Nothing.
   * @throws {RecordsRefused} `not_member` when they are not.
   */
  const member = async (): Promise<void> => {
    try {
      await projectService.assertAccess(projectId, userId, "viewer");
    } catch (err) {
      if (err instanceof NotFoundError || err instanceof ForbiddenError) throw new RecordsRefused("not_member");
      throw err;
    }
  };

  /**
   * A conversation, when it is the user's own, in this project, and live.
   * @param id - The conversation.
   * @returns It.
   * @throws {RecordsRefused} `unknown_conversation` when it is not.
   */
  const own = async (id: string): Promise<ConversationEntity> => {
    const found = await conversationRepo.getConversation(id);
    if (found === null || found.userId !== userId || found.projectId !== projectId) {
      throw new RecordsRefused("unknown_conversation");
    }
    return found;
  };

  /**
   * How many rows a page holds.
   * @returns The configured size.
   * @throws {never} Never.
   */
  const pageSize = (): number => getAgentConfig().records_page_size;

  return {
    async listConversations(cursor) {
      await member();
      const prefix = cursorPrefix("conversations");
      const from = readCursor(prefix, cursor)?.after;
      const [page, total] = await Promise.all([
        conversationRepo.listWithTurnCounts(userId, projectId, {
          limit: pageSize(),
          ...(from === undefined ? {} : { after: from }),
        }),
        conversationRepo.countInProject(userId, projectId),
      ]);
      const last = page.rows.at(-1);
      return {
        conversations: page.rows.map((r) => ({
          id: r.conversation.id,
          title: r.conversation.title,
          updatedAt: r.conversation.updatedAt.toISOString(),
          turns: r.turns,
          current: r.conversation.id === conversationId,
        })),
        total,
        nextCursor:
          page.hasMore && last ? `${prefix}${encodeActivityCursor(last.cursorAt, last.conversation.id)}` : null,
      };
    },

    async searchMessages(terms, opts) {
      await member();
      if (opts.conversationId !== undefined) await own(opts.conversationId);
      const prefix = cursorPrefix("search", { terms, conversationId: opts.conversationId ?? null });
      const from = readCursor(prefix, opts.cursor)?.after;
      const page = await messageRepo.searchMessages(
        {
          userId,
          projectId,
          currentConversationId: conversationId,
          turnIndex,
          ...(opts.conversationId === undefined ? {} : { conversationId: opts.conversationId }),
        },
        terms,
        { limit: pageSize(), ...(from === undefined ? {} : { after: from }) },
      );
      const last = page.rows.at(-1);
      return {
        hits: page.rows.map(({ id: _id, cursorAt: _at, ...hit }) => ({ ...hit, current: hit.conversationId === conversationId })),
        total: page.total,
        nextCursor: page.hasMore && last ? `${prefix}${encodeActivityCursor(last.cursorAt, last.id)}` : null,
      };
    },

    async readConversation(id, range) {
      await member();
      const conversation = await own(id ?? conversationId);
      const fromTurn = range.fromTurn ?? 1;
      // A page of turns at most, and no further than a turn index holds: the tool cuts it further to what fits.
      const toTurn = Math.min(range.toTurn ?? MAX_TURN_INDEX, fromTurn + pageSize() - 1);
      const read = await messageRepo.getTurns(conversation.id, {
        fromTurn,
        toTurn,
        ...(conversation.id === conversationId ? { beforeTurn: turnIndex } : {}),
      });
      return {
        conversationId: conversation.id,
        title: conversation.title,
        totalTurns: read.totalTurns,
        current: conversation.id === conversationId,
        messages: read.messages,
      };
    },

    async nodeRecords(nodeId, opts) {
      await member();
      const size = pageSize();
      const tasksOffset = opts.tasksOffset ?? 0;
      // Read only: the panel's harvest writes, and this is not the panel.
      const [tasks, versions] = await Promise.all([
        nodeTaskService.listLive({ projectId, nodeId }),
        nodeHistoryService.listByNode(projectId, nodeId, { limit: size, offset: opts.versionsOffset ?? 0 }),
      ]);
      const page = tasks.slice(tasksOffset, tasksOffset + size);
      const names = await studioService.getPersonalStudioIdentitiesByUserIds([
        ...new Set(page.map((task) => task.startedByUserId)),
      ]);
      return {
        tasks: {
          rows: page.map((task) => ({ ...task, startedByName: names.get(task.startedByUserId)?.name ?? null })),
          total: tasks.length,
        },
        versions: { rows: versions.entries, total: versions.total },
      };
    },

    async activity(opts) {
      await member();
      const prefix = cursorPrefix("activity", opts.spaceName ?? null);
      // Decoded here: the feed's own decoder reads a cursor it cannot decode as the first page.
      const raw = readCursor(prefix, opts.cursor)?.raw;
      let only: { spaceIds?: string[] } = {};
      if (opts.spaceName !== undefined) {
        const spaceIds = turn.spaces.filter((space) => space.name === opts.spaceName).map((space) => space.id);
        if (spaceIds.length === 0) throw new RecordsRefused("unknown_space");
        only = { spaceIds };
      }
      const [page, total] = await Promise.all([
        listProjectActivities(projectId, raw, undefined, only),
        countProjectActivities(projectId, only),
      ]);
      return { items: page.items, total, nextCursor: page.nextCursor === null ? null : `${prefix}${page.nextCursor}` };
    },

    spaceName(spaceId) {
      return turn.spaces.find((space) => space.id === spaceId)?.name;
    },
  };
}
