// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * #904 验收 S2b ②：the one assembly that gets every key right.
 *
 * `withCollaboration` merges `extensions` and `disableExtensions` from ITS OWN
 * argument and overwrites `initialContent`, so anything we want in those keys
 * has to travel through it. Both wrong spreads fail silently and in opposite
 * directions, measured on real editors:
 *
 * ```
 * ours before the spread : mark=true ysync=true pmHistory=false placeholder=1
 * through                : mark=true ysync=true pmHistory=false placeholder=0
 * ours after the spread  : mark=true ysync=true pmHistory=true  placeholder=0
 * ```
 *
 * `mark` and `ysync` are true in every row — asserting only those two, which
 * is what the first draft of this item did, sees neither failure. The four
 * assertions below are what separates them.
 *
 * The identity assertion is here for the same reason: `CollaborationOptions`
 * requires a `user`, and the cursor plugin writes it onto awareness the moment
 * it can reach one — measured, one frame at construction. #1886's invariant is
 * that this client never states who it is. Withholding the provider is what
 * makes the write structurally impossible rather than a matter of timing.
 */

import { describe, it, expect } from 'vitest';
import { Mark } from '@tiptap/core';
import { createExtension } from '@blocknote/core';
import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';

import { documentBodyFragment } from '@breatic/shared';

import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';

/** A stand-in for the cross-version fallback mark, which lands in step 4. */
const SentinelMark = Mark.create({ name: 'assemblySentinel' });

const Sentinel = createExtension(() => ({
  key: 'assemblySentinel',
  tiptapExtensions: [SentinelMark],
}) as never);

/**
 * Reads the plugin keys off a mounted editor.
 * @param editor - The editor to inspect.
 * @returns Every plugin key as a string.
 */
function pluginKeys(
  editor: ReturnType<typeof buildDocumentEditor>,
): readonly string[] {
  return editor.prosemirrorState.plugins.map((p) =>
    String((p as unknown as { key: string }).key),
  );
}

/**
 * Builds an editor over a fresh doc, mounted, with the sentinel registered.
 * @returns The editor, its doc and its awareness.
 */
function open(): {
  editor: ReturnType<typeof buildDocumentEditor>;
  doc: Y.Doc;
  awareness: Awareness;
  } {
  const doc = new Y.Doc();
  const awareness = new Awareness(doc);
  const editor = buildDocumentEditor({
    fragment: documentBodyFragment(doc),
    extensions: [Sentinel()],
  });
  editor.mount(document.createElement('div'));
  return { editor, doc, awareness };
}

describe('the document editor assembly', () => {
  it('keeps the extensions we passed in', () => {
    const { editor, doc, awareness } = open();
    expect(editor.pmSchema.marks['assemblySentinel']).toBeDefined();
    awareness.destroy();
    doc.destroy();
  });

  it('registers the Yjs sync plugin', () => {
    const { editor, doc, awareness } = open();
    expect(pluginKeys(editor).some((k) => k.includes('y-sync'))).toBe(true);
    awareness.destroy();
    doc.destroy();
  });

  it('leaves ProseMirror\'s history plugin out, since y-undo owns undo here', () => {
    const { editor, doc, awareness } = open();
    const keys = pluginKeys(editor);
    expect(keys.some((k) => k.includes('y-undo'))).toBe(true);
    expect(keys.some((k) => k === 'history$')).toBe(false);
    awareness.destroy();
    doc.destroy();
  });

  it('leaves BlockNote\'s placeholder out, since ours draws the placeholder', () => {
    const { editor, doc, awareness } = open();
    expect(
      pluginKeys(editor).filter((k) => k.toLowerCase().includes('placeholder')),
    ).toEqual([]);
    awareness.destroy();
    doc.destroy();
  });

  it('never states who this client is on awareness', () => {
    const doc = new Y.Doc();
    const awareness = new Awareness(doc);
    const frames: unknown[] = [];
    awareness.on('update', () => {
      const local = awareness.getLocalState();
      frames.push(local === null ? null : local['user']);
    });

    const editor = buildDocumentEditor({
      fragment: documentBodyFragment(doc),
      extensions: [Sentinel()],
    });
    editor.mount(document.createElement('div'));

    expect(frames).toEqual([]);
    expect(awareness.getLocalState()).toEqual({});

    awareness.destroy();
    doc.destroy();
  });
});
