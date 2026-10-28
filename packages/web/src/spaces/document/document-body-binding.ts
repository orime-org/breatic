// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { createExtension, type ExtensionFactoryInstance } from '@blocknote/core';
import { ReadOnlyExtension } from '@blocknote/core/extensions';
import { Extension } from '@tiptap/core';
import { Mark, type Node as PMNode, type Schema } from '@tiptap/pm/model';
import { Plugin, Selection, type EditorState, type Transaction } from '@tiptap/pm/state';
import type { StepMap } from '@tiptap/pm/transform';
import type * as Y from 'yjs';
import { ySyncPluginKey } from 'y-prosemirror';
import { captureException } from '@sentry/react';

import { compileBodyBatch } from '@web/spaces/document/document-body-compiler';
import { projectBodyTree } from '@web/spaces/document/document-body-codec';
import type { BodyProjection } from '@web/spaces/document/document-body-codec-types';
import { BodyJournal } from '@web/spaces/document/document-body-journal';
import { commitPreparedBodyBatch, prepareBodyBatch } from '@web/spaces/document/document-body-plan';
import { nameBodyPoint, nameBodySelection, resolveBodyPoint, resolveBodySelection } from '@web/spaces/document/document-body-positions';
import type { BodyPointName, BodySelectionName } from '@web/spaces/document/document-body-positions-types';
import { BodyStagedNames, stageBodyProjection } from '@web/spaces/document/document-body-staged';
import { isCommentMarkWrite } from '@web/spaces/document/document-comment-undo-filter';
import { BODY_TRANSACTION_SOURCE, documentBodyBindingKey } from '@web/spaces/document/document-body-binding-key';
import type {
  BodyAcceptedBatch,
  BodyAppliedBatch,
  BodyBindingPhase,
  BodyBindingPluginState,
  BoundBodyEditor,
  DocumentBodyBindingAccess,
  DocumentBodyOptions,
} from '@web/spaces/document/document-body-binding-types';

export { bodyBindingOf, transactionSource } from '@web/spaces/document/document-body-binding-key';

const FRAME_META = 'breatic.body.frame';
const RUNTIME_LOCK = 'document-body-runtime';

/** A projection transaction can be recognized only by its actual binding owner. */
interface ProjectionMeta {
  readonly owner: DocumentBodyBinding;
  readonly frame: BodyProjection;
}

/**
 * Aligns the codec's equal immutable root with the actual accepted PM state.
 * @param frame - The legal codec frame.
 * @param doc - The actual transaction document with the same complete content.
 * @returns A frame whose selection and position names belong to that exact root.
 * @throws {Error} If the accepted document differs from the codec's projection.
 */
function adoptProjection(frame: BodyProjection, doc: PMNode): BodyProjection {
  if (!frame.doc.eq(doc)) throw new Error('The accepted projection differs from its native frame');
  return { ...frame, doc, index: { ...frame.index, doc } };
}

/**
 * Moves a document that differs only in node attributes onto the projection
 * in place, so positions and the reader's selection stay where they are.
 * @param transaction - The projection transaction to extend.
 * @param from - The current document.
 * @param to - The projected document.
 * @returns Whether the two shared one shape and the attributes were adopted.
 * @throws {never}
 */
function adoptAttributes(transaction: Transaction, from: PMNode, to: PMNode): boolean {
  const changes: Array<{ pos: number; node: PMNode }> = [];
  /**
   * Compares one node pair and records attribute differences beneath it.
   * @param a - The current node.
   * @param b - The projected node.
   * @param pos - The position before `a`, or -1 for the document.
   * @returns Whether both have the same type, marks, text and children.
   * @throws {never}
   */
  const same = (a: PMNode, b: PMNode, pos: number): boolean => {
    if (a.type !== b.type || a.childCount !== b.childCount || a.text !== b.text || !Mark.sameSet(a.marks, b.marks)) return false;
    if (pos >= 0 && JSON.stringify(a.attrs) !== JSON.stringify(b.attrs)) changes.push({ pos, node: b });
    let shared = true;
    a.forEach((child, offset, index) => { shared &&= same(child, b.child(index), pos + 1 + offset); });
    return shared;
  };
  if (!same(from, to, -1)) return false;
  for (const { pos, node } of changes) transaction.setNodeMarkup(pos, undefined, node.attrs);
  return true;
}

