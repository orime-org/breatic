// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The document editor, cached per document instead of per component.
 *
 * **Why the editor and not just its history.** The body that renders the
 * editor can unmount while its tab keeps the document open — StrictMode mounts
 * it twice. (The notices `DocumentSpace` shows in its place are not such a
 * case: the refused one shows only before any content, when no editor has been
 * built, and the schema one evicts the editor.) An editor owned by
 * that component dies with it. The text survives, because it is in the Y.Doc;
 * the undo stack, the selection and any in-flight input-method composition do
 * not. A switch of Space tab is not among these: it hides the body and keeps it.
 *
 * The narrower response is to rescue the undo stack alone, by handing the
 * collaboration a manager built to outlive the editor. That was tried and it is
 * a dead end. The binding assumes the manager belongs to its editor and
 * releases its subscriptions by destroying it outright — `yUndoPlugin`'s view
 * teardown calls `undoManager.destroy()` (`y-prosemirror.cjs:2182-2183`) — so a
 * manager that refuses to die accumulates a listener pair per rebuild, each
 * pinning a dead editor view, while one that lets the teardown run loses its
 * document attachment. Three shapes, three failures, one cause: the assumption
 * being fought is upstream's, and it is a reasonable one.
 *
 * Letting the editor outlive the body drops the fight. The manager then
 * belongs to its editor exactly as upstream expects.
 *
 * **What makes the hand-off work here.** `unmount()` is a teardown rather than
 * a detach: it runs the plugin views' destroy, and two of those take the
 * collaboration apart — the sync plugin's calls `binding.destroy()`
 * (`y-prosemirror.cjs:309-310`), the undo plugin's the line above. So the body
 * must never unmount on its way out.
 *
 * Mounting a second time is not the other half of that, though it reads like
 * it: `mount()` builds a NEW view without taking the old one down
 * (`@tiptap/core`'s `Editor.mount` builds one without taking any down: the
 * rest of what it does — an environment check, two events, appending `css` to
 * the head, and a deferred `focus` — leaves the previous view running), and
 * inside `createView` the assignment `this.editorView = new EditorView(...)`
 * runs the constructor BEFORE the field is updated — so any plugin view that
 * dispatches while the view is being built reaches an editor still pointing at
 * the old one. The sync plugin dispatches exactly there: its view calls
 * `_forceRerender()`, which replaces the whole document from Yjs
 * (`sync-plugin.js:190-194`). Measured on a document with content in it:
 * `RangeError: Applying a mismatched transaction`, and the old view's plugin
 * views never destroyed — the language listener among them, left dispatching
 * into a view nobody reads.
 *
 * So the editor is mounted ONCE, into a surface this cache owns, and the
 * hand-off moves that surface between containers. Nothing about the editor is
 * rebuilt, which is what the previous shape was reaching for.
 *
 * Evicting a closed tab's editor IS that teardown, which is why this file
 * unmounts there and nowhere else.
 */

import type * as Y from 'yjs';
import type { BlockNoteEditor } from '@blocknote/core';

import { documentBodyFragment, t } from '@breatic/shared';

import { assetsApi } from '@web/data/api/assets';
import { uploadMedia } from '@web/data/upload/media-upload';
import { toast } from '@web/lib/toast';
import { useSpaceOperationsStore } from '@web/stores/space-operations';

import { createDocScopedCache } from '@web/data/yjs/doc-scoped-cache';
import type { ResolveCollaboratorName } from '@web/features/collab-editor/caret-render';
import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';
import type { DocumentCommentAuthInput } from '@web/spaces/document/document-comment-auth';
import { viewOf } from '@web/spaces/document/document-editor-view';
import { documentChordsExtension } from '@web/spaces/document/document-block-chords';
import { documentCaretExtension } from '@web/spaces/document/document-caret';
import { documentDecorationsExtension } from '@web/spaces/document/document-decorations';
import { documentLocaleRedrawExtension } from '@web/spaces/document/document-locale-redraw';
import { documentPlaceholderExtension } from '@web/spaces/document/document-placeholders-blocknote';
import { documentSelectAllExtension } from '@web/spaces/document/document-select-all-guard';
import {
  createDocumentUndo,
} from '@web/spaces/document/document-undo-blocknote';
import { marksStayOnTextExtension } from '@web/spaces/document/document-marks-on-text';
import { documentFallbackExtension } from '@web/spaces/document/document-unsupported-blocknote';
import { documentUploadsExtension } from '@web/spaces/document/document-upload-slots';
import {
  createDocumentUploader,
  type DocumentUploader,
} from '@web/spaces/document/document-uploads';
import type { FilesArrival } from '@web/spaces/document/document-file-input';

