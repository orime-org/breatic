// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as Y from 'yjs';
import { AllSelection, NodeSelection, Selection, TextSelection } from '@tiptap/pm/state';
import { CellSelection, inSameTable } from '@tiptap/pm/tables';

import { assertBodySourceBoundary, documentBodySource, DocumentBodyFormatError, readBodyTree } from '@breatic/shared/document-body';

import type { BodyIndexedUnit, BodyNodePosition, BodyProjectionIndex } from '@web/spaces/document/document-body-codec-types';
import { bodyEdgeAt, bodyEdgeBetween, bodyEdgePos } from '@web/spaces/document/document-body-edge-selection';
import { bodyNativeItem, bodyNativeItemAlive, bodyTokenId } from '@web/spaces/document/document-body-position-native';
import { stagedBodyNameState } from '@web/spaces/document/document-body-staged';
import type {
  BodyAssociation,
  BodyNameIdentity,
  BodyPointName,
  BodyPointResolution,
  BodyPointTarget,
  BodyPositionOptions,
  BodyPositionUnavailable,
  BodySelectionName,
  BodySelectionResolution,
  BodyTextPointName,
} from '@web/spaces/document/document-body-positions-types';

/**
 * Rejects foreign ownership and paused or incomplete frames before using last-good positions.
 * @param index - The common final projection index.
 * @param name - The stable point or selection name.
 * @param options - The current document epoch or runtime state.
 * @returns The distinct unavailable outcome, or null for a usable frame.
 * @throws {DocumentBodyFormatError} If the current native records contradict their schema.
 */
function unavailable(index: BodyProjectionIndex, name: BodyNameIdentity, options: BodyPositionOptions): BodyPositionUnavailable | null {
  if (name.document !== index.document) return { status: 'otherDocument' };
  if (options.runtime !== undefined && options.runtime !== 'active') return { status: 'bindingUnavailable', runtime: options.runtime };
  if (options.missing !== undefined && options.missing.length > 0) return { status: 'pendingDependency', missing: options.missing };
  const current = readBodyTree(index.sourceDoc);
  if (current.status === 'pending') return { status: 'pendingDependency', missing: current.missing };
  if (current.status === 'uninitialized') return { status: 'gone' };
  return null;
}

/**
 * Distinguishes a registered hidden record from a name that never existed.
 * @param index - The common final projection index.
 * @param id - The stable record or native identity.
 * @returns Whether the registered target is hidden or absent.
 * @throws {never}
 */
function absentNode(index: BodyProjectionIndex, id: string): BodyPositionUnavailable {
  return { status: index.view.body.records.has(id) ? 'hidden' : 'gone' };
}

/**
 * Reads a point at a registered node's outer or inline-content boundary.
 * @param node - The registered node boundary.
 * @param side - The requested node boundary.
 * @returns The requested current PM boundary.
 * @throws {never}
 */
function nodeSide(node: BodyNodePosition, side: 'before' | 'after' | 'inside'): number {
  return side === 'before' ? node.from : side === 'after' ? node.to : node.contentFrom;
}

/**
 * Checks the displayed parent rather than a transparent record's native ancestry.
 * @param index - The exact current PM projection index.
 * @param child - A named visible neighbor, when it exists.
 * @param parent - The visible container holding the named gap.
 * @returns The direct visible child, or none when it has left that container.
 * @throws {RangeError} If the published index contains an invalid PM boundary.
 */
function visibleGapNeighbor(index: BodyProjectionIndex, child: string | null, parent: BodyNodePosition): BodyNodePosition | undefined {
  const node = child === null ? undefined : index.nodes.get(child);
  if (node === undefined || node.from < parent.contentFrom || node.to > parent.contentTo) return undefined;
  const holder = parent.id === index.view.root ? index.doc : index.doc.nodeAt(parent.from);
  return index.doc.resolve(node.from).parent === holder ? node : undefined;
}

/**
 * Finds the visible text owner's common coordinate interval.
 * @param index - The common final projection index.
 * @param position - The position in the supplied final PM document.
 * @returns The visible owner containing the text point.
 * @throws {DocumentBodyFormatError} If the PM point is not a native text position.
 */