/** Owns complete accepted batches and the single source mutation boundary. */
export class DocumentBodyBinding implements DocumentBodyBindingAccess {
  readonly doc: Y.Doc;
  readonly document: string;
  readonly runtime: DocumentBodyOptions['runtime'];
  readonly history: Y.UndoManager;
  readonly origin: object;
  private readonly machineOrigin = Object.freeze({ body: 'machine' });
  private readonly appliedListeners = new Set<(batch: BodyAppliedBatch) => void>();
  private editor: BoundBodyEditor | null = null;
  private schema: Schema | null = null;
  private lastGood: BodyProjection | null = null;
  private currentPhase: BodyBindingPhase = 'idle';
  private sequence = 0;
  private requestedSelection: BodySelectionName | null = null;
  private changedRanges: number[] | null = null;
  private releaseRuntime: (() => void) | null = null;
  private writeState = { started: false, returned: false };
  private readonly stagedNames = new BodyStagedNames();

  /**
   * Uses the existing document handle's runtime, history and user origin.
   * @param doc - The content document already prepared by the loading boundary.
   * @param options - Resources owned by this editor handle.
   * @throws {never}
   */
  constructor(doc: Y.Doc, options: DocumentBodyOptions) {
    this.doc = doc;
    this.document = options.document;
    this.runtime = options.runtime;
    this.history = options.history;
    this.origin = options.origin;
  }

  /**
   * Reads the frame attached to the caller's exact PM state.
   * @param state - The consumer's state, or this editor's current state.
   * @returns Its latest published legal frame.
   * @throws {Error} If construction has not installed a legal frame.
   */
  read(state?: EditorState): BodyProjection {
    const current = state ?? this.editor?.prosemirrorState;
    const published = current === undefined ? null : documentBodyBindingKey.getState(current);
    if (published !== null && published !== undefined && published.owner !== this) throw new Error('A body frame belongs to a different handle');
    const frame = published?.frame ?? this.lastGood;
    if (frame === null) throw new Error('The body binding has no published frame');
    return frame;
  }

  /**
   * Reports the current synchronous mutation phase.
   * @returns The phase used by final writers and history.
   * @throws {never}
   */
  phase(): BodyBindingPhase {
    if (this.currentPhase !== 'idle') return this.currentPhase;
    // Collecting lives in the live state alone: ProseMirror also applies
    // transactions to states it never dispatches (input rules apply their
    // inserted text speculatively), and those must leave this handle idle.
    const live = this.editor === null ? undefined : documentBodyBindingKey.getState(this.editor.prosemirrorState);
    return (live?.batch ?? null) === null ? 'idle' : 'collecting';
  }

  /**
   * Applies the existing permission and current handle's final write gate.
   * @returns Whether an external operation may enter a new body batch.
   * @throws {never}
   */
  canWrite(): boolean {
    return this.phase() === 'idle' && this.runtime.canWrite(this.editor?.isEditable ?? true, this.runtime.incarnation);
  }

  /**
   * Hands a native history selection to the next source projection.
   * @param selection - The semantic name from the actual current stack item.
   * @throws {never}
   */
  requestSelection(selection: BodySelectionName): void {
    this.requestedSelection = selection;
  }

  /**
   * Subscribes final history and result owners to successful complete commits.
   * @param listener - Receives the final common frame after USER has returned.
   * @returns An idempotent listener release.
   * @throws {never}
   */
  subscribeApplied(listener: (batch: BodyAppliedBatch) => void): () => void {
    this.appliedListeners.add(listener);
    return (): void => { this.appliedListeners.delete(listener); };
  }

