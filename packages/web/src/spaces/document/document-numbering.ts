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
 * Nothing here writes to the document: the result is handed to a decoration
 * layer, so opening a document changes no bytes and fills nobody's undo stack.
 */

import type { Node as PMNode } from '@tiptap/pm/model';

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
  /** How many runs of quoted blocks have opened so far. */
  quoteRuns: number;
  /** Whether the block just visited was inside a quote. */
  prevQuoted: boolean;
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
    quoted: content.attrs['quoted'] === true,
    level: typeof level === 'number' ? level : 1,
    pinned: pinnedNumber(content.attrs['number']),
  };
}

/**
 * Whether a block holds a place in a list — that is, whether it IS one.
 * @param block - The block to judge.
 * @returns True for a list item and for a heading carrying a number.
 */
function countsInAList(block: Block): boolean {
  return (
    block.type === 'numberedListItem' ||
    (block.type === 'heading' && block.numbered)
  );
}

/**
 * Whether a list sits immediately beside this block, in the same list.
 *
 * This is what keeps a numbered heading from eating the first number of a list
 * it merely stands above (§6.2.1). A heading the user turned into an ordered
 * item while it sat inside a list is a member of that list and holds its
 * place; a heading with prose between it and the nearest list never was.
 * @param siblings - The blocks sharing this block's parent, in order.
 * @param index - Where this block sits among them.
 * @returns True when the neighbour before or after is in the same list.
 */
function touchesAList(siblings: readonly Block[], index: number): boolean {
  const self = siblings[index];
  if (self === undefined) {
    return false;
  }
  return [siblings[index - 1], siblings[index + 1]].some(
    (neighbour) =>
      neighbour !== undefined &&
      neighbour.quoted === self.quoted &&
      countsInAList(neighbour),
  );
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
  const containers: PMNode[] = [];
  group.forEach((child) => containers.push(child));
  const siblings = containers.map(describe);

  containers.forEach((container, index) => {
    const block = siblings[index]!;
    if (block.quoted && !walk.prevQuoted) {
      walk.quoteRuns += 1;
    }
    walk.prevQuoted = block.quoted;
    const key = `${parentKey}|${block.quoted ? `quote${String(walk.quoteRuns)}` : NOT_QUOTED}`;

    if (
      block.type === 'heading' &&
      block.numbered &&
      block.level >= 1 &&
      block.level <= DEEPEST_LEVEL
    ) {
      countHeading(block, walk);
      // It shows a heading path, and it is still an ordered item: the siblings
      // after it count on past it. Only when it stands in a list, though.
      if (touchesAList(siblings, index)) {
        walk.runs.set(key, (walk.runs.get(key) ?? 0) + 1);
      }
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
 * @returns Block id to the literal string the reader sees.
 */
export function computeNumbering(doc: PMNode): Map<string, string> {
  const walk: Walk = {
    counters: new Array<number>(DEEPEST_LEVEL).fill(0),
    runs: new Map<string, number>(),
    out: new Map<string, string>(),
    quoteRuns: 0,
    prevQuoted: false,
  };
  if (doc.childCount > 0) {
    walkGroup(doc.child(0), 'root', walk);
  }
  return walk.out;
}
