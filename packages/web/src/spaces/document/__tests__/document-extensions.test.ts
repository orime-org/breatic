// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Nothing changes what can be written into this document except on purpose.
 *
 * The editing feature set — which blocks and marks exist, what the toolbar
 * offers, how the body is styled — is a separate body of work with its own
 * slice. A schema change smuggled in alongside anything else is both out of
 * scope and dangerous: y-tiptap deletes any node, mark or attribute its schema
 * does not recognise, and commits that deletion as an ordinary local change,
 * so it syncs to every peer and persists. A client on an older bundle would
 * erase what a newer one wrote.
 *
 * So the schema is asserted to be plain StarterKit's PLUS exactly the named
 * additions below, and the configuration to differ by exactly the named
 * switches below. Each entry carries the reason it qualifies; a further one
 * needs the same kind of justification, not just a good idea.
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
  // StarterKit's own Document is `block+`, which forbids the empty document
  // this schema makes legal on purpose.
  document: 'the document may hold no blocks at all',
  // A second, client-blind undo stack: a peer's edit arrives as a local
  // transaction there, so one Cmd+Z deletes their paragraph.
  undoRedo: 'collaboration owns history through the shared undo manager',
  // Appending a trailing paragraph is a WRITE in a shared document: it
  // broadcasts, lands on the opener's undo stack, and fires for a viewer whose
  // update the server then silently drops.
  trailingNode: 'its append is a write to a document everyone shares',
  // Switched off so `BodyHeading` can take its place. The cap to three levels
  // would be a `configure` away, but a stored heading below that has to render
  // as the smallest level rather than the largest, and that lives in Heading's
  // own `renderHTML` — an `extend` on an instance StarterKit builds internally
  // and never hands out.
  heading: 'the body caps headings at three levels and answers for the rest',
  // The one entry here that removes a node rather than replacing one. See
  // `REMOVED_NODES` for why the divider goes.
  horizontalRule: 'the divider is not a feature this document offers',
  // Three switches, one purpose: a click on a link has to reach the link
  // rather than leave the page, and an address typed without a protocol has to
  // mean the same thing wherever it was typed. The node itself is untouched —
  // this entry changes how the extension behaves, not what the schema holds.
  link: 'an editor reaches a link by clicking it, and stores https',
};

/**
 * Nodes plain StarterKit registers that this document does not, and why.
 *
 * The mirror of `ADDED_NODES`, and it exists so that removing a node is stated
 * once, here, rather than by quietly switching it off on BOTH sides of the
 * comparison below. Configuring the stock schema to match ours would make the
 * assertion green and blind at the same time: it could never again notice a
 * default node going missing, which is the one thing it is for.
 */
const REMOVED_NODES: Readonly<Record<string, string>> = {
  horizontalRule:
    'the divider is not offered yet: it was switched off when "everything visible can be selected" priced in a block with no text to select, and bringing it back together with the selected-look such a block needs is task #124',
};

/**
 * Nodes this document has that plain StarterKit does not, and why.
 *
 * Same contract as the switches above: the reason travels with the entry, so
 * a further addition has to state one rather than slip in as a name.
 */
const ADDED_NODES: Readonly<Record<string, string>> = {
  unsupportedBlock:
    'where a block this build has no vocabulary for is kept, instead of being deleted from the shared document',
  unsupportedInline:
    'the same for an inline element — that one is dropped while the document merely loads, with no edit involved',
};

const ADDED_MARKS: Readonly<Record<string, string>> = {
  unsupportedMark:
    'carries a mark this build has no vocabulary for, with its original key and value, so a round trip through this client is lossless',
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
  it('registers what plain StarterKit registers plus exactly the named additions', () => {
    // Written as a set comparison rather than a hard-coded list so it keeps
    // working when StarterKit itself gains or loses something in an upgrade:
    // what is pinned is "we changed it by exactly this much", not "it contains
    // these names".
    const ours = getSchema(buildDocumentExtensions({ fragment: schemaFragment() }));
    const stock = getSchema([
      StarterKit.configure({ undoRedo: false, trailingNode: false }),
    ]);

    const expected = [
      ...Object.keys(stock.nodes).filter((name) => !(name in REMOVED_NODES)),
      ...Object.keys(ADDED_NODES),
    ].sort();
    expect(Object.keys(ours.nodes).sort()).toEqual(expected);
    // The only mark addition is the fallback.
    expect(Object.keys(ours.marks).sort()).toEqual(
      [...Object.keys(stock.marks), ...Object.keys(ADDED_MARKS)].sort(),
    );
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
        Object.entries(schema.nodes)
          // The added nodes have no StarterKit counterpart to compare against;
          // what they declare is pinned where they are defined. The removed
          // ones have no counterpart on our side, and their absence is already
          // asserted by name in the test above — this one is about the nodes
          // both schemas have.
          .filter(([name]) => !(name in ADDED_NODES) && !(name in REMOVED_NODES))
          .map(([name, node]) => [name, Object.keys(node.spec.attrs ?? {}).sort()]),
      );

    expect(attrsOf(ours)).toEqual(attrsOf(stock));
  });

  it('changes only the StarterKit switches a shared document requires', () => {
    // Assert the CONFIG, not the extension-name list: StarterKit is a bundle,
    // so its children never appear as top-level names and a name-based
    // assertion would pass even with history switched back on.
    //
    // Every key we differ from stock on, rather than every key set to `false`.
    // Configuration is not only switches — narrowing heading to
    // `{ levels: [1, 2] }` or restricting the link protocols changes what users
    // can write, arrives as an object, and would sail past a false-only check
    // while this file's docstring claims to gate it.
    //
    // In practice stock's options object is EMPTY (`configure({})` stores what
    // it is given, it does not materialise defaults), so this reduces to "the
    // keys we passed". That is the assertion either way, and writing it as a
    // diff keeps it correct if StarterKit ever does start filling them in.
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
