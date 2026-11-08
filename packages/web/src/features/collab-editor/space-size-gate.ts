// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The size cap at the ProseMirror editors bound to a Space document
 * (inner#1790 design 5.3): the transaction filter every editor carries, and
 * the gate their undo and redo commands go through. The document body and
 * the canvas text node body, prompt and lyrics share it.
 *
 * A transaction carrying the editor's own sync key meta came from Yjs (a
 * peer, an undo, the binding, the redraw after an executor write) and always
 * passes; each editor passes its own key, y-prosemirror's for the body and
 * y-tiptap's for the canvas editors. A local transaction:
 *
 * | state | handling |
 * |---|---|
 * | `unknown`, `normal`, `warning` | passes; the sync plugin writes Yjs as usual |
 * | `resyncing` | refused, no toast |
 * | `full` | a deletion of text inside one `XmlText` (its text block's only Y child) passes, y-prosemirror writing it as a delete set; anything else is refused and handed to the delete executor; what it does not take is told with a toast |
 * | over the ceiling | deleting part of one `XmlText` is refused at once; anything else is handed to the executor |
 *
 * While full the filter sees transactions before the sync plugin writes them,
 * so a refused one never reaches Yjs. A transaction a plugin appends after a
 * root (the state passed in is not the view's) is refused silently: what
 * follows a redraw (the chip whitespace fix, BlockNote's id stamping and
 * schema migration) waits until the Space is below its limit.
 *
 * The toast follows what the user did: a refused deletion (Backspace, Delete,
 * cut, recorded as the trigger of the dispatch, or a transaction of plain
 * deletions such as the side menu's) gets the compound sentence; anything
 * else (typing, pasting, Enter, formatting, moving blocks) the add one; over
 * the ceiling the over-ceiling one. The comment highlight sync is refused
 * without one.
 *
 * Backspace in an empty block is taken over before the editor's own keys
 * while full: the block goes whole, instead of first being turned into a
 * paragraph or merged.
 */

import type { Command } from '@tiptap/pm/state';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { Plugin, PluginKey, TextSelection, type Transaction } from '@tiptap/pm/state';
import { AddMarkStep, RemoveMarkStep } from '@tiptap/pm/transform';
import type { EditorView } from '@tiptap/pm/view';
import type * as Y from 'yjs';

import { readDocSize } from '@web/data/yjs/doc-size';
import { runHistoryStep } from '@web/data/yjs/history-step';
import { spaceRefusalMessage, writeSpaceDoc } from '@web/data/yjs/space-write';
import {
  applySpaceDelete,
  planNodeRemoval,
  planSpaceDelete,
  deletesPartOfOneText,
  type SpaceDeletePlan,
  type SpaceDeleteWriteBinding,
} from '@web/features/collab-editor/space-delete-executor';
import { toast } from '@web/lib/toast';

/** What an editor tells the filter about itself. */
export interface SpaceSizeFilterOptions {
  /** The editor's own sync plugin key; its meta marks a transaction from Yjs. */
  readonly syncKey: PluginKey;
  /** The Space document's canonical name, or null when it is not a registered document. */
  readonly docName: () => string | null;
  /**
   * Marks the editor's own extensions keep in step with other Yjs data (the
   * comment mark, which BlockNote rewrites from the thread map): a
   * transaction made only of them is refused without a toast while full.
   */
  readonly derivedMarks?: readonly string[];
}

/**
 * Whether a transaction only adds and removes marks of the given types.
 * @param tr - The transaction.
 * @param marks - Mark type names.
 * @returns True when every step is such a mark step.
 */
function onlyMarks(tr: Transaction, marks: readonly string[]): boolean {
  return marks.length > 0 && tr.steps.length > 0 && tr.steps.every((step) =>
    (step instanceof AddMarkStep || step instanceof RemoveMarkStep) && marks.includes(step.mark.type.name));
}

/**
 * Throws away what the browser wrote into the DOM during a refused
 * composition and redraws it from the state, which never took it.
 *
 * `docView.markDirty` is internal to prosemirror-view: without it
 * `updateState` with an unchanged document finds nothing to do and leaves the
 * composed characters on screen.
 * @param view - The editor view.
 */
function redrawFromState(view: EditorView): void {
  const { docView } = view as unknown as { docView: { markDirty: (from: number, to: number) => void } };
  docView.markDirty(0, view.state.doc.content.size);
  view.updateState(view.state);
}

/**
 * The node Backspace in an empty block removes: the text block, climbing to
 * each wrapper below the document it is the only child of (BlockNote's
 * container, then a nested group it would leave empty).
 * @param view - The editor view.
 * @returns The node's position, or null when the caret is not in an empty block the filter takes.
 */
function emptyBlockAt(view: EditorView): number | null {
  const { selection } = view.state;
  const { $from } = selection;
  if (!selection.empty || !$from.parent.isTextblock || $from.parent.content.size !== 0) return null;
  for (let depth = $from.depth; depth > 0; depth -= 1) {
    const role = $from.node(depth).type.spec['tableRole'] as string | undefined;
    if (role === 'cell' || role === 'header_cell') return null;
  }
  // Whether the schema lets the node go is the executor's check.
  let depth = $from.depth;
  while (depth > 1 && $from.node(depth - 1).childCount === 1) depth -= 1;
  return $from.before(depth);
}

/**
 * The filter for one editor. Build one per editor: it keeps that editor's
 * view, for the executor and for redrawing after a refused composition.
 * @param options - The editor's sync key and document name.
 * @returns The ProseMirror plugin.
 */
export function spaceSizeFilterPlugin(options: SpaceSizeFilterOptions): Plugin {
  let view: EditorView | null = null;
  /** A composition was refused and its characters are still on screen. */
  let refusedComposition = false;
  /** The dispatch running now was triggered by Backspace, Delete or cut. */
  let deleteTriggered = false;

  /**
   * Records that the current event deletes, until its handlers have run.
   */
  const markDeleteTrigger = (): void => {
    deleteTriggered = true;
    // ProseMirror runs every handler of the event in one listener; the mark
    // is gone before the next event.
    queueMicrotask(() => {
      deleteTriggered = false;
    });
  };

  /**
   * The size state the filter acts on.
   * @returns The document name with whether it is full and over its ceiling, or null while the size does not stop writes.
   */
  const fullState = (): { name: string; overCeiling: boolean } | null => {
    const name = options.docName();
    if (name === null) return null;
    const size = readDocSize(name);
    return size.phase === 'full' ? { name, overCeiling: size.overCeiling } : null;
  };

  /**
   * The editor's sync binding.
   * @param editorView - The view.
   * @returns The binding.
   */
  const bindingOf = (editorView: EditorView): SpaceDeleteWriteBinding =>
    (options.syncKey.getState(editorView.state) as { binding: SpaceDeleteWriteBinding }).binding;

  /**
   * Step 8: writes an accepted plan once the refused dispatch has returned
   * (writing Yjs inside the filter would re-enter dispatch), unless the
   * document changed in between.
   * @param editorView - The view.
   * @param name - The document name.
   * @param plan - The plan.
   * @param before - The document it was planned on.
   * @param addToHistory - Whether the deletion goes on the undo stack.
   */
  const execute = (
    editorView: EditorView,
    name: string,
    plan: Extract<SpaceDeletePlan, { ok: true }>,
    before: ProseMirrorNode,
    addToHistory: boolean,
  ): void => {
    queueMicrotask(() => {
      if (editorView.isDestroyed || editorView.state.doc !== before) return;
      applySpaceDelete(name, editorView, bindingOf(editorView), plan, options.syncKey, addToHistory);
    });
  };

  /**
   * Backspace in an empty block while full: the block goes whole and the caret
   * goes to the end of the one before. Not taken in a table cell or where the
   * schema needs the block; the editor's own Backspace then runs.
   * @param editorView - The view.
   * @param state - The size state.
   * @param state.name - The document name.
   * @param state.overCeiling - Whether the Space is over its ceiling.
   * @returns True when taken over.
   */
  const takeEmptyBlock = (editorView: EditorView, { name, overCeiling }: { name: string; overCeiling: boolean }): boolean => {
    const pos = emptyBlockAt(editorView);
    if (pos === null) return false;
    const { doc } = editorView.state;
    const plan = planNodeRemoval(doc, pos, bindingOf(editorView), { syncKey: options.syncKey, overCeiling });
    if (!plan.ok) return false;
    execute(editorView, name, { ...plan, at: TextSelection.near(doc.resolve(pos), -1).from }, doc, true);
    return true;
  };

  // Whether the Yjs transaction whose observers are running now was made by
  // this client, per document the binding writes.
  const localNow = new WeakMap<Y.Doc, boolean>();

  /**
   * Starts telling, for a binding's document, whether a Yjs transaction is
   * this client's own while y-prosemirror redraws from it.
   * @param doc - The binding's document.
   */
  const watchOrigin = (doc: Y.Doc): void => {
    if (localNow.has(doc)) return;
    localNow.set(doc, false);
    doc.on('beforeObserverCalls', (transaction: Y.Transaction) => localNow.set(doc, transaction.local));
  };

  /**
   * After a redraw of this client's own Yjs write, writes what plugins
   * appended to the redraw: y-prosemirror holds its mutex through the redraw
   * and leaves the appended change in ProseMirror only, where any later
   * transaction would write it unjudged. A peer's write is left alone, since
   * every member's editor appends the same change (design 5.3).
   * @param editorView - The view.
   * @param redrawn - The document the sync transaction left.
   */
  const writeAppended = (editorView: EditorView, redrawn: ProseMirrorNode): void => {
    const binding = bindingOf(editorView) as SpaceDeleteWriteBinding & {
      _prosemirrorChanged: (doc: ProseMirrorNode) => void;
      _forceRerender: () => void;
    };
    if (!localNow.get(binding.doc)) return;
    const appended = editorView.state.doc;
    queueMicrotask(() => {
      const name = options.docName();
      if (name === null || editorView.isDestroyed || editorView.state.doc !== appended || appended === redrawn) return;
      const written = writeSpaceDoc(name, { kind: 'add', notify: false }, () =>
        binding.mux(() =>
          binding.doc.transact((ytr) => {
            ytr.meta.set('addToHistory', false);
            binding._prosemirrorChanged(appended);
          }, options.syncKey),
        ),
      );
      if (!written.ok) binding._forceRerender();
    });
  };

  const key = new PluginKey<ProseMirrorNode | null>('spaceSizeFilter');
  // The redraw whose appended change was last handed to `writeAppended`.
  let handled: ProseMirrorNode | null = null;

  return new Plugin<ProseMirrorNode | null>({
    key,
    // The document a sync transaction left, kept through the transactions
    // plugins append to it and cleared by the next one of anyone's.
    state: {
      init: (): ProseMirrorNode | null => null,
      apply: (tr, redrawn): ProseMirrorNode | null => {
        if (tr.getMeta(options.syncKey) !== undefined) return tr.doc;
        return tr.getMeta('appendedTransaction') !== undefined ? redrawn : null;
      },
    },
    props: {
      // DOM handlers run before every plugin's `handleKeyDown`, whatever
      // order the extensions put the keymaps in.
      handleDOMEvents: {
        keydown: (editorView, event): boolean => {
          if (event.key !== 'Backspace' && event.key !== 'Delete') return false;
          markDeleteTrigger();
          const state = event.key === 'Backspace' && !editorView.composing ? fullState() : null;
          if (state === null || !takeEmptyBlock(editorView, state)) return false;
          event.preventDefault();
          return true;
        },
        cut: (): boolean => {
          markDeleteTrigger();
          return false;
        },
      },
    },
    filterTransaction: (tr, state): boolean => {
      if (!tr.docChanged || tr.getMeta(options.syncKey) !== undefined) return true;
      const name = options.docName();
      if (name === null) return true;
      const size = readDocSize(name);
      const composing = view?.composing === true || tr.getMeta('composition') !== undefined;
      if (size.phase === 'resyncing') {
        if (composing) refusedComposition = true;
        return false;
      }
      if (size.phase !== 'full') return true;
      // Step 0: appended after a root, or before the view exists.
      if (view === null || state !== view.state) return false;
      if (onlyMarks(tr, options.derivedMarks ?? [])) return false;
      const binding = bindingOf(view);
      /**
       * Refuses the transaction with a toast, unless a machine made it
       * (`addToHistory: false`) or a composition already refused has said so.
       * @param message - The sentence.
       * @returns False.
       */
      const refuse = (message: string | null): false => {
        if (message !== null && tr.getMeta('addToHistory') !== false && !(composing && refusedComposition)) toast.warning(message);
        if (composing) refusedComposition = true;
        return false;
      };
      // Step 7 before any planning: part of one XmlText.
      if (size.overCeiling && deletesPartOfOneText(tr, binding)) return refuse(spaceRefusalMessage('add', 'over_ceiling'));
      const plan = planSpaceDelete(tr, binding, { syncKey: options.syncKey, overCeiling: size.overCeiling, deleteTriggered });
      if (plan.ok) {
        execute(view, name, plan, tr.before, tr.getMeta('addToHistory') !== false);
        return false;
      }
      return refuse(size.overCeiling
        ? spaceRefusalMessage('add', 'over_ceiling')
        : spaceRefusalMessage(plan.refusal === 'compound' ? 'compound' : 'add', 'full'));
    },
    view: (editorView) => {
      view = editorView;
      /** Redraws once the last composition has ended, if one was refused. */
      const onEnd = (): void => {
        // After ProseMirror's own handler has run for this event.
        setTimeout(() => {
          if (!refusedComposition || editorView.isDestroyed || editorView.composing) return;
          refusedComposition = false;
          redrawFromState(editorView);
        }, 0);
      };
      editorView.dom.addEventListener('compositionend', onEnd);
      /** Watches the binding's document once the sync plugin has made it. */
      const watch = (): void => {
        const binding = (options.syncKey.getState(editorView.state) as { binding?: SpaceDeleteWriteBinding | null } | undefined)?.binding;
        if (binding) watchOrigin(binding.doc);
      };
      watch();
      return {
        update: (updated): void => {
          watch();
          const redrawn = key.getState(updated.state) ?? null;
          if (redrawn === null || redrawn === handled || updated.state.doc === redrawn) return;
          handled = redrawn;
          writeAppended(updated, redrawn);
        },
        destroy: (): void => {
          editorView.dom.removeEventListener('compositionend', onEnd);
          view = null;
        },
      };
    },
  });
}

/**
 * Runs an undo or redo through `runHistoryStep` (design 5.2), which judges
 * what it writes against the Space's size. An empty stack, or a document that
 * is not a registered Space, runs the editor's own command.
 * @param name - The Space document's name, or null for an unregistered one.
 * @param manager - The undo manager the step comes from.
 * @param direction - Which stack.
 * @param run - The editor's own command.
 * @returns What `run` returned, or true once the step was judged (run or refused, the press is handled).
 * @throws {Error} Whatever the step throws.
 */
export function gatedHistoryStep(
  name: string | null,
  manager: Y.UndoManager,
  direction: 'undo' | 'redo',
  run: () => boolean,
): boolean {
  const stack = direction === 'undo' ? manager.undoStack : manager.redoStack;
  if (name === null || stack.length === 0) return run();
  runHistoryStep(name, manager, direction);
  return true;
}

/**
 * A ProseMirror undo or redo command behind the size gate.
 * @param name - Reads the Space document's name.
 * @param manager - The undo manager the command drives.
 * @param direction - Which stack.
 * @param command - The command.
 * @returns The gated command; a dry run (no dispatch) asks the command itself.
 */
export function gatedHistoryCommand(
  name: () => string | null,
  manager: Y.UndoManager,
  direction: 'undo' | 'redo',
  command: Command,
): Command {
  return (state, dispatch, view) => {
    if (dispatch === undefined) return command(state, dispatch, view);
    return gatedHistoryStep(name(), manager, direction, () => command(state, dispatch, view));
  };
}