/** The editor plus what is handed out alongside it. */
export interface DocumentEditorHandle {
  /** The live editor, owned by this cache rather than by any component. */
  editor: BlockNoteEditor<never, never, never>;
  /**
   * The element the editor's DOM lives in, for a body to adopt.
   *
   * Owned here rather than by the body, because it is what carries the editor
   * across a remount of the body — see the module comment for what mounting a
   * second time does instead. Bodies reach it through
   * {@link adoptDocumentEditor}.
   */
  surface: HTMLElement;
  /**
   * The editor's undo manager, held rather than looked up. Its readers are the
   * tests, which assert on the undo stack directly; the extensions get it from
   * the local it is built in.
   */
  undoManager: Y.UndoManager;
  /**
   * Subscribe to the guarded whole-document delete asking for confirmation.
   *
   * The ask is wired into the extensions at construction, and the editor
   * outlives any one mount — so the extension cannot hold a component's
   * callback. It emits here instead, and whichever `DocumentSpace` is mounted
   * subscribes for its lifetime and shows the dialog.
   * @param listener - Called each time the delete keys land on a
   *   whole-document selection.
   * @returns Unsubscribe.
   */
  onClearDocumentRequest: (listener: () => void) => () => void;
  /**
   * What takes files into this body (inner#1127), or null for an editor built
   * with nowhere to upload them to.
   */
  uploader: DocumentUploader | null;
}

/** Where a body's uploads land. */
export interface DocumentUploadTarget {
  readonly projectId: string;
  readonly spaceId: string;
}

/**
 * What the editor needs at construction and can never be given again.
 *
 * The caret wiring is baked into the extension list when the editor is built,
 * and the editor is built once per document. The caret layer therefore mounts
 * only once its provider exists, which is why the caller waits for one rather
 * than building an editor without carets and rebuilding later.
 */
export interface DocumentEditorInputs {
  /** Provider whose awareness carries collaborator carets. */
  caretProvider: { awareness: unknown };
  /** Resolves collaborators' display names from the project roster (#1882). */
  resolveCollaboratorName?: ResolveCollaboratorName;
  /**
   * Who is reading, for every question the comment store asks.
   *
   * A reading rather than a value, and it has to stay one: the editor is
   * built once and this interface is ignored on a cache hit, so a role
   * captured here would be the role this document was first opened with.
   */
  readWho: () => DocumentCommentAuthInput;
  /**
   * Whether this client may type.
   *
   * Unlike the rest of this interface it is honoured on a cache HIT too — see
   * {@link getDocumentEditor}. It cannot wait for the effect that keeps it in
   * step, because the editor defaults to editable and that effect runs after
   * the first paint.
   */
  editable: boolean;
  /**
   * Where files put into this body are uploaded to. Left out, the body takes
   * no files: a drop or a paste of one does nothing.
   */
  uploadTarget?: DocumentUploadTarget;
}

/**
 * The uploader for a body whose uploads land in this project and Space.
 * @param target - Where they land.
 * @param undoManager - The body's undo manager.
 * @returns The uploader.
 */
function uploaderFor(target: DocumentUploadTarget, undoManager: Y.UndoManager): DocumentUploader {
  const operations = useSpaceOperationsStore.getState();
  return createDocumentUploader({
    maxUploadBytes: () =>
      assetsApi
        .fetchUploadConfig()
        .then((cfg) => cfg.maxUploadBytes)
        // The ticket endpoint refuses an oversize file itself; a cap that
        // could not be read only skips the early refusal.
        .catch(() => Infinity),
    upload: (file, onProgress) =>
      uploadMedia(file, { projectId: target.projectId, spaceId: target.spaceId }, onProgress),
    register: (id) => {
      operations.register(target.spaceId, id);
    },
    unregister: (id) => {
      operations.unregister(target.spaceId, id);
    },
    refuse: (key, params) => {
      toast.warning(t(key, params));
    },
    undo: undoManager,
  });
}

/**
 * Build the editor for a document.
 * @param doc - The document Space's Y.Doc.
 * @param inputs - Construction-time collaborative wiring.
 * @returns The editor and its undo manager.
 */
