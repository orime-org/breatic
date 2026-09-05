// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What Tab refuses to do: indent a block into a stand-in's slot.
 *
 * A stand-in holds an element a peer wrote and this build cannot read. The
 * binding wraps it in whatever containers its slot needs, and those wrappers
 * exist only here — on the peer's side there is one element, with whatever
 * content rule the build that wrote it gave it. Indenting a block into one of
 * them asks the write-back to put a child inside that element, and it has no
 * way to: the element and the wrapper are different nodes, so the walk falls
 * through to comparing names, which is never equal for a stand-in, and the
 * branch it lands in deletes the element and rebuilds it from what this build
 * can see — a bare stand-in. Measured before this refusal: an element carrying
 * `colour="crimson"` and a paragraph came back as `<unsupportedblock>` in the
 * shared document, broadcast to every peer as this client's own edit.
 *
 * `wrapDepth` says how many wrappers a stand-in sits under, so the two shapes
 * are told apart from the block that is trying to move:
 *
 * - depth 1 — the stand-in is a `blockGroup`'s child, wrapped in a container.
 *   Indenting into it writes into that container's child-group slot, which the
 *   peer's element does not have.
 * - depth 2 — the stand-in fills a container's child-group slot, wrapped in a
 *   group and a container. Indenting adds a second member to that group, and
 *   the peer's element IS the whole slot.
 *
 * Depth 0 takes no wrapper and is a block like any other: it sits in the
 * content slot of a real container, and that container's own group slot is
 * real too. Nothing here refuses it.
 */

import { createExtension } from '@blocknote/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import type { Transaction } from '@tiptap/pm/state';

import {
  UNSUPPORTED_BLOCK,
  WRAP_DEPTH,
} from '@web/spaces/document/document-unsupported-blocknote';

/** What the editor object offers this file. */
interface TabEditor {
  transact: <T>(run: (tr: Transaction) => T) => T;
}

/**
 * The stand-in a block container holds, if that is all it holds.
 * @param node - The container to look inside.
 * @returns That stand-in, or null.
 */
function standInOf(node: PMNode): PMNode | null {
  if (node.type.name !== 'blockContainer') {
    return null;
  }
  const content = node.firstChild;
  return content !== null && content.type.name === UNSUPPORTED_BLOCK
    ? content
    : null;
}

/**
 * Whether indenting the block the selection is in would write into a wrapper.
 *
 * The range is the one `sinkItem` computes, read the same way so the answer is
 * about the block that would actually move.
 * @param tr - The transaction to read the selection from.
 * @returns Whether the indent has to be refused.
 */
export function indentWouldReachStandIn(tr: Transaction): boolean {
  const { $from, $to } = tr.selection;
  const range = $from.blockRange(
    $to,
    (node) =>
      node.childCount > 0 &&
      (node.type.name === 'blockGroup' || node.type.name === 'column'),
  );
  if (range === null || range.startIndex === 0) {
    return false;
  }
  const before = range.parent.child(range.startIndex - 1);

  // The block would become this one's child: depth 1 means its container is a
  // wrapper with no slot to become.
  const ownStandIn = standInOf(before);
  if (ownStandIn !== null && ownStandIn.attrs[WRAP_DEPTH] === 1) {
    return true;
  }

  // Or it joins the group already under it: depth 2 means that group is a
  // wrapper standing for one element of the peer's.
  const group = before.lastChild;
  if (group === null || group.type.name !== 'blockGroup') {
    return false;
  }
  for (let index = 0; index < group.childCount; index += 1) {
    const nested = standInOf(group.child(index));
    if (nested !== null && nested.attrs[WRAP_DEPTH] === 2) {
      return true;
    }
  }
  return false;
}

/**
 * The extension that refuses those indents.
 *
 * Registered ahead of BlockNote's own `Tab`, which runs `nestBlock`
 * unconditionally. Returning true claims the key, so the browser does not take
 * it and move focus out of the editor — the same reason BlockNote's binding
 * always returns true.
 * @returns The extension.
 */
export const documentTabExtension = createExtension(() => ({
  key: 'document-tab',
  keyboardShortcuts: {
    Tab: ({ editor }: { editor: TabEditor }) =>
      editor.transact((tr) => indentWouldReachStandIn(tr)),
  },
}) as never);