  /**
   * Decodes the actual source with the editor's already constructed schema.
   * @param doc - The real source or isolated preflight document.
   * @param epoch - The epoch to publish with this complete frame.
   * @returns The complete legal source projection.
   * @throws {Error} If the source is absent, incomplete or invalid.
   */
  private project(doc: Y.Doc, epoch: number): BodyProjection {
    if (this.schema === null) throw new Error('A body projection requires the constructed editor schema');
    const read = projectBodyTree(doc, this.schema, { document: this.document, epoch });
    if (read.status !== 'ready') throw new Error(`The body source is ${read.status}`);
    return read.projection;
  }

  /**
   * Installs the initial legal projection before the editor is mounted.
   * @param editor - The one editor created by the production factory.
   * @throws {Error} If the prepared source cannot be projected.
   */
  initialize(editor: BoundBodyEditor): void {
    this.editor = editor;
    this.schema = editor.pmSchema;
    this.lastGood = this.project(this.doc, 0);
    this.releaseRuntime = this.runtime.subscribe(() => this.syncRuntime());
    this.doc.on('update', this.sourceChanged);
    this.doc.on('destroy', this.dispose);
    this.publish(this.lastGood);
    this.syncRuntime();
  }

  /**
   * Keeps the runtime restriction separate from the application preference.
   * @throws {never} Runtime publication isolates a subscriber's notification error.
   */
  private syncRuntime(): void {
    const status = this.runtime.read().status;
    if (status !== 'active' && this.currentPhase !== 'closed') this.currentPhase = 'frozen';
    else if (status === 'active' && this.currentPhase === 'frozen') this.currentPhase = 'idle';
    this.editor?.getExtension(ReadOnlyExtension)?.setReadOnly(status !== 'active', RUNTIME_LOCK);
  }

  /**
   * Admits this projection, harmless metadata or the current accepted append.
   * @param transaction - The transaction entering the actual PM pipeline.
   * @param state - The actual state ProseMirror is currently extending.
   * @returns Whether this handle may accept its content mutation.
   * @throws {never}
   */
  private admit(transaction: Transaction, state: EditorState): boolean {
    const projection = transaction.getMeta(FRAME_META) as ProjectionMeta | undefined;
    if (projection?.owner === this || !transaction.docChanged) return true;
    // ProseMirror stamps appendedTransaction only after running this filter.
    // Its passed state already carries the accepted root; a reentrant dispatch
    // from the live view is filtered against the live state itself.
    const extending = (documentBodyBindingKey.getState(state)?.batch ?? null) !== null && state !== this.editor?.prosemirrorState;
    if (extending && this.currentPhase === 'idle' && transaction.before.eq(state.doc)) return this.runtime.read().status === 'active';
    return this.canWrite();
  }

  /**
   * Collects an immutable root/append snapshot without writing shared state.
   * @param transaction - The actual accepted root or appended transaction.
   * @param value - The previous state's body frame and accepted batch.
   * @param oldState - The state before this accepted transaction.
   * @returns The body value belonging to the new exact PM state.
   * @throws {never} Failures are retained by the handle before its readonly notification.
   */
  private reduce(transaction: Transaction, value: BodyBindingPluginState, oldState: EditorState): BodyBindingPluginState {
    const projection = transaction.getMeta(FRAME_META) as ProjectionMeta | undefined;
    if (projection?.owner === this) return { owner: this, frame: projection.frame, batch: null, source: 'projection' };
    const root = transaction.getMeta('appendedTransaction') as Transaction | undefined;
    if (root?.getMeta(FRAME_META) !== undefined) {
      if (transaction.docChanged) this.fail(new Error('A source projection append changed its legal document'), transaction, value.batch);
      return { ...value, source: 'projection' };
    }
    if (!transaction.docChanged && value.batch === null) return { ...value, source: 'metadata' };
    if (this.runtime.read().status !== 'active') return value;
    try {
      let batch = value.batch;
      if (batch === null) {
        const before = this.read(oldState);
        if (!before.doc.eq(transaction.before)) throw new Error('The accepted root differs from the published source frame');
        const id = `body:${this.doc.clientID}:${this.sequence++}`;
        const source = transaction.getMeta('addToHistory') === false || isCommentMarkWrite(transaction) ? 'machine' : 'user';
        const preSelection: BodySelectionName = before.synthetic
          ? { version: 1, document: this.document, kind: 'text', anchor: { version: 1, document: this.document, kind: 'bodyEdge', edge: 'start' }, head: { version: 1, document: this.document, kind: 'bodyEdge', edge: 'start' } }
          : nameBodySelection(before.index, oldState.selection);
        const journal = new BodyJournal(transaction.before, before.units, { batchId: id });
        batch = { id, root: transaction, revision: this.runtime.revision(), before, preSelection, source, journal, accepted: journal.read() };
        transaction.setMeta(BODY_TRANSACTION_SOURCE, source);
      }
      const accepted = batch.journal.accept(transaction);
      const frame = stageBodyProjection({ doc: this.doc, projection: batch.before, journal: accepted, batchId: batch.id }, this.stagedNames);
      return { owner: this, frame, batch: { ...batch, accepted }, source: batch.source };
    } catch (error) {
      this.fail(error, transaction, value.batch);
      return { ...value, batch: null, source: 'metadata' };
    }
  }

