// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * This slice delivers a COLLABORATIVE SURFACE, not an editor's feature set.
 *
 * The document Space ships in slices. This one is the foundation: a body bound
 * to Yjs, carets, undo, persistence — everything needed for two people to type
 * into the same document at once. Formatting, block structure and media are a
 * separate body of work that arrives whole in later slices.
 *
 * So the editing surface here is PLAIN TEXT, and the lists below pin that down:
 * paragraphs, text, and a line break. Every block type and every mark is
 * switched off, including the ones StarterKit enables by default — because a
 * default nobody chose is still a feature users can reach. Type `# ` today and
 * StarterKit's input rule turns the line into a heading; that heading belongs
 * to a slice that has not been designed yet, and it drags real consequences
 * with it (see the undo note below).
 *
 * An earlier version of this file asserted the OPPOSITE — that every node any
 * future slice might need was already registered. The reasoning was that
 * y-tiptap deletes nodes its schema does not recognise, so an older client
 * would destroy newer content. That mechanism is real, but it needs a client
 * that can PRODUCE the content, and none can here. The right place to handle it
 * is the slice that first makes a node reachable: register the schema, release
 * it, and only then ship the UI that writes it.
 *
 * Two things a later slice MUST do when it turns any of these back on:
 *   1. Move the name out of the forbidden list below into an assertion that it
 *      IS registered — with its ATTRIBUTES, which are dropped by the same
 *      mechanism as unknown nodes and are the easy half to forget.
 *   2. Widen the undo manager's protected-node list. It currently protects
 *      `paragraph` alone (see `document-undo.ts`), which is complete only
 *      because a paragraph is all this document can hold. Add a heading without
 *      it and one person's undo deletes what another wrote inside that heading,
 *      syncs the deletion to everyone, and leaves no entry in their undo stack.
 */

import { describe, it, expect } from 'vitest';
import { getSchema } from '@tiptap/core';

import * as Y from 'yjs';

import { buildDocumentExtensions } from '@web/spaces/document/document-extensions';

/**
 * A throwaway fragment, for asserting on the schema alone. The collaboration
 * extensions contribute no node or mark, so the schema is the same as
 * production's.
 * @returns An empty fragment, standing in for a real document body.
 */
function schemaFragment(): Y.XmlFragment {
  return new Y.Doc().getXmlFragment('content');
}

/** The whole editing surface of this slice. Nothing else may be reachable. */
const ALLOWED_NODES: ReadonlyArray<string> = [
  'doc',
  'paragraph',
  'text',
  'hardBreak',
];

/**
 * Block types that must NOT be registered yet, and the slice that owns each.
 *
 * StarterKit enables the first seven by default and gives every one of them an
 * input rule, so leaving any of them on hands users a feature this slice never
 * designed.
 */
const FORBIDDEN_NODES: ReadonlyArray<string> = [
  // Slice 2 — basic editing
  'heading',
  'bulletList',
  'orderedList',
  'listItem',
  'blockquote',
  'codeBlock',
  'horizontalRule',
  'taskList',
  'taskItem',
  // Slice 4 — tables
  'table',
  'tableRow',
  'tableCell',
  'tableHeader',
  // Slice 5 — media
  'image',
  'video',
  'audio',
];

/**
 * Marks that must NOT be registered yet.
 *
 * Bold, italic and strike are the ones worth spelling out: their toolbar
 * buttons are still on screen. The buttons are deliberately inert — the UI keeps
 * its final shape while the capability lands in slice 2 — and a mark registered
 * behind an inert button would be reachable by keyboard shortcut anyway, which
 * is exactly the "no entry point but still producible" state this file exists
 * to prevent.
 */
const FORBIDDEN_MARKS: ReadonlyArray<string> = [
  'bold',
  'italic',
  'strike',
  'underline',
  'code',
  'link',
  'highlight',
  'textStyle',
];

/**
 * Attributes that must NOT be declared yet.
 *
 * An extension can contribute no node at all and still change the schema:
 * TextAlign only hangs a `textAlign` field on nodes that already exist. Absence
 * of a node name therefore does not prove absence of a capability.
 */
const FORBIDDEN_NODE_ATTRS: Readonly<Record<string, ReadonlyArray<string>>> = {
  paragraph: ['textAlign'],
};

describe('document schema — plain text only in this slice', () => {
  it('registers nothing beyond a paragraph, its text, and a line break', () => {
    const schema = getSchema(buildDocumentExtensions({ fragment: schemaFragment() }));
    const unexpected = Object.keys(schema.nodes).filter(
      (name) => !ALLOWED_NODES.includes(name),
    );
    expect(unexpected).toEqual([]);
  });

  it('keeps every block type of a later slice out of the schema', () => {
    const schema = getSchema(buildDocumentExtensions({ fragment: schemaFragment() }));
    const present = FORBIDDEN_NODES.filter((name) => name in schema.nodes);
    expect(present).toEqual([]);
  });

  it('registers no marks at all', () => {
    const schema = getSchema(buildDocumentExtensions({ fragment: schemaFragment() }));
    expect(Object.keys(schema.marks)).toEqual([]);
    const present = FORBIDDEN_MARKS.filter((name) => name in schema.marks);
    expect(present).toEqual([]);
  });

  it('declares no attribute belonging to a later slice', () => {
    const schema = getSchema(buildDocumentExtensions({ fragment: schemaFragment() }));
    const present: string[] = [];
    for (const [nodeName, attrs] of Object.entries(FORBIDDEN_NODE_ATTRS)) {
      const declared = Object.keys(schema.nodes[nodeName]?.spec.attrs ?? {});
      for (const attr of attrs) {
        if (declared.includes(attr)) present.push(`${nodeName}.${attr}`);
      }
    }
    expect(present).toEqual([]);
  });

  it('switches off StarterKit history — Collaboration owns undo', () => {
    // StarterKit ships UndoRedo by default and it is incompatible with the
    // Collaboration extension's shared undo manager (upstream warns and the
    // two histories diverge). Assert the CONFIG rather than the extension-name
    // list: StarterKit is a bundle, so its children never appear as top-level
    // names and a name-based assertion would pass even when history is on.
    const starterKit = buildDocumentExtensions({ fragment: schemaFragment() }).find(
      (e) => e.name === 'starterKit',
    );
    expect(starterKit).toBeDefined();
    expect(
      (starterKit?.options as { undoRedo?: unknown } | undefined)?.undoRedo,
    ).toBe(false);
  });
});
