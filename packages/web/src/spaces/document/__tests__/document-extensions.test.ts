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
  // StarterKit's own Document is `block+`, which is wrong on both halves: it
  // has no title, and it forbids the empty body the title makes safe.
  document: 'the document opens with a title and may hold no body block',
  // A second, client-blind undo stack: a peer's edit arrives as a local
  // transaction there, so one Cmd+Z deletes their paragraph.
  undoRedo: 'collaboration owns history through the shared undo manager',
  // Appending a trailing paragraph is a WRITE in a shared document: it
  // broadcasts, lands on the opener's undo stack, and fires for a viewer whose
  // update the server then silently drops.
  trailingNode: 'its append is a write to a document everyone shares',
  // Switched off so `BodyHeading` can take its place. The body keeps three
  // levels, and a stored heading below that has to render as the smallest one
  // rather than the largest — neither is reachable through `configure`, since
  // the fallback lives in Heading's own `renderHTML`.
  heading: 'the body caps headings at three levels and answers for the rest',
};

/**
 * Nodes this document has that plain StarterKit does not, and why.
 *
 * Same contract as the switches above: the reason travels with the entry, so
 * a further addition has to state one rather than slip in as a name.
 */
const ADDED_NODES: Readonly<Record<string, string>> = {
  title: 'the undeletable first block that keeps the shared fragment inhabited',
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
      ...Object.keys(stock.nodes),
      ...Object.keys(ADDED_NODES),
    ].sort();
    expect(Object.keys(ours.nodes).sort()).toEqual(expected);
    // Marks are untouched: the title refuses all of them rather than adding
    // one of its own.
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
        Object.entries(schema.nodes)
          // The added nodes have no StarterKit counterpart to compare against;
          // what they declare is pinned where they are defined.
          .filter(([name]) => !(name in ADDED_NODES))
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
