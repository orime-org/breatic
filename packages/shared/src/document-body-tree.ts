// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as Y from "yjs";

import {
  BODY_CONTEXT_ATTRIBUTE,
  BODY_MARK_ATTRIBUTE_PREFIX,
  bodyCutId,
  documentBodySource,
  DocumentBodyFormatError,
  readDocumentBodyRecords,
} from "@shared/document-body-records.js";
import type {
  BodyAttributeFact,
  BodyJsonObject,
  BodyJsonValue,
  BodyNodeKindFact,
  BodyParentEdge,
  BodyRecord,
  BodyRecordsSnapshot,
} from "@shared/document-body-records-types.js";
import {
  bodyTreeOrderBetween,
  computeBodyTreeCandidates,
  type BodyComputedTree,
  type BodyTreeCandidate,
  type BodyTreeCandidates,
} from "@shared/document-body-tree-vendor.js";

const RIGHT = "\u00ff";

/** A permanent cut's derived boundary, movable branch or native payload. */
export interface BodyDerivedNode {
  readonly id: string;
  readonly kind: "cut" | "right" | "piece";
  readonly source: string;
  readonly cut: string;
  readonly parent: string;
  readonly order: string;
}

/** Registered product nodes and the current permanent-cut chain. */
export type BodyTreeNode = BodyRecord | BodyDerivedNode;

/** One native UTF-16 or inline unit, retaining its actual Yjs identity. */
export interface BodyTreeUnit {
  readonly id: string;
  readonly source: string;
  readonly index: number;
  readonly piece: string;
  readonly value: unknown;
  readonly attributes: Readonly<Record<string, unknown>>;
}

/** The physical interval following a cut and ending before its next cut. */
export interface BodyTreePiece {
  readonly id: string;
  readonly source: string;
  readonly cut: string;
  readonly start: number;
  readonly end: number;
  readonly units: readonly BodyTreeUnit[];
}

/** One visible block's current kind, complete attributes and original sources. */
export interface BodyTreeOwner {
  readonly id: string;
  readonly type: string;
  readonly attrs: BodyJsonObject;
  readonly wrapperAttrs: BodyJsonObject;
  readonly facet: string;
  readonly units: readonly BodyTreeUnit[];
}

/** A complete read-only body frame shared by planning, positions and the codec. */
export interface BodyTreeView {
  readonly root: string;
  readonly body: BodyRecordsSnapshot;
  readonly nodes: ReadonlyMap<string, BodyTreeNode>;
  readonly pieces: ReadonlyMap<string, BodyTreePiece>;
  readonly units: readonly BodyTreeUnit[];
  readonly candidates: BodyTreeCandidates;
  readonly tree: BodyComputedTree;
  readonly effective: ReadonlySet<string>;
  readonly attributes: ReadonlyMap<string, BodyAttributeFact | BodyNodeKindFact>;
  readonly maxCounters: ReadonlyMap<string, number>;
  readonly visible: ReadonlySet<string>;
  readonly owners: readonly BodyTreeOwner[];
}

/** An incomplete frame preserves the caller's last published projection. */
export type BodyTreeRead =
  | { readonly status: "uninitialized" }
  | { readonly status: "pending"; readonly missing: readonly string[] }
  | { readonly status: "ready"; readonly view: BodyTreeView };

/** A source position before an existing native unit or immediately after it. */
export interface BodyTreeSourcePoint {
  readonly source: string;
  readonly index: number;
}

/** Mutable local buffers used only while deriving a complete frame. */
interface SourceRegistry {
  readonly nodes: Map<string, BodyTreeNode>;
  readonly pieces: Map<string, BodyTreePiece>;
  readonly units: BodyTreeUnit[];
}

/**
 * Reads permanent sources and derives their C/R/P chains.
 * @param doc - The native document holding the body sources.
 * @param body - Validated immutable records and enabled groups.
 * @returns Derived cut nodes, physical pieces and native source units.
 * @throws {DocumentBodyFormatError} If source content is outside its cut chain.
 */
