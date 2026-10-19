// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What the four record tools read, as the server hands it to them for one
 * turn (inner#1469).
 *
 * The records are the user's own conversations in this project, the history
 * and tasks of a canvas node, and the project's activity feed. The server
 * builds one of these per turn, bound to the turn's user, project,
 * conversation, turn index and Spaces; the model only ever names a
 * conversation, node or Space id and how far to page. Each read checks that
 * the user is still a member of the project before it reads anything.
 */

import type { MessagePart, NodeHistoryEntity, ProjectActivityEntry } from "@breatic/shared";

import type { NodeTaskListRow } from "@domain/node-task/node-task.repo.js";

/** One of the user's conversations in this project. */
export interface ConversationSummary {
  id: string;
  /** Null while the conversation has no name of its own. */
  title: string | null;
  /** ISO instant of its last change. */
  updatedAt: string;
  /** How many turns it holds: the highest turn index in it. */
  turns: number;
  /** Whether it is the conversation this turn is running in. */
  current: boolean;
}

/** A page of the user's conversations, newest first. */
export interface ConversationListPage {
  conversations: ConversationSummary[];
  /** How many there are in all. */
  total: number;
  /** Where the next page starts; null on the last one. */
  nextCursor: string | null;
}

/** One message whose readable text holds every search term. */
export interface MessageHit {
  conversationId: string;
  conversationTitle: string | null;
  turnIndex: number;
  role: "user" | "assistant";
  /** ISO instant the message was written. */
  createdAt: string;
  /** The message's readable strings joined, which the terms matched. */
  body: string;
}

/** A page of hits, newest first. */
export interface MessageHitPage {
  hits: MessageHit[];
  /** How many messages match in all. */
  total: number;
  nextCursor: string | null;
}

/** One stored message of a conversation, in order. */
export interface StoredMessage {
  role: "user" | "assistant";
  turnIndex: number;
  /** ISO instant the message was written. */
  createdAt: string;
  parts: MessagePart[];
}

/** A run of whole turns of one conversation. */
export interface ConversationTurns {
  conversationId: string;
  title: string | null;
  /** The highest turn index the conversation holds, as far as it may be read. */
  totalTurns: number;
  /** Whether it is the conversation this turn is running in. */
  current: boolean;
  /** The messages of the turns asked for, in turn and position order. */
  messages: StoredMessage[];
}

/** A task on a node, with the name of who started it. */
export interface NodeTaskRecord extends NodeTaskListRow {
  /** The starter's display name; null when it cannot be resolved. */
  startedByName: string | null;
}

/** A node's tasks and versions, each a page of its own. */
export interface NodeRecords {
  tasks: { rows: NodeTaskRecord[]; total: number };
  versions: { rows: NodeHistoryEntity[]; total: number };
}

/** A page of the project's activity feed, newest first. */
export interface ActivityPage {
  items: ProjectActivityEntry[];
  total: number;
  nextCursor: string | null;
}

/** The reads one turn lends the record tools. */
export interface ProjectRecords {
  /**
   * The user's conversations in this project.
   * @param cursor - Where the previous page stopped.
   * @throws {RecordsRefused} `bad_cursor` when the cursor is not one a page gave.
   */
  listConversations(cursor?: string): Promise<ConversationListPage>;
  /**
   * Messages whose readable text holds every term, leaving out the turn now
   * running.
   * @param terms - The search words, each matched as a substring, ignoring case.
   * @param opts - Where to search.
   * @param opts.conversationId - One conversation to keep to.
   * @param opts.cursor - Where the previous page stopped.
   * @throws {RecordsRefused} `bad_cursor` when the cursor is not one a page gave.
   * @throws {RecordsRefused} `unknown_conversation` when the conversation named is not one of the user's here.
   */
  searchMessages(terms: string[], opts: { conversationId?: string; cursor?: string }): Promise<MessageHitPage>;
  /**
   * Whole turns of a conversation; the current one when none is named, read up
   * to the turn before this one.
   * @param conversationId - The conversation, or undefined for the current one.
   * @param range - Which turns.
   * @param range.fromTurn - The first turn wanted.
   * @param range.toTurn - The last turn wanted.
   * @throws {RecordsRefused} `unknown_conversation` when the conversation named is not one of the user's here.
   */
  readConversation(
    conversationId: string | undefined,
    range: { fromTurn?: number; toTurn?: number },
  ): Promise<ConversationTurns>;
  /**
   * A node's tasks and versions in this project.
   * @param nodeId - The node.
   * @param opts - Where each list's page starts.
   * @param opts.versionsOffset - The first version wanted.
   * @param opts.tasksOffset - The first task wanted.
   */
  nodeRecords(nodeId: string, opts: { versionsOffset?: number; tasksOffset?: number }): Promise<NodeRecords>;
  /**
   * The project's activity feed.
   * @param opts - What to read.
   * @param opts.spaceName - One Space to keep to, by the name this turn's
   *   message gives it; every Space of that name counts.
   * @param opts.cursor - Where the previous page stopped.
   * @throws {RecordsRefused} `bad_cursor` when the cursor is not one a page gave.
   * @throws {RecordsRefused} `unknown_space` when this turn's message names no Space so.
   */
  activity(opts: { spaceName?: string; cursor?: string }): Promise<ActivityPage>;
  /**
   * The name this turn's message gives a Space.
   * @param spaceId - The Space.
   * @returns Its name, or undefined when the message lists no such Space.
   */
  spaceName(spaceId: string): string | undefined;
}

/** Why a read was refused. */
export type RecordsRefusalKind = "not_member" | "unknown_conversation" | "unknown_space" | "bad_cursor";

/** A read the server refused, by kind. */
export class RecordsRefused extends Error {
  /**
   * A refusal of one kind.
   * @param kind - Why it was refused.
   * @throws {never} Never.
   */
  constructor(readonly kind: RecordsRefusalKind) {
    super(kind);
    this.name = "RecordsRefused";
  }
}

/** What each record tool is handed in its context. */
export interface RecordsContext extends Record<string, unknown> {
  records: ProjectRecords;
}