function textOwner(index: BodyProjectionIndex, position: number): BodyNodePosition {
  if (!Number.isInteger(position) || position < 0 || position > index.doc.content.size || !index.doc.resolve(position).parent.inlineContent) throw new DocumentBodyFormatError('A named text point must be inside inline content');
  for (const owner of index.owners.values()) if (position >= owner.contentFrom && position <= owner.contentTo && !index.opaque.has(owner.id)) return owner;
  throw new DocumentBodyFormatError('A named text point needs an existing native owner');
}

/**
 * Names a native text gap while separately retaining the associated character's identity.
 * @param index - The common final projection index.
 * @param owner - The visible text owner's exact boundaries.
 * @param unit - The associated original native occurrence, or none for an empty source.
 * @param position - The position in the supplied final PM document.
 * @param assoc - The native or container boundary affinity.
 * @returns A native point name and associated character identity.
 * @throws {DocumentBodyFormatError} If the gap has no existing native source or divides a Unicode scalar.
 */
function nativeTextPoint(index: BodyProjectionIndex, owner: BodyNodePosition, unit: BodyIndexedUnit | undefined, position: number, assoc: BodyAssociation): BodyTextPointName {
  let source: string;
  let physical: number;
  if (unit === undefined) {
    const facet = index.view.owners.find((entry) => entry.id === owner.id)!.facet;
    const descriptor = [...index.view.body.sources.values()].find((entry) => entry.facet === facet);
    if (descriptor === undefined) throw new DocumentBodyFormatError('An empty owner needs an existing native source');
    source = descriptor.id;
    physical = 1;
  } else {
    source = unit.source;
    const text = documentBodySource(index.sourceDoc, source);
    const base = Y.createRelativePositionFromTypeIndex(text, 0);
    const id = bodyTokenId(source, unit.token);
    const actual = id === null ? null : Y.createAbsolutePositionFromRelativePosition(new Y.RelativePosition(base.type, base.tname, id, 0), index.sourceDoc);
    if (actual === null || actual.type !== text) throw new DocumentBodyFormatError('A named native unit has no current source boundary');
    physical = actual.index + (position > unit.pos ? 1 : 0);
  }
  const text = documentBodySource(index.sourceDoc, source);
  assertBodySourceBoundary(text, physical);
  return { version: 1, document: index.document, kind: 'text', source, relative: Y.createRelativePositionFromTypeIndex(text, physical, assoc), token: unit?.token ?? null, assoc };
}

/**
 * Keeps a deleted independent source's original gap through neighboring native sources.
 * @param index - The exact accepted or final common index.
 * @param position - The current PM inline boundary.
 * @param assoc - The requested boundary affinity.
 * @returns A native name with shallow, identity-based gap neighbors.
 * @throws {DocumentBodyFormatError} If the boundary is invalid or divides a Unicode scalar.
 */
function nameText(index: BodyProjectionIndex, position: number, assoc: BodyAssociation): BodyTextPointName {
  const owner = textOwner(index, position);
  const units = index.units.filter((unit) => unit.owner === owner.id);
  const right = units.find((unit) => unit.pos === position);
  const left = units.find((unit) => unit.pos + unit.width === position);
  const unit = assoc < 0 ? left ?? right : right ?? left;
  const name = nativeTextPoint(index, owner, unit, position, assoc);
  const before = units.findLast((entry) => entry.source !== name.source && entry.pos + entry.width <= position);
  const after = units.find((entry) => entry.source !== name.source && entry.pos >= position);
  return before === undefined && after === undefined ? name : { ...name, fallback: {
    left: before === undefined ? null : nativeTextPoint(index, owner, before, before.pos + before.width, -1),
    right: after === undefined ? null : nativeTextPoint(index, owner, after, after.pos, 1),
  } };
}

/**
 * Creates a final stable point name from one published index.
 * @param index - The common final projection index.
 * @param target - The target to name in this final epoch.
 * @returns A final stable point name.
 * @throws {DocumentBodyFormatError} If the requested point or registered target is invalid.
 */
