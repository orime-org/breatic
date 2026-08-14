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
 * It carries a range and nothing else. Replacement, mapping and equality are
 * the base class's, and content extraction is the default slice of the range,
 * which is what copying a stretch of blocks should produce anyway.
 */

import { Node as ProseMirrorNode } from '@tiptap/pm/model';
import type { Mappable } from '@tiptap/pm/transform';
import { Selection } from '@tiptap/pm/state';

/**
 * A selection spanning the body, endpoints included whether or not they hold
 * inline content.
 */
export class BodySelection extends Selection {
  /**
   * Select from one document position to another.
   * @param doc - The document the positions belong to.
   * @param from - Where the body starts.
   * @param to - Where the body ends.
   */
  constructor(doc: ProseMirrorNode, from: number, to: number) {
    super(doc.resolve(from), doc.resolve(to));
  }

  /**
   * Move the selection through a change to the document.
   *
   * Both ends are mapped with a bias that keeps them on the outside of an
   * insertion, so a block added at either edge of the body stays inside the
   * selection rather than falling out of it.
   * @param doc - The document after the change.
   * @param mapping - How positions moved.
   * @returns The selection in the new document.
   */
  map(doc: ProseMirrorNode, mapping: Mappable): Selection {
    const from = mapping.map(this.from, -1);
    const to = mapping.map(this.to, 1);
    // The body can be emptied by the change that is being mapped through; a
    // range that has collapsed or inverted is no longer a body selection, and
    // the base class knows what a valid selection near a position is.
    if (to <= from) return Selection.near(doc.resolve(from));
    return new BodySelection(doc, from, to);
  }

  /**
   * Whether this is the same selection as another.
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
   * @returns The plain object a stored selection round-trips through.
   */
  toJSON(): { type: string; anchor: number; head: number } {
    return { type: 'body', anchor: this.anchor, head: this.head };
  }

  /**
   * Rebuild from the serialised form.
   * @param doc - The document the positions belong to.
   * @param json - What `toJSON` produced.
   * @param json.anchor - Where the selection was anchored.
   * @param json.head - Where the selection's head was.
   * @returns The selection.
   * @throws {RangeError} When the stored object is not a body selection.
   */
  static fromJSON(
    doc: ProseMirrorNode,
    json: { anchor?: unknown; head?: unknown },
  ): BodySelection {
    if (typeof json.anchor !== 'number' || typeof json.head !== 'number') {
      throw new RangeError('Invalid input for BodySelection.fromJSON');
    }
    return new BodySelection(doc, json.anchor, json.head);
  }
}

// Registers the name used in `toJSON`, so a selection stored in history or
// sent through a plugin's state round-trips back to this class instead of
// throwing. `AllSelection` and `CellSelection` register themselves the same
// way, at module scope.
//
// The guard is for the test runner, not for production. `jsonID` is
// `if (id in classesById) throw` — one registration per process — and this
// package's vitest config resets the module registry between files while
// keeping one process, so this module is evaluated once per test file. In the
// browser it is evaluated once and the catch never runs. Only that one error
// is swallowed; anything else is rethrown.
try {
  Selection.jsonID('body', BodySelection);
} catch (error) {
  const alreadyRegistered =
    error instanceof RangeError &&
    error.message.includes('Duplicate use of selection JSON ID');
  if (!alreadyRegistered) throw error;
}
