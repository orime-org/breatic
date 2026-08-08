// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * The document's title block.
 *
 * Every document Space opens with one, it is always the first block, and
 * nothing a user can do removes it. That is not a convenience — it is what
 * keeps the shared fragment inhabited. `@breatic/shared`'s `document-body`
 * carries the full reasoning; the short version is that a Yjs fragment can be
 * empty while ProseMirror's document model cannot, and when the two disagree
 * the editor writes a repair that counts as a user edit and destroys the redo
 * the user was entitled to. A first block nobody can issue a delete for closes
 * that gap by construction, so no merge of concurrent edits can produce one.
 *
 * Three properties do the work, and each is load-bearing:
 *
 * `group` is absent. The document's content rule is `title block*`, and the
 * body half of that only accepts nodes in the `block` group — so a title
 * cannot be created anywhere in the body, and the one at the front cannot be
 * replaced by anything else. Put it in the `block` group and both guarantees
 * evaporate at once.
 *
 * `marks: ''` refuses every mark the body accepts. Bold on the title is not
 * "allowed but discouraged", it does not apply.
 *
 * `isolating` keeps operations that span the boundary from reaching in and
 * dissolving the node — a whole-document range delete clears the body and
 * leaves the title standing.
 *
 * The content is `text*` rather than `inline*`: the title holds text, not
 * inline atoms. A reference chip or an inline image in a title has no meaning
 * and would need its own answers for serialisation and for what happens when
 * it is dragged out.
 */

import { Node } from '@tiptap/core';
import { DOCUMENT_TITLE_NODE } from '@breatic/shared';

/**
 * Class name the title renders with.
 *
 * Exported because the stylesheet and the placeholder both key off it, and a
 * literal repeated in three files is three places to drift.
 */
export const DOCUMENT_TITLE_CLASS = 'doc-title';

/**
 * The title node.
 *
 * Its name comes from `@breatic/shared` because the backend writes this node
 * into Yjs directly, without going through ProseMirror. A mismatch between the
 * two would be silent: the editor deletes what it cannot resolve and
 * broadcasts that deletion as its own edit.
 */
export const DocumentTitle = Node.create({
  name: DOCUMENT_TITLE_NODE,
  content: 'text*',
  marks: '',
  defining: true,
  isolating: true,
  parseHTML: () => [{ tag: `h1.${DOCUMENT_TITLE_CLASS}` }],
  renderHTML: () => ['h1', { class: DOCUMENT_TITLE_CLASS }, 0],
});
