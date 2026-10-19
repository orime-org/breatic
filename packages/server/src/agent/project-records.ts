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

import {
  decodeActivityCursor,
  encodeActivityCursor,
  ForbiddenError,
  getAgentConfig,
  NotFoundError,
  type ActivityCursor,
} from "@breatic/core";
import { nodeHistoryService, nodeTaskService, RecordsRefused, type ProjectRecords } from "@breatic/domain";
import type { ChatSpace, ConversationEntity } from "@breatic/shared";
import { projectService, studioService } from "@server/modules";
import { countProjectActivities, listProjectActivities } from "@server/modules/activity/projectActivity.service.js";
import * as conversationRepo from "@server/modules/conversation/conversation.repo.js";
import * as messageRepo from "@server/modules/conversation/conversation-message.repo.js";

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

  /**
   * A cursor read back, or undefined for the first page.
   * @param cursor - The cursor the model passed.
   * @returns The position after which the page starts.
   * @throws {RecordsRefused} `bad_cursor` when a cursor is given that no page gave.
   */
  const after = (cursor: string | undefined): ActivityCursor | undefined => {
    if (cursor === undefined) return undefined;
    const decoded = decodeActivityCursor(cursor);
    if (decoded === null) throw new RecordsRefused("bad_cursor");
    return decoded;
  };

  return {
    async listConversations(cursor) {
      await member();
      const from = after(cursor);
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
        nextCursor: page.hasMore && last ? encodeActivityCursor(last.cursorAt, last.conversation.id) : null,
      };
    },

    async searchMessages(terms, opts) {
      await member();
      if (opts.conversationId !== undefined) await own(opts.conversationId);
      const from = after(opts.cursor);
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
        hits: page.rows.map(({ id: _id, cursorAt: _at, ...hit }) => hit),
        total: page.total,
        nextCursor: page.hasMore && last ? encodeActivityCursor(last.cursorAt, last.id) : null,
      };
    },

    async readConversation(id, range) {
      await member();
      const conversation = await own(id ?? conversationId);
      const fromTurn = range.fromTurn ?? 1;
      // A page of turns at most: the tool cuts it further to what fits.
      const toTurn = Math.min(range.toTurn ?? Number.MAX_SAFE_INTEGER, fromTurn + pageSize() - 1);
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
      // Checked here: the feed's own decoder reads a cursor it cannot decode as the first page.
      after(opts.cursor);
      let only: { spaceIds?: string[] } = {};
      if (opts.spaceName !== undefined) {
        const spaceIds = turn.spaces.filter((space) => space.name === opts.spaceName).map((space) => space.id);
        if (spaceIds.length === 0) throw new RecordsRefused("unknown_space");
        only = { spaceIds };
      }
      const [page, total] = await Promise.all([
        listProjectActivities(projectId, opts.cursor, undefined, only),
        countProjectActivities(projectId, only),
      ]);
      return { items: page.items, total, nextCursor: page.nextCursor };
    },

    spaceName(spaceId) {
      return turn.spaces.find((space) => space.id === spaceId)?.name;
    },
  };
}
