// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { Plugin, PluginKey, type EditorState } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { Awareness } from 'y-protocols/awareness';
import { DOCUMENT_BODY_FORMAT, DOCUMENT_BODY_FORMAT_VERSION } from '@breatic/shared';

import { bodyBindingOf } from '@web/spaces/document/document-body-binding-key';
import { textEnds } from '@web/spaces/document/document-body-edge-selection';
import { finalizeBodySelectionName, nameBodySelection, resolveBodySelection } from '@web/spaces/document/document-body-positions';
import type { BodyPointName, BodySelectionName } from '@web/spaces/document/document-body-positions-types';
import type { DocumentBodyCursor, DocumentCaretBodyOptions } from '@web/spaces/document/document-caret-types';
import {
  renderCollabCaret, renderCollabSelection, type CaretUser, type ResolveCollaboratorName,
} from '@web/features/collab-editor/caret-render';

/** The awareness event's public routing fields. */
interface AwarenessChange {
  readonly added: readonly number[];
  readonly updated: readonly number[];
  readonly removed: readonly number[];
}

/**
 * Recognizes a record-shaped wire value without trusting a remote cast.
 * @param value - An awareness payload or one of its fields.
 * @returns Whether named JSON fields can be read.
 * @throws {never}
 */
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Recognizes the public final point variants; local staged names stay local.
 * @param value - A remote semantic point.
 * @param document - The owning body identity already checked on the envelope.
 * @returns Whether this is a supported final common point name.
 * @throws {never}
 */
function finalPoint(value: unknown, document: string): value is BodyPointName {
  if (!record(value) || value['version'] !== 1 || value['document'] !== document) return false;
  switch (value['kind']) {
    case 'bodyEdge': return value['edge'] === 'start' || value['edge'] === 'end';
    case 'node': return typeof value['node'] === 'string' && (value['side'] === 'before' || value['side'] === 'after' || value['side'] === 'inside');
    case 'gap': return typeof value['parent'] === 'string' && (value['left'] === null || typeof value['left'] === 'string') && (value['right'] === null || typeof value['right'] === 'string') && (value['assoc'] === -1 || value['assoc'] === 1);
    case 'text': return typeof value['source'] === 'string' && record(value['relative']) && (value['token'] === null || typeof value['token'] === 'string') && (value['assoc'] === -1 || value['assoc'] === 1);
    default: return false;
  }
}

/**
 * Reads only the current records cursor protocol from the shared awareness field.
 * @param value - A remote cursor, including older XML cursor shapes.
 * @param document - The current document ownership boundary.
 * @returns Its final common selection, or null for another protocol or document.
 * @throws {never}
 */
function remoteSelection(value: unknown, document: string): BodySelectionName | null {
  if (!record(value) || value['format'] !== DOCUMENT_BODY_FORMAT || value['version'] !== DOCUMENT_BODY_FORMAT_VERSION || value['document'] !== document) return null;
  const selection = value['selection'];
  if (!record(selection) || selection['version'] !== 1 || selection['document'] !== document) return null;
  if (selection['kind'] === 'all') return selection as unknown as BodySelectionName;
  if (selection['kind'] === 'node' && typeof selection['node'] === 'string') {
    if (selection['part'] !== undefined && selection['part'] !== 'content') return null;
    return selection as unknown as BodySelectionName;
  }
  if ((selection['kind'] !== 'text' && selection['kind'] !== 'cell' && selection['kind'] !== 'bodyEdge') || !finalPoint(selection['anchor'], document) || !finalPoint(selection['head'], document)) return null;
  return selection as unknown as BodySelectionName;
}

/**
 * Rebuilds remote decorations from the current exact common projection index.
 * @param state - The actual PM state whose document decorations will inhabit.
 * @param awareness - The original document provider's awareness.
 * @param body - The same handle's identity and runtime.
 * @param resolveName - The existing project roster resolver.
 * @returns Common-renderer widgets and selection highlights for supported peers.
 * @throws {never} Invalid remote names are diagnosed without breaking source rendering.
 */
function remoteDecorations(state: EditorState, awareness: Awareness, body: DocumentCaretBodyOptions, resolveName?: ResolveCollaboratorName): DecorationSet {
  const binding = bodyBindingOf(state);
  if (binding === null || binding.document !== body.document || binding.runtime !== body.runtime || body.runtime.read().status !== 'active') return DecorationSet.empty;
  const frame = binding.read(state);
  const decorations: Decoration[] = [];
  for (const [client, peer] of awareness.getStates()) {
    if (client === awareness.clientID) continue;
    const selection = remoteSelection(peer['cursor'], body.document);
    if (selection === null) continue;
    try {
      const resolved = resolveBodySelection(frame.index, selection);
      if (resolved.status !== 'resolved') continue;
      const { anchor, head } = textEnds(resolved.selection);
      const user: CaretUser = record(peer['user']) ? peer['user'] : {};
      decorations.push(Decoration.widget(head, () => renderCollabCaret(user, client, resolveName), { key: String(client), side: 10 }));
      if (anchor !== head) decorations.push(Decoration.inline(Math.min(anchor, head), Math.max(anchor, head), renderCollabSelection(user), { inclusiveEnd: true, inclusiveStart: false }));
    } catch (err) {
      console.error('document_caret_resolution_failed', { err, document: body.document, client });
    }
  }
  return DecorationSet.create(state.doc, decorations);
}

