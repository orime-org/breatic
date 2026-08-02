// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Opening a document must not change it.
 *
 * In a single-user editor, a plugin that quietly repairs the document — appends
 * a trailing paragraph, fills in a missing block — is a convenience. Bound to a
 * shared Yjs document it is something else: the repair becomes a write that
 * broadcasts to everyone, lands on the writer's undo stack, and happens again
 * on the next client to open the file.
 *
 * Two consequences, both of which this file pins:
 *
 * A reader who opens a document changes it. The editor is set non-editable for
 * a viewer, which stops KEYSTROKES — it does not stop a plugin's own
 * appendTransaction, and the server silently drops the update rather than
 * erroring, so the viewer ends up permanently one paragraph ahead of everyone
 * else with nothing to signal it.
 *
 * And the repair revives the exact defect the seeded body exists to prevent:
 * the appended paragraph is on the undo stack, so undoing back past it removes
 * it, the next ordinary click re-appends it as a fresh local edit, and the redo
 * stack is cleared — the text just undone is unrecoverable.
 *
 * ## What these tests can and cannot reach
 *
 * An earlier version loaded a body ending in a heading, because TrailingNode
 * appends a paragraph whenever the last block is not one. That scenario is gone
 * with the heading: this slice registers no block type but the paragraph, so no
 * client can produce such a body and none would keep it if one arrived —
 * y-tiptap deletes what its schema cannot name.
 *
 * **TrailingNode is therefore unreachable here, and these tests do not cover
 * it** — measured, not assumed: with `trailingNode: false` removed the
 * extension really does enter the tree, and all of this still passes, because a
 * ProseMirror doc always holds at least one block and that block can only be a
 * paragraph. It stays switched off in `document-extensions.ts` so the next
 * slice does not inherit it enabled, and the reasoning lives there.
 *
 * What is left reachable is the SEED, and that is what these tests pin: the
 * empty body is the one case where opening a document legitimately writes to
 * it, so the two conditions on that write — only from a client allowed to
 * write, and never onto the undo stack — are the whole of the risk this slice
 * carries.
 *
 * **The slice that registers a block type must bring the other scenario back**
 * — a body ending in that block, opened by a viewer and by an editor.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';

import { resolvePaletteHex, userPaletteHue } from '@web/lib/user-color';
import {
  _resetDocumentEditorCacheForTests,
  getDocumentEditor,
} from '@web/spaces/document/document-editor-cache';
import { documentBodyFragment } from '@web/spaces/document/document-yjs';
import { useDocumentEditor } from '@web/spaces/document/use-document-editor';

const HUE = userPaletteHue('test-user');
const CARET_USER = { name: 'Tester', color: resolvePaletteHex(HUE), hue: HUE };
const NAME = 'project-p/document-s';