  /**
   * Publishes one complete frame and matching selection without source writes.
   * @param input - The legal codec frame to adopt into the actual PM root.
   * @throws {Error} If the editor, selection or projection consumers fail.
   */
  private publish(input: BodyProjection): void {
    if (this.editor === null) throw new Error('The body editor has not been constructed');
    this.currentPhase = 'projecting';
    const state = this.editor.prosemirrorState;
    const transaction = state.tr;
    if (!state.doc.eq(input.doc) && !adoptAttributes(transaction, state.doc, input.doc)) transaction.replaceWith(0, state.doc.content.size, input.doc.content);
    const frame = adoptProjection(input, transaction.doc);
    const requested = this.requestedSelection;
    if (requested !== null) {
      const resolved = resolveBodySelection(frame.index, requested);
      if (resolved.status === 'resolved') transaction.setSelection(resolved.selection);
      else transaction.setSelection(Selection.near(transaction.doc.resolve(Math.min(state.selection.head, transaction.doc.content.size))));
    }
    this.requestedSelection = null;
    transaction.setMeta(FRAME_META, { owner: this, frame } satisfies ProjectionMeta);
    transaction.setMeta(BODY_TRANSACTION_SOURCE, 'projection').setMeta('addToHistory', false);
    transaction.setMeta(ySyncPluginKey, { isChangeOrigin: true, isUndoRedoOperation: this.history.undoing || this.history.redoing });
    this.editor.prosemirrorView.dispatch(transaction);
    this.lastGood = adoptProjection(frame, this.editor.prosemirrorState.doc);
    this.currentPhase = this.runtime.read().status === 'active' ? 'idle' : 'frozen';
  }

  /**
   * Starts a new undo step when a user batch does not touch the previous one's
   * changed ranges, as prosemirror-history groups (`isAdjacentTo`);
   * the native history still merges adjacent batches by its capture time.
   * @param maps - The batch's step maps in order.
   * @throws {never}
   */
  private groupHistory(maps: readonly StepMap[]): void {
    const previous = this.changedRanges;
    let adjacent = false;
    maps[0]?.forEach((start, end) => {
      for (let index = 0; previous !== null && index < previous.length; index += 2) {
        if (start <= previous[index + 1] && end >= previous[index]) adjacent = true;
      }
    });
    if (!adjacent) this.history.stopCapturing();
    // Every step's range, carried to the batch's end: BlockNote's appended
    // ID stamp is the last step, and it alone would hide a split's range.
    const ranges: number[] = [];
    maps.forEach((map, index) => {
      map.forEach((_oldStart, _oldEnd, start, end) => {
        const later = maps.slice(index + 1);
        ranges.push(later.reduce((pos, next) => next.map(pos, -1), start), later.reduce((pos, next) => next.map(pos, 1), end));
      });
    });
    this.changedRanges = ranges;
  }

