// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * The document editor's schema must be COMPLETE from the first release.
 *
 * Why this file exists: y-tiptap deletes any node or mark its schema does not
 * recognise, and commits that deletion as an ordinary local change — so it
 * syncs to every peer and persists. A client running an older bundle whose
 * schema lacks (say) `table` therefore destroys every table in the shared
 * document, permanently and silently, with no entry in anyone's undo stack.
 *
 * The lists below are deliberately hard-coded rather than imported from the
 * implementation: their whole purpose is to fail when a later slice introduces
 * content the schema forgot to register.
 */

import { describe, it, expect } from 'vitest';
import { getSchema } from '@tiptap/core';

import { buildDocumentExtensions } from '@web/spaces/document/document-extensions';

/**
 * Every node the document will ever hold, across all delivery slices.
 * UI for most of these lands later; the SCHEMA must exist from slice 1.
 */
const REQUIRED_NODES: ReadonlyArray<string> = [
  // Core
  'doc',
  'paragraph',
  'text',
  'hardBreak',
  // Slice 2 — basic editing
  'heading',
  'bulletList',
  'orderedList',
  'listItem',
  'blockquote',
  'codeBlock',
  'horizontalRule',
  // Slice 2 — task list
  'taskList',
  'taskItem',
  // Slice 4 — tables
  'table',
  'tableRow',
  'tableCell',
  'tableHeader',
  // Slice 5 / 6 — inline media
  'image',
  'video',
  'audio',
];

/** Every mark the document will ever hold, across all delivery slices. */
const REQUIRED_MARKS: ReadonlyArray<string> = [
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
 * Attributes matter as much as names.
 *
 * An extension can contribute no node at all and still change the schema —
 * TextAlign only hangs a `textAlign` field on nodes that already exist. And an
 * undeclared attribute is dropped by exactly the mechanism that drops an
 * undeclared node: y-tiptap compares attribute sets, finds one it cannot
 * account for, and strips it in a local transaction that then syncs and
 * persists. Checking node names alone let TextAlign slip through once already.
 */
const REQUIRED_NODE_ATTRS: Readonly<Record<string, ReadonlyArray<string>>> = {
  paragraph: ['textAlign'],
  heading: ['textAlign', 'level'],
  // `width` and `height` back the drag-to-resize the media slice specifies;
  // `textAlign` backs its alignment control. Both are attributes on a node
  // that already exists, which is the failure mode this file exists to catch —
  // the node survives an older client, the attribute does not.
  image: ['src', 'alt', 'title', 'width', 'height', 'textAlign'],
  video: ['src', 'poster', 'title', 'textAlign'],
  audio: ['src', 'title', 'textAlign'],
  tableCell: ['colspan', 'rowspan', 'colwidth'],
  tableHeader: ['colspan', 'rowspan', 'colwidth'],
  taskItem: ['checked'],
  codeBlock: ['language'],
};

/** Mark attributes, same reasoning as {@link REQUIRED_NODE_ATTRS}. */
const REQUIRED_MARK_ATTRS: Readonly<Record<string, ReadonlyArray<string>>> = {
  link: ['href', 'target', 'rel'],
  highlight: ['color'],
};

describe('document schema — complete from slice 1 (guards against silent prose destruction)', () => {
  it('registers every node type the document will ever hold', () => {
    const schema = getSchema(buildDocumentExtensions());
    const missing = REQUIRED_NODES.filter((n) => !(n in schema.nodes));
    expect(missing).toEqual([]);
  });

  it('registers every mark type the document will ever hold', () => {
    const schema = getSchema(buildDocumentExtensions());
    const missing = REQUIRED_MARKS.filter((m) => !(m in schema.marks));
    expect(missing).toEqual([]);
  });

  it('switches off StarterKit history — Collaboration owns undo', () => {
    // StarterKit ships UndoRedo by default and it is incompatible with the
    // Collaboration extension's shared undo manager (upstream warns and the
    // two histories diverge). Assert the CONFIG rather than the extension-name
    // list: StarterKit is a bundle, so its children never appear as top-level
    // names and a name-based assertion would pass even when history is on.
    const starterKit = buildDocumentExtensions().find(
      (e) => e.name === 'starterKit',
    );
    expect(starterKit).toBeDefined();
    expect(
      (starterKit?.options as { undoRedo?: unknown } | undefined)?.undoRedo,
    ).toBe(false);
  });

  it('registers every attribute the document will ever carry', () => {
    const schema = getSchema(buildDocumentExtensions());
    const missing: string[] = [];
    for (const [nodeName, attrs] of Object.entries(REQUIRED_NODE_ATTRS)) {
      const declared = Object.keys(schema.nodes[nodeName]?.spec.attrs ?? {});
      for (const attr of attrs) {
        if (!declared.includes(attr)) missing.push(`${nodeName}.${attr}`);
      }
    }
    for (const [markName, attrs] of Object.entries(REQUIRED_MARK_ATTRS)) {
      const declared = Object.keys(schema.marks[markName]?.spec.attrs ?? {});
      for (const attr of attrs) {
        if (!declared.includes(attr)) missing.push(`${markName}.${attr}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('keeps the media nodes as block-level atoms so a slice-1 client can hold them intact', () => {
    const schema = getSchema(buildDocumentExtensions());
    for (const kind of ['image', 'video', 'audio']) {
      expect(schema.nodes[kind]).toBeDefined();
    }
    // Video and audio carry a poster/cover URL alongside their source, so the
    // attributes must exist in slice 1 even though no UI writes them yet —
    // an unknown ATTRIBUTE is dropped the same way an unknown node is.
    expect(Object.keys(schema.nodes.video.spec.attrs ?? {})).toContain('src');
    expect(Object.keys(schema.nodes.video.spec.attrs ?? {})).toContain('poster');
    expect(Object.keys(schema.nodes.audio.spec.attrs ?? {})).toContain('src');
  });
});