/**
 * Uses the existing awareness field with records names and the handle's lifetime.
 * @param awareness - The provider awareness that outlives an ordinary view mount.
 * @param body - The original handle identity and runtime, never a second session.
 * @param resolveName - The same remote collaborator name resolver as XML carets.
 * @returns A records plugin that never constructs or accesses XML sync plugins.
 * @throws {Error} If plugin construction fails.
 */
export function documentRecordsCaretPlugin(awareness: Awareness, body: DocumentCaretBodyOptions, resolveName?: ResolveCollaboratorName): Plugin<number> {
  const key = new PluginKey<number>('documentRecordsCaret');
  return new Plugin<number>({
    key,
    state: {
      init: () => 0,
      apply: (transaction, version) => transaction.getMeta(key) === true ? version + 1 : version,
    },
    props: { decorations: (state) => remoteDecorations(state, awareness, body, resolveName) },
    view: (view) => {
      const domDocument = view.dom.ownerDocument;
      let destroyed = false;
      let queued = false;

      /**
       * Writes only the cursor field and avoids an awareness notification loop.
       * @param cursor - A complete final cursor or synchronous withdrawal.
       * @throws {Error} If the provider rejects a local state update.
       */
      const writeCursor = (cursor: DocumentBodyCursor | null): void => {
        const state = awareness.getLocalState();
        if (state === null || JSON.stringify(state['cursor']) === JSON.stringify(cursor)) return;
        awareness.setLocalStateField('cursor', cursor);
      };

      /**
       * Publishes only a focused, visible, idle final frame from this handle.
       * @throws {never} Naming errors are logged and withdraw the stale cursor.
       */
      const publish = (): void => {
        if (destroyed) return;
        const binding = bodyBindingOf(view.state);
        if (body.runtime.read().status !== 'active' || !view.hasFocus() || domDocument.visibilityState === 'hidden' || binding === null || binding.runtime !== body.runtime || binding.document !== body.document) {
          writeCursor(null);
          return;
        }
        if (binding.phase() !== 'idle') return;
        try {
          const frame = binding.read(view.state);
          const selection = finalizeBodySelectionName(nameBodySelection(frame.index, view.state.selection));
          writeCursor({ format: DOCUMENT_BODY_FORMAT, version: DOCUMENT_BODY_FORMAT_VERSION, document: body.document, selection });
        } catch (err) {
          writeCursor(null);
          console.error('document_caret_publication_failed', { err, document: body.document });
        }
      };

      /**
       * Defers a completed USER notification until the binding has left projecting.
       * @throws {never}
       */
      const afterBatch = (): void => {
        if (destroyed || queued) return;
        queued = true;
        queueMicrotask(() => { queued = false; publish(); });
      };

      /**
       * Refreshes positions only for remote awareness changes, never our own publish.
       * @param change - The provider's actual changed client IDs.
       * @throws {Error} If the current editor cannot accept harmless metadata.
       */
      const onAwareness = (change: AwarenessChange): void => {
        if (destroyed || ![...change.added, ...change.updated, ...change.removed].some((client) => client !== awareness.clientID)) return;
        view.dispatch(view.state.tr.setMeta(key, true).setMeta('addToHistory', false));
      };

      /**
       * Clears this view's cursor in the blur event before another transaction.
       * @throws {Error} If the provider rejects cursor withdrawal.
       */
      const onBlur = (): void => { writeCursor(null); };

      /**
       * Observes source updates after the binding's own source projection listener.
       * @throws {never}
       */
      const onSource = (): void => { publish(); afterBatch(); };

      const binding = bodyBindingOf(view.state);
      const stopApplied = binding?.subscribeApplied(afterBatch) ?? (() => undefined);
      const stopRuntime = body.runtime.subscribe(publish);
      awareness.on('change', onAwareness);
      binding?.doc.on('update', onSource);
      view.dom.addEventListener('focus', publish, true);
      view.dom.addEventListener('blur', onBlur, true);
      domDocument.addEventListener('visibilitychange', publish);
      publish();

      return {
        update: (): void => { publish(); },
        destroy: (): void => {
          destroyed = true;
          stopApplied();
          stopRuntime();
          awareness.off('change', onAwareness);
          binding?.doc.off('update', onSource);
          view.dom.removeEventListener('focus', publish, true);
          view.dom.removeEventListener('blur', onBlur, true);
          domDocument.removeEventListener('visibilitychange', publish);
          writeCursor(null);
        },
      };
    },
  });
}