  /**
   * Commits only after the final accepted append loop has reached the view.
   * @throws {never} Original accepted input and source truth are retained on failure.
   */
  flush(): void {
    if (this.editor === null || this.currentPhase === 'closed' || this.currentPhase === 'projecting') return;
    if (this.runtime.read().status !== 'active') {
      if (this.lastGood !== null && !this.editor.prosemirrorState.doc.eq(this.lastGood.doc)) this.publish(this.lastGood);
      return;
    }
    const value = documentBodyBindingKey.getState(this.editor.prosemirrorState);
    const batch = value?.batch;
    if (batch === null || batch === undefined) return;
    try {
      this.currentPhase = 'preflighting';
      this.writeState = { started: false, returned: false };
      if (this.runtime.revision() !== batch.revision) throw new Error('The source revision changed while collecting the accepted batch');
      const plan = compileBodyBatch({ doc: this.doc, projection: batch.before, journal: batch.accepted, batchId: batch.id });
      const epoch = batch.before.epoch + 1;
      const environment = {
        doc: this.doc, runtime: this.runtime,
        userOrigin: batch.source === 'user' ? this.origin : this.machineOrigin,
        writeState: this.writeState,
        canWrite: (): boolean => this.runtime.canWrite(this.editor?.isEditable ?? false, this.runtime.incarnation),
        project: (doc: Y.Doc): BodyProjection => this.project(doc, epoch),
        onCommitPhase: (phase: 'registering' | 'committing' | 'written' | 'projecting'): void => {
          if (phase !== 'written') this.currentPhase = phase;
        },
      };
      if (batch.source === 'user') this.groupHistory(batch.accepted.transactions.flatMap((entry) => entry.transaction.mapping.maps));
      const prepared = prepareBodyBatch(environment, plan);
      const result = commitPreparedBodyBatch(environment, prepared);
      const frame = this.project(this.doc, epoch);
      this.stagedNames.finalize(batch.id, frame, result.aliases);
      this.publish(frame);
      const published = this.read();
      const applied = { id: batch.id, source: batch.source, preSelection: batch.preSelection, postSelection: this.editor.prosemirrorState.selection, projection: published };
      this.currentPhase = 'projecting';
      for (const listener of this.appliedListeners) listener(applied);
      this.currentPhase = 'idle';
    } catch (error) {
      this.fail(error, undefined, batch);
      if (this.lastGood !== null && !this.editor.prosemirrorState.doc.eq(this.lastGood.doc)) this.publish(this.lastGood);
    }
  }

  /**
   * Latches the original phase and accepted material before readonly metadata reenters.
   * @param original - The original thrown value.
   * @param transaction - The root or currently accepted transaction.
   * @param batch - The accepted complete or partial batch, when available.
   * @throws {never}
   */
  private fail(original: unknown, transaction?: Transaction, batch?: BodyAcceptedBatch | null): void {
    const first = this.runtime.read().status !== 'failed' && this.runtime.read().status !== 'disposed';
    const phase = this.currentPhase;
    this.currentPhase = 'frozen';
    const error = original instanceof Error ? original : new Error('The body binding failed', { cause: original });
    this.runtime.fail({ phase, error, batch: batch?.id ?? null, epoch: this.lastGood?.epoch ?? 0,
      accepted: transaction?.doc ?? batch?.accepted.doc ?? this.lastGood?.doc,
      selection: transaction?.selection ?? this.editor?.prosemirrorState.selection ?? null, journal: batch?.accepted ?? null, lastGood: this.lastGood,
      writeStarted: this.writeState.started, writeReturned: this.writeState.returned });
    if (first) {
      try {
        captureException(error, {
          tags: { error_boundary: 'document-body', phase },
          extra: { document: this.document, batch: batch?.id ?? null, epoch: this.lastGood?.epoch ?? 0,
            writeStarted: this.writeState.started, writeReturned: this.writeState.returned },
        });
      } catch (reportingError) {
        console.error('document_body_error_reporting_failed', { err: reportingError, document: this.document, phase });
      }
    }
    console.error('document_body_binding_failed', { err: error, document: this.document, phase, batch: batch?.id ?? null });
  }