export function nameBodyPoint(index: BodyProjectionIndex, target: BodyPointTarget): BodyPointName {
  if (target.kind === 'text') {
    const fresh = index.staged?.names.name(index, target.pos, target.assoc);
    if (fresh !== undefined && fresh !== null) return fresh;
    const owner = [...index.derived.values()].filter((entry) => entry.kind === 'owner').map((entry) => index.nodes.get(entry.id)).find((entry) => entry !== undefined && target.pos >= entry.contentFrom && target.pos <= entry.contentTo);
    if (owner !== undefined) return { version: 1, document: index.document, kind: 'node', node: owner.id, side: 'inside' };
    return nameText(index, target.pos, target.assoc);
  }
  if (target.kind === 'node' && !index.nodes.has(target.node)) throw new DocumentBodyFormatError('Cannot name an unprojected node');
  if (target.kind === 'gap' && !index.nodes.has(target.parent)) throw new DocumentBodyFormatError('Cannot name a gap in an unprojected container');
  return { version: 1, document: index.document, ...target };
}

/**
 * Locates a source's current empty or deleted gap under its selected piece ancestry.
 * @param index - The common final projection index.
 * @param source - The permanent source identifier.
 * @param physical - The physical native UTF-16 or embed gap.
 * @returns The visible empty owner boundary, or null.
 * @throws {never}
 */
function emptySourcePoint(index: BodyProjectionIndex, source: string, physical: number): number | null {
  const pieces = [...index.view.pieces.values()].filter((piece) => piece.source === source && piece.start <= physical + 1 && piece.end >= physical);
  for (const piece of pieces) {
    let parent: string | undefined = piece.id;
    while (parent !== undefined) {
      const owner = index.owners.get(parent);
      if (owner !== undefined && !index.opaque.has(parent)) return owner.contentFrom;
      parent = index.view.tree.parents.get(parent);
    }
  }
  return null;
}

/**
 * Resolves a native gap and follows Yjs redone chains independently of character lifetime.
 * @param index - The common final projection index.
 * @param name - The stable point or selection name.
 * @returns The native point outcome in the current epoch.
 * @throws {DocumentBodyFormatError} If current native data violates its registered format.
 */
function resolveText(index: BodyProjectionIndex, name: BodyTextPointName): BodyPointResolution {
  if (!index.view.body.sources.has(name.source)) return { status: 'gone' };
  const tokenId = bodyTokenId(name.source, name.token);
  const native = tokenId === null ? null : bodyNativeItem(index.sourceDoc, tokenId);
  const live = native !== null && bodyNativeItemAlive(native);
  const actualToken = native === null ? null : `${name.source}/${native.item.id.client}:${native.item.id.clock + native.offset}`;
  const named = live ? index.units.find((unit) => unit.token === actualToken) : undefined;
  if (live && named === undefined) return { status: 'hidden' };

  const absolute = Y.createAbsolutePositionFromRelativePosition(name.relative, index.sourceDoc);
  if (absolute === null) return { status: 'gone' };
  if (absolute.type !== documentBodySource(index.sourceDoc, name.source)) return { status: 'otherDocument' };
  const anchor = name.relative.item === null ? null : bodyNativeItem(index.sourceDoc, name.relative.item);
  if (anchor !== null && bodyNativeItemAlive(anchor)) {
    const anchorToken = `${name.source}/${anchor.item.id.client}:${anchor.item.id.clock + anchor.offset}`;
    const occurrence = index.units.find((unit) => unit.token === anchorToken);
    if (occurrence !== undefined) return { status: 'resolved', pos: occurrence.pos + (name.relative.assoc < 0 ? occurrence.width : 0), epoch: index.epoch };
  }
  const units = index.units.filter((unit) => unit.source === name.source).sort((first, second) => first.index - second.index);
  const right = units.find((unit) => unit.index >= absolute.index);
  const left = units.findLast((unit) => unit.index < absolute.index);
  const point = name.assoc < 0
    ? left === undefined ? right?.pos : left.pos + left.width
    : right === undefined ? left === undefined ? undefined : left.pos + left.width : right.pos;
  if (point !== undefined) return { status: 'resolved', pos: point, epoch: index.epoch };
  if (name.fallback !== undefined) {
    const neighbors = name.assoc < 0 ? [name.fallback.left, name.fallback.right] : [name.fallback.right, name.fallback.left];
    for (const neighbor of neighbors) {
      if (neighbor === null) continue;
      const resolved = resolveText(index, neighbor);
      if (resolved.status === 'resolved') return resolved;
    }
  }
  const empty = emptySourcePoint(index, name.source, absolute.index);
  return empty === null ? { status: 'hidden' } : { status: 'resolved', pos: empty, epoch: index.epoch };
}

