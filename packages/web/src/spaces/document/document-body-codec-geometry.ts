// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { Fragment, type Node as PMNode } from '@tiptap/pm/model';
import { EditorState } from '@tiptap/pm/state';
import { Mapping } from '@tiptap/pm/transform';
import { fixTables, TableMap } from '@tiptap/pm/tables';

import { bodyTreeOrderBetween, bodyTreeRecordProperties, deriveId, DocumentBodyFormatError, type BodyTreeView } from '@breatic/shared';

import type { BodyDerivedRecord, BodyNodePosition } from '@web/spaces/document/document-body-codec-types';

/** Original row geometry, including incoming spans, before any library repair. */
export type BodyGeometryCoverage = ReadonlyMap<string, ReadonlyMap<string, string>>;

/** Final local node identities and boundaries, including slots with no persisted records yet. */
export interface BodyCompletedGeometry {
  readonly doc: PMNode;
  readonly nodes: Map<string, BodyNodePosition>;
  readonly owners: Map<string, BodyNodePosition>;
  readonly derived: Map<string, BodyDerivedRecord>;
}

/** Context is structural and never contains a PM absolute position in an allocated name. */
interface GeometryContext {
  readonly parent: string;
  readonly table: string | null;
  readonly row: string | null;
  readonly coverage: string;
  readonly slot: readonly number[];
}

/** Local finalization buffers, scoped to one complete read-only projection. */
interface GeometryBuilder {
  readonly view: BodyTreeView;
  readonly original: ReadonlyMap<number, string>;
  readonly coverage: BodyGeometryCoverage;
  readonly retired: ReadonlySet<string>;
  readonly result: BodyCompletedGeometry;
}

/**
 * Captures original row coverage by stable identities instead of text-dependent PM offsets.
 * @param doc - The original complete PM construction before table repair.
 * @returns Each table and row's canonical original geometric input.
 * @throws {RangeError} If installed TableMap rejects the original table shape.
 */
export function bodyGeometryCoverage(doc: PMNode): BodyGeometryCoverage {
  const tables = new Map<string, ReadonlyMap<string, string>>();
  doc.descendants((table) => {
    if (table.type.spec.tableRole !== 'table') return;
    const id: unknown = table.attrs['id'];
    if (typeof id !== 'string') throw new DocumentBodyFormatError('A table requires a stable original identity');
    const map = TableMap.get(table);
    const rows = new Map<string, string>();
    table.forEach((row, _offset, ordinal) => {
      const rowId: unknown = row.attrs['id'];
      if (typeof rowId !== 'string') throw new DocumentBodyFormatError('A table row requires a stable original identity');
      const cells: unknown[] = [];
      row.forEach((cell) => cells.push([cell.attrs['id'], cell.type.name, cell.attrs['colspan'], cell.attrs['rowspan'], cell.attrs['colwidth']]));
      const slots = map.map.slice(ordinal * map.width, (ordinal + 1) * map.width).map((offset) => offset === 0 ? null : table.nodeAt(offset)?.attrs['id'] ?? null);
      rows.set(rowId, JSON.stringify([ordinal, map.width, cells, slots]));
    });
    tables.set(id, rows);
  });
  return tables;
}

/**
 * Repeats the installed table repair to its own fixed point without a product pass limit.
 * @param doc - The original PM construction.
 * @returns Stable geometry and the composition of its actual positional mappings.
 * @throws {DocumentBodyFormatError} If the installed repair cycles or makes no progress.
 * @throws {RangeError} If the installed repair rejects the current geometry.
 */
export function repairBodyGeometry(doc: PMNode): { readonly doc: PMNode; readonly mapping: Mapping } {
  let state = EditorState.create({ doc });
  const mapping = new Mapping();
  const seen = new Set<string>([JSON.stringify(doc.toJSON())]);
  for (;;) {
    const repair = fixTables(state);
    if (repair === undefined) return { doc: state.doc, mapping };
    const key = JSON.stringify(repair.doc.toJSON());
    if (repair.doc.eq(state.doc) || seen.has(key)) throw new DocumentBodyFormatError('Installed table repair did not advance its geometry');
    seen.add(key);
    mapping.appendMapping(repair.mapping);
    state = state.apply(repair);
  }
}