function sourceRegistry(doc: Y.Doc, body: BodyRecordsSnapshot): SourceRegistry {
  const nodes = new Map<string, BodyTreeNode>(body.records);
  const pieces = new Map<string, BodyTreePiece>();
  const units: BodyTreeUnit[] = [];
  for (const source of body.sources.values()) {
    const text = documentBodySource(doc, source.id);
    const delta: readonly { readonly insert: unknown; readonly attributes?: Readonly<Record<string, unknown>> }[] = text.toDelta();
    let index = 0;
    let prior: string | undefined;
    let current: { id: string; source: string; cut: string; start: number; end: number; units: BodyTreeUnit[] } | undefined;
    for (const run of delta) {
      const cut = bodyCutId(run.insert);
      if (cut !== null) {
        if (current !== undefined) current.end = index;
        const boundary = `C:${cut}`;
        const right = `R:${cut}`;
        const piece = `P:${cut}`;
        nodes.set(boundary, { id: boundary, kind: "cut", source: source.id, cut, parent: prior ?? source.facet, order: RIGHT });
        nodes.set(right, { id: right, kind: "right", source: source.id, cut, parent: boundary, order: RIGHT });
        nodes.set(piece, { id: piece, kind: "piece", source: source.id, cut, parent: right, order: RIGHT });
        current = { id: piece, source: source.id, cut, start: index + 1, end: text.length, units: [] };
        pieces.set(piece, current);
        prior = piece;
        index += 1;
        continue;
      }
      if (current === undefined) throw new DocumentBodyFormatError(`Source content precedes its first cut:${source.id}`);
      const values = typeof run.insert === "string" ? run.insert.split("") : [run.insert];
      for (const value of values) {
        const item = Y.createRelativePositionFromTypeIndex(text, index).item;
        if (item === null) throw new DocumentBodyFormatError(`Source unit has no native identity:${source.id}:${index}`);
        const unit = { id: `${source.id}/${item.client}:${item.clock}`, source: source.id, index, piece: current.id, value, attributes: run.attributes ?? {} };
        current.units.push(unit);
        units.push(unit);
        index += 1;
      }
    }
    if (current === undefined || current.cut !== source.tail || current.units.length !== 0) {
      throw new DocumentBodyFormatError(`Invalid terminal source piece:${source.id}`);
    }
  }
  return { nodes, pieces, units };
}

/**
 * Chooses current enabled attribute facts independently of structural support.
 * @param body - Validated immutable records and enabled groups.
 * @returns One winner for each independent attribute or node-kind field.
 * @throws {never}
 */
function currentAttributes(body: BodyRecordsSnapshot): Map<string, BodyAttributeFact | BodyNodeKindFact> {
  const result = new Map<string, BodyAttributeFact | BodyNodeKindFact>();
  for (const fact of body.facts.values()) {
    if (!body.enabled.has(fact.group) || (fact.kind !== "attribute" && fact.kind !== "nodeKind")) continue;
    const key = JSON.stringify([fact.kind, fact.owner, fact.kind === "attribute" ? fact.name : null]);
    const prior = result.get(key);
    if (prior === undefined || fact.counter > prior.counter || (fact.counter === prior.counter && fact.id > prior.id)) result.set(key, fact);
  }
  return result;
}

/**
 * Computes support from current native runs, current attributes and current mark instances.
 * @param body - Validated immutable records and enabled groups.
 * @param units - Current live native units from the permanent sources.
 * @param attributes - Current enabled attribute winners.
 * @returns Fact identities enabled directly or supported by live data.
 * @throws {DocumentBodyFormatError} If support names a non-structural fact.
 */