/**
 * Resolves a name against one final index while preserving every unavailable outcome.
 * @param index - The common final projection index.
 * @param name - The stable point or selection name.
 * @param options - The current document epoch or runtime state.
 * @returns The resolved point or distinct unavailable outcome.
 * @throws {DocumentBodyFormatError} If complete native records are invalid.
 */
export function resolveBodyPoint(index: BodyProjectionIndex, name: BodyPointName, options: BodyPositionOptions = {}): BodyPointResolution {
  const blocked = unavailable(index, name, options);
  if (blocked !== null) return blocked;
  if (name.kind === 'stagedText') {
    const finalized = stagedBodyNameState(name);
    if (finalized.status === 'final') return resolveBodyPoint(index, finalized.point, options);
    if (finalized.status === 'disposed') return { status: 'bindingUnavailable', runtime: 'disposed' };
    const unit = index.staged?.batch === name.batch ? index.staged.units.find((entry) => entry.token === name.token) : undefined;
    return unit === undefined ? { status: 'gone' } : { status: 'resolved', pos: unit.pos + name.offset, epoch: index.epoch };
  }
  if (name.kind === 'text') return resolveText(index, name);
  if (name.kind === 'bodyEdge') return { status: 'resolved', pos: bodyEdgePos(index.doc, name.edge), epoch: index.epoch };
  if (name.kind === 'node') {
    const node = index.nodes.get(name.node);
    return node === undefined ? absentNode(index, name.node) : { status: 'resolved', pos: nodeSide(node, name.side), epoch: index.epoch };
  }
  const parent = index.nodes.get(name.parent);
  if (parent === undefined) return absentNode(index, name.parent);
  const left = visibleGapNeighbor(index, name.left, parent);
  const right = visibleGapNeighbor(index, name.right, parent);
  const pos = name.assoc < 0 ? left?.to ?? right?.from ?? parent.contentFrom : right?.from ?? left?.to ?? parent.contentTo;
  return { status: 'resolved', pos, epoch: index.epoch };
}

/**
 * Tests the original character's current native replacement, even when its visible owner is hidden.
 * @param index - The common final projection index.
 * @param name - The stable point or selection name.
 * @returns Whether the original native character has a live replacement.
 * @throws {never}
 */
export function isNamedCharacterAlive(index: BodyProjectionIndex, name: BodyPointName): boolean {
  if (name.document === index.document && name.kind === 'stagedText') {
    const final = stagedBodyNameState(name);
    return final.status === 'final'
      ? final.character && isNamedCharacterAlive(index, final.point)
      : final.status === 'pending' && index.staged?.batch === name.batch && index.staged.units.some((unit) => unit.token === name.token);
  }
  if (name.document !== index.document || name.kind !== 'text') return false;
  const id = bodyTokenId(name.source, name.token);
  const native = id === null ? null : bodyNativeItem(index.sourceDoc, id);
  return native !== null && bodyNativeItemAlive(native);
}

/**
 * Converts a held local character name before awareness or persistence serialization.
 * @param name - A native name or a local name completed by its actual USER.
 * @returns A final name containing no batch-local token.
 * @throws {DocumentBodyFormatError} If the name has not been finalized or its handle was released.
 */
