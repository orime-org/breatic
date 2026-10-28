// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * #904 验收 A22: closing a document does not leave a transaction in flight.
 *
 * y-prosemirror batches the metas it puts on transactions — a remote user
 * arriving or leaving, a sync state changing — into one pass on the next tick
 * (`lib.js:39`). Between the `setMeta` and that tick a reader can close the
 * Space, and the pass then dispatches into an editor that is gone.
 *
 * It means to check for that. `updateMetas` guards on
 * `!syncState.binding.isDestroyed`, and `isDestroyed` is a property no code in
 * `sync-plugin.js` ever assigns — the guard reads `undefined` every time and
 * lets every batch through. The binding says it is finished by null-ing its
 * `prosemirrorView`, which is what its own `destroy()` reads on the first line
 * to make itself idempotent.
 *
 * What reaches the reader is an uncaught `RangeError: Applying a mismatched
 * transaction`, and what reaches CI is a red run: the test runner counts an
 * unhandled rejection as a failure however many cases passed.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { setMeta, ySyncPluginKey } from 'y-prosemirror';
import * as Y from 'yjs';

import { documentBodyFragment } from '@breatic/shared';

import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';

const roots: HTMLElement[] = [];

afterEach(() => {
  roots.splice(0).forEach((root) => {
    root.remove();
  });
  vi.useRealTimers();
});

/**
 * Opens a mounted editor on its own document.
 * @returns The editor and the root it is mounted in.
 */
function open(): ReturnType<typeof buildDocumentEditor> {
  const editor = buildDocumentEditor({
    fragment: documentBodyFragment(new Y.Doc()),
  });
  const root = document.createElement('div');
  document.body.appendChild(root);
  roots.push(root);
  editor.mount(root);
  return editor;
}

describe('a meta batch that lands after the editor closed', () => {
  it('writes nothing, and the binding says it is finished', () => {
    vi.useFakeTimers();
    const editor = open();
    const view = editor.prosemirrorView!;

    // What a peer arriving or leaving does: queue a meta for the next tick.
    setMeta(view, ySyncPluginKey, { isChangeOrigin: true });

    editor.unmount();

    const binding = (
      ySyncPluginKey.getState(view.state) as {
        binding: { prosemirrorView: unknown };
      }
    ).binding;
    expect(
      binding.prosemirrorView,
      'the binding is torn down by unmount',
    ).toBeNull();

    // Counted from here, so the teardown's own dispatches are not in it.
    const dispatched = vi.spyOn(view, 'dispatch');

    vi.runAllTimers();

    expect(dispatched).not.toHaveBeenCalled();
  });
});