/**
 * Reads a stable name after repair, preserving nameless-schema groups via the composed mapping.
 * @param builder - Current completion buffers.
 * @param node - The current PM node.
 * @param position - Its position, used only for lookup and indexing.
 * @returns An original registered identity, or null for an unregistered schema slot.
 * @throws {never}
 */
function originalId(builder: GeometryBuilder, node: PMNode, position: number): string | null {
  const mapped = builder.original.get(position);
  if (mapped !== undefined) return mapped;
  const id: unknown = node.attrs['id'];
  return typeof id === 'string' && builder.view.body.records.has(id) ? id : null;
}

/**
 * Allocates the first identity without a currently effective explicit retirement fact.
 * @param builder - Current completion buffers.
 * @param node - The local schema node requiring a stable identity.
 * @param context - Stable table, row, parent and repair-slot inputs.
 * @returns The stable v5 identity and its first non-retired generation.
 * @throws {never}
 */
function derivedIdentity(builder: GeometryBuilder, node: PMNode, context: GeometryContext): { readonly id: string; readonly generation: number } {
  let generation = 0;
  let id: string;
  do {
    id = deriveId(JSON.stringify(['document-body-hole', 1, context.table ?? builder.view.root, context.row, context.coverage, context.parent, context.slot, node.type.name, generation++]));
  } while (builder.retired.has(id));
  return { id, generation: generation - 1 };
}

/**
 * Identifies the schema nodes that need block identity or a stable structural parent.
 * @param node - The current PM node.
 * @returns Whether it needs a common-index node identity.
 * @throws {never}
 */
function needsIdentity(node: PMNode): boolean {
  return node.type.name === 'blockContainer' || node.type.name === 'blockGroup' || ['table', 'row', 'cell', 'header_cell'].includes(String(node.type.spec.tableRole));
}

/**
 * Finds a derived sibling's actual available order interval in the current registered tree.
 * @param builder - Current completion buffers.
 * @param children - Actual final PM children in physical order.
 * @param starts - Their lookup positions after geometry repair.
 * @param parent - Their stable structural parent.
 * @param index - The local child ordinal.
 * @param previous - The preceding final sibling order, when present.
 * @param id - This derived node's operation name for the existing fractional-index helper.
 * @returns A stable order between the surrounding registered/current siblings.
 * @throws {RangeError} If stored sibling orders provide no legal interval.
 */
function derivedOrder(builder: GeometryBuilder, children: readonly PMNode[], starts: readonly number[], parent: string, index: number, previous: string, id: string): string {
  let after = '';
  for (let next = index + 1; next < children.length; next += 1) {
    const original = originalId(builder, children[next], starts[next]);
    if (original !== null && builder.view.tree.parents.get(original) === parent) {
      after = builder.view.tree.selected.get(original)?.order ?? '';
      break;
    }
  }
  return bodyTreeOrderBetween(previous, after, id);
}

/**
 * Indexes a final registered or derived node's exact outer and content boundaries.
 * @param builder - The final completion buffers.
 * @param node - The completed PM node.
 * @param id - Its stable registered or local identity.
 * @param position - Its final PM position.
 * @throws {DocumentBodyFormatError} If a block wrapper has no content node.
 */
function indexNode(builder: GeometryBuilder, node: PMNode, id: string, position: number): void {
  const owner = node.type.name === 'blockContainer';
  if (owner && node.firstChild === null) throw new DocumentBodyFormatError('A body wrapper requires a content node');
  const props = builder.view.body.records.has(id) ? bodyTreeRecordProperties(builder.view, id) : builder.result.derived.get(id);
  const contentFrom = position + (owner ? 2 : 1);
  const entry = { id, type: props?.type ?? node.type.name, from: position, to: position + node.nodeSize, contentFrom, contentTo: owner ? contentFrom + node.firstChild!.content.size : position + node.nodeSize - 1 };
  builder.result.nodes.set(id, entry);
  if (owner) builder.result.owners.set(id, entry);
}

/**
 * Completes a repaired subtree with purely local identity and immutable derived descriptors.
 * @param builder - Current completion buffers.
 * @param node - The node being completed.
 * @param position - Its final PM lookup position.
 * @param context - Its stable parent and geometry context.
 * @param assigned - An identity/order allocated by the parent sibling traversal.
 * @param assigned.id - The stable derived identity.
 * @param assigned.generation - The deterministic generation of this local hole.
 * @param assigned.order - Its immutable default sibling order.
 * @returns The same geometry and content with stable local attrs.
 * @throws {DocumentBodyFormatError} If an original visible wrapper or table lacks its content.
 * @throws {RangeError} If current sibling orders cannot represent a derived slot.
 */
