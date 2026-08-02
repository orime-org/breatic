// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * No collaborative editor may carry a second undo stack.
 *
 * Collaboration owns history through the shared Yjs undo manager, which tracks
 * only this client's transactions. An editor that ALSO has a local history
 * plugin — StarterKit ships `UndoRedo` on by default — gets a second stack that
 * is blind to who made each change: a peer's edit arrives there as an ordinary
 * local transaction, so one Cmd+Z deletes their paragraph.
 *
 * `buildCollabExtensions` cannot prevent this. The local history belongs to
 * whichever extension set the editor configures, which is the editor's own
 * business and out of reach from the shared module. So the invariant is held
 * here instead.
 *
 * The list is deliberately hard-coded. A new collaborative editor has to be
 * added to it, and being absent from it is precisely the failure this exists
 * to catch — an imported list would grow itself and assert nothing.
 *
 * It does NOT cover every collaborative editor today, and says so where an
 * editor is missing. Claiming otherwise would be worse than the gap.
 *
 * The check builds a real editor rather than reading the extension array,
 * because a preset is ONE entry there: StarterKit's own name is all an array
 * scan sees, and the `undoRedo` it contributes is invisible until the manager
 * expands it. A first version of this test asserted on the array, and switching
 * `undoRedo` back on left it green.
 */

import { describe, it, expect } from 'vitest';
import { Editor, type Extensions } from '@tiptap/core';
import * as Y from 'yjs';

import { buildDocumentExtensions } from '@web/spaces/document/document-extensions';

/** The plugin key a local (non-collaborative) history registers under. */
const LOCAL_HISTORY_PLUGIN = 'undoRedo';

/** Every editor built on the shared collaboration wiring. */
const COLLABORATIVE_EDITORS: ReadonlyArray<{
  name: string;
  build: () => Extensions;
}> = [
  {
    name: 'document body',
    build: () =>
      buildDocumentExtensions({
        fragment: new Y.Doc().getXmlFragment('content'),
      }),
  },
  // The canvas prompt editor composes its list inline inside `PromptEditor`
  // rather than exporting a builder, so it cannot be resolved here. It is safe
  // by construction — it assembles Document / Paragraph / Text by hand and
  // never pulls in StarterKit — and the day it gains a builder it belongs in
  // this list.
];

describe('a collaborative editor', () => {
  for (const target of COLLABORATIVE_EDITORS) {
    it(`has no local history plugin: ${target.name}`, () => {
      const editor = new Editor({ extensions: target.build() });
      // Post-expansion: presets have contributed everything they contribute.
      const names = editor.extensionManager.extensions.map((e) => e.name);
      editor.destroy();

      expect(names).toContain('collaboration');
      expect(names).not.toContain(LOCAL_HISTORY_PLUGIN);
    });
  }
});
