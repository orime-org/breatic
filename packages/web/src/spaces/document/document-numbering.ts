// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The numbers a document shows, computed from the document alone.
 *
 * Two counting rules, answering to different things (§3.4 of the design):
 *
 * - A numbered HEADING counts within the headings of its own level, across the
 *   whole document, and indentation does not enter into it. It shows the path
 *   down to itself — `1`, `1.1`, `1.1.1` — dots between levels, none at the
 *   end.
 * - Every other numbered item counts within ONE list, and a list is the blocks
 *   at one indentation level under one parent, within one run of
 *   quoted-or-not. Indent an item and it joins a different list; quote it and
 *   it leaves the one around it. It shows `1.`, the shape the delivered
 *   `list-style-type: decimal` marker already draws.
 *
 * A block that is both — an ordered item the user made a heading — draws its
 * number from the headings, so the list it sits in numbers the items around it
 * as though it were not there. Three ordered items with the middle one turned
 * into a heading read `1.`, the heading path, `2.`.
 *
 * Nothing here writes to the document: the result is handed to a decoration
 * layer, so opening a document changes no bytes and fills nobody's undo stack.
 */

import type { Node as PMNode } from '@tiptap/pm/model';

import { QUOTED } from '@web/spaces/document/document-list-block';
import type { QuoteRun } from '@web/spaces/document/document-quote-runs';


/** How deep a heading path goes; §3.4 names exactly three levels. */
const DEEPEST_LEVEL = 3;

/** The half of a list key that says "not inside a quote". */
const NOT_QUOTED = 'open';

/** What one block contributes, read off its content node. */
interface Block {
  readonly id: string;
  readonly type: string;
  readonly numbered: boolean;
  readonly quoted: boolean;
  readonly level: number;
  /** The number the user pinned, if any. */
  readonly pinned: number | undefined;
}

/** The running state one walk carries down the document. */
interface Walk {
  /** One counter per heading level, counting only numbered headings. */
  readonly counters: number[];
  /** One counter per list, keyed by parent and quote run. */
  readonly runs: Map<string, number>;
  readonly out: Map<string, string>;
  /** Which run of quote each quoted block belongs to. */
  readonly runOf: ReadonlyMap<string, number>;
}

/**
 * Reads the one number a block pinned, if it pinned one.
 * @param value - The `number` prop as the schema hands it over.
 * @returns The pinned number, or undefined when the block counts along.
 */
function pinnedNumber(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

/**
 * Describes a `blockContainer` by the content node inside it.
 * @param container - The container to read.
 * @returns What the counting rules need to know about it.
 */
function describe(container: PMNode): Block {
  const content = container.child(0);
  const level = content.attrs['level'];
  return {
    id: String(container.attrs['id']),
    type: content.type.name,
    numbered: content.attrs['numbered'] === true,
    quoted: content.attrs[QUOTED] === true,
    level: typeof level === 'number' ? level : 1,
    pinned: pinnedNumber(content.attrs['number']),
  };
}

/**
 * The heading path down to a level, filling in a 1 for any level above it that
 * has no numbered heading yet.
 *
 * The fill is shown, never stored: writing it into the counters would make the
 * document's first real heading of that level show 2.
 * @param counters - The live per-level counters.
 * @param level - The level to build the path for.
 * @returns The string the reader sees, such as `1.1`.
 */
function headingPath(counters: readonly number[], level: number): string {
  const shown: number[] = [];
  for (let i = 0; i < level; i += 1) {
    const count = counters[i] ?? 0;
    shown.push(count === 0 ? 1 : count);
  }
  return shown.join('.');
}

/**
 * Counts one numbered heading and records the path it shows.
 * @param block - The heading.
 * @param walk - The running state, advanced in place.
 */
function countHeading(block: Block, walk: Walk): void {
  const index = block.level - 1;
  walk.counters[index] =
    block.pinned ?? (walk.counters[index] ?? 0) + 1;
  walk.out.set(block.id, headingPath(walk.counters, block.level));
  // A new section: everything under it starts over.
  for (let i = block.level; i < DEEPEST_LEVEL; i += 1) {
    walk.counters[i] = 0;
  }
}

/**
 * Advances one list and records the number the item shows.
 * @param block - The item.
 * @param key - Which list it belongs to.
 * @param walk - The running state, advanced in place.
 */
function countListItem(block: Block, key: string, walk: Walk): void {
  const next = block.pinned ?? (walk.runs.get(key) ?? 0) + 1;
  walk.runs.set(key, next);
  walk.out.set(block.id, `${String(next)}.`);
}

/**
 * Walks one `blockGroup` and everything nested under it, in reading order.
 * @param group - The group to walk.
 * @param parentKey - Identifies the list this group's blocks share.
 * @param walk - The running state, advanced in place.
 */
function walkGroup(group: PMNode, parentKey: string, walk: Walk): void {
  group.forEach((container) => {
    const block = describe(container);
    const run = walk.runOf.get(block.id);
    const key = `${parentKey}|${run === undefined ? NOT_QUOTED : `quote${String(run)}`}`;

    if (
      block.type === 'heading' &&
      block.numbered &&
      block.level >= 1 &&
      block.level <= DEEPEST_LEVEL
    ) {
      countHeading(block, walk);
      // Its number comes from the headings, so the list it sits in numbers the
      // items around it as though it were not there.
    } else if (block.type === 'numberedListItem') {
      countListItem(block, key, walk);
    }
    // Anything else — prose, a bullet, a heading carrying no number, a
    // stand-in for vocabulary this build does not know — moves neither
    // counter, and a list closes over it rather than restarting.

    if (container.childCount > 1) {
      walkGroup(container.child(1), block.id, walk);
    }
  });
}

/**
 * Every number the document shows, keyed by block id.
 *
 * A heading at level four and beyond gets none: the menu offers three, and
 * what an existing document with a deeper one should show is `#920`.
 * @param doc - The document to read.
 * @param runs - The document's quote runs. Taken as an argument because the
 *   decoration plugin reads them too, and reading them is a walk of the whole
 *   document that then happened twice per keystroke.
 * @returns Block id to the literal string the reader sees.
 */
export function computeNumbering(
  doc: PMNode,
  runs: readonly QuoteRun[],
): Map<string, string> {
  const runOf = new Map<string, number>();
  runs.forEach((run, index) => {
    run.ids.forEach((id) => runOf.set(id, index));
  });
  const walk: Walk = {
    counters: new Array<number>(DEEPEST_LEVEL).fill(0),
    runs: new Map<string, number>(),
    out: new Map<string, string>(),
    runOf,
  };
  if (doc.childCount > 0) {
    walkGroup(doc.child(0), 'root', walk);
  }
  return walk.out;
}
