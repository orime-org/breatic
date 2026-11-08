// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The links one turn's `web_fetch` may read: every link the conversation
 * holds, from the places listed in the design and nowhere else (inner#1664).
 */
import type { ModelMessage } from "ai";

import type { ReplayRow } from "@server/agent/history-replay.js";

/** The turn's set of links. */
export interface PageLinks {
  /** Note the links one stored row holds. */
  addRow(row: ReplayRow): void;
  /** Note the links the message sent to the model this turn holds. */
  addUserMessage(message: ModelMessage): void;
  /** Note the links one tool result of this turn holds. */
  addToolResult(toolName: string, output: unknown): void;
  /** Whether a link is in the set. */
  allows(url: string): boolean;
}

/**
 * An empty set.
 * @returns The set.
 * @throws {Error} Always, until implemented.
 */
export function makePageLinks(): PageLinks {
  throw new Error("not implemented: makePageLinks");
}

/**
 * The set holding every link of the conversation's rows before `upTo`.
 * @param conversationId - The conversation.
 * @param upTo - The turn to stop short of, as the turn's history reads it.
 * @returns The set.
 * @throws {Error} Always, until implemented.
 */
export async function pageLinksForTurn(conversationId: string, upTo: number): Promise<PageLinks> {
  void [conversationId, upTo];
  throw new Error("not implemented: pageLinksForTurn");
}
