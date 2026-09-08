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
 * one, whatever the list outside it read), and the decoration layer draws the
 * quote's own geometry from it (§5.3 — the line down the side, the outer
 * margins, and the two blocks that carry them).
 */

import type { Node as PMNode } from '@tiptap/pm/model';

import { QUOTED } from '@web/spaces/document/document-list-block';

/**
 * Every block id in a document, in reading order, with whether it is quoted.
 * @param group - A `blockGroup` to walk.
 * @param out - The blocks found so far, appended to in place.
 */
function walkGroup(
  group: PMNode,
  out: { id: string; quoted: boolean }[],
): void {
  group.forEach((container) => {
    const content = container.child(0);
    out.push({
      id: String(container.attrs['id']),
      quoted: content.attrs[QUOTED] === true,
    });
    if (container.childCount > 1) {
      walkGroup(container.child(1), out);
    }
  });
}

/** One quote, and the block drawn right below it. */
export interface QuoteRun {
  /** The run's block ids, in reading order. */
  readonly ids: readonly string[];
  /**
   * The block drawn right after the run, or null when the document ends on it.
   *
   * Read off this same walk because reading order is the only thing that
   * answers it: a run's last block can sit inside an indented group while the
   * block below sits back out in the group above, and those two are not
   * siblings in the DOM. A CSS sibling combinator does not reach across that,
   * so the stylesheet is given a mark on the block itself instead — measured,
   * the block below a run ending one level in kept a 12.75px top margin and
   * stood 29.25px below the run against the 16.5px above it.
   */
  readonly after: string | null;
}

/**
 * The runs of quoted blocks a document holds.
 * @param doc - The document to read.
 * @returns One entry per run, in document order.
 */
export function quoteRuns(doc: PMNode): QuoteRun[] {
  const blocks: { id: string; quoted: boolean }[] = [];
  if (doc.childCount > 0) {
    walkGroup(doc.child(0), blocks);
  }

  const runs: { ids: string[]; after: string | null }[] = [];
  let open: { ids: string[]; after: string | null } | null = null;
  for (const block of blocks) {
    if (!block.quoted) {
      if (open !== null) {
        open.after = block.id;
      }
      open = null;
      continue;
    }
    if (open === null) {
      open = { ids: [], after: null };
      runs.push(open);
    }
    open.ids.push(block.id);
  }
  return runs;
}