function completeNode(builder: GeometryBuilder, node: PMNode, position: number, context: GeometryContext, assigned?: { readonly id: string; readonly generation: number; readonly order: string }): PMNode {
  if (node.isText) return node;
  const original = originalId(builder, node, position);
  const identified = needsIdentity(node);
  const allocation = identified && original === null ? assigned ?? { ...derivedIdentity(builder, node, context), order: bodyTreeOrderBetween('', '', node.type.name) } : null;
  const id = original ?? allocation?.id;
  const owner = node.type.name === 'blockContainer';
  if (allocation !== null) {
    builder.result.derived.set(allocation.id, { ...allocation, kind: owner ? 'owner' : 'container', type: owner ? node.firstChild!.type.name : node.type.name, parent: context.parent, attrs: (owner ? node.firstChild!.attrs : { ...node.attrs, ...(Object.hasOwn(node.type.spec.attrs ?? {}, 'id') ? { id: allocation.id } : {}) }), wrapperAttrs: owner ? { ...node.attrs, id: allocation.id } : {} });
  }
  const table = node.type.spec.tableRole === 'table' ? id ?? null : context.table;
  const row = node.type.spec.tableRole === 'row' ? id ?? null : context.row;
  const coverage = table !== null && row !== null ? builder.coverage.get(table)?.get(row) ?? context.coverage : context.coverage;
  const parent = id ?? context.parent;
  const children: PMNode[] = [];
  const starts: number[] = [];
  node.forEach((child, offset) => { children.push(child); starts.push(position + 1 + offset); });
  let previous = '';
  const output = children.map((child, ordinal) => {
    const start = starts[ordinal];
    const existing = originalId(builder, child, start);
    const childContext: GeometryContext = { parent, table, row, coverage, slot: [ordinal] };
    let childAllocation: { readonly id: string; readonly generation: number; readonly order: string } | undefined;
    if (needsIdentity(child) && existing === null) {
      const identity = derivedIdentity(builder, child, childContext);
      const order = derivedOrder(builder, children, starts, parent, ordinal, previous, identity.id);
      childAllocation = { ...identity, order };
      previous = order;
    } else if (existing !== null && builder.view.tree.parents.get(existing) === parent) previous = builder.view.tree.selected.get(existing)?.order ?? previous;
    return completeNode(builder, child, start, childContext, childAllocation);
  });
  const attrs = allocation !== null && Object.hasOwn(node.type.spec.attrs ?? {}, 'id') ? { ...node.attrs, id: allocation.id } : node.attrs;
  const completed = node.type.create(attrs, Fragment.fromArray(output), node.marks);
  if (id !== undefined) indexNode(builder, completed, id, position);
  return completed;
}

/**
 * Adds stable derived names and complete boundaries without adding any shared registration.
 * @param doc - Stable installed-library geometry.
 * @param view - The original complete native frame.
 * @param original - Original registered positions mapped through every repair.
 * @param coverage - Canonical original row coverage, captured before repair.
 * @returns The final purely local PM document, derived descriptions and all node boundaries.
 * @throws {DocumentBodyFormatError} If current geometry cannot preserve original content.
 * @throws {RangeError} If stored sibling orders cannot represent local repair slots.
 */
export function completeBodyGeometry(doc: PMNode, view: BodyTreeView, original: ReadonlyMap<number, string>, coverage: BodyGeometryCoverage): BodyCompletedGeometry {
  const retired = new Set([...view.body.facts.values()].filter((fact) => fact.kind === 'delete' && view.body.enabled.has(fact.group)).map((fact) => fact.kind === 'delete' ? fact.owner : ''));
  const result: BodyCompletedGeometry = { doc, nodes: new Map(), owners: new Map(), derived: new Map() };
  const builder = { view, original, coverage, retired, result };
  const completed = completeNode(builder, doc, -1, { parent: view.root, table: null, row: null, coverage: '', slot: [] });
  completed.check();
  const root = { id: view.root, type: 'doc', from: 0, to: completed.content.size, contentFrom: 0, contentTo: completed.content.size };
  result.nodes.set(view.root, root);
  return { ...result, doc: completed };
}
