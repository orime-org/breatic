// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { Fragment, Mark, type Node as PMNode, type NodeType, type Schema } from '@tiptap/pm/model';
import type * as Y from 'yjs';

import { type BodyRecord, type BodyTreeOwner, type BodyTreeUnit, type BodyTreeView } from '@breatic/shared';
import { BODY_MARK_ATTRIBUTE_PREFIX, bodyTreeRecordProperties, DocumentBodyFormatError, readBodyTree } from '@breatic/shared/document-body';

import type {
  BodyIndexedUnit,
  BodyNodePosition,
  BodyOpaquePayload,
  BodyProjectionOptions,
  BodyProjectionRead,
} from '@web/spaces/document/document-body-codec-types';
import { bodyGeometryCoverage, completeBodyGeometry, repairBodyGeometry } from '@web/spaces/document/document-body-codec-geometry';
import { bodyNativePoints } from '@web/spaces/document/document-body-codec-points';
import { bodyInlineOccurrences } from '@web/spaces/document/document-body-provenance';
import { UNSUPPORTED_BLOCK, UNSUPPORTED_INLINE } from '@web/spaces/document/document-unsupported-blocknote';

/** Local construction state never attached to the native document. */
interface ProjectionBuilder {
  readonly schema: Schema;
  readonly view: BodyTreeView;
  readonly ids: WeakMap<PMNode, string>;
  readonly owners: Map<string, BodyTreeOwner>;
  readonly opaque: Map<string, BodyOpaquePayload>;
}

/**
 * Narrows a native envelope without accepting an inherited property.
 * @param value - The unknown native value.
 * @returns Whether the value is an inspectable dictionary.
 * @throws {never}
 */
