// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What each tool of one turn is handed through the SDK's tool context.
 *
 * The context is keyed by tool, and each tool's `contextSchema` reads its own
 * entry, so one entry carries everything that tool needs: every tool keeps
 * the turn's usage recorder, and the ones that need something of the turn
 * carry it in the shape they use: the save and the canvas proposal the
 * project (inner#1315), the document proposal the open document (inner#1509).
 */

import type { ChatSpaceContext } from "@breatic/shared";
import {
  PROPOSE_CANVAS_ACTION,
  PROPOSE_DOCUMENT_EDIT,
  SAVE_IMAGE,
  usageContextFor,
  type OpenDocument,
  type SaveToStorage,
} from "@breatic/domain";

type UsageRecorder = Parameters<typeof usageContextFor>[1];

/**
 * The context for one turn's tool set.
 * @param tools - The tool set the call runs with.
 * @param usage - The turn's recorder.
 * @param turn - What this turn's project lends its tools.
 * @param turn.saveToStorage - How a found picture is stored for this project and reader.
 * @param turn.studioId - The studio whose material a proposal may name.
 * @param turn.openDocument - The document the reader has open, which a
 *   document proposal goes to, or null when none can be read.
 * @returns The context, by tool name.
 * @throws {never} Never.
 */
export function turnToolsContext(
  tools: Readonly<Record<string, unknown>>,
  usage: UsageRecorder,
  turn: { saveToStorage: SaveToStorage; studioId: string; openDocument: OpenDocument | null },
): Record<string, Record<string, unknown>> {
  const context: Record<string, Record<string, unknown>> = { ...usageContextFor(tools, usage) };
  if (context[SAVE_IMAGE]) context[SAVE_IMAGE] = { ...context[SAVE_IMAGE], saveToStorage: turn.saveToStorage };
  if (context[PROPOSE_CANVAS_ACTION]) {
    context[PROPOSE_CANVAS_ACTION] = { ...context[PROPOSE_CANVAS_ACTION], studioId: turn.studioId };
  }
  if (context[PROPOSE_DOCUMENT_EDIT]) {
    context[PROPOSE_DOCUMENT_EDIT] = { ...context[PROPOSE_DOCUMENT_EDIT], openDocument: turn.openDocument };
  }
  return context;
}

/**
 * The document the reader has open this turn, as a document proposal reads
 * it (inner#1509): a loaded document Space and the blocks its browser sent.
 * @param space - The reader's Spaces as the message carries them.
 * @returns The document, or null when the open Space is not a loaded document.
 * @throws {never} Never.
 */
export function openDocumentOf(space: ChatSpaceContext): OpenDocument | null {
  const open = space.current_space;
  if (open?.state !== "loaded" || open.kind !== "document" || open.blocks === undefined) return null;
  return { spaceId: open.id, spaceName: open.name, blocks: open.blocks };
}
