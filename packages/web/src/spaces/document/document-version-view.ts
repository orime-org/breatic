// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The read-only preview editor that shows snapshots and comparisons
 * (inner#1129 design §7.1, §7.3).
 *
 * It is a second body editor on a private Y.Doc carrying BlockNote's
 * versioning controller and its diff renderer; the live body is never
 * touched by preview, and restoring writes into it through the storage
 * (`document-version-restore.ts`). Loaded only with the panel's chunk.
 */

import { docToBlocks, type BlockNoteEditor } from '@blocknote/core';
import { createVersioningExtension, type createVersioning, type VersionStorage, type VersionViewAdapter } from '@blocknote/core/extensions';
import { DiffVersioningExtension } from '@blocknote/core/y';
import type { Node as PMNode } from '@tiptap/pm/model';
import * as Y from 'yjs';
import { documentBodyFragment } from '@breatic/shared';

import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';
import { documentVersionFoldExtension } from '@web/spaces/document/document-version-fold';
import type { ShownRef } from '@web/spaces/document/document-version-storage';

type Json = Record<string, unknown>;
type Editor = BlockNoteEditor<never, never, never>;

/**
 * A snapshot's JSON as blocks of the preview's own schema.
 * @param editor - The preview editor.
 * @param content - The JSON.
 * @returns The blocks.
 * @throws {RangeError} When the schema cannot hold the JSON.
 */
function blocksOf(editor: Editor, content: Json): never[] {
  return docToBlocks(editor.pmSchema.nodeFromJSON(content)) as never[];
}

/**
 * The adapter showing displays on the preview editor.
 * @param editor - The preview editor.
 * @param options - Where the live body and the shown record are.
 * @param options.live - The live body's document now.
 * @param options.shown - Records what is on screen, for the restore.
 * @param options.onShow - Told after each display is drawn.
 * @returns The adapter.
 */
function previewAdapter(
  editor: Editor,
  options: { live: () => PMNode; shown: ShownRef; onShow: (comparing: boolean) => void },
): VersionViewAdapter<Json> {
  return {
    supportsComparison: true,
    open() {
      const current = { content: options.live().toJSON() as Json, capturedAt: Date.now() };
      // The controller shows nothing until a selection; the preview opens on the current content.
      editor.replaceBlocks(editor.document, blocksOf(editor, current.content));
      options.shown.current = { id: null, content: current.content };
      return {
        current,
        show({ content, comparison, target }) {
          if (comparison) {
            editor.getExtension(DiffVersioningExtension)!.renderDiff(blocksOf(editor, content), blocksOf(editor, comparison.content));
          } else {
            editor.replaceBlocks(editor.document, blocksOf(editor, content));
          }
          options.shown.current = { id: target.type === 'snapshot' ? target.id : null, content };
          options.onShow(comparison !== undefined);
        },
        close() {
          options.shown.current = null;
        },
      };
    },
  };
}

/**
 * Builds the preview editor for one document.
 * @param options - The live body, the storage and the shown record.
 * @param options.live - The live body's document now.
 * @param options.storage - The snapshot storage.
 * @param options.shown - Records what is on screen.
 * @param options.onShow - Told after each display is drawn, with whether it is a comparison.
 * @returns The editor, not yet mounted.
 */
export function buildVersionPreview(options: {
  live: () => PMNode;
  storage: VersionStorage<Json>;
  shown: ShownRef;
  onShow: (comparing: boolean) => void;
}): Editor {
  return buildDocumentEditor({
    fragment: documentBodyFragment(new Y.Doc()),
    extensions: [
      DiffVersioningExtension(),
      documentVersionFoldExtension(),
      createVersioningExtension<Json>((editor) => ({
        adapter: previewAdapter(editor as unknown as Editor, options),
        storage: options.storage,
        // The library scrolls with DOM scrollIntoView; the panel scrolls its own viewport.
        scrollToFirstChange: false,
      }))(),
    ] as never,
  });
}

/** The versioning controller, as the panel drives it. */
export type VersioningController = ReturnType<typeof createVersioning<Json, never>>;

/**
 * The preview editor's versioning controller.
 * @param editor - The preview editor.
 * @returns The controller.
 */
export function versioningOf(editor: Editor): VersioningController {
  return editor.getExtension('versioning') as unknown as VersioningController;
}