function dictionary(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Reads native mark references and filters only the displayed marks.
 * @param builder - The local read-only projection context.
 * @param parent - The installed content node type.
 * @param unit - The original native inline unit.
 * @returns The marks allowed by the displayed parent.
 * @throws {DocumentBodyFormatError} If a registered mark cannot be projected.
 */
function marksFor(builder: ProjectionBuilder, parent: NodeType, unit: BodyTreeUnit): readonly Mark[] {
  const marks: Mark[] = [];
  for (const [key, value] of Object.entries(unit.attributes)) {
    if (!key.startsWith(BODY_MARK_ATTRIBUTE_PREFIX)) continue;
    if (!dictionary(value) || typeof value['factId'] !== 'string') throw new DocumentBodyFormatError('Invalid inline mark reference');
    const fact = builder.view.body.facts.get(value['factId']);
    if (fact?.kind !== 'mark') throw new DocumentBodyFormatError('Missing inline mark payload');
    const known = builder.schema.marks[fact.payload.type];
    if (known !== undefined) marks.push(known.create(fact.payload.attrs));
    else {
      const fallback = builder.schema.marks['unsupportedMark'];
      if (fallback === undefined) throw new DocumentBodyFormatError('The body schema requires its unknown-mark fallback');
      marks.push(fallback.create({ originalName: fact.payload.type, originalValue: fact.payload.attrs }));
    }
  }
  return parent.allowedMarks(Mark.setFrom(marks));
}

/**
 * Decodes exactly one product-owned native leaf while retaining its source value in the index.
 * @param builder - The local read-only projection context.
 * @param parent - The installed content node type.
 * @param unit - The original native inline unit.
 * @returns One legal text or inline leaf node.
 * @throws {DocumentBodyFormatError} If the native envelope or schema leaf is invalid.
 */
function inlineFor(builder: ProjectionBuilder, parent: NodeType, unit: BodyTreeUnit): PMNode {
  const marks = marksFor(builder, parent, unit);
  if (typeof unit.value === 'string') return builder.schema.text(unit.value, marks);
  const value = unit.value;
  if (!dictionary(value) || !Object.hasOwn(value, 'bodyInline') || !dictionary(value['bodyInline'])) throw new DocumentBodyFormatError('Invalid body inline value');
  const inline = value['bodyInline'];
  if (typeof inline['type'] !== 'string' || !dictionary(inline['attrs'])) throw new DocumentBodyFormatError('Invalid body inline descriptor');
  const known = builder.schema.nodes[inline['type']];
  if (known !== undefined) {
    if (!known.isInline || !known.isLeaf) throw new DocumentBodyFormatError('A body inline value must name an inline leaf');
    return known.create(inline['attrs'], null, marks);
  }
  const fallback = builder.schema.nodes[UNSUPPORTED_INLINE];
  if (fallback === undefined) throw new DocumentBodyFormatError('The body schema requires its unknown-inline fallback');
  return fallback.create({ originalName: inline['type'] }, null, marks);
}

/**
 * Captures original records and native units in current tree order behind a stand-in.
 * @param view - The complete shared tree view.
 * @param id - The stable record or native identity.
 * @returns The complete original payload in tree order.
 * @throws {never}
 */
function opaqueFor(view: BodyTreeView, id: string): BodyOpaquePayload {
  const descendants: BodyRecord[] = [];
  const units: BodyTreeUnit[] = [];
  const stack = [id];
  while (stack.length > 0) {
    const current = stack.pop()!;
    const record = view.body.records.get(current);
    if (current !== id && record !== undefined) descendants.push(record);
    const piece = view.pieces.get(current);
    if (piece !== undefined) units.push(...piece.units);
    const children = view.tree.children.get(current) ?? [];
    for (let index = children.length - 1; index >= 0; index -= 1) stack.push(children[index]);
  }
  return { record: view.body.records.get(id)!, descendants, units };
}

/**
 * Makes one legal block placeholder without modifying its complete native subtree.
 * @param builder - The local read-only projection context.
 * @param id - The stable record or native identity.
 * @param originalName - The original registered node type.
 * @param wrapper - The original block wrapper attributes.
 * @returns A legal block stand-in retaining its source index.
 * @throws {DocumentBodyFormatError} If the installed schema lacks the fallback.
 */
function opaqueNode(builder: ProjectionBuilder, id: string, originalName: string, wrapper: Readonly<Record<string, unknown>> = {}): PMNode {
  const fallback = builder.schema.nodes[UNSUPPORTED_BLOCK];
  const container = builder.schema.nodes['blockContainer'];
  if (fallback === undefined || container === undefined) throw new DocumentBodyFormatError('The body schema requires its unknown-block fallback');
  builder.opaque.set(id, opaqueFor(builder.view, id));
  const node = container.create({ ...wrapper, id }, fallback.create({ originalName }));
  builder.ids.set(node, id);
  return node;
}

/**
 * Projects structural children, keeping source facets out of the PM block tree.
 * @param builder - The local read-only projection context.
 * @param id - The stable record or native identity.
 * @returns The displayed structural children in current order.
 * @throws {DocumentBodyFormatError} If a child is not representable.
 */
function childrenFor(builder: ProjectionBuilder, id: string): PMNode[] {
  return (builder.view.tree.children.get(id) ?? []).flatMap((child) => renderRecord(builder, child));
}

/**
 * Renders an owner or a product container and transparently expands detached wrappers.
 * @param builder - The local read-only projection context.
 * @param id - The stable record or native identity.
 * @returns The legal structural nodes replacing this record.
 * @throws {DocumentBodyFormatError} If native content violates the declared schema.
 */
function renderRecord(builder: ProjectionBuilder, id: string): PMNode[] {
  const record = builder.view.body.records.get(id);
  if (record === undefined || record.kind === 'facet') return [];
  if (!builder.view.visible.has(id)) {
    if (record.kind !== 'owner') return [];
    return childrenFor(builder, id).flatMap((child) => child.type.name === 'blockGroup' ? [...child.content.content] : [child]);
  }
  const props = bodyTreeRecordProperties(builder.view, id);
  const type = builder.schema.nodes[props.type];
  if (type === undefined) return [opaqueNode(builder, id, props.type, props.wrapperAttrs)];
  if (record.kind === 'owner') {
    const owner = builder.owners.get(id);
    if (owner === undefined) throw new DocumentBodyFormatError('Visible owner has no source projection');
    const inline = Fragment.fromArray(owner.units.map((unit) => inlineFor(builder, type, unit)));
    if (!type.validContent(inline)) throw new DocumentBodyFormatError(`Inline content is invalid for body owner:${id}`);
    const content = type.create(props.attrs, inline);
    const nested = childrenFor(builder, id);
    const container = builder.schema.nodes['blockContainer'];
    if (container === undefined) throw new DocumentBodyFormatError('The body schema requires block containers');
    const node = container.create({ ...props.wrapperAttrs, id }, [content, ...nested]);
    if (!container.validContent(node.content)) throw new DocumentBodyFormatError(`Invalid body owner children:${id}`);
    builder.ids.set(node, id);
    return [node];
  }
  const children = childrenFor(builder, id);
  if (type.spec.tableRole === 'table' && !children.some((row) => row.childCount > 0)) return [];
  if (props.type === 'blockGroup' && children.length === 0) {
    const group = syntheticGroup(builder.schema, id);
    builder.ids.set(group, id);
    return [group];
  }
  const attrs = Object.hasOwn(type.spec.attrs ?? {}, 'id') ? { ...props.attrs, id } : props.attrs;
  const node = type.createAndFill(attrs, children);
  if (node === null) throw new DocumentBodyFormatError(`Invalid body container children:${id}`);
  builder.ids.set(node, id);
  return [node];
}

/**
 * Builds a legal local placeholder without registering owner, source, fact or history.
 * @param schema - The actual installed editor schema.
 * @param document - The owning document identity.
 * @returns A local empty block group.
 * @throws {DocumentBodyFormatError} If the installed schema cannot represent an empty body.
 */
function syntheticGroup(schema: Schema, document: string): PMNode {
  const paragraph = schema.nodes['paragraph']?.createAndFill();
  const container = paragraph === null || paragraph === undefined ? null : schema.nodes['blockContainer']?.createAndFill({ id: `body-synthetic:${document}` }, paragraph);
  const group = container === null || container === undefined ? null : schema.nodes['blockGroup']?.createAndFill(null, container);
  if (group === null || group === undefined) throw new DocumentBodyFormatError('The body schema cannot represent a local empty body');
  return group;
}

/**
 * Associates constructed nodes with their original stable record names before table repair.
 * @param doc - The document being inspected.
 * @param builder - The local read-only projection context.
 * @returns The stable identities and their initial PM positions.
 * @throws {never}
 */
function originalPositions(doc: PMNode, builder: ProjectionBuilder): Map<string, number> {
  const positions = new Map<string, number>();
  doc.descendants((node, pos) => {
    const id = builder.ids.get(node);
    if (id !== undefined) positions.set(id, pos);
  });
  return positions;
}

/**
 * Binds displayed occurrences to their original units without matching by text.
 * @param doc - The document being inspected.
 * @param builder - The local read-only projection context.
 * @param owners - The independently registered or projected owners.
 * @returns Displayed occurrences with their exact native identities.
 * @throws {DocumentBodyFormatError} If a repair changed, duplicated or discarded native content.
 */
function indexedUnits(doc: PMNode, builder: ProjectionBuilder, owners: ReadonlyMap<string, BodyNodePosition>): BodyIndexedUnit[] {
  const cursors = new Map<string, number>();
  const result: BodyIndexedUnit[] = [];
  for (const occurrence of bodyInlineOccurrences(doc)) {
    const owner = occurrence.block === null ? undefined : builder.owners.get(occurrence.block);
    if (owner === undefined || builder.opaque.has(owner.id)) throw new DocumentBodyFormatError('A displayed inline occurrence has no registered owner');
    const cursor = cursors.get(owner.id) ?? 0;
    const native = owner.units[cursor];
    if (native === undefined) throw new DocumentBodyFormatError('A displayed inline occurrence has no native source');
    const expected = typeof native.value === 'string' ? native.value : `<${dictionary(native.value) && dictionary(native.value['bodyInline']) && typeof native.value['bodyInline']['type'] === 'string' && builder.schema.nodes[native.value['bodyInline']['type']] !== undefined ? native.value['bodyInline']['type'] : UNSUPPORTED_INLINE}>`;
    if (occurrence.value !== expected) throw new DocumentBodyFormatError('Body projection changed a native inline occurrence');
    result.push({ ...occurrence, token: native.id, origin: 'existing', source: native.source, index: native.index, owner: owner.id, native });
    cursors.set(owner.id, cursor + 1);
  }
  for (const [id] of owners) {
    const original = builder.owners.get(id);
    if (original !== undefined && !builder.opaque.has(id) && (cursors.get(id) ?? 0) !== original.units.length) throw new DocumentBodyFormatError(`Body projection lost native owner content:${id}`);
  }
  if (new Set(result.map((unit) => unit.token)).size !== result.length) throw new DocumentBodyFormatError('Body projection duplicated native identity');
  return result;
}

/**
 * Projects native records into one legal final frame without writing to the source document.
 * @param sourceDoc - The native document holding the permanent sources.
 * @param schema - The actual installed editor schema.
 * @param options - The current document epoch or runtime state.
 * @returns A final frame or its explicit dependency state.
 * @throws {DocumentBodyFormatError} If complete records cannot be represented by the installed schema.
 * @throws {RangeError} If the schema or installed table repair rejects the projected document.
 */
export function projectBodyTree(sourceDoc: Y.Doc, schema: Schema, options: BodyProjectionOptions): BodyProjectionRead {
  const read = readBodyTree(sourceDoc);
  if (read.status !== 'ready') return read;
  const view = read.view;
  const builder: ProjectionBuilder = { schema, view, ids: new WeakMap(), owners: new Map(view.owners.map((owner) => [owner.id, owner])), opaque: new Map() };
  const root = view.body.records.get(view.root)!;
  if (root.kind !== 'root') throw new DocumentBodyFormatError('The body root must be a root record');
  let children = childrenFor(builder, view.root);
  const synthetic = children.length === 0;
  if (synthetic) {
    const group = syntheticGroup(schema, options.document);
    const originalGroup = (view.tree.children.get(view.root) ?? []).find((id) => {
      const record = view.body.records.get(id);
      return record?.kind === 'container' && record.type === 'blockGroup';
    });
    if (originalGroup !== undefined) builder.ids.set(group, originalGroup);
    children = [group];
  }
  const before = schema.topNodeType.create(root.attrs, children);
  const initial = originalPositions(before, builder);
  const coverage = bodyGeometryCoverage(before);
  const repair = repairBodyGeometry(before);
  const mapped = new Map([...initial].map(([id, position]) => [repair.mapping.map(position, 1), id]));
  const completed = completeBodyGeometry(repair.doc, view, mapped, coverage);
  const { doc, nodes, owners, derived } = completed;
  if (synthetic) {
    for (const [id, record] of derived) if (record.kind === 'owner') owners.delete(id);
  }
  const units = indexedUnits(doc, builder, owners);
  const nativePoints = bodyNativePoints(sourceDoc, view, units, owners);
  const index = { ...options, sourceDoc, doc, view, units, nativePoints, nodes, owners, derived, opaque: builder.opaque };
  const occurrences = units.map(({ pos, width, value, block, token, origin }) => ({ pos, width, value, block, token, origin }));
  return { status: 'ready', projection: { doc, units: occurrences, view, index, epoch: options.epoch, synthetic } };
}