export function finalizeBodyPointName(name: BodyPointName): BodyPointName {
  if (name.kind !== 'stagedText') return name;
  const final = stagedBodyNameState(name);
  if (final.status !== 'final') throw new DocumentBodyFormatError(`A local body name is ${final.status}`);
  return finalizeBodyPointName(final.point);
}

/**
 * Finalizes every local endpoint while preserving the original selection family.
 * @param name - The complete selection held by a consumer.
 * @returns Its final serializable selection name.
 * @throws {DocumentBodyFormatError} If any local endpoint is not finalized.
 */
export function finalizeBodySelectionName(name: BodySelectionName): BodySelectionName {
  return name.kind === 'node' || name.kind === 'all' ? name : { ...name, anchor: finalizeBodyPointName(name.anchor), head: finalizeBodyPointName(name.head) };
}

/**
 * Finds the registered node beginning at a PM selection's stable boundary.
 * @param index - The common final projection index.
 * @param position - The position in the supplied final PM document.
 * @returns The stable registered identity at this boundary.
 * @throws {DocumentBodyFormatError} If the selection points at a local synthetic node.
 */
function nodeAt(index: BodyProjectionIndex, position: number): string {
  for (const node of index.nodes.values()) if (node.from === position && node.id !== index.view.root) return node.id;
  throw new DocumentBodyFormatError('A node selection needs an existing registered node');
}

/**
 * Distinguishes an owner's direct content selection from its outer wrapper selection.
 * @param index - The exact current common projection index.
 * @param selection - The actual node selection made by the product entry.
 * @returns A stable owner name with an explicit content selector only when needed.
 * @throws {DocumentBodyFormatError} If neither a registered boundary nor direct owner content matches.
 */
function nameNodeSelection(index: BodyProjectionIndex, selection: NodeSelection): Extract<BodySelectionName, { readonly kind: 'node' }> {
  const identity = { version: 1, document: index.document, kind: 'node' } as const;
  for (const owner of index.nodes.values()) {
    if (owner.from + 1 !== selection.from) continue;
    const wrapper = index.doc.nodeAt(owner.from);
    if (wrapper?.type.name === 'blockContainer' && wrapper.firstChild?.eq(selection.node)) return { ...identity, node: owner.id, part: 'content' };
  }
  return { ...identity, node: nodeAt(index, selection.from) };
}

/**
 * Names one endpoint, preserving the body-edge marker when the selection uses it.
 * @param index - The common final projection index.
 * @param position - The position in the supplied final PM document.
 * @param assoc - The native or container boundary affinity.
 * @param edge - Whether to preserve body-edge markers.
 * @returns A native text or explicit body-edge name.
 * @throws {DocumentBodyFormatError} If the endpoint has no native target.
 */
function selectionPoint(index: BodyProjectionIndex, position: number, assoc: BodyAssociation, edge: boolean): BodyPointName {
  const marker = edge ? bodyEdgeAt(index.doc, position) : null;
  return nameBodyPoint(index, marker === null ? { kind: 'text', pos: position, assoc } : { kind: 'bodyEdge', edge: marker });
}

/**
 * Names actual PM selections without collapsing cell, node, body-edge or all semantics into text.
 * @param index - The common final projection index.
 * @param selection - The actual PM selection to name.
 * @returns A name preserving the original selection family.
 * @throws {DocumentBodyFormatError} If the selection has no existing registered target.
 */
export function nameBodySelection(index: BodyProjectionIndex, selection: Selection): BodySelectionName {
  const identity = { version: 1, document: index.document } as const;
  if (selection instanceof AllSelection) return { ...identity, kind: 'all' };
  if (selection instanceof NodeSelection) {
    if (selection.node.isInline) return { ...identity, kind: 'inlineNode',
      anchor: nameBodyPoint(index, { kind: 'text', pos: selection.from, assoc: 1 }),
      head: nameBodyPoint(index, { kind: 'text', pos: selection.to, assoc: -1 }),
    };
    return nameNodeSelection(index, selection);
  }
  if (selection instanceof CellSelection) return { ...identity, kind: 'cell', anchor: nameBodyPoint(index, { kind: 'node', node: nodeAt(index, selection.$anchorCell.pos), side: 'before' }), head: nameBodyPoint(index, { kind: 'node', node: nodeAt(index, selection.$headCell.pos), side: 'before' }) };
  const edge = selection.toJSON().type === 'bodyEdge';
  const forward = selection.anchor <= selection.head;
  return { ...identity, kind: edge ? 'bodyEdge' : 'text', anchor: selectionPoint(index, selection.anchor, forward ? 1 : -1, edge), head: selectionPoint(index, selection.head, selection.empty ? 1 : forward ? -1 : 1, edge) };
}