function effectiveFacts(body: BodyRecordsSnapshot, units: readonly BodyTreeUnit[], attributes: ReadonlyMap<string, BodyAttributeFact | BodyNodeKindFact>): Set<string> {
  const effective = new Set<string>();
  const demanded: string[] = [];
  for (const fact of body.facts.values()) if (body.enabled.has(fact.group)) effective.add(fact.id);
  for (const unit of units) {
    const context = unit.attributes[BODY_CONTEXT_ATTRIBUTE];
    if (typeof context === "string") demanded.push(...body.contexts.get(context)!.dependencies);
    for (const [key, value] of Object.entries(unit.attributes)) {
      if (!key.startsWith(BODY_MARK_ATTRIBUTE_PREFIX) || typeof value !== "object" || value === null || !("factId" in value) || typeof value.factId !== "string") continue;
      const fact = body.facts.get(value.factId)!;
      demanded.push(...fact.dependencies);
    }
  }
  for (const fact of attributes.values()) demanded.push(...fact.dependencies);
  const seen = new Set<string>();
  while (demanded.length > 0) {
    const id = demanded.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const fact = body.facts.get(id);
    if (fact?.kind !== "structure") throw new DocumentBodyFormatError(`Invalid live structural support:${id}`);
    effective.add(id);
    demanded.push(...fact.dependencies);
  }
  return effective;
}

/**
 * Combines default edges with active complete structure payloads.
 * @param nodes - Registered and cut-derived tree nodes.
 * @param body - Validated immutable records and enabled groups.
 * @param effective - Enabled or live-supported fact identities.
 * @returns Complete candidate histories for the current facts.
 * @throws {DocumentBodyFormatError} If an edge names a missing node.
 */
function parentCandidates(nodes: ReadonlyMap<string, BodyTreeNode>, body: BodyRecordsSnapshot, effective: ReadonlySet<string>): Map<string, Map<string, BodyTreeCandidate>> {
  const candidates = new Map<string, Map<string, BodyTreeCandidate>>();
  for (const node of nodes.values()) candidates.set(node.id, new Map(node.kind === "root" ? [] : [[node.parent, { counter: 0, order: node.order }]]));
  for (const id of effective) {
    const fact = body.facts.get(id)!;
    if (fact.kind !== "structure") continue;
    for (const edge of fact.edges) {
      const history = candidates.get(edge.child);
      if (history === undefined || !nodes.has(edge.parent)) throw new DocumentBodyFormatError(`Missing body edge endpoint:${edge.child}:${edge.parent}`);
      const prior = history.get(edge.parent);
      if (prior === undefined || edge.counter > prior.counter || (edge.counter === prior.counter && id > (prior.fact ?? ""))) {
        history.set(edge.parent, { counter: edge.counter, order: edge.order, fact: id });
      }
    }
  }
  return candidates;
}

/**
 * Iterates a rooted tree in exact sibling order without recursive cut-chain calls.
 * @param root - The declared root identity.
 * @param tree - The complete selected parent and sibling tree.
 * @returns Node identities in exact current preorder.
 * @throws {never}
 */
function treeOrder(root: string, tree: BodyComputedTree): string[] {
  const result: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const id = stack.pop()!;
    result.push(id);
    const children = tree.children.get(id)!;
    for (let index = children.length - 1; index >= 0; index -= 1) stack.push(children[index]!);
  }
  return result;
}

/**
 * Reads current attributes while retaining unknown own JSON keys.
 * @param view - The complete immutable frame used as the planning baseline.
 * @param id - The stable product record identity.
 * @returns Current product type and complete own attribute dictionaries.
 * @throws {DocumentBodyFormatError} If the requested record is missing.
 */