function createDocumentEditor(
  doc: Y.Doc,
  inputs: DocumentEditorInputs,
): DocumentEditorHandle {
  const { manager: undoManager, extension: undoExtension } =
    createDocumentUndo(doc);
  const clearListeners = new Set<() => void>();
  const target = inputs.uploadTarget;
  const uploader = target === undefined ? null : uploaderFor(target, undoManager);
  if (uploader !== null) {
    // Fetched now so a paste can tell our media from outside links the moment
    // it lands (inner#1127 A18). A fetch that fails leaves every pasted
    // medium out until a later fetch lands, which an upload also makes.
    void assetsApi.fetchUploadConfig().catch(() => undefined);
  }

  const editor = buildDocumentEditor({
    fragment: documentBodyFragment(doc),
    comments: { doc, readWho: inputs.readWho },
    ...(uploader !== null && {
      onFiles: (arrival: FilesArrival) => {
        const view = viewOf(editor);
        if (view !== null) {
          void uploader.start(view, arrival.files, () => arrival);
        }
      },
    }),
    media: {
      assetUrlPrefix: () => assetsApi.cachedUploadConfig()?.assetUrlPrefix ?? null,
      onLeftOut: (count) => {
        toast.warning(t('spaces.document.media.leftOut', { count }));
      },
    },
    extensions: [
      // The awareness is withheld from BlockNote's own collaboration wiring and
      // handed to this plugin instead; `build-document-editor` carries why.
      documentCaretExtension(
        inputs.caretProvider.awareness as never,
        inputs.resolveCollaboratorName,
      ),
      undoExtension,
      documentSelectAllExtension(() => {
        clearListeners.forEach((listener) => {
          listener();
        });
      }),
      documentChordsExtension(),
      documentDecorationsExtension(),
      documentFallbackExtension(),
      marksStayOnTextExtension(),
      documentPlaceholderExtension(),
      documentLocaleRedrawExtension(),
      documentUploadsExtension(),
    ],
  });

  // Not mounted yet: BlockNote reads the surface's parent to decide where its
  // floating UI portals to, and a surface with no parent would send it to the
  // page body. `adoptDocumentEditor` mounts once the surface is in place.
  const surface = document.createElement('div');

  return {
    editor,
    undoManager,
    surface,
    uploader,
    onClearDocumentRequest: (listener) => {
      clearListeners.add(listener);
      return () => {
        clearListeners.delete(listener);
      };
    },
  };
}

const cache = createDocScopedCache<DocumentEditorHandle, DocumentEditorInputs>(
  createDocumentEditor,
  (handle) => {
    handle.editor.unmount();
    handle.surface.remove();
  },
);

/** An editor and the surface it lives on — all a body needs to show one. */
export type ShowableEditor = Pick<DocumentEditorHandle, 'editor' | 'surface'>;

/**
 * Put a document's editor inside a container, mounting it the first time.
 *
 * The surface moves, and the floating UI portal with it; the editor is never
 * mounted twice. What that costs to get
 * wrong is in the module comment — a rebuilt view, a mismatched transaction,
 * and the old view's plugin views left running.
 *
 * Adopting into a container that already holds the surface — StrictMode's
 * double-invoked effect, and a Space shown again — leaves it where it is.
 * `appendChild` always takes a node out and puts it back, and that resets
 * every scroll position inside it, a wide table's frame among them.
 * @param handle - The handle {@link getDocumentEditor} returned.
 * @param container - The element that should hold the editor's DOM.
 */
export function adoptDocumentEditor(
  handle: ShowableEditor,
  container: HTMLElement,
): void {
  if (handle.surface.parentElement === container) return;
  container.appendChild(handle.surface);
  // `mount()` is what builds the view, so its absence is what "not yet
  // mounted" means. Asking the editor is more direct than a flag here that
  // would have to be kept in step with it.
  if (viewOf(handle.editor) === null) {
    handle.editor.mount(handle.surface);
  }
  // `mount()` appended the floating UI portal to the container it found the
  // surface in, and nothing moves it after that. The block strip renders into
  // it, so a portal left in a previous container leaves the page with it.
  container.appendChild(handle.editor.portalElement);
}

/**
 * Get-or-create the editor for a document.
 * @param doc - The document Space's Y.Doc; pass the one `getDoc(name)` returns.
 * @param name - The canonical document name (cache key).
 * @param inputs - Construction-time wiring; ignored if an editor already exists.
 * @returns The cached (or newly built) editor and its undo manager.
 */
export function getDocumentEditor(
  doc: Y.Doc,
  name: string,
  inputs: DocumentEditorInputs,
): DocumentEditorHandle {
  const handle = cache.get(doc, name, inputs);
  // Editability is settled HERE, on the way out, and nowhere else. The editor
  // defaults to editable and the effect in `useDocumentEditor` that keeps it in
  // step runs after the first paint, so a viewer would otherwise get a writable
  // document for a frame. Setting it at construction would only cover a fresh
  // editor — on a cache HIT the inputs are ignored by design, because
  // rebuilding would discard the undo stack and the selection. One correction
  // covering both paths beats two that overlap.
  if (handle.editor.isEditable !== inputs.editable) {
    handle.editor.isEditable = inputs.editable;
  }
  return handle;
}

/**
 * Destroy and drop the editor for a document. Called when a tab closes, so
 * reopening the Space starts with a fresh editor and an empty history.
 * @param name - The canonical document name to evict.
 */
export function evictDocumentEditor(name: string): void {
  cache.evict(name);
}

/** Reset the cache (test helper — not for production use). */
export function _resetDocumentEditorCacheForTests(): void {
  cache.reset();
}
