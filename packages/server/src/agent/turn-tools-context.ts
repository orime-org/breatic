// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What each tool of one turn is handed through the SDK's tool context.
 *
 * The context is keyed by tool, and each tool's `contextSchema` reads its own
 * entry, so one entry carries everything that tool needs: every tool keeps
 * the turn's usage recorder, and the two that need the turn's project carry
 * it in the shape they use (inner#1315).
 */

import { PROPOSE_CANVAS_ACTION, SAVE_IMAGE, usageContextFor, type SaveToStorage } from "@breatic/domain";

type UsageRecorder = Parameters<typeof usageContextFor>[1];

/**
 * The context for one turn's tool set.
 * @param tools - The tool set the call runs with.
 * @param usage - The turn's recorder.
 * @param turn - What this turn's project lends its tools.
 * @param turn.saveToStorage - How a found picture is stored for this project and reader.
 * @param turn.studioId - The studio whose material a proposal may name.
 * @returns The context, by tool name.
 * @throws {never} Never.
 */
export function turnToolsContext(
  tools: Readonly<Record<string, unknown>>,
  usage: UsageRecorder,
  turn: { saveToStorage: SaveToStorage; studioId: string },
): Record<string, Record<string, unknown>> {
  const context: Record<string, Record<string, unknown>> = { ...usageContextFor(tools, usage) };
  if (context[SAVE_IMAGE]) context[SAVE_IMAGE] = { ...context[SAVE_IMAGE], saveToStorage: turn.saveToStorage };
  if (context[PROPOSE_CANVAS_ACTION]) {
    context[PROPOSE_CANVAS_ACTION] = { ...context[PROPOSE_CANVAS_ACTION], studioId: turn.studioId };
  }
  return context;
}
