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
 * | `full`, over the ceiling | refused, and handed to the delete executor; what it does not take is told with a toast |
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
import { nextHistoryStep } from '@web/data/yjs/history-step';
import { spaceRefusalMessage, writeSpaceDoc } from '@web/data/yjs/space-write';
import {
  applySpaceDelete,
  planNodeRemoval,
  planSpaceDelete,
  type SpaceDeleteBinding,
  type SpaceDeletePlan,
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
  const bindingOf = (editorView: EditorView): SpaceDeleteBinding =>
    (options.syncKey.getState(editorView.state) as { binding: SpaceDeleteBinding }).binding;

  /**
   * Step 8: writes an accepted plan once the refused dispatch has returned
   * (writing Yjs inside the filter would re-enter dispatch), unless the
   * document changed in between; the sync plugin then redraws the editor and
   * the caret goes to where the deletion started.
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
      const binding = bindingOf(editorView);
      const result = writeSpaceDoc(name, { kind: plan.kind }, () => {
        binding.doc.transact((ytr) => {
          applySpaceDelete(plan, ytr, addToHistory);
        }, options.syncKey);
      });
      if (!result.ok) return;
      const { doc } = editorView.state;
      editorView.dispatch(editorView.state.tr.setSelection(TextSelection.near(doc.resolve(Math.min(plan.at, doc.content.size)), -1)));
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

  return new Plugin({
    key: new PluginKey('spaceSizeFilter'),
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
      const plan = planSpaceDelete(tr, bindingOf(view), { syncKey: options.syncKey, overCeiling: size.overCeiling, deleteTriggered });
      if (plan.ok) {
        execute(view, name, plan, tr.before, tr.getMeta('addToHistory') !== false);
        return false;
      }
      // A machine edit (`addToHistory: false`) is not something the user did,
      // and a composition already refused once has said so.
      if (tr.getMeta('addToHistory') !== false && !(composing && refusedComposition)) {
        const message = size.overCeiling
          ? spaceRefusalMessage('add', 'over_ceiling')
          : spaceRefusalMessage(plan.refusal === 'compound' ? 'compound' : 'add', 'full');
        if (message !== null) toast.warning(message);
      }
      if (composing) refusedComposition = true;
      return false;
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
      return {
        destroy: (): void => {
          editorView.dom.removeEventListener('compositionend', onEnd);
          view = null;
        },
      };
    },
  });
}

/**
 * Runs an undo or redo if the Space's size allows what it does (design 5.2:
 * the kind comes from `nextHistoryStep`; a step with no effect still runs).
 * @param name - The Space document's name, or null for an unregistered one.
 * @param manager - The undo manager the step comes from.
 * @param direction - Which stack.
 * @param run - The step itself.
 * @returns What `run` returned, or true when the step was refused (the press is handled).
 * @throws {Error} Whatever `run` throws.
 */
export function gatedHistoryStep(
  name: string | null,
  manager: Y.UndoManager,
  direction: 'undo' | 'redo',
  run: () => boolean,
): boolean {
  const stack = direction === 'undo' ? manager.undoStack : manager.redoStack;
  if (name === null || stack.length === 0) return run();
  let ran = false;
  const result = writeSpaceDoc(name, { kind: nextHistoryStep(manager, direction).kind }, () => {
    ran = run();
  });
  return result.ok ? ran : true;
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
