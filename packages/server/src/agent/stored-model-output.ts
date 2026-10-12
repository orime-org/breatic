// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type { Tool } from "ai";
import type { MessagePart } from "@breatic/shared";

export const EARLIER_RESULT_NOTE = "";

/**
 * Stub.
 * @param parts - Parts.
 * @param _tools - Tools.
 * @param _context - Context.
 * @param _context.conversationId - Conversation.
 * @returns Parts.
 */
export async function withModelOutputs(
  parts: readonly MessagePart[],
  _tools: Readonly<Record<string, Tool>>,
  _context: { conversationId: string },
): Promise<MessagePart[]> {
  return [...parts];
}