describe('opening a document does not write to it', () => {
  let doc: Y.Doc;
  let awareness: Awareness;

  beforeEach(() => {
    doc = new Y.Doc();
    awareness = new Awareness(doc);
  });
  afterEach(() => {
    _resetDocumentEditorCacheForTests();
    awareness.destroy();
    doc.destroy();
  });

  /**
   * Load someone else's content, the way a peer or the server would deliver it.
   * @param text - Text for the single paragraph.
   */
  function loadBody(text: string): void {
    const source = new Y.Doc();
    const body = documentBodyFragment(source);
    const para = new Y.XmlElement('paragraph');
    para.insert(0, [new Y.XmlText(text)]);
    body.insert(0, [para]);
    // A remote origin: this is someone else's content arriving, not our edit.
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(source), 'remote-provider');
    source.destroy();
  }

  /**
   * Mounts the editor over the shared doc.
   * @param editable - Whether this client may type.
   * @returns The rendered hook.
   */
  function mount(editable: boolean) {
    return renderHook(() =>
      useDocumentEditor({
        doc,
        name: NAME,
        caretProvider: { awareness },
        caretUser: CARET_USER,
        hasEverSynced: true,
        editable,
      }),
    );
  }

  /**
   * Record every update this client originates — anything not tagged remote.
   * @returns The recorded updates, and a function to stop recording.
   */
  function recordLocalWrites(): {
    writes: Uint8Array[];
    stop: () => void;
    } {
    const writes: Uint8Array[] = [];
    const record = (update: Uint8Array, origin: unknown): void => {
      if (origin !== 'remote-provider') writes.push(update);
    };
    doc.on('update', record);
    return {
      writes,
      stop: (): void => {
        doc.off('update', record);
      },
    };
  }

  /**
   * Let any appendTransaction settle — a repair fires on the first dispatch,
   * and the binding dispatches one of its own on bind.
   */
  async function settle(): Promise<void> {
    await new Promise((r) => setTimeout(r, 50));
  }

  it('leaves an existing body exactly as it found it', async () => {
    loadBody('real body text');
    const body = documentBodyFragment(doc);
    const before = body.toString();
    expect(body.length).toBe(1);

    const rendered = mount(true);
    await waitFor(() => expect(rendered.result.current).not.toBeNull());
    await settle();

    expect(body.length).toBe(1);
    expect(body.toString()).toBe(before);
  });

  it('writes nothing at all from a read-only client, empty body included', async () => {
    // No `loadBody`: an empty body is where a repair still has something to
    // repair, and a viewer is who must not be the one repairing it.
    const recorder = recordLocalWrites();

    const rendered = mount(false);
    await waitFor(() => expect(rendered.result.current).not.toBeNull());
    await settle();
    recorder.stop();

    // A viewer has no way to be told their write was refused: the server drops
    // it without an error, so any update here is a permanent local divergence.
    expect(recorder.writes).toHaveLength(0);
    expect(documentBodyFragment(doc).length).toBe(0);
  });

  it('leaves nothing on the undo stack just from opening', async () => {
    const rendered = mount(true);
    await waitFor(() => expect(rendered.result.current).not.toBeNull());
    await settle();

    const handle = rendered.result.current as NonNullable<
      ReturnType<typeof useDocumentEditor>
    >;
    // An editable client DOES write here — `seedEmptyBody` gives the empty body
    // its one paragraph. That write is stamped with a seed origin the undo
    // manager does not track, so it must not be undoable: a user whose first
    // Cmd+Z empties the document is back at the disagreement the seed exists to
    // remove. Anything else on this stack is an edit attributed to whoever
    // opened the file, and undoing past it is what clears the redo stack.
    expect(documentBodyFragment(doc).length).toBe(1);
    expect(handle.undoManager.undoStack).toHaveLength(0);
  });
});

describe('editability is settled before the first paint', () => {
  // TipTap defaults to editable, and the effect in `useDocumentEditor` that
  // keeps it in step runs AFTER the first paint — so a viewer would get a
  // `contenteditable` document for a frame unless it is set at construction.
  // On a cache HIT the construction inputs are ignored by design, so that path
  // needs its own correction.
  //
  // Asserted against `getDocumentEditor` directly, NOT through the hook: the
  // hook's effect runs synchronously inside `renderHook`, so a hook-level
  // assertion reads the value AFTER the correction and passes even with both
  // fixes removed. (Confirmed — a first version of this did exactly that.)
  let doc: Y.Doc;
  let awareness: Awareness;

  beforeEach(() => {
    doc = new Y.Doc();
    awareness = new Awareness(doc);
  });
  afterEach(() => {
    _resetDocumentEditorCacheForTests();
    awareness.destroy();
    doc.destroy();
  });

  /**
   * Resolve the editor the way the hook does, and report editability as built.
   * @param editable - What the caller asks for.
   * @returns Whether the resolved editor accepts typing.
   */
  function resolve(editable: boolean): boolean {
    return getDocumentEditor(doc, NAME, {
      caretProvider: { awareness },
      caretUser: CARET_USER,
      editable,
    }).editor.isEditable;
  }

  it('a viewer never gets an editable document, not even for a frame', () => {
    expect(resolve(false)).toBe(false);
  });

  it('and the same holds when the editor comes from the cache', () => {
    // Someone editable opened it first; a viewer reopening the same document
    // gets that same instance back.
    expect(resolve(true)).toBe(true);
    expect(resolve(false)).toBe(false);
  });
});
