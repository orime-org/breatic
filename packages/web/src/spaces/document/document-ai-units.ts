// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The text units of the AI output dialog (inner#1860, design §4.6, §5.1–§5.3):
 * every block of the original range that holds selected words is one unit.
 * The units are what is sent, what the answer is read back into, what the
 * preview shows and what replace writes over, all from one computation.
 */

import type { Node as ProseMirrorNode } from '@tiptap/pm/model';

import type { AiCommand } from '@web/spaces/document/document-ai-session';
import type { AiWriteResult } from '@web/spaces/document/document-ai-write';
import type { DocumentEditorHandle } from '@web/spaces/document/document-editor-cache';
import type { ViewedEditor } from '@web/spaces/document/document-editor-view';
import type { WrittenBlock } from '@web/spaces/document/document-external-media';
import type { LocalRange } from '@web/spaces/document/document-local-range';
import type { ProposalAdmission } from '@web/spaces/document/document-proposal-landing';

/**
 * Stands in for a part not written yet.
 * @throws {Error} Always.
 */
function notImplemented(): never {
  throw new Error('not implemented');
}

/** One unit: a block holding selected words, or one cell of a legacy table. */
export interface AiTextUnit {
  /** Its number in the request, from 1 in document order. */
  readonly id: number;
  /** The block's id; for a legacy table cell, the table's. */
  readonly blockId: string;
  /** The block's type; `tableCell` for a legacy table cell. */
  readonly kind: string;
  /** Which cell of a legacy table, or null. */
  readonly cell: { readonly row: number; readonly col: number } | null;
  /** Whether the selection covered all of the block's words when it opened. */
  readonly whole: boolean;
}

/** What one unit becomes. */
export type AiUnitWrite =
  | { readonly kind: 'inline'; readonly block: WrittenBlock }
  | { readonly kind: 'blocks'; readonly blocks: readonly WrittenBlock[] }
  | { readonly kind: 'clear' };

/** One answered unit. */
export interface AiUnitResult {
  readonly unit: AiTextUnit;
  readonly write: AiUnitWrite;
}

/** An answer read into blocks. */
export interface AiAnswer {
  /** Tags were expected and no unit sent was recognised. */
  readonly formatFailed: boolean;
  /** The answered units, in document order. */
  readonly results: readonly AiUnitResult[];
  /** What the preview shows and insert writes, in order. */
  readonly preview: readonly WrittenBlock[];
  /** How many outside media were left out. */
  readonly leftOut: number;
}

/**
 * The units of a range, as it is when the dialog opens.
 * @param doc - The body.
 * @param segments - The original range.
 * @returns The units, in document order.
 * @throws {Error} Not implemented yet.
 */
export function aiTextUnits(doc: ProseMirrorNode, segments: readonly LocalRange[]): AiTextUnit[] {
  void doc;
  void segments;
  return notImplemented();
}

/**
 * Where a unit's selected words are now.
 * @param doc - The body now.
 * @param unit - The unit.
 * @param segments - The original range, where it is now.
 * @returns The span, or null when no selected word of it is left.
 * @throws {Error} Not implemented yet.
 */
export function unitSpan(doc: ProseMirrorNode, unit: AiTextUnit, segments: readonly LocalRange[]): LocalRange | null {
  void doc;
  void unit;
  void segments;
  return notImplemented();
}

/**
 * The `selection` field a command sends: the units as numbered tags.
 * @param editor - An editor with the body's schema, for the Markdown export.
 * @param doc - The body.
 * @param units - The units.
 * @param segments - The original range.
 * @param command - The command.
 * @returns The tagged units.
 * @throws {Error} Not implemented yet.
 */
export function aiUnitsRequest(
  editor: ViewedEditor,
  doc: ProseMirrorNode,
  units: readonly AiTextUnit[],
  segments: readonly LocalRange[],
  command: AiCommand['id'],
): string {
  void editor;
  void doc;
  void units;
  void segments;
  void command;
  return notImplemented();
}

/**
 * An answer, as far as it is shown, read into blocks per unit.
 * @param parser - An editor with the body's schema, for the Markdown import.
 * @param doc - The body.
 * @param units - The units sent.
 * @param text - The answer shown so far.
 * @param command - The command.
 * @param ourPrefix - Where our own media live, or null when not known.
 * @returns The answer.
 * @throws {Error} Not implemented yet.
 */
export function aiAnswer(
  parser: ViewedEditor,
  doc: ProseMirrorNode,
  units: readonly AiTextUnit[],
  text: string,
  command: AiCommand['id'],
  ourPrefix: string | null,
): AiAnswer {
  void parser;
  void doc;
  void units;
  void text;
  void command;
  void ourPrefix;
  return notImplemented();
}

/**
 * Whether replace can be pressed: some unit is answered, and every unit with
 * a non-empty answer still has selected words.
 * @param doc - The body now.
 * @param answer - The answer.
 * @param segments - The original range, where it is now.
 * @returns Whether it can.
 * @throws {Error} Not implemented yet.
 */
export function aiReplaceAvailable(doc: ProseMirrorNode, answer: AiAnswer, segments: readonly LocalRange[]): boolean {
  void doc;
  void answer;
  void segments;
  return notImplemented();
}

/**
 * Writes an answer over its units, last to first, in one undo step.
 * @param handle - The document, mounted.
 * @param answer - The answer.
 * @param segments - The original range, where it is now.
 * @param readAdmission - Reads current lifecycle and write admission synchronously.
 * @returns How it ended.
 * @throws {Error} Not implemented yet.
 */
export function replaceAiAnswer(
  handle: Pick<DocumentEditorHandle, 'editor'>,
  answer: AiAnswer,
  segments: readonly LocalRange[],
  readAdmission: () => ProposalAdmission,
): AiWriteResult {
  void handle;
  void answer;
  void segments;
  void readAdmission;
  return notImplemented();
}

/**
 * Puts an answer's preview blocks under the insert block, in one undo step.
 * @param handle - The document, mounted.
 * @param blockId - The insert block.
 * @param answer - The answer.
 * @param readAdmission - Reads current lifecycle and write admission synchronously.
 * @returns How it ended.
 * @throws {Error} Not implemented yet.
 */
export function insertAiAnswer(
  handle: Pick<DocumentEditorHandle, 'editor'>,
  blockId: string,
  answer: AiAnswer,
  readAdmission: () => ProposalAdmission,
): AiWriteResult {
  void handle;
  void blockId;
  void answer;
  void readAdmission;
  return notImplemented();
}