/**
 * Uses a surviving endpoint or the beginning of the current body for legal near-selection fallback.
 * @param index - The common final projection index.
 * @param position - The position in the supplied final PM document.
 * @returns A legal selection in the final document.
 * @throws {RangeError} If the schema cannot provide a selection.
 */
function nearSelection(index: BodyProjectionIndex, position = 0): Selection {
  return Selection.near(index.doc.resolve(Math.min(index.doc.content.size, Math.max(0, position))));
}

/**
 * Restores the original selection family, using a legal near selection only after a target disappears.
 * @param index - The common final projection index.
 * @param name - The stable point or selection name.
 * @param options - The current document epoch or runtime state.
 * @returns The restored selection or distinct unavailable outcome.
 * @throws {DocumentBodyFormatError} If current complete records are invalid.
 * @throws {RangeError} If the current schema cannot represent a selection.
 */
export function resolveBodySelection(index: BodyProjectionIndex, name: BodySelectionName, options: BodyPositionOptions = {}): BodySelectionResolution {
  const blocked = unavailable(index, name, options);
  if (blocked !== null) return blocked;
  let selection: Selection;
  if (name.kind === 'all') selection = new AllSelection(index.doc);
  else if (name.kind === 'node') {
    const node = index.nodes.get(name.node);
    if (node === undefined) selection = nearSelection(index);
    else if (name.part === 'content') {
      const wrapper = index.doc.nodeAt(node.from);
      selection = wrapper?.type.name === 'blockContainer' && wrapper.firstChild !== null
        ? NodeSelection.create(index.doc, node.from + 1)
        : nearSelection(index, node.from);
    } else selection = NodeSelection.create(index.doc, node.from);
  } else {
    const anchor = resolveBodyPoint(index, name.anchor, options);
    const head = resolveBodyPoint(index, name.head, options);
    for (const endpoint of [anchor, head]) if (endpoint.status !== 'resolved' && endpoint.status !== 'hidden' && endpoint.status !== 'gone') return endpoint;
    if (anchor.status !== 'resolved' || head.status !== 'resolved') selection = nearSelection(index, anchor.status === 'resolved' ? anchor.pos : head.status === 'resolved' ? head.pos : 0);
    else if (name.kind === 'inlineNode') {
      const node = index.doc.nodeAt(anchor.pos);
      selection = node?.isInline === true && NodeSelection.isSelectable(node) && anchor.pos + node.nodeSize === head.pos
        ? NodeSelection.create(index.doc, anchor.pos)
        : nearSelection(index, anchor.pos);
    } else if (name.kind === 'cell') {
      const a = index.doc.nodeAt(anchor.pos);
      const h = index.doc.nodeAt(head.pos);
      const aCell = a?.type.spec.tableRole === 'cell' || a?.type.spec.tableRole === 'header_cell';
      const hCell = h?.type.spec.tableRole === 'cell' || h?.type.spec.tableRole === 'header_cell';
      const $anchor = index.doc.resolve(anchor.pos);
      const $head = index.doc.resolve(head.pos);
      selection = aCell && hCell && inSameTable($anchor, $head) ? new CellSelection($anchor, $head) : nearSelection(index, anchor.pos);
    } else if (name.kind === 'bodyEdge') selection = bodyEdgeBetween(index.doc, anchor.pos, head.pos);
    else selection = TextSelection.between(index.doc.resolve(anchor.pos), index.doc.resolve(head.pos));
  }
  return { status: 'resolved', selection, epoch: index.epoch };
}
