// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Where one quote begins and ends.
 *
 * A quote is a prop on each block rather than a container (§5.2), so what the
 * reader sees as one quote is however many blocks carry it in a row. In a row
 * means READING order — the order the blocks are drawn in — which is why an
 * indented block belongs to the run of the block it is indented under: on the
 * screen the two are stacked with nothing between them.
 *
 * Two readers need this boundary and would drift apart if each found it for
 * itself: the numbering divides lists by it (§3.4 — a quoted list starts at
 * one, whatever the list outside it read), and the decoration layer marks the
 * blocks the rule down the side is drawn from (§5.3).
 */

import type { Node as PMNode } from '@tiptap/pm/model';

import { QUOTED } from '@web/spaces/document/document-list-block';

/**
 * Every block id in one body, in reading order, with whether it is quoted. A
 * table is one block of the body it stands in; its cells are bodies of their
 * own, gathered to be read after it.
 * @param group - A `blockGroup` to walk, or a table cell.
 * @param out - The blocks found so far, appended to in place.
 * @param cells - The cells of the tables met, appended to in place.
 */
function walkGroup(
  group: PMNode,
  out: { id: string; quoted: boolean }[],
  cells: PMNode[],
): void {
  group.forEach((block) => {
    if (block.type.name !== 'blockContainer') {
      out.push({ id: String(block.attrs['id']), quoted: block.attrs[QUOTED] === true });
      block.forEach((row) => row.forEach((cell) => cells.push(cell)));
      return;
    }
    const content = block.child(0);
    out.push({
      id: String(block.attrs['id']),
      quoted: content.attrs[QUOTED] === true,
    });
    if (block.childCount > 1) {
      walkGroup(block.child(1), out, cells);
    }
  });
}

/**
 * The runs of quoted blocks in one body's blocks.
 * @param blocks - The body's blocks, in reading order.
 * @returns One entry per run.
 */
function runsOf(blocks: readonly { id: string; quoted: boolean }[]): { ids: string[] }[] {
  const runs: { ids: string[] }[] = [];
  let open: { ids: string[] } | null = null;
  for (const block of blocks) {
    if (!block.quoted) {
      open = null;
      continue;
    }
    if (open === null) {
      open = { ids: [] };
      runs.push(open);
    }
    open.ids.push(block.id);
  }
  return runs;
}

/** One quote: the blocks it holds, in reading order. */
export interface QuoteRun {
  /** The run's block ids, in reading order. */
  readonly ids: readonly string[];
}

/**
 * The runs of quoted blocks a document holds.
 * @param doc - The document to read.
 * @returns One entry per run: the body's in reading order, then each table
 *   cell's.
 */
export function quoteRuns(doc: PMNode): QuoteRun[] {
  if (doc.childCount === 0) return [];
  // The body, then each cell of its tables as a body of its own: a quote
  // never runs from a cell out into the body or into another cell.
  const bodies: PMNode[] = [doc.child(0)];
  const runs: { ids: string[] }[] = [];
  for (let at = 0; at < bodies.length; at += 1) {
    const blocks: { id: string; quoted: boolean }[] = [];
    walkGroup(bodies[at]!, blocks, bodies);
    runs.push(...runsOf(blocks));
  }
  return runs;
}