  /**
   * Receives real source updates while retaining last-good input on dependencies or failure.
   * @throws {never}
   */
  private readonly sourceChanged = (): void => {
    if (this.runtime.read().status === 'failed' || this.runtime.read().status === 'disposed' || this.schema === null) return;
    if (this.currentPhase !== 'idle' && this.currentPhase !== 'frozen') return;
    try {
      const read = projectBodyTree(this.doc, this.schema, { document: this.document, epoch: (this.lastGood?.epoch ?? 0) + 1 });
      if (read.status === 'pending') {
        this.runtime.wait(read.missing);
        return;
      }
      if (read.status !== 'ready') throw new Error('A bound body lost its records marker');
      if (this.requestedSelection === null && this.lastGood !== null && this.editor !== null) {
        this.requestedSelection = nameBodySelection(this.lastGood.index, this.editor.prosemirrorState.selection);
      }
      this.publish(read.projection);
      this.currentPhase = 'idle';
      this.runtime.resume();
    } catch (error) {
      this.fail(error);
    }
  };

  /**
   * Releases this handle at its document lifetime boundary.
   * @throws {never}
   */
  readonly dispose = (): void => {
    if (this.currentPhase === 'closed') return;
    this.currentPhase = 'closed';
    this.doc.off('update', this.sourceChanged);
    this.doc.off('destroy', this.dispose);
    this.releaseRuntime?.();
    this.releaseRuntime = null;
    this.appliedListeners.clear();
    this.stagedNames.dispose();
    this.runtime.dispose();
    this.editor = null;
    this.lastGood = null;
  };

  /**
   * Creates the one plugin and headless completion hook used by records mode.
   * @returns The project-owned BlockNote extension.
   * @throws {never}
   */
  extension(): ExtensionFactoryInstance {
    return createExtension(() => ({
      key: 'documentBodyBinding',
      // These state fields resolve names against the same transaction's frame.
      runsBefore: [
        'document-comment-draft-range',
        'document-uploads',
        'document-table-target',
        'document-table-drag',
      ],
      prosemirrorPlugins: [new Plugin<BodyBindingPluginState>({
        key: documentBodyBindingKey,
        state: {
          init: (): BodyBindingPluginState => ({ owner: this, frame: null, batch: null, source: 'metadata' }),
          apply: (transaction, value, oldState): BodyBindingPluginState => this.reduce(transaction, value, oldState),
        },
        filterTransaction: (transaction, state): boolean => this.admit(transaction, state),
        view: (): { update: () => void } => ({ update: (): void => this.flush() }),
      })],
      tiptapExtensions: [Extension.create({ name: 'documentBodyCompletion', onTransaction: (): void => this.flush() })],
    }))();
  }

  /**
   * Supplies BlockNote's existing history and position extension keys.
   * @returns Source-backed compatibility methods without XML plugin factories.
   * @throws {never}
   */
  compatibility(): readonly ExtensionFactoryInstance[] {
    return [
      createExtension(() => ({ key: 'yUndo', manager: this.history,
        undoCommand: (): boolean => { this.changedRanges = null; return this.canWrite() && this.history.undo() !== null; },
        redoCommand: (): boolean => { this.changedRanges = null; return this.canWrite() && this.history.redo() !== null; },
      }))(),
      createExtension(() => ({ key: 'yPositionMapping', mapPosition: (position: number, side: 'left' | 'right' = 'left'): (() => number) => {
        if (position === 0) return (): number => 0;
        const index = this.read().index;
        let name: BodyPointName;
        if (index.doc.resolve(position).parent.inlineContent) name = nameBodyPoint(index, { kind: 'text', pos: position, assoc: side === 'left' ? -1 : 1 });
        else {
          const node = [...index.nodes.values()].find((entry) => entry.from === position || entry.to === position);
          if (node === undefined) throw new Error('The tracked position has no registered body boundary');
          name = nameBodyPoint(index, { kind: 'node', node: node.id, side: node.from === position ? 'before' : 'after' });
        }
        return (): number => {
          const resolved = resolveBodyPoint(this.read().index, name, { runtime: this.runtime.read().status });
          if (resolved.status !== 'resolved') throw new Error(`The tracked body position is ${resolved.status}`);
          return resolved.pos;
        };
      } }))(),
    ];
  }
}
