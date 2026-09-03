// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * #904 验收 A22 的接线那半: what the shared collaboration layer can still
 * find on a BlockNote editor.
 *
 * `collab-plugin-keys.ts` locates y-prosemirror's plugins by NAME rather than
 * by importing their keys, and says so in its own header — a lookup that
 * misses is silent, so whether those plugins are there at all, and whether the
 * names that file spells still match, are facts worth asserting rather than
 * assuming.
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
import { ySyncPluginKey, yUndoPluginKey } from 'y-prosemirror';

import { documentBodyFragment } from '@breatic/shared';

import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';
import {
  Y_SYNC_PLUGIN_KEY_NAME,
  Y_UNDO_PLUGIN_KEY_NAME,
} from '@web/features/collab-editor/collab-plugin-keys';

/**
 * The string a `PluginKey` registers plugins under, which its type omits.
 * @param key - The plugin key.
 * @returns That string.
 */
function keyName(key: unknown): string {
  return (key as { key: string }).key;
}

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

describe('the plugins the shared layer looks up', () => {
  it('registers the sync and undo plugins, one of each', () => {
    const { editor } = open();
    const names = pluginKeyNames(editor);

    // Compared against the keys this test imports rather than against the
    // string constants, because the SUFFIX is a property of the run rather
    // than of the build. `PluginKey` numbers a repeated name off a table in
    // `prosemirror-state`, and vitest resets the module registry between
    // files while that table can outlive the reset — so a run where
    // y-prosemirror is loaded a second time mints `y-sync$1`, and both this
    // editor and the lookups in `collab-plugin-keys.ts` then agree on that
    // name instead. What the build guarantees is that there is exactly one of
    // each plugin, which is what is asserted.
    expect(
      names.filter((name) => name === keyName(ySyncPluginKey)),
    ).toHaveLength(1);
    expect(
      names.filter((name) => name === keyName(yUndoPluginKey)),
    ).toHaveLength(1);
  });

  it('names them the way `collab-plugin-keys.ts` spells them', () => {
    // The two constants that file exports, checked against the keys the
    // plugins actually carry. A rename upstream turns this red rather than
    // leaving every name lookup silently answering undefined.
    expect(keyName(ySyncPluginKey).startsWith(Y_SYNC_PLUGIN_KEY_NAME)).toBe(
      true,
    );
    expect(keyName(yUndoPluginKey).startsWith(Y_UNDO_PLUGIN_KEY_NAME)).toBe(
      true,
    );
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
