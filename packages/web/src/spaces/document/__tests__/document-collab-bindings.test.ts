// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * #904 验收 A22 的接线那半: what the shared collaboration layer can still
 * find on a BlockNote editor.
 *
 * The shared collaboration readers resolve those plugins through
 * `collab-plugin-keys.ts`, and a resolution that misses is silent in every one
 * of them — so whether the plugins are registered at all, and how many of each,
 * is worth asserting rather than assuming.
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

    // Compared against the keys this test imports rather than against a
    // literal name, because the SUFFIX is a property of the run rather than of
    // the build: `PluginKey` numbers a repeated name off a table in
    // `prosemirror-state`, and both y-prosemirror and `@tiptap/y-tiptap` ask
    // for `y-sync`. What the build guarantees is one plugin of each, which is
    // what is asserted.
    expect(
      names.filter((name) => name === keyName(ySyncPluginKey)),
    ).toHaveLength(1);
    expect(
      names.filter((name) => name === keyName(yUndoPluginKey)),
    ).toHaveLength(1);
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
