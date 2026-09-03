// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * #904 验收 A22 的接线那半: what the shared collaboration layer can still
 * find on a BlockNote editor.
 *
 * `collab-plugin-keys.ts` locates y-prosemirror's plugins by NAME rather than
 * by importing their keys, and says so in its own header — a lookup that
 * misses is silent, so whether those two names are still there is a fact worth
 * asserting rather than assuming.
 *
 * The identity invariant is here too. #1886 delivered "this client never
 * states who it is": the id is written by the server from a validated
 * credential, and a client announcing its own would be announcing something
 * nobody verified. BlockNote's cursor extension writes
 * `awareness.setLocalStateField('user', ...)` unconditionally in its factory
 * body (`YCursorPlugin.ts:72-86`), reached before any `disableExtensions` check
 * (`ExtensionManager/index.ts:154-162`) — so the invariant is kept by never
 * handing it an awareness, which is a structural answer rather than a race to
 * clear a frame that was already broadcast.
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as Y from 'yjs';

import { documentBodyFragment } from '@breatic/shared';

import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';
import {
  Y_SYNC_PLUGIN_KEY_NAME,
  Y_UNDO_PLUGIN_KEY_NAME,
} from '@web/features/collab-editor/collab-plugin-keys';

const mounted: ReturnType<typeof buildDocumentEditor>[] = [];

afterEach(() => {
  mounted.splice(0).forEach((editor) => {
    editor.unmount();
  });
});

/**
 * Opens an editor over a fresh document.
 * @returns The editor and the Yjs doc behind it.
 */
function open(): {
  editor: ReturnType<typeof buildDocumentEditor>;
  doc: Y.Doc;
  } {
  const doc = new Y.Doc();
  const editor = buildDocumentEditor({
    fragment: documentBodyFragment(doc),
  });
  const root = document.createElement('div');
  document.body.appendChild(root);
  editor.mount(root);
  mounted.push(editor);
  return { editor, doc };
}

/** Every plugin key name registered on the editor's state. */
function pluginKeyNames(
  editor: ReturnType<typeof buildDocumentEditor>,
): string[] {
  return editor.prosemirrorView!.state.plugins.map(
    (plugin) => (plugin as unknown as { key: string }).key,
  );
}

describe('the plugin names the shared layer looks up', () => {
  it('still finds the sync and undo plugins by name', () => {
    const { editor } = open();
    const names = pluginKeyNames(editor);

    expect(names).toContain(Y_SYNC_PLUGIN_KEY_NAME);
    expect(names).toContain(Y_UNDO_PLUGIN_KEY_NAME);
  });

  it('registers exactly one of each, so no lookup lands on a second copy', () => {
    // A duplicate copy in the bundle mints the second key as `y-sync$1`, and
    // the name lookup then answers with whichever registered first.
    const { editor } = open();
    const names = pluginKeyNames(editor);

    expect(names.filter((name) => name === Y_SYNC_PLUGIN_KEY_NAME)).toHaveLength(
      1,
    );
    expect(names.filter((name) => name === Y_UNDO_PLUGIN_KEY_NAME)).toHaveLength(
      1,
    );
    expect(names.filter((name) => name.startsWith('y-sync$1'))).toHaveLength(0);
  });
});

describe('A22 — this client never states who it is', () => {
  it('registers no cursor plugin of BlockNote’s own', () => {
    // `YCursorPlugin.ts:72-86` writes the user onto awareness in the factory
    // body and registers the plugin from the same block, both guarded by
    // having found an awareness through `options.provider`. No plugin here is
    // therefore the observable half of no write: the two share one condition,
    // and this build never passes a provider.
    const { editor } = open();
    const names = pluginKeyNames(editor);
    // `PluginKey('yjs-cursor')` registers under `yjs-cursor$`; the two names
    // asserted above carry the same suffix, and looking for the bare string
    // would find nothing whether the plugin is there or not.
    expect(names.some((name) => name.startsWith('yjs-cursor'))).toBe(false);
  });
});
