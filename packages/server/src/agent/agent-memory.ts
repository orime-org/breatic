// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The memory one turn lends the Agent's memory tools (#1363).
 *
 * Bound to the turn's user, Project and conversation, all from the server's
 * own state for the turn; the model only names an entry id and the words to
 * look for. Every call checks first that the user is still a member of the
 * Project, and an id the model names must be the user's own entry, of this
 * Project or of this conversation.
 */

import { createHash } from "node:crypto";

import { ForbiddenError, getAgentConfig, NotFoundError } from "@breatic/core";
import { MemoryRefused, type AgentMemory } from "@breatic/domain";
import type { AgentMemoryEntity } from "@breatic/shared";
import { projectService } from "@server/modules";
import * as memoryRepo from "@server/modules/memory/memory.repo.js";
import { toMemoryEntry } from "@server/modules/memory/memory.service.js";

/** What the memory is bound to: this turn, as the server holds it. */
export interface MemoryTurn {
  userId: string;
  projectId: string;
  /** The conversation the turn runs in. */
  conversationId: string;
}

/**
 * What a search's cursors start with: a short hash of its words, so a cursor
 * passed back with other words is refused rather than read as a position.
 * @param query - The words.
 * @returns The prefix.
 * @throws {never} Never.
 */
function cursorPrefix(query: string): string {
  return `memory.${createHash("sha256").update(query).digest("hex").slice(0, 12)}.`;
}

/**
 * The memory for one turn.
 * @param turn - The turn it is bound to.
 * @returns The calls.
 * @throws {never} Never; the calls it returns throw.
 */
export function agentMemoryFor(turn: MemoryTurn): AgentMemory {
  const { userId, projectId, conversationId } = turn;
  const scope = { userId, projectId, conversationId };

  /**
   * Refuse every call once the user is not a member of the project.
   * @returns Nothing.
   * @throws {MemoryRefused} `not_member` when they are not.
   */
  const member = async (): Promise<void> => {
    try {
      await projectService.assertAccess(projectId, userId, "viewer");
    } catch (err) {
      if (err instanceof NotFoundError || err instanceof ForbiddenError) throw new MemoryRefused("not_member");
      throw err;
    }
  };

  /**
   * The user's live entry by this id, of this Project or this conversation.
   * @param id - The entry.
   * @returns It.
   * @throws {MemoryRefused} `unknown_entry` when it is not one of theirs here, `deleted` when it was deleted.
   */
  const own = async (id: string): Promise<AgentMemoryEntity> => {
    const found = await memoryRepo.findOwnEntry(userId, id);
    const here =
      found !== null &&
      (found.conversationId === null ? found.projectId === projectId : found.conversationId === conversationId);
    if (!here) throw new MemoryRefused("unknown_entry", id);
    if (found.deletedAt !== null) throw new MemoryRefused("deleted", id);
    return found;
  };

  return {
    async save({ id, scope: where, title, content }) {
      await member();
      const target = where === "conversation" ? conversationId : null;
      if (id === undefined) {
        return toMemoryEntry(
          await memoryRepo.insertEntry({
            userId,
            projectId,
            conversationId: target,
            sourceConversationId: conversationId,
            title,
            content,
            origin: "agent",
          }),
        );
      }
      await own(id);
      const updated = await memoryRepo.updateEntry(id, { title, content, conversationId: target });
      // Deleted between the check and the write, by another tab.
      if (updated === null) throw new MemoryRefused("deleted", id);
      return toMemoryEntry(updated);
    },

    async remove(id) {
      await member();
      await own(id);
      const removed = await memoryRepo.softDeleteEntry(id);
      if (removed === null) throw new MemoryRefused("deleted", id);
      return toMemoryEntry(removed);
    },

    async read(ids) {
      await member();
      const found = await memoryRepo.getVisible(scope, ids);
      const byId = new Map(found.map((e) => [e.id, e]));
      return ids.flatMap((id) => {
        const entity = byId.get(id);
        return entity === undefined ? [] : [toMemoryEntry(entity)];
      });
    },

    async search(query, cursor) {
      await member();
      const prefix = cursorPrefix(query);
      let offset = 0;
      if (cursor !== undefined) {
        const raw = cursor.startsWith(prefix) ? Number(cursor.slice(prefix.length)) : Number.NaN;
        if (!Number.isInteger(raw) || raw <= 0) throw new MemoryRefused("bad_cursor");
        offset = raw;
      }
      const limit = getAgentConfig().records_page_size;
      const page = await memoryRepo.searchVisible(scope, query, { offset, limit });
      return {
        items: page.items.map(toMemoryEntry),
        nextCursor: page.more ? `${prefix}${String(offset + limit)}` : null,
      };
    },
  };
}