export function bodyTreeRecordProperties(view: Pick<BodyTreeView, "body" | "attributes">, id: string): { readonly type: string; readonly attrs: BodyJsonObject; readonly wrapperAttrs: BodyJsonObject } {
  const record = view.body.records.get(id);
  if (record === undefined || record.kind === "facet") throw new DocumentBodyFormatError(`Missing body product record:${id}`);
  let type = record.kind === "root" ? "doc" : record.type;
  const attrs = new Map<string, BodyJsonValue>(Object.entries(record.attrs));
  const wrapper = new Map<string, BodyJsonValue>(record.kind === "owner" ? Object.entries(record.wrapperAttrs) : []);
  for (const fact of view.attributes.values()) {
    if (fact.owner !== id) continue;
    if (fact.kind === "nodeKind") type = fact.value;
    else if (fact.name.startsWith("wrapper:")) wrapper.set(fact.name.slice(8), fact.value);
    else attrs.set(fact.name, fact.value);
  }
  return { type, attrs: Object.fromEntries(attrs), wrapperAttrs: Object.fromEntries(wrapper) };
}

/**
 * Flattens one current content facet into its original native units.
 * @param facet - The content facet containing the interval.
 * @param nodes - Registered and cut-derived tree nodes.
 * @param pieces - Physical source intervals following permanent cuts.
 * @param tree - The complete selected parent and sibling tree.
 * @returns The current facet content in native unit order.
 * @throws {DocumentBodyFormatError} If structural blocks entered inline content.
 */
function inlineUnits(facet: string, nodes: ReadonlyMap<string, BodyTreeNode>, pieces: ReadonlyMap<string, BodyTreePiece>, tree: BodyComputedTree): BodyTreeUnit[] {
  const result: BodyTreeUnit[] = [];
  for (const id of treeOrder(facet, tree)) {
    const node = nodes.get(id)!;
    if (node.kind === "root" || node.kind === "owner" || node.kind === "container") throw new DocumentBodyFormatError(`Structural node inside body inline content:${id}`);
    if (node.kind === "piece") result.push(...pieces.get(id)!.units);
  }
  return result;
}

/**
 * Projects complete source facts into current owners without any shared write.
 * @param doc - The native document holding the body sources.
 * @returns The complete body frame or its explicit initialization/dependency state.
 * @throws {DocumentBodyFormatError} If source identities or the product tree are invalid.
 * @throws {Error} If the parent history cannot reach its declared root.
 */
export function readBodyTree(doc: Y.Doc): BodyTreeRead {
  const decoded = readDocumentBodyRecords(doc);
  if (decoded.status !== "ready") return decoded;
  const body = decoded.body;
  const { nodes, pieces, units } = sourceRegistry(doc, body);
  const attributes = currentAttributes(body);
  const effective = effectiveFacts(body, units, attributes);
  const candidates = parentCandidates(nodes, body, effective);
  const root = body.metadata.seedRoot;
  const tree = computeBodyTreeCandidates(root, candidates);
  const maxCounters = new Map<string, number>();
  for (const fact of body.facts.values()) if (fact.kind === "structure") {
    for (const edge of fact.edges) maxCounters.set(edge.child, Math.max(maxCounters.get(edge.child) ?? 0, edge.counter));
  }

  const needed = new Set<string>();
  const supportRoots = new Set(units.map((unit) => unit.piece));
  const explicitlyHidden = new Set<string>();
  for (const record of body.records.values()) if (record.kind === "owner" && record.base) supportRoots.add(record.id);
  for (const fact of body.facts.values()) {
    if (!body.enabled.has(fact.group)) continue;
    if (fact.kind === "birth") supportRoots.add(fact.owner);
    if (fact.kind === "delete") explicitlyHidden.add(fact.owner);
  }
  for (const fact of attributes.values()) supportRoots.add(fact.owner);
  for (const id of supportRoots) {
    let current: string | undefined = id;
    while (current !== undefined && !needed.has(current)) {
      needed.add(current);
      current = tree.parents.get(current);
    }
  }

  const visible = new Set<string>();
  const hidden = new Set<string>();
  const owners: BodyTreeOwner[] = [];
  for (const id of treeOrder(root, tree)) {
    const parent = tree.parents.get(id);
    if (explicitlyHidden.has(id) || (parent !== undefined && hidden.has(parent))) hidden.add(id);
    const node = nodes.get(id)!;
    if (!needed.has(id) || hidden.has(id)) continue;
    if (node.kind === "root" || node.kind === "container") visible.add(id);
    if (node.kind !== "owner" || tree.parents.get(node.facet) !== id) continue;
    visible.add(id);
    const props = bodyTreeRecordProperties({ body, attributes }, id);
    owners.push({ id, ...props, facet: node.facet, units: inlineUnits(node.facet, nodes, pieces, tree) });
  }
  const projected = owners.flatMap((owner) => owner.units.map((unit) => unit.id));
  const eligible = units.filter((unit) => !hidden.has(unit.piece)).map((unit) => unit.id);
  const expected = new Set(eligible);
  if (expected.size !== eligible.length || new Set(projected).size !== projected.length || projected.length !== expected.size || projected.some((id) => !expected.has(id))) {
    throw new DocumentBodyFormatError("Body native units must project exactly once");
  }
  return { status: "ready", view: { root, body, nodes, pieces, units, candidates, tree, effective, attributes, maxCounters, visible, owners } };
}

