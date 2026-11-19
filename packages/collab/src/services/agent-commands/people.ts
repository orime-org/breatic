// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Who is in a Space right now and what they have on screen, as the external
 * agent's reads report it (breatic#1488 §7, §11.4), from the members' last
 * views (`last-view-cache.ts`).
 */

import * as Y from "yjs";
import type { AgentCommand } from "@breatic/shared";
import type { LastView } from "@collab/services/last-view-cache.js";

/** The block container element of a BlockNote body. */
const BLOCK_CONTAINER = "blockContainer";

/**
 * The views of a command's Space.
 * @param views - Every live view in the Project.
 * @param command - The command.
 * @returns The views of its Space.
 */
function viewsOfSpace(views: readonly LastView[], command: AgentCommand): LastView[] {
  return views.filter((view) => view.spaceId === command.spaceId);
}

/**
 * What the command's user has on screen in its Space.
 * @param views - Every live view in the Project.
 * @param command - The command.
 * @returns The view, or undefined when the user is not looking at this Space.
 */
export function ownerView(views: readonly LastView[], command: AgentCommand): LastView | undefined {
  return viewsOfSpace(views, command).find((view) => view.userId === command.userId);
}

/** One member on a canvas. */
export interface CanvasPerson {
  userId: string;
  /** The command's own user. */
  you: boolean;
  selectedNodeIds: string[];
  pointer: { x: number; y: number } | null;
}

/**
 * The members on the command's canvas.
 * @param views - Every live view in the Project.
 * @param command - The command.
 * @returns Who is there, what they hold and where their pointer is.
 */
export function canvasPeople(views: readonly LastView[], command: AgentCommand): CanvasPerson[] {
  return viewsOfSpace(views, command).map((view) => ({
    userId: view.userId,
    you: view.userId === command.userId,
    selectedNodeIds: view.activeNodeIds ?? [],
    pointer: view.pointer,
  }));
}

/** One member in a document. */
export interface DocumentPerson {
  userId: string;
  you: boolean;
  /** The block their caret is in, or null when it no longer resolves. */
  blockId: string | null;
  /** The words they select within one text run, "" for a caret, null across runs or when unresolved. */
  selectedText: string | null;
}

/**
 * Where a y-prosemirror relative position lands now.
 * @param doc - The document.
 * @param json - The position as the caret carried it.
 * @returns The type and index, or null when its item is gone.
 */
function landing(doc: Y.Doc, json: Record<string, unknown>): Y.AbsolutePosition | null {
  try {
    return Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(json), doc);
  } catch {
    // An item this document never had: the caret belongs to a state it no longer holds.
    return null;
  }
}

/**
 * The block a position is inside.
 * @param type - The type the position landed in.
 * @returns The block's id, or null when it sits in none.
 */
function blockIdOf(type: Y.AbstractType<unknown>): string | null {
  for (let at: Y.AbstractType<unknown> | null = type; at; at = at.parent as Y.AbstractType<unknown> | null) {
    if (at instanceof Y.XmlElement && at.nodeName === BLOCK_CONTAINER) {
      const id = at.getAttribute("id");
      return typeof id === "string" ? id : null;
    }
  }
  return null;
}

/**
 * The plain text of a text run.
 * @param text - The run.
 * @returns Its characters; embeds count as none.
 */
function plainText(text: Y.XmlText): string {
  return (text.toDelta() as Array<{ insert?: unknown }>).map((op) => (typeof op.insert === "string" ? op.insert : "")).join("");
}

/**
 * The members in the command's document, with the block each caret is in
 * and the words it selects.
 * @param doc - The document Space's document.
 * @param views - Every live view in the Project.
 * @param command - The command.
 * @returns Who is there.
 */
export function documentPeople(doc: Y.Doc, views: readonly LastView[], command: AgentCommand): DocumentPerson[] {
  return viewsOfSpace(views, command).map((view) => {
    const anchor = view.cursor ? landing(doc, view.cursor.anchor) : null;
    const head = view.cursor ? landing(doc, view.cursor.head) : null;
    const sameRun = anchor !== null && head !== null && anchor.type === head.type && anchor.type instanceof Y.XmlText;
    return {
      userId: view.userId,
      you: view.userId === command.userId,
      blockId: head ? blockIdOf(head.type) : null,
      selectedText: sameRun
        ? plainText(anchor.type as Y.XmlText).slice(Math.min(anchor.index, head.index), Math.max(anchor.index, head.index))
        : null,
    };
  });
}
