// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * What each tool of one turn is handed through the SDK's tool context.
 *
 * The context is keyed by tool, and each tool's `contextSchema` reads its own
 * entry, so one entry carries everything that tool needs: every tool keeps
 * the turn's usage recorder, and the ones that need something of the turn
 * carry it in the shape they use: the save and the canvas proposal the
 * project (inner#1315), the document proposal the open document (inner#1509),
 * the record tools the user's records (inner#1469), the memory tools the
 * user's memory (#1363), and the page read its rate-limited reader (inner#1664).
 */

import type { ChatSpaceContext } from "@breatic/shared";
import { canonicalMediaSourceFor } from "@server/agent/canonical-media-source.js";
import {
  PROPOSE_CANVAS_ACTION,
  PROPOSE_DOCUMENT_EDIT,
  RECORD_TOOL_NAMES,
  MEMORY_TOOL_NAMES,
  SAVE_IMAGE,
  UNDERSTAND_MEDIA,
  WEB_FETCH,
  usageContextFor,
  type OpenDocument,
  type AgentMemory,
  type ProjectRecords,
  type ReadPages,
  type SaveToStorage,
} from "@breatic/domain";

type UsageRecorder = Parameters<typeof usageContextFor>[1];

/**
 * The context for one turn's tool set.
 * @param tools - The tool set the call runs with.
 * @param usage - The turn's recorder.
 * @param turn - What this turn's project lends its tools.
 * @param turn.saveToStorage - How a found picture is stored for this project and user.
 * @param turn.studioId - The studio whose material a proposal may name.
 * @param turn.projectId - The project owning the long-media operation, when supplied.
 * @param turn.actorUserId - The user who owns the long-media operation, when supplied.
 * @param turn.openDocument - The document the user has open, which a
 *   document proposal goes to, or null when none can be read.
 * @param turn.records - The user's records this turn may read (inner#1469).
 * @param turn.memory - The user's memory this turn may write and read (#1363).
 * @param turn.readPages - How this turn's page reads are rate limited and sent (inner#1664).
 * @returns The context, by tool name.
 * @throws {never} Never.
 */
export function turnToolsContext(
  tools: Readonly<Record<string, unknown>>,
  usage: UsageRecorder,
  turn: {
    saveToStorage: SaveToStorage;
    studioId: string;
    projectId?: string;
    actorUserId?: string;
    openDocument: OpenDocument | null;
    records: ProjectRecords;
    memory: AgentMemory;
    readPages: ReadPages;
  },
): Record<string, Record<string, unknown>> {
  const context: Record<string, Record<string, unknown>> = { ...usageContextFor(tools, usage) };
  if (context[SAVE_IMAGE]) context[SAVE_IMAGE] = { ...context[SAVE_IMAGE], saveToStorage: turn.saveToStorage };
  if (context[WEB_FETCH]) context[WEB_FETCH] = { ...context[WEB_FETCH], readPages: turn.readPages };
  if (context[UNDERSTAND_MEDIA]) {
    context[UNDERSTAND_MEDIA] = {
      ...context[UNDERSTAND_MEDIA],
      saveToStorage: turn.saveToStorage,
      studioId: turn.studioId,
      ...(turn.projectId ? { projectId: turn.projectId } : {}),
      ...(turn.actorUserId ? { actorUserId: turn.actorUserId } : {}),
      resolveCanonicalMediaSource: (url: string) => canonicalMediaSourceFor(url, turn.studioId),
    };
  }
  if (context[PROPOSE_CANVAS_ACTION]) {
    context[PROPOSE_CANVAS_ACTION] = { ...context[PROPOSE_CANVAS_ACTION], studioId: turn.studioId };
  }
  if (context[PROPOSE_DOCUMENT_EDIT]) {
    context[PROPOSE_DOCUMENT_EDIT] = { ...context[PROPOSE_DOCUMENT_EDIT], openDocument: turn.openDocument };
  }
  for (const name of RECORD_TOOL_NAMES) {
    if (context[name]) context[name] = { ...context[name], records: turn.records };
  }
  for (const name of MEMORY_TOOL_NAMES) {
    if (context[name]) context[name] = { ...context[name], memory: turn.memory };
  }
  return context;
}

/**
 * The document the user has open this turn, as a document proposal reads
 * it (inner#1509): a loaded document Space and the blocks its browser sent.
 * @param space - The user's Spaces as the message carries them.
 * @returns The document, or null when the open Space is not a loaded document.
 * @throws {never} Never.
 */
export function openDocumentOf(space: ChatSpaceContext): OpenDocument | null {
  const open = space.current_space;
  if (open?.state !== "loaded" || open.kind !== "document" || open.blocks === undefined) return null;
  return { spaceId: open.id, spaceName: open.name, blocks: open.blocks };
}