/**
 * Resolves a legal visible UTF-16 gap to the original native source.
 * @param view - The complete immutable frame used as the planning baseline.
 * @param ownerId - The visible content owner.
 * @param offset - The gap measured in visible UTF-16 and inline units.
 * @returns The original source gap, or null for an empty visible owner.
 * @throws {DocumentBodyFormatError} If the owner, offset or scalar boundary is invalid.
 */
export function bodyTreeSourcePoint(view: BodyTreeView, ownerId: string, offset: number): BodyTreeSourcePoint | null {
  const owner = view.owners.find((entry) => entry.id === ownerId);
  if (owner === undefined || !Number.isInteger(offset) || offset < 0 || offset > owner.units.length) throw new DocumentBodyFormatError(`Invalid body point:${ownerId}:${offset}`);
  const left: unknown = owner.units[offset - 1]?.value;
  const right: unknown = owner.units[offset]?.value;
  const high = typeof left === "string" ? left.charCodeAt(left.length - 1) : 0;
  const low = typeof right === "string" ? right.charCodeAt(0) : 0;
  if (high >= 0xd800 && high <= 0xdbff && low >= 0xdc00 && low <= 0xdfff) throw new DocumentBodyFormatError("A body point cannot split a Unicode scalar");
  const next = owner.units[offset];
  if (next !== undefined) return { source: next.source, index: next.index };
  const prior = owner.units.at(-1);
  return prior === undefined ? null : { source: prior.source, index: prior.index + 1 };
}

/**
 * Collects complete structure facts selected on one current path.
 * @param view - The complete immutable frame used as the planning baseline.
 * @param node - The node whose current ancestor path is inspected.
 * @returns The complete structure fact identities on the selected path.
 * @throws {DocumentBodyFormatError} If the start node is absent.
 */
export function bodyTreeDependencies(view: BodyTreeView, node: string): readonly string[] {
  if (!view.nodes.has(node)) throw new DocumentBodyFormatError(`Missing body dependency node:${node}`);
  const result = new Set<string>();
  let current: string | undefined = node;
  while (current !== undefined) {
    const fact = view.tree.selected.get(current)?.fact;
    if (fact !== undefined) result.add(fact);
    current = view.tree.parents.get(current);
  }
  return [...result].sort();
}

/**
 * Adds staged candidates to a frame for pure structure planning.
 * @param view - The complete immutable frame used as the planning baseline.
 * @param staged - All parent edges already planned in this semantic operation.
 * @returns The selected tree after applying the staged candidate values.
 * @throws {Error} If staged edges make the tree unrootable.
 */
function stagedTree(view: BodyTreeView, staged: readonly BodyParentEdge[]): BodyComputedTree {
  const candidates = new Map([...view.candidates].map(([id, edges]) => [id, new Map(edges)]));
  for (const edge of staged) candidates.get(edge.child)!.set(edge.parent, { counter: edge.counter, order: edge.order });
  return computeBodyTreeCandidates(view.root, candidates);
}

