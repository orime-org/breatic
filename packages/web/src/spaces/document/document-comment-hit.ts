// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Which threads a press in the body lands on (#18, A20).
 *
 * Two comments may overlap the same run — `excludes: ""` on the mark is what
 * allows it — and the library's own handler cannot reach the second: it takes
 * `node.marks.find(...)`, the first match, and selects that one thread
 * (`comments/extension.ts:261-263`). A reader pressing a doubly commented run
 * would get one of the two with no way to tell which, or to reach the other.
 *
 * So this names them all and the reader picks, which is what the three
 * implementations that answer the question do: ProseMirror's own `commentsAt`
 * returns a list and renders every entry, Lexical holds an array of ids and
 * activates all of them, CKEditor's `activeAnnotations` is a set. (No
 * vendor's help pages answer it, so there is no product convention to follow
 * — only these.)
 *
 * `orphan` is read, as the library's own handler reads it: what a reader can
 * press is what is drawn for them. The library sets that attribute from
 * `!thread || resolved || deletedAt` (`extension.ts:138-142`) and
 * `.bn-thread-mark[data-orphan='true']` paints it transparent, so those words
 * look like any others on the page — and a press there belongs to whoever
 * else wants it, the link handler among them.
 *
 * The position-to-node step is the library's own, `nodeAt`, so a press lands
 * on the same run in both. Its edge behaviour comes with it: a position
 * exactly between two runs reads the one that starts there.
 */

import type { Node as PMNode } from '@tiptap/pm/model';

import { COMMENT_MARK } from '@web/spaces/document/document-comment-extension';


/**
 * Every thread whose painted highlight covers one position.
 * @param doc - The document the press landed in.
 * @param pos - Where in the document it landed.
 * @returns The thread ids there, in the order the marks carry them; empty
 *   where the press reached no node, no highlight, or only unpainted ones.
 */
export function threadsAtPosition(
  doc: PMNode,
  pos: number,
): readonly string[] {
  // Out of range: `nodeAt` throws on a negative position rather than
  // answering nothing, and a press can be resolved past the end of a
  // document a peer has just shortened.
  if (pos < 0 || pos > doc.content.size) return [];

  const node = doc.nodeAt(pos);
  if (node === null) return [];

  return node.marks
    .filter(
      (mark) => mark.type.name === COMMENT_MARK && mark.attrs.orphan !== true,
    )
    .map((mark) => mark.attrs.threadId as string);
}
