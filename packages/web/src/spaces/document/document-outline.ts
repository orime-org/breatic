// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import type { Node as PMNode } from '@tiptap/pm/model';

import { BODY_HEADING_LEVELS } from '@web/spaces/document/document-block-type';
import { computeNumbering } from '@web/spaces/document/document-numbering';
import { quoteRuns } from '@web/spaces/document/document-quote-runs';

/** One heading in the outline, with the headings under it. */
export interface OutlineEntry {
  /** The heading's block id. */
  readonly id: string;
  /** 1, 2 or 3. */
  readonly level: number;
  /** Its words, as written. */
  readonly text: string;
  /** The number the body draws before it, or null when it has none. */
  readonly number: string | null;
  readonly children: readonly OutlineEntry[];
}

/** An entry while the tree is being built. */
interface Building {
  id: string;
  level: number;
  text: string;
  number: string | null;
  children: Building[];
}

/**
 * The body's headings in reading order. Only `blockContainer`s are walked into,
 * so a layout table's cells are passed over; a stored table's cells hold words
 * only, so they hold no heading to find.
 * @param group - A `blockGroup` to walk.
 * @param found - Where headings are collected, in order.
 */
function collect(group: PMNode, found: PMNode[]): void {
  group.forEach((container) => {
    if (container.type.name !== 'blockContainer') return;
    const content = container.firstChild;
    if (content?.type.name === 'heading') found.push(container);
    if (container.childCount > 1) collect(container.child(1), found);
  });
}

/**
 * The document's level 1–3 headings as a tree: each heading hangs under the
 * nearest heading of a higher level before it, a skipped level included.
 * Headings in table cells and headings with no words are left out (inner#1149
 * A1–A5); a heading's number is the string the body draws for it.
 * @param doc - The document to read.
 * @returns The top-level entries, in reading order.
 */
export function readOutline(doc: PMNode): readonly OutlineEntry[] {
  const containers: PMNode[] = [];
  if (doc.childCount > 0) collect(doc.child(0), containers);
  const numbers = computeNumbering(doc, quoteRuns(doc));
  const levels: readonly number[] = BODY_HEADING_LEVELS;
  const top: Building[] = [];
  const open: Building[] = [];
  for (const container of containers) {
    const heading = container.firstChild!;
    const level = Number(heading.attrs['level']);
    const text = heading.textContent;
    if (!levels.includes(level) || text.trim() === '') continue;
    const id = String(container.attrs['id']);
    const entry: Building = { id, level, text, number: numbers.get(id) ?? null, children: [] };
    while (open.length > 0 && open[open.length - 1]!.level >= level) open.pop();
    (open.length === 0 ? top : open[open.length - 1]!.children).push(entry);
    open.push(entry);
  }
  return top;
}