/**
 * Returns a new counter above active and inactive registered candidates.
 * @param view - The complete immutable frame used as the planning baseline.
 * @param staged - All parent edges already planned in this semantic operation.
 * @param child - The node being moved.
 * @returns A counter above every known candidate for this child.
 * @throws {never}
 */
function nextCounter(view: BodyTreeView, staged: readonly BodyParentEdge[], child: string): number {
  let counter = view.maxCounters.get(child) ?? 0;
  for (const edge of staged) if (edge.child === child) counter = Math.max(counter, edge.counter);
  return counter + 1;
}

/**
 * Tests the current ancestor relation using the acyclic selected tree.
 * @param tree - The complete selected parent and sibling tree.
 * @param node - The node whose current ancestor path is inspected.
 * @param ancestor - The candidate ancestor.
 * @returns Whether the current node belongs to the ancestor subtree.
 * @throws {never}
 */
function under(tree: BodyComputedTree, node: string, ancestor: string): boolean {
  let current: string | undefined = node;
  while (current !== undefined) {
    if (current === ancestor) return true;
    current = tree.parents.get(current);
  }
  return false;
}

/**
 * Stabilizes every observed fallback while retaining the complete ordered tree.
 * @param view - The complete immutable frame used as the planning baseline.
 * @returns Zero-effect edges that preserve the observed fallback choices.
 * @throws {DocumentBodyFormatError} If stabilization changes current content placement.
 */
function stabilized(view: BodyTreeView): BodyParentEdge[] {
  const result: BodyParentEdge[] = [];
  for (const [child, parent] of view.tree.parents) {
    let highest: string | undefined;
    let counter = -1;
    for (const [candidate, edge] of view.candidates.get(child)!) {
      if (edge.counter > counter || (edge.counter === counter && (highest === undefined || candidate > highest))) {
        highest = candidate;
        counter = edge.counter;
      }
    }
    if (highest !== parent) result.push({ child, parent, counter: nextCounter(view, result, child), order: view.tree.selected.get(child)!.order });
  }
  const checked = stagedTree(view, result);
  for (const [id] of view.nodes) {
    if (checked.parents.get(id) !== view.tree.parents.get(id) || JSON.stringify(checked.children.get(id)) !== JSON.stringify(view.tree.children.get(id))) {
      throw new DocumentBodyFormatError("Observed fallback stabilization changed the ordered body tree");
    }
  }
  return result;
}

/**
 * Applies the adopted old-parent and new-parent path repair to a staged move.
 * @param view - The complete immutable frame used as the planning baseline.
 * @param staged - All parent edges already planned in this semantic operation.
 * @param child - The node being moved.
 * @param parent - Its requested parent.
 * @param order - The exact sibling order for the selected edge.
 * @throws {DocumentBodyFormatError} If the move targets a descendant or missing node.
 */
function stageMove(view: BodyTreeView, staged: BodyParentEdge[], child: string, parent: string, order: string): void {
  const tree = stagedTree(view, staged);
  if (child === view.root || !view.nodes.has(child) || !view.nodes.has(parent) || under(tree, parent, child)) throw new DocumentBodyFormatError(`Invalid body reparent:${child}:${parent}`);
  const repairs: { child: string; parent: string }[] = [];
  for (const start of [tree.parents.get(child), parent]) {
    let current = start;
    while (current !== undefined) {
      const selectedParent = tree.parents.get(current);
      if (selectedParent === undefined) break;
      const candidates = new Map(view.candidates.get(current));
      for (const edge of staged) if (edge.child === current) candidates.set(edge.parent, { counter: edge.counter, order: edge.order });
      let highest: string | undefined;
      let counter = -1;
      for (const [id, edge] of candidates) if (edge.counter > counter || (edge.counter === counter && (highest === undefined || id > highest))) {
        highest = id;
        counter = edge.counter;
      }
      if (highest !== selectedParent) repairs.push({ child: current, parent: selectedParent });
      current = selectedParent;
    }
  }
  for (const repair of repairs) staged.push({ ...repair, counter: nextCounter(view, staged, repair.child), order: tree.selected.get(repair.child)!.order });
  staged.push({ child, parent, counter: nextCounter(view, staged, child), order });
}

