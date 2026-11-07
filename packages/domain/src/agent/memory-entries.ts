// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The Agent's memory as the memory tools see it (#1363): one fact per entry,
 * scoped to the member's Project or to one conversation.
 *
 * The writes and reads are the server's. It builds one `AgentMemory` per
 * turn, bound to the turn's user, Project and conversation, and hands it to
 * the tools through the tool context; the model only ever names an entry id
 * and the words to look for.
 */

import { z } from "zod";
import { MEMORY_CONTENT_MAX_CHARS, MEMORY_TITLE_MAX_CHARS } from "@breatic/core";

/**
 * How many characters a text holds, counted the way the limits are: by code
 * point, so an emoji is one.
 * @param text - The text.
 * @returns Its length in characters.
 * @throws {never} Never.
 */
export function countCharacters(text: string): number {
  return [...text].length;
}

/** An entry's title, as the memory tools and a consolidation answer are held to it. */
export const memoryTitle = z
  .string()
  .trim()
  .min(1, "must not be empty")
  .refine((t) => countCharacters(t) <= MEMORY_TITLE_MAX_CHARS, `must be at most ${String(MEMORY_TITLE_MAX_CHARS)} characters`)
  .refine((t) => !/[\r\n\u2028\u2029]/.test(t), "must be one line");

/** An entry's content, as the memory tools and a consolidation answer are held to it. */
export const memoryContent = z
  .string()
  .trim()
  .min(1, "must not be empty")
  .refine((c) => countCharacters(c) <= MEMORY_CONTENT_MAX_CHARS, `must be at most ${String(MEMORY_CONTENT_MAX_CHARS)} characters`);

/** Where an entry is read: every conversation of the member's in the Project, or one conversation. */
export type MemoryScope = "project" | "conversation";

/** Who wrote an entry. */
export type MemoryOrigin = "agent" | "consolidation" | "migration";

/** One entry, in full. */
export interface MemoryEntry {
  id: string;
  scope: MemoryScope;
  title: string;
  content: string;
  origin: MemoryOrigin;
  /** The conversation it was written in; null for an entry migrated from a Project block. */
  sourceConversationId: string | null;
  /** When it last changed, as an ISO string. */
  updatedAt: string;
}

/** A page of entries found by words, newest first. */
export interface MemorySearchPage {
  items: MemoryEntry[];
  nextCursor: string | null;
}

/** What one turn lends the memory tools. */
export interface AgentMemory {
  /**
   * Add an entry, or replace the one named.
   * @param input - The entry.
   * @param input.id - The entry it replaces; absent, a new entry is added.
   * @param input.scope - Where it is read.
   * @param input.title - Its one-line title.
   * @param input.content - What it holds.
   * @throws {MemoryRefused} `unknown_entry` or `deleted` for an id that cannot be replaced.
   */
  save(input: { id?: string; scope: MemoryScope; title: string; content: string }): Promise<MemoryEntry>;
  /**
   * Delete the entry named.
   * @param id - The entry.
   * @throws {MemoryRefused} `unknown_entry` or `deleted`.
   */
  remove(id: string): Promise<MemoryEntry>;
  /**
   * Read the entries named, in full, in the order named; ids that are not
   * this member's live entries here are left out.
   * @param ids - The entries.
   */
  read(ids: string[]): Promise<MemoryEntry[]>;
  /**
   * Find entries whose title or content holds the words, as written.
   * @param query - The words.
   * @param cursor - Where the previous page stopped.
   * @throws {MemoryRefused} `bad_cursor` when the cursor is not one a page gave.
   */
  search(query: string, cursor?: string): Promise<MemorySearchPage>;
}

/** Why a memory call was refused. */
export type MemoryRefusalKind = "unknown_entry" | "deleted" | "not_member" | "bad_cursor";

/** A memory call the server refused, by kind. */
export class MemoryRefused extends Error {
  /**
   * A refusal of one kind.
   * @param kind - Why it was refused.
   * @param id - The entry it was about, when there was one.
   * @throws {never} Never.
   */
  constructor(
    readonly kind: MemoryRefusalKind,
    readonly id?: string,
  ) {
    super(kind);
    this.name = "MemoryRefused";
  }
}

/** What each memory tool is handed in its context. */
export interface MemoryToolContext extends Record<string, unknown> {
  memory: AgentMemory;
}
