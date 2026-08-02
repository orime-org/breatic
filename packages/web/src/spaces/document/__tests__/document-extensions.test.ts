// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Connecting this document to a shared one must not change what can be written
 * into it.
 *
 * The editing feature set — which blocks and marks exist, what the toolbar
 * offers, how the body is styled — is a separate body of work with its own
 * slice. This slice only makes the document collaborative, and a schema change
 * smuggled in alongside that is both out of scope and dangerous: y-tiptap
 * deletes any node, mark or attribute its schema does not recognise, and
 * commits that deletion as an ordinary local change, so it syncs to every peer
 * and persists. A client on an older bundle would erase what a newer one wrote.
 *
 * So the schema here is asserted to be IDENTICAL to plain StarterKit's, and the
 * only configuration allowed is the two switches that a shared document
 * genuinely requires. Both are named below with the reason they qualify; a
 * third needs the same kind of justification, not just a good idea.
 */

import { describe, it, expect } from 'vitest';
import { getSchema } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';

import * as Y from 'yjs';

import { buildDocumentExtensions } from '@web/spaces/document/document-extensions';

/**
 * The switches this slice is allowed to change, and why each qualifies.
 *
 * The test compares against this map rather than a bare list, so the reason
 * travels with the entry and a future addition has to state one.
 */
const ALLOWED_STARTERKIT_OVERRIDES: Readonly<Record<string, string>> = {
  // A second, client-blind undo stack: a peer's edit arrives as a local
  // transaction there, so one Cmd+Z deletes their paragraph.
  undoRedo: 'collaboration owns history through the shared undo manager',
  // Appending a trailing paragraph is a WRITE in a shared document: it
  // broadcasts, lands on the opener's undo stack, and fires for a viewer whose
  // update the server then silently drops.
  trailingNode: 'its append is a write to a document everyone shares',
};

/**
 * A throwaway fragment, for asserting on the schema alone. The collaboration
 * extensions contribute no node or mark, so the schema is the same as
 * production's.
 * @returns An empty fragment, standing in for a real document body.
 */
function schemaFragment(): Y.XmlFragment {
  return new Y.Doc().getXmlFragment('content');
}

describe('the document schema', () => {
  it('registers exactly what plain StarterKit registers — no more, no less', () => {
    // Written as a set comparison rather than a hard-coded list so it keeps
    // working when StarterKit itself gains or loses something in an upgrade:
    // what is pinned is "we did not change it", not "it contains these names".
    const ours = getSchema(buildDocumentExtensions({ fragment: schemaFragment() }));
    const stock = getSchema([
      StarterKit.configure({ undoRedo: false, trailingNode: false }),
    ]);

    expect(Object.keys(ours.nodes).sort()).toEqual(Object.keys(stock.nodes).sort());
    expect(Object.keys(ours.marks).sort()).toEqual(Object.keys(stock.marks).sort());
  });

  it('declares the same attributes on every node it shares with StarterKit', () => {
    // Names alone are not enough. An extension can contribute no node and still
    // change the schema — TextAlign only hangs a `textAlign` field on nodes
    // that already exist — and an undeclared attribute is dropped by exactly
    // the mechanism that drops an undeclared node.
    const ours = getSchema(buildDocumentExtensions({ fragment: schemaFragment() }));
    const stock = getSchema([
      StarterKit.configure({ undoRedo: false, trailingNode: false }),
    ]);

    const attrsOf = (schema: typeof ours): Record<string, string[]> =>
      Object.fromEntries(
        Object.entries(schema.nodes).map(([name, node]) => [
          name,
          Object.keys(node.spec.attrs ?? {}).sort(),
        ]),
      );

    expect(attrsOf(ours)).toEqual(attrsOf(stock));
  });

  it('changes only the StarterKit switches a shared document requires', () => {
    // Assert the CONFIG, not the extension-name list: StarterKit is a bundle,
    // so its children never appear as top-level names and a name-based
    // assertion would pass even with history switched back on.
    //
    // Compared against stock StarterKit key by key, rather than by looking for
    // options set to `false`. Configuration is not only switches — narrowing
    // heading to `{ levels: [1, 2] }` or restricting the link protocols is a
    // change to what users can write, arrives as an object, and would sail past
    // a false-only check while this file's docstring claims to gate it.
    const starterKit = buildDocumentExtensions({ fragment: schemaFragment() }).find(
      (e) => e.name === 'starterKit',
    );
    expect(starterKit).toBeDefined();

    const ours = (starterKit?.options ?? {}) as Record<string, unknown>;
    const stock = StarterKit.configure({}).options as unknown as Record<
      string,
      unknown
    >;
    const changed = Object.keys(ours)
      .filter((key) => ours[key] !== stock[key])
      .sort();

    expect(changed).toEqual(Object.keys(ALLOWED_STARTERKIT_OVERRIDES).sort());
  });
});
