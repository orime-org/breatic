// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * A selection over the document's body, whatever the body is made of.
 *
 * ## Why a selection type of our own
 *
 * `TextSelection` requires both endpoints to sit in inline content. A body
 * that starts or ends with a block nobody can put a cursor in — a divider, or
 * one of the `unsupported*` fallbacks — has no such position at that end, so
 * `TextSelection.between` pulls the endpoint inward and the block falls out of
 * the selection. Measured: a body of three dividers selected only the first
 * one; a body ending in a divider left that divider out.
 *
 * ProseMirror's answer to a range its built-in types cannot express is to
 * define one. The guide says so — "ProseMirror supports several types of
 * selection (and allows 3rd-party code to define new selection types)" — and
 * `Selection`'s own doc comment is "Superclass for editor selections. Every
 * selection type should extend this." The library takes its own advice twice:
 * `AllSelection` is a `Selection` subclass, and so is `CellSelection` in
 * `prosemirror-tables`, which exists for exactly this reason — a span of table
 * cells is not something `TextSelection` can hold either.
 *
 * ## What it does NOT do
 *
 * Replacement and content extraction are the base class's: what gets copied,
 * cut or typed over is the default slice of the range, which is what a stretch
 * of blocks should produce anyway. Mapping, equality and serialisation are
 * defined here — see the class comment for why.
 */

import { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { Selection } from '@tiptap/pm/state';

/**
 * Where the body starts in a document — the position just past the title.
 *
 * The title is always the first block; the content rule `title block*` admits
 * nothing else there.
 * @param doc - The document to measure.
 * @returns The first position belonging to the body.
 */
function bodyStart(doc: ProseMirrorNode): number {
  return doc.child(0).nodeSize;
}

/**
 * A selection spanning the body, endpoints included whether or not they hold
 * inline content.
 *
 * ## Defined by the document, not by a pair of coordinates
 *
 * "The whole body" is a description of a document, so the range is derived
 * from whatever document the selection is asked about, rather than carried
 * around as two numbers. `AllSelection` is built the same way and for the same
 * reason: its `map` ignores the mapping and returns `new AllSelection(doc)`,
 * its `toJSON` stores no positions, and its `fromJSON` rebuilds from the doc
 * alone (`prosemirror-state@1.4.4`).
 *
 * This is what makes the selection survive things that move text around. A
 * coordinate pair has to be mapped, and every mapping is a chance to land
 * somewhere it should not — measured, a title that swallows the body's first
 * block maps the start position to inside the title. Deriving instead of
 * mapping removes the question.
 */
export class BodySelection extends Selection {
  /**
   * Select the whole body of a document.
   * @param doc - The document to select the body of.
   */
  constructor(doc: ProseMirrorNode) {
    super(doc.resolve(bodyStart(doc)), doc.resolve(doc.content.size));
  }

  /**
   * Whether a document has a body to select at all.
   * @param doc - The document to check.
   * @returns True when there is at least one block after the title.
   */
  static hasBody(doc: ProseMirrorNode): boolean {
    return doc.content.size > bodyStart(doc);
  }

  /**
   * The body of a document, or the nearest valid selection when it is empty.
   *
   * `title block*` allows zero blocks after the title, and a document in that
   * shape has nothing in its body to select. The only place a selection can go
   * is the title — not a choice this makes, but what the document is.
   * @param doc - The document to select the body of.
   * @returns The body selection, or a valid selection near where it would be.
   */
  static of(doc: ProseMirrorNode): Selection {
    if (!BodySelection.hasBody(doc)) return Selection.near(doc.resolve(doc.content.size), -1);
    return new BodySelection(doc);
  }

  /**
   * Carry the selection into a changed document.
   *
   * The mapping is deliberately unused: the body of the new document is what
   * this selects, whatever moved. Same shape as `AllSelection.map`.
   * @param doc - The document after the change.
   * @returns The body of that document.
   */
  map(doc: ProseMirrorNode): Selection {
    return BodySelection.of(doc);
  }

  /**
   * Whether this is the same selection as another.
   *
   * Two body selections over the same document are the same selection; there
   * is only one body. Positions are compared as well so that a stale one
   * belonging to an older document does not compare equal to a current one.
   * @param other - The selection to compare with.
   * @returns True when both are body selections over the same range.
   */
  eq(other: Selection): boolean {
    return (
      other instanceof BodySelection &&
      other.from === this.from &&
      other.to === this.to
    );
  }

  /**
   * The serialisable form, for `Selection.fromJSON`.
   *
   * No positions, for the same reason `AllSelection.toJSON` stores none: the
   * range is a function of the document, so storing coordinates would let a
   * stale pair override the real answer on the way back in.
   * @returns The plain object a stored selection round-trips through.
   */
  toJSON(): { type: string } {
    return { type: 'body' };
  }

  /**
   * Rebuild from the serialised form.
   * @param doc - The document to select the body of.
   * @returns The body of that document.
   */
  static fromJSON(doc: ProseMirrorNode): Selection {
    return BodySelection.of(doc);
  }
}

// Registers the name used in `toJSON`, so a selection stored in history or
// sent through a plugin's state round-trips back to this class instead of
// throwing. `AllSelection` and `CellSelection` register themselves the same
// way, at module scope.
//
// `Selection.jsonID` does two things: it puts the class in a registry keyed by
// id, and it writes the id onto the class's prototype. The registry is
// per-process and rejects a second use of the same id, and the throw is the
// first statement — so on a second call NEITHER thing happens, including the
// prototype write, which is independent of the registry.
//
// That second call does not happen in a browser, where this module is
// evaluated once. It happens under vitest: this package runs one process for
// the whole package and resets the module registry between files, so our
// source is re-evaluated per file while `prosemirror-state` in node_modules is
// not. Every file after the first got a `BodySelection` whose instances had no
// `jsonID` — and `@tiptap/y-tiptap` reads exactly that property to decide how
// to restore a selection across a remote change, so the restore fell through
// to its `TextSelection` default and the collaboration tests passed or failed
// depending on which file ran first.
//
// So the prototype write is done here when the registry rejects the id. The
// registry keeps pointing at the first class, which is correct: every
// evaluation produces the same behaviour, and `Selection.fromJSON` returning
// the first one is indistinguishable from returning this one.
try {
  Selection.jsonID('body', BodySelection);
} catch (error) {
  const alreadyRegistered =
    error instanceof RangeError &&
    error.message.includes('Duplicate use of selection JSON ID');
  if (!alreadyRegistered) throw error;
  (BodySelection.prototype as { jsonID?: string }).jsonID = 'body';
}