/**
 * Selects maximal following sibling subtrees in current inline traversal order.
 * @param tree - The complete selected parent and sibling tree.
 * @param start - The first subtree of the current suffix.
 * @param facet - The content facet containing the interval.
 * @returns Maximal following subtrees in current reading order.
 * @throws {DocumentBodyFormatError} If the range boundary lies outside the owner's facet.
 */
function suffix(tree: BodyComputedTree, start: string, facet: string): string[] {
  const result = [start];
  let current = start;
  while (current !== facet) {
    const parent = tree.parents.get(current);
    if (parent === undefined) throw new DocumentBodyFormatError(`Body range is outside its content facet:${start}`);
    const siblings = tree.children.get(parent)!;
    result.push(...siblings.slice(siblings.indexOf(current) + 1));
    current = parent;
  }
  return result;
}

/**
 * Finds the next insertion order before a cut's default right branch.
 * @param view - The complete immutable frame used as the planning baseline.
 * @param staged - All parent edges already planned in this semantic operation.
 * @param cut - The permanent cut whose left slot receives content.
 * @param operation - The unique identity of the semantic operation.
 * @returns The next sibling order before the cut default branch.
 * @throws {RangeError} If the order interval is invalid.
 */
function leftOrder(view: BodyTreeView, staged: readonly BodyParentEdge[], cut: string, operation: string): string {
  const tree = stagedTree(view, staged);
  const orders = tree.children.get(`C:${cut}`)!.map((id) => tree.selected.get(id)!.order).filter((order) => order < RIGHT).sort();
  return bodyTreeOrderBetween(orders.at(-1) ?? "", RIGHT, operation);
}

/**
 * Plans complete block, table or facet reparenting as one structure payload.
 * @param view - The complete immutable frame used as the planning baseline.
 * @param moves - The complete set of subtree moves in this operation.
 * @param operation - The unique identity of the semantic operation.
 * @returns All stabilization and movement edges for the complete operation.
 * @throws {DocumentBodyFormatError} If a move is invalid.
 * @throws {Error} If parent selection fails.
 */
export function planBodyReparent(view: BodyTreeView, moves: readonly { readonly child: string; readonly parent: string; readonly order?: string }[], operation: string): readonly BodyParentEdge[] {
  if (moves.length === 0) return [];
  const staged = stabilized(view);
  for (const [index, move] of moves.entries()) {
    const tree = stagedTree(view, staged);
    const siblings = tree.children.get(move.parent);
    if (siblings === undefined) throw new DocumentBodyFormatError(`Missing body reparent target:${move.parent}`);
    const prior = siblings.length === 0 ? "" : tree.selected.get(siblings.at(-1)!)!.order;
    const order = move.order ?? bodyTreeOrderBetween(prior, "", `${operation}:${index}`);
    stageMove(view, staged, move.child, move.parent, order);
  }
  return staged;
}

/**
 * Plans one whole content-facet join as an indivisible structure payload.
 * @param view - The complete immutable frame used as the planning baseline.
 * @param left - The owner receiving the joined inline content.
 * @param right - The owner whose original facet is moved.
 * @param targetCut - The insertion boundary in the destination owner.
 * @param operation - The unique identity of the semantic operation.
 * @returns The indivisible facet-transfer and path-repair edges.
 * @throws {DocumentBodyFormatError} If the owners or boundary are invalid.
 * @throws {Error} If parent selection fails.
 */
