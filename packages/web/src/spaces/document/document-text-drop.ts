// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { NodeSelection, Plugin, PluginKey, Selection } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';

import { bodyBindingOf } from '@web/spaces/document/document-body-binding-key';
import type { DocumentBodyBindingAccess } from '@web/spaces/document/document-body-binding-types';
import { nameBodyPoint, nameBodySelection, resolveBodyPoint, resolveBodySelection } from '@web/spaces/document/document-body-positions';
import type { BodyPointName, BodySelectionName } from '@web/spaces/document/document-body-positions-types';
import { BODY_OPERATION_META, BodyOriginMirror, BodyProvenanceError, bodyInlineOccurrences, recordBodyOperation } from '@web/spaces/document/document-body-provenance';
import { bodyDropSlice } from '@web/spaces/document/document-table-nodes';

/** Native names outlive Safari's temporary selection and intervening peer edits. */
type DragName =
  | { readonly kind: 'selection'; readonly selection: BodySelectionName }
  | { readonly kind: 'inline'; readonly from: BodyPointName; readonly to: BodyPointName };

/** One drag is bound to the editor that actually captured its source. */
interface DragSource {
  readonly binding: DocumentBodyBindingAccess;
  readonly name: DragName;
}

/**
 * Names the live selection the actual PM dragstart chose, including inline nodes.
 * @param view - The source view.
 * @param selection - The actual dragged selection, not its clipboard snapshot.
 * @returns Names tied to this exact records binding, or null for another editor mode.
 * @throws {DocumentBodyFormatError} If the actual selection cannot be named.
 */
function capture(view: EditorView, selection: Selection): DragSource | null {
  const binding = bodyBindingOf(view.state);
  if (binding === null || selection.empty) return null;
  const index = binding.read().index;
  const name: DragName = selection instanceof NodeSelection && selection.node.isInline
    ? { kind: 'inline', from: nameBodyPoint(index, { kind: 'text', pos: selection.from, assoc: 1 }), to: nameBodyPoint(index, { kind: 'text', pos: selection.to, assoc: -1 }) }
    : { kind: 'selection', selection: nameBodySelection(index, selection) };
  return { binding, name };
}

/**
 * Resolves the source from current native names rather than dragstart content.
 * @param source - The names captured by this view's actual dragstart.
 * @returns The current source selection, or null when its content is gone or unavailable.
 * @throws {DocumentBodyFormatError} If current records violate their schema.
 * @throws {RangeError} If the current node boundary is invalid.
 */
function resolve(source: DragSource): Selection | null {
  const index = source.binding.read().index;
  if (source.name.kind === 'selection') {
    const result = resolveBodySelection(index, source.name.selection, { runtime: source.binding.runtime.read().status });
    return result.status === 'resolved' ? result.selection : null;
  }
  const from = resolveBodyPoint(index, source.name.from);
  const to = resolveBodyPoint(index, source.name.to);
  if (from.status !== 'resolved' || to.status !== 'resolved') return null;
  const node = index.doc.nodeAt(from.pos);
  return node?.isInline === true && NodeSelection.isSelectable(node) && from.pos + node.nodeSize === to.pos
    ? NodeSelection.create(index.doc, from.pos)
    : null;
}

/**
 * Writes a local move through the installed real/private fitters and existing journal contract.
 * @param view - The current source and target view.
 * @param selection - The resolved live source.
 * @param target - The actual target before removal.
 * @throws {BodyProvenanceError} If real/private fitting diverges or invents content.
 * @throws {RangeError} If ProseMirror rejects an actual step.
 */
function move(view: EditorView, selection: Selection, target: number): void {
  // Safari can move its selection to the drop caret. Restore the native source
  // before the user batch so history also captures the original selection.
  const current = Selection.fromJSON(view.state.doc, selection.toJSON());
  if (!current.eq(view.state.selection)) view.dispatch(view.state.tr.setSelection(current));
  const sourceAt = new Map(bodyInlineOccurrences(view.state.doc).map((unit) => [unit.pos, `text-drop:${unit.pos}`]));
  const mirror = new BodyOriginMirror(view.state.tr, { sourceAt });
  const operation = mirror.moveSelection(view.state.selection, target, bodyDropSlice);
  if (operation.created.length > 0) throw new BodyProvenanceError('An internal move invented inline content');
  const transaction = mirror.tr.setMeta(BODY_OPERATION_META, []);
  recordBodyOperation(transaction, {
    id: operation.id, name: operation.name, source: operation.source, target: operation.target,
    handoffs: operation.handoffs.map((handoff) => ({ kind: handoff.kind, source: handoff.source, target: handoff.target })),
    created: [],
  });
  view.focus();
  view.dispatch(transaction);
}

/**
 * Adapts only the installed handler's explicit local move decision; copies keep its existing path.
 * @param rowActive - Whether the product's separate whole-row drag owns this gesture.
 * @returns A per-view native-source tracker and actual move producer.
 * @throws {never}
 */
export function documentTextDropPlugin(rowActive: () => boolean): Plugin {
  let source: DragSource | null = null;
  return new Plugin({
    key: new PluginKey('documentTextDrop'),
    props: {
      handleDOMEvents: {
        dragstart: (view, event): boolean => {
          source = null;
          if (rowActive() || event.dataTransfer === null || view.state.selection.empty) return false;
          const position = view.posAtCoords({ left: event.clientX, top: event.clientY });
          const selection = view.state.selection;
          const end = selection instanceof NodeSelection ? selection.to - 1 : selection.to;
          if (position !== null && position.pos >= selection.from && position.pos <= end) source = capture(view, selection);
          return false;
        },
        dragend: (): boolean => { source = null; return false; },
      },
      handleDrop: (view, event, _slice, moved): boolean => {
        const current = source;
        source = null;
        if (!moved || rowActive() || current === null || view.dragging === null) return false;
        event.preventDefault();
        if (bodyBindingOf(view.state) !== current.binding || !current.binding.canWrite()) return true;
        const selection = resolve(current);
        const target = view.posAtCoords({ left: event.clientX, top: event.clientY });
        if (selection !== null && !selection.empty && target !== null) move(view, selection, target.pos);
        return true;
      },
    },
    view: (view) => {
      /**
       * Runs after PM's DOM listener has chosen dragging.node or the current selection.
       * @param event - The actual native dragstart.
       * @throws {DocumentBodyFormatError} If its selected node cannot be named.
       */
      const rememberNativeSource = (event: DragEvent): void => {
        const dragging = view.dragging;
        if (rowActive() || event.defaultPrevented || dragging === null) { source = null; return; }
        if ('node' in dragging && dragging.node instanceof NodeSelection) source = capture(view, dragging.node);
        else source ??= capture(view, view.state.selection);
      };
      // EditorView installs its input listeners before plugin views, so this
      // observes PM's chosen node without reading its private mouseDown state.
      view.dom.addEventListener('dragstart', rememberNativeSource);
      return { destroy: (): void => { source = null; view.dom.removeEventListener('dragstart', rememberNativeSource); } };
    },
  });
}
