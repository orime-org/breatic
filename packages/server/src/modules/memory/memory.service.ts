// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Memory service — the Agent's memory entries and each conversation's
 * progress note (#1363).
 *
 * Reads what a turn's system prompt carries, what a consolidation is shown,
 * and writes what a consolidation produced. All of it is the member's own:
 * nothing one person's Agent kept reaches another's prompt.
 */

import * as memoryRepo from "@server/modules/memory/memory.repo.js";
import * as conversationRepo from "@server/modules/conversation/conversation.repo.js";
import type { MemoryScopeKey } from "@server/modules/memory/memory.repo.js";
import { db, getAgentConfig } from "@breatic/core";
import { countCharacters, type MemoryEntry, type MemoryScope } from "@breatic/domain";
import type { AgentMemoryEntity, MemoryContext } from "@breatic/shared";

/**
 * One row as the memory tools and the consolidation read it.
 * @param entity - The row.
 * @returns The entry.
 * @throws {never} Never.
 */
export function toMemoryEntry(entity: AgentMemoryEntity): MemoryEntry {
  return {
    id: entity.id,
    scope: entity.conversationId === null ? "project" : "conversation",
    title: entity.title,
    content: entity.content,
    origin: entity.origin,
    sourceConversationId: entity.sourceConversationId,
    updatedAt: entity.updatedAt.toISOString(),
  };
}

/**
 * Assemble a turn's memory for its system prompt: the index of the entries it
 * sees and the conversation's progress note.
 *
 * All three ids are required: the entries are keyed by the member and the
 * Project together, and by the conversation for its own ones; a missing one
 * is not a smaller context, it is a set that comes back empty with nothing
 * saying so.
 * @param userId - Whose memory to read.
 * @param conversationId - The conversation being spoken in.
 * @param projectId - The project it belongs to.
 * @returns The memory the turn carries.
 */
export async function buildContext(
  userId: string,
  conversationId: string,
  projectId: string,
): Promise<MemoryContext> {
  const config = getAgentConfig();
  // Together: neither read is an input to the other, and this sits on the
  // path of every turn, in front of a reader waiting for the first word.
  const [index, progress] = await Promise.all([
    memoryRepo.listIndex({ userId, projectId, conversationId }, config.memory_index_max_entries),
    memoryRepo.getProgress(conversationId),
  ]);
  return { ...index, progress };
}

/** What one consolidation is shown of the memory it may change. */
export interface ConsolidationInput {
  /** Shown in full, so it may update or delete them: migrated blocks first, then newest first. */
  full: MemoryEntry[];
  /** Shown by id and title only, past the character bound; it may not change them. */
  titlesOnly: Array<{ id: string; title: string; scope: MemoryScope }>;
  /** The conversation's progress note as it stands. */
  progress: string;
}

/**
 * What a consolidation is shown: every entry the turn sees, the migrated
 * blocks and the newest in full while their content stays within the bound,
 * the rest by title.
 * @param scope - Whose and where.
 * @param maxChars - How many characters of content it is shown in full.
 * @returns The input.
 */
export async function consolidationInput(scope: MemoryScopeKey, maxChars: number): Promise<ConsolidationInput> {
  const [entries, progress] = await Promise.all([
    memoryRepo.listVisible(scope),
    memoryRepo.getProgress(scope.conversationId),
  ]);
  const full: MemoryEntry[] = [];
  const titlesOnly: ConsolidationInput["titlesOnly"] = [];
  let used = 0;
  for (const entity of entries) {
    const entry = toMemoryEntry(entity);
    used += countCharacters(entry.content);
    // A migrated block is always shown whole: it is there to be split, and a
    // consolidation that sees only its title cannot.
    if (entity.origin === "migration" || (titlesOnly.length === 0 && used <= maxChars)) full.push(entry);
    else titlesOnly.push({ id: entry.id, title: entry.title, scope: entry.scope });
  }
  return { full, titlesOnly, progress };
}

/** One change a consolidation makes to a single entry. */
export type MemoryOperation =
  | { op: "add"; scope: MemoryScope; title: string; content: string }
  | { op: "update"; id: string; title: string; content: string }
  | { op: "delete"; id: string };

/** One consolidation's results, and the watermark they cover. */
export interface ConsolidationCommit extends MemoryScopeKey {
  /** The entries the consolidation was shown in full, as it read them. */
  shown: ReadonlyArray<{ id: string; scope: MemoryScope; title: string; content: string }>;
  /** The watermark the consolidation read. */
  watermarkBefore: number;
  /** The turn the window ended on. */
  newWatermark: number;
  /** The progress note, replacing the one there. */
  progress: string;
  /** The changes to entries, checked against what the consolidation was shown. */
  operations: readonly MemoryOperation[];
}

/**
 * Write one consolidation, or nothing at all.
 *
 * The entries, the progress note and the watermark go in one transaction
 * because the invariant that makes the watermark meaningful spans all of
 * them: everything under it is in memory. Written separately, a crash between
 * them leaves turns that are in neither.
 *
 * The watermark moves first, and only from where the consolidation read it.
 * Two tabs on one conversation fold from the same watermark, and the second
 * would add the same facts again; finding the watermark moved is that answer,
 * and it costs the caller a reassembly rather than any data.
 *
 * An entry is changed or deleted only while it still holds what the
 * consolidation was shown, scope included. A Project entry another
 * conversation changed, moved or deleted while the fold ran fails the whole
 * write, so the next fold reads it as it now is.
 * @param commit - The results and the watermark they cover.
 * @returns Whether this call's memory landed.
 * @throws {Error} When a write fails, or an entry it changes no longer holds
 *   what it was shown; nothing is written then.
 */
export async function commitConsolidation(commit: ConsolidationCommit): Promise<"written" | "superseded"> {
  const { userId, projectId, conversationId, shown, watermarkBefore, newWatermark, progress, operations } = commit;
  const read = new Map(
    shown.map((entry) => [
      entry.id,
      { title: entry.title, content: entry.content, conversationId: entry.scope === "conversation" ? conversationId : null },
    ]),
  );
  return db.transaction(async (tx) => {
    const moved = await conversationRepo.advanceConsolidatedTurn(conversationId, watermarkBefore, newWatermark, tx);
    if (!moved) return "superseded";

    await memoryRepo.upsertProgress(conversationId, progress, tx);
    for (const operation of operations) {
      if (operation.op === "add") {
        await memoryRepo.insertEntry(
          {
            userId,
            projectId,
            conversationId: operation.scope === "conversation" ? conversationId : null,
            sourceConversationId: conversationId,
            title: operation.title,
            content: operation.content,
            origin: "consolidation",
          },
          tx,
        );
        continue;
      }
      const was = read.get(operation.id);
      const done =
        was === undefined
          ? null
          : operation.op === "update"
            ? await memoryRepo.updateEntry(operation.id, { title: operation.title, content: operation.content }, tx, was)
            : await memoryRepo.softDeleteEntry(operation.id, tx, was);
      if (done === null) throw new Error(`memory entry ${operation.id} changed after the consolidation read it`);
    }
    return "written";
  });
}