export function planBodyJoin(view: BodyTreeView, left: string, right: string, targetCut: string, operation: string): readonly BodyParentEdge[] {
  const target = view.body.records.get(left);
  const source = view.body.records.get(right);
  if (left === right || target?.kind !== "owner" || source?.kind !== "owner") throw new DocumentBodyFormatError("Body join requires distinct owners");
  const staged = stabilized(view);
  stageMove(view, staged, source.facet, `C:${targetCut}`, leftOrder(view, staged, targetCut, operation));
  return staged;
}

/**
 * Plans the full right-hand forest of a split across all joined sources.
 * @param view - The complete immutable frame used as the planning baseline.
 * @param from - The owner containing the selected interval.
 * @param startCut - The inclusive interval boundary.
 * @param target - The owner receiving the split suffix.
 * @param operation - The unique identity of the semantic operation.
 * @returns The complete suffix-forest and path-repair edges.
 * @throws {DocumentBodyFormatError} If the source or target is invalid.
 * @throws {Error} If parent selection fails.
 */
export function planBodySplit(view: BodyTreeView, from: string, startCut: string, target: string, operation: string): readonly BodyParentEdge[] {
  const source = view.body.records.get(from);
  const destination = view.body.records.get(target);
  if (from === target || source?.kind !== "owner" || destination?.kind !== "owner") throw new DocumentBodyFormatError("Body split requires distinct owners");
  const roots = suffix(view.tree, `R:${startCut}`, source.facet);
  const staged = stabilized(view);
  let prior = "";
  for (const [index, root] of roots.entries()) {
    const order = bodyTreeOrderBetween(prior, RIGHT, `${operation}:${index}`);
    stageMove(view, staged, root, destination.facet, order);
    prior = order;
  }
  return staged;
}

/**
 * Plans exact interval transfer together with original suffix retention.
 * @param view - The complete immutable frame used as the planning baseline.
 * @param from - The owner containing the selected interval.
 * @param startCut - The inclusive interval boundary.
 * @param endCut - The exclusive interval boundary.
 * @param to - The owner receiving the selected interval.
 * @param targetCut - The insertion boundary in the destination owner.
 * @param operation - The unique identity of the semantic operation.
 * @returns The selected-forest, suffix-retention and path-repair edges.
 * @throws {DocumentBodyFormatError} If range boundaries are invalid.
 * @throws {Error} If parent selection fails.
 */
export function planBodyRangeMove(view: BodyTreeView, from: string, startCut: string, endCut: string, to: string, targetCut: string, operation: string): readonly BodyParentEdge[] {
  const source = view.body.records.get(from);
  const destination = view.body.records.get(to);
  if (source?.kind !== "owner" || destination?.kind !== "owner") throw new DocumentBodyFormatError("Body range transfer requires content owners");
  const positions = new Map(treeOrder(source.facet, view.tree).map((id, index) => [id, index]));
  const first = positions.get(`R:${startCut}`);
  const last = positions.get(`R:${endCut}`);
  if (first === undefined || last === undefined || first >= last) throw new DocumentBodyFormatError("Invalid ordered body range");
  if (from === to) {
    const target = positions.get(`R:${targetCut}`);
    if (target !== undefined && target >= first && target <= last) return [];
  }
  const selected = suffix(view.tree, `R:${startCut}`, source.facet).filter((id) => positions.get(id)! < last);
  const trailing = suffix(view.tree, `R:${endCut}`, source.facet).filter((id) => selected.some((root) => under(view.tree, id, root)));
  const staged = stabilized(view);
  let after = RIGHT;
  for (const [index, root] of trailing.entries()) {
    stageMove(view, staged, root, `C:${startCut}`, after);
    after = bodyTreeOrderBetween(after, "", `${operation}:suffix:${index}`);
  }
  for (const [index, root] of selected.entries()) {
    stageMove(view, staged, root, `C:${targetCut}`, leftOrder(view, staged, targetCut, `${operation}:move:${index}`));
  }
  return staged;
}
