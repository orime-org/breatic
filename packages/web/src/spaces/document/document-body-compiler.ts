// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type { Mark } from '@tiptap/pm/model';
import { AddMarkStep, AddNodeMarkStep, RemoveMarkStep, RemoveNodeMarkStep, ReplaceStep } from '@tiptap/pm/transform';
import * as Y from 'yjs';
import { type BodyContext, type BodyFact, type BodyGroup, type BodyJsonObject, type BodyJsonValue, type BodyMarkPayload, type BodyParentEdge, type BodyRecord, type BodyRegistration, type BodySource, type BodyTreeOwner, type BodyTreeUnit, type BodyTreeView } from '@breatic/shared';
import { assertBodySourceBoundary, BODY_MARK_ATTRIBUTE_PREFIX, bodyCutId, bodyTreeDependencies, bodyTreeOrderBetween, bodyTreeRecordProperties, bodyTreeSourcePoint, documentBodyRecords, documentBodySource, planBodyJoin, planBodyRangeMove, planBodyReparent, planBodySplit, readBodyTree, registerBodyCut, registerDocumentBodyRecords } from '@breatic/shared/document-body';

import { compilerFrames, compilerJson, rekeyedExpectation, type CompilerFrame, type CompilerNode } from '@web/spaces/document/document-body-compiler-frames';
import { transactionSource } from '@web/spaces/document/document-body-binding-key';
import type { CompileBodyBatchOptions } from '@web/spaces/document/document-body-compiler-types';
import type { BodyBatchPlan, BodyFreshRun, BodyNativeWrite, BodyPlannedCut } from '@web/spaces/document/document-body-plan-types';
import { BodyProvenanceError, type BodyInlineUnit } from '@web/spaces/document/document-body-provenance';
import { bodyTreePoints, type BodyTreePoint } from '@web/spaces/document/document-body-tree-points';

const RIGHT = '\u00ff';

/** One scalar-safe native operation, never containing a registration cut. */
interface NativeRange {
  readonly source: string;
  readonly from: number;
  readonly to: number;
}

/** Distributes removal of the group field over every concrete fact kind. */
type CompilerFact = {
  readonly [Kind in BodyFact['kind']]: Omit<Extract<BodyFact, { readonly kind: Kind }>, 'group'>;
}[BodyFact['kind']];

/**
 * Requires an explicit compiler invariant before any real shared mutation.
 * @param condition - The required identity or structural condition.
 * @param message - A content-free source diagnostic.
 * @throws {BodyProvenanceError} If the invariant fails.
 */
function requireCompiler(condition: unknown, message: string): asserts condition {
  if (!condition) throw new BodyProvenanceError(message);
}

/**
 * Reads complete native facts from an isolated planning document.
 * @param doc - The private native planning snapshot.
 * @returns Its current selected forest and original native identities.
 * @throws {BodyProvenanceError} If dependencies are incomplete.
 * @throws {Error} If stored descriptions are malformed.
 */
function viewOf(doc: Y.Doc): BodyTreeView {
  const read = readBodyTree(doc);
  requireCompiler(read.status === 'ready', 'Compiler requires complete native body dependencies');
  return read.view;
}

/**
 * Compares semantic JSON payloads independently of dictionary key order.
 * @param value - A JSON-domain payload.
 * @returns A canonical comparison string.
 * @throws {never}
 */
function jsonKey(value: BodyJsonValue): string {
  if (Array.isArray(value)) return `[${value.map((item) => jsonKey(item)).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${jsonKey(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * Reads the original semantic payload behind a displayed unknown-mark stand-in.
 * @param mark - A mark from the actual accepted schema.
 * @returns The exact semantic type and complete payload.
 * @throws {BodyProvenanceError} If an unknown mark lost its original type.
 */
function markPayload(mark: Mark): BodyMarkPayload {
  if (mark.type.name !== 'unsupportedMark') return { type: mark.type.name, attrs: compilerJson(mark.attrs) };
  const original: unknown = mark.attrs['originalName'];
  requireCompiler(typeof original === 'string', 'An unknown mark requires its original type');
  return { type: original, attrs: compilerJson(mark.attrs['originalValue']) };
}

/**
 * Names single-valued marks by type and overlapping comments by thread.
 * @param payload - The actual semantic mark payload.
 * @returns The independent semantic attribute key.
 * @throws {never}
 */
function semanticMarkKey(payload: BodyMarkPayload): string {
  return `${BODY_MARK_ATTRIBUTE_PREFIX}${payload.type}${payload.type === 'comment' ? `:${String(payload.attrs['threadId'] ?? '')}` : ''}`;
}

/**
 * Reads a frame's existing-only labels, retaining its empty owner semantics.
 * @param frame - The actual stage frame.
 * @param owner - Its explicitly named content owner.
 * @returns Only original native labels in exact stage order.
 * @throws {never}
 */
function skeleton(frame: CompilerFrame, owner: string): string[] {
  return (frame.owners.get(owner) ?? []).filter((unit) => unit.origin === 'existing').map((unit) => unit.token);
}

/** Native lookups derived from one immutable planner view. */
interface PlannerIndex {
  readonly units: ReadonlyMap<string, BodyTreeUnit>;
  readonly ownersByUnit: ReadonlyMap<string, BodyTreeOwner>;
  readonly labels: ReadonlyMap<string, readonly string[]>;
  readonly points: ReadonlyMap<string, BodyTreePoint>;
}

/**
 * Captures table coverage inputs using normalized frame identities before ID appends finish.
 * Row order and each cell's identity, kind, span and widths determine the
 * original coverage used by the codec; inline content never changes it.
 * @param frame - One complete accepted semantic boundary.
 * @returns Canonical geometry inputs keyed by stable table identity.
 * @throws {never}
 */
function frameTableGeometry(frame: CompilerFrame): ReadonlyMap<string, string> {
  const result = new Map<string, string>();
  for (const node of frame.nodes.values()) {
    if (frame.document.type.schema.nodes[node.type]?.spec.tableRole !== 'table') continue;
    const rows = (frame.children.get(node.id) ?? []).map((row) => [row, (frame.children.get(row) ?? []).map((id) => {
      const cell = frame.nodes.get(id)!;
      return [id, cell.type, cell.attrs['colspan'], cell.attrs['rowspan'], cell.attrs['colwidth']];
    })]);
    result.set(node.id, JSON.stringify(rows));
  }
  return result;
}

/**
 * Finds the table whose original coverage names a local derived descendant.
 * @param frame - The complete structural boundary containing the node.
 * @param id - An actual normalized node identity.
 * @returns Its nearest table identity, when it belongs to a table.
 * @throws {never}
 */
function frameTable(frame: CompilerFrame, id: string): string | undefined {
  let node = frame.nodes.get(id);
  while (node !== undefined) {
    if (frame.document.type.schema.nodes[node.type]?.spec.tableRole === 'table') return node.id;
    node = frame.nodes.get(node.parent);
  }
  return undefined;
}

/** Compiles explicit descriptors and writes using only an isolated native planning snapshot. */
class BodyBatchCompiler {
  private readonly input: CompileBodyBatchOptions;
  private readonly planner = new Y.Doc({ gc: false });
  private readonly records: BodyRecord[] = [];
  private readonly sources: BodySource[] = [];
  private readonly facts: BodyFact[] = [];
  private readonly groups: BodyGroup[] = [];
  private readonly contexts: BodyContext[] = [];
  private readonly cuts: BodyPlannedCut[] = [];
  private readonly fresh: BodyFreshRun[] = [];
  private readonly deleted = new Set<string>();
  private readonly formats = new Map<string, BodyJsonObject>();
  private readonly reserved = new Set<string>();
  private readonly originals: ReadonlyMap<string, BodyTreeUnit>;
  private readonly known: ReadonlySet<string>;
  private readonly markFacts = new Map<string, string>();
  private readonly history: BodyGroup['history'];
  private sequence = 0;
  private cachedView: BodyTreeView | undefined;
  private readonly indices = new WeakMap<BodyTreeView, PlannerIndex>();

  /**
   * Invalidates derived reads on actual updates, including deletion-only updates.
   * @throws {never}
   */
  private readonly invalidateView = (): void => { this.cachedView = undefined; };

  /**
   * Reads one complete view per private source revision.
   * @returns The current private planner view.
   * @throws {Error} If native records are invalid.
   */
  private view(): BodyTreeView {
    this.cachedView ??= viewOf(this.planner);
    return this.cachedView;
  }

  /**
   * Indexes native identities once for each immutable view retained by this batch.
   * @param view - The exact immutable planner view.
   * @returns Its native identity and visible owner lookups.
   * @throws {never}
   */
  private index(view: BodyTreeView): PlannerIndex {
    const prior = this.indices.get(view);
    if (prior !== undefined) return prior;
    const ownersByUnit = new Map<string, BodyTreeOwner>();
    const labels = new Map<string, readonly string[]>();
    for (const owner of view.owners) {
      labels.set(owner.id, owner.units.filter((unit) => this.known.has(unit.id)).map((unit) => unit.id));
      for (const unit of owner.units) ownersByUnit.set(unit.id, owner);
    }
    const result = { units: new Map(view.units.map((unit) => [unit.id, unit])), ownersByUnit, labels, points: bodyTreePoints(view) };
    this.indices.set(view, result);
    return result;
  }

  /**
   * Starts from the exact native source associated with the original codec frame.
   * @param input - Complete accepted input and its original projection.
   * @throws {BodyProvenanceError} If the projection and journal belong to different sources.
   * @throws {Error} If the current native snapshot cannot be decoded.
   */
  constructor(input: CompileBodyBatchOptions) {
    this.input = input;
    const root = input.journal.transactions[0]?.transaction;
    this.history = root === undefined || transactionSource(root) === 'user' ? 'user' : 'machine';
    requireCompiler(input.batchId.length > 0 && input.projection.index.sourceDoc === input.doc, 'Compiler source handle differs from the projection');
    requireCompiler(input.journal.before.eq(input.projection.doc), 'Compiler journal begins at a different projection');
    this.originals = new Map(input.projection.view.units.map((unit) => [unit.id, unit]));
    this.known = new Set(input.projection.units.map((unit) => unit.token));
    const body = input.projection.view.body;
    for (const entries of [body.records, body.sources, body.facts, body.groups, body.contexts]) {
      for (const id of entries.keys()) this.reserved.add(id);
    }
    for (const node of input.projection.view.nodes.values()) {
      this.reserved.add(node.id);
      if (node.kind === 'cut') this.reserved.add(node.cut);
    }
    this.planner.on('update', this.invalidateView);
    try {
      Y.applyUpdate(this.planner, Y.encodeStateAsUpdate(input.doc));
      const current = this.view();
      requireCompiler(current.units.every((unit) => this.originals.has(unit.id)) && current.units.length === this.originals.size, 'Compiler native source changed since projection');
    } catch (error) {
      this.planner.off('update', this.invalidateView);
      this.planner.destroy();
      throw error;
    }
  }

  /**
   * Allocates immutable batch identities across all registration domains.
   * @param kind - The registration domain used in the allocated identity.
   * @returns A unique immutable identity within this batch.
   * @throws {never}
   */
  private id(kind: string): string {
    let id: string;
    do { id = `${this.input.batchId}:${kind}:${this.sequence++}`; } while (this.reserved.has(id));
    this.reserved.add(id);
    return id;
  }

  /**
   * Registers typed descriptors in the planner and accumulates the explicit REG request.
   * @param registration - The immutable records, sources and supporting facts to accumulate.
   * @throws {Error} If registration is invalid.
   */
  private register(registration: BodyRegistration): void {
    registerDocumentBodyRecords(this.planner, registration);
    this.records.push(...registration.records ?? []);
    this.sources.push(...registration.sources ?? []);
    this.facts.push(...registration.facts ?? []);
    this.groups.push(...registration.groups ?? []);
    this.contexts.push(...registration.contexts ?? []);
  }

  /**
   * Emits one indivisible fact group and enables it only in the private stage planner.
   * @param facts - The paired facts belonging to this semantic action.
   * @throws {Error} If a fact dependency is invalid.
   */
  private emit(facts: readonly CompilerFact[]): void {
    if (facts.length === 0) return;
    const group = this.id('group');
    const complete: BodyFact[] = facts.map((fact) => ({ ...fact, group }));
    this.register({ facts: complete, groups: [{ id: group, history: this.history, facts: complete.map((fact) => fact.id) }] });
    documentBodyRecords(this.planner).enabled.set(group, true);
  }

  /**
   * Builds complete structural support from the paths selected before this operation.
   * @param view - The planner tree before the operation.
   * @param nodes - The endpoints whose selected paths support the operation.
   * @returns The sorted unique supporting fact identities.
   * @throws {Error} If an endpoint is missing.
   */
  private dependencies(view: BodyTreeView, nodes: readonly string[]): string[] {
    return [...new Set(nodes.flatMap((node) => bodyTreeDependencies(view, node)))].sort();
  }

  /**
   * Publishes the entire shared planner payload with its existing selected-path support.
   * @param view - The planner tree before applying these edges.
   * @param edges - The complete paired forest edges to publish.
   * @throws {Error} If a forest edge is invalid.
   */
  private structure(view: BodyTreeView, edges: readonly BodyParentEdge[]): void {
    if (edges.length === 0) return;
    this.emit([{ id: this.id('structure'), kind: 'structure', edges,
      dependencies: this.dependencies(view, edges.flatMap((edge) => [edge.child, edge.parent])) }]);
  }

  /**
   * Bundles all paired forests of one accepted semantic action into one support unit.
   * Intermediate private facts exist only to let the shared planner observe
   * earlier submoves. Their complete edges and external dependencies replace
   * them in the emitted plan before any new mark or context can reference them.
   * @param first - The first fact index emitted for this semantic action.
   * @throws {Error} If the complete forest registration is invalid.
   */
  private coalesceStructures(first: number): void {
    const structures = this.facts.slice(first).filter((fact) => fact.kind === 'structure');
    if (structures.length < 2) return;
    const replaced = new Set(structures.map((fact) => fact.id));
    const groups = new Set(structures.map((fact) => fact.group));
    this.emit([{ id: this.id('structure'), kind: 'structure', edges: structures.flatMap((fact) => fact.edges),
      dependencies: [...new Set(structures.flatMap((fact) => fact.dependencies).filter((id) => !replaced.has(id)))].sort() }]);
    const enabled = documentBodyRecords(this.planner).enabled;
    for (const group of groups) enabled.delete(group);
    for (let index = this.facts.length - 1; index >= first; index -= 1) {
      if (replaced.has(this.facts[index].id)) this.facts.splice(index, 1);
    }
    for (let index = this.groups.length - 1; index >= 0; index -= 1) {
      if (groups.has(this.groups[index].id)) this.groups.splice(index, 1);
    }
  }

  /**
   * Tests actual selected ancestry rather than stored default parents.
   * @param view - The current selected planner tree.
   * @param node - The descendant being tested.
   * @param ancestor - The endpoint of the selected ancestry search.
   * @returns Whether the selected parent path reaches the ancestor.
   * @throws {never}
   */
  private under(view: BodyTreeView, node: string, ancestor: string): boolean {
    let current: string | undefined = node;
    while (current !== undefined) {
      if (current === ancestor) return true;
      current = view.tree.parents.get(current);
    }
    return false;
  }

  /**
   * Reads one current owner's old native labels, excluding opaque payloads outside this journal.
   * @param view - The current planner projection.
   * @param owner - The content owner whose observed native units are read.
   * @returns The known observed native identities in visible order.
   * @throws {never}
   */
  private labels(view: BodyTreeView, owner: string): readonly string[] {
    return this.index(view).labels.get(owner) ?? [];
  }

  /**
   * Gets the full registered content owner descriptor.
   * @param view - The current registered planner records.
   * @param id - The stable identity of the requested content owner.
   * @returns The registered content owner descriptor.
   * @throws {BodyProvenanceError} If the owner is absent.
   */
  private owner(view: BodyTreeView, id: string): Extract<BodyRecord, { kind: 'owner' }> {
    const owner = view.body.records.get(id);
    requireCompiler(owner?.kind === 'owner', 'Compiler content range has no owner record');
    return owner;
  }

  /**
   * Chooses a new node's default order between its current observed siblings.
   * @param frame - The accepted stage defining sibling order.
   * @param node - The new structural node.
   * @param view - The planner tree containing already registered siblings.
   * @returns The fractional order between observed registered siblings.
   * @throws {Error} If the fractional order interval is invalid.
   */
  private initialOrder(frame: CompilerFrame, node: CompilerNode, view: BodyTreeView): string {
    const siblings = frame.children.get(node.parent) ?? [];
    const index = siblings.indexOf(node.id);
    const prior = [...siblings.slice(0, index)].reverse().find((id) => view.tree.parents.get(id) === node.parent);
    const next = siblings.slice(index + 1).find((id) => view.tree.parents.get(id) === node.parent);
    const left = prior === undefined ? '' : view.tree.selected.get(prior)!.order;
    const right = next === undefined ? '' : view.tree.selected.get(next)!.order;
    return bodyTreeOrderBetween(left, right !== '' && right > left ? right : '', this.id('order'));
  }

  /**
   * Keeps untouched local repair slots out of mutation planning while preserving complete display frames.
   * Activity comes from actual named inline units and structural/attribute
   * changes, never an absolute position shift caused by editing a sibling.
   * @param frames - Complete accepted frames also used by the staged display index.
   * @returns Private planning frames containing only required local descriptors.
   * @throws {BodyProvenanceError} If a required derived ancestor cannot be reached.
   */
  private planningFrames(frames: readonly CompilerFrame[]): readonly CompilerFrame[] {
    const derived = this.input.projection.index.derived;
    if (derived.size === 0) return frames;
    const needed = new Set<string>();
    const affectedTables = new Set<string>();
    const initial = frames[0];
    for (let index = 1; index < frames.length; index += 1) {
      const before = frames[index - 1];
      const after = frames[index];
      const beforeGeometry = frameTableGeometry(before);
      const afterGeometry = frameTableGeometry(after);
      for (const table of new Set([...beforeGeometry.keys(), ...afterGeometry.keys()])) {
        if (beforeGeometry.get(table) !== afterGeometry.get(table)) affectedTables.add(table);
      }
      for (const id of derived.keys()) {
        const left = before.nodes.get(id);
        const right = after.nodes.get(id);
        if (left === undefined && right === undefined) continue;
        if (left === undefined || right === undefined || (after.owners.get(id)?.length ?? 0) > 0 ||
          left.type !== right.type || left.parent !== right.parent ||
          jsonKey(left.attrs) !== jsonKey(right.attrs) || jsonKey(left.wrapperAttrs) !== jsonKey(right.wrapperAttrs) ||
          JSON.stringify(before.children.get(id) ?? []) !== JSON.stringify(after.children.get(id) ?? [])) needed.add(id);
      }
      // Actual new or moved content can require an otherwise unchanged local parent.
      for (const node of after.nodes.values()) {
        if (!derived.has(node.id) && derived.has(node.parent)) needed.add(node.parent);
      }
    }
    // First materialization changes the original coverage even when accepted
    // display geometry is unchanged. Preserve the other displayed slots named
    // from that coverage in this same USER rather than renaming them afterwards.
    for (const id of needed) {
      const table = frameTable(initial, id);
      if (table !== undefined) affectedTables.add(table);
    }
    const final = frames.at(-1)!;
    for (const id of derived.keys()) {
      const table = frameTable(initial, id);
      if (final.nodes.has(id) && table !== undefined && affectedTables.has(table)) needed.add(id);
    }
    let prior = -1;
    while (prior !== needed.size) {
      prior = needed.size;
      for (const id of needed) {
        const descriptor = derived.get(id);
        requireCompiler(descriptor !== undefined, 'A touched derived node lost its default descriptor');
        if (derived.has(descriptor.parent)) needed.add(descriptor.parent);
        // A required local cell/group also needs its schema-required default body.
        if (descriptor.kind === 'container') {
          for (const child of initial.children.get(id) ?? []) if (derived.has(child)) needed.add(child);
        }
      }
    }
    const localOnly = new Set([...derived.keys()].filter((id) => !needed.has(id)));
    return frames.map((frame) => ({
      ...frame,
      nodes: new Map([...frame.nodes].filter(([id]) => !localOnly.has(id))),
      owners: new Map([...frame.owners].filter(([id]) => !localOnly.has(id))),
      children: new Map([...frame.children].filter(([id]) => !localOnly.has(id)).map(([id, children]) => [id, children.filter((child) => !localOnly.has(child))])),
    }));
  }

  /**
   * Registers complete initial descriptors; none of these births is visible during actual REG.
   * @param frame - The accepted stage whose structural nodes need immutable defaults.
   * @throws {Error} If a product descriptor is invalid.
   */
  private registerNodes(frame: CompilerFrame): void {
    for (const node of frame.nodes.values()) {
      const view = this.view();
      const derived = this.input.projection.index.derived.get(node.id);
      const existing = view.body.records.get(node.id);
      if (existing !== undefined) {
        // Undo retains immutable defaults while removing their user's birth.
        // This real edit gets a new birth only when the current selected view
        // does not already materialize the owner from live content or a birth.
        if (derived !== undefined && existing.kind === 'owner' && !view.visible.has(node.id)) {
          this.emit([{ id: this.id('birth'), kind: 'birth', owner: node.id, dependencies: [] }]);
        }
        continue;
      }
      const order = derived?.order ?? this.initialOrder(frame, node, view);
      const parent = derived?.parent ?? node.parent;
      const type = derived?.type ?? node.type;
      const attrs = derived?.attrs ?? node.attrs;
      const wrapperAttrs = derived?.wrapperAttrs ?? node.wrapperAttrs;
      if (!node.owner) {
        this.register({ records: [{ id: node.id, kind: 'container', type, attrs, parent, order }] });
        continue;
      }
      // A local hole is the same owner/facet on every client, using the stable
      // seed facet name. Native empty sources retain the existing batch scope:
      // concurrent REG must not initialize the same Y.Text head/tail twice.
      const facet = derived === undefined ? this.id('facet') : `${node.id}:facet`;
      const source = this.id('source');
      const head = this.id('head');
      const tail = this.id('tail');
      for (const id of [facet, source, head, tail]) this.reserved.add(id);
      this.register({ records: [
        { id: node.id, kind: 'owner', type, attrs, wrapperAttrs, base: false, facet, parent, order },
        { id: facet, kind: 'facet', owner: node.id, parent: node.id, order: RIGHT },
      ], sources: [{ id: source, facet, head, tail }] });
      this.emit([{ id: this.id('birth'), kind: 'birth', owner: node.id, dependencies: [] }]);
    }
  }

  /**
   * Plans actual wrapper/container movement without using inline text to infer identity.
   * @param frame - The accepted stage defining current parents and sibling order.
   * @throws {Error} If the selected structural forest cannot be moved.
   */
  private positionNodes(frame: CompilerFrame): void {
    for (const [parent, children] of frame.children) {
      const view = this.view();
      const current = (view.tree.children.get(parent) ?? []).filter((id) => frame.nodes.has(id));
      if (JSON.stringify(current) === JSON.stringify(children) && children.every((id) => view.tree.parents.get(id) === parent)) continue;
      let prior = '';
      const moves = children.map((child) => {
        prior = bodyTreeOrderBetween(prior, '', this.id('order'));
        return { child, parent, order: prior };
      });
      this.structure(view, planBodyReparent(view, moves, this.id('placement')));
    }
  }

  /**
   * Records only observed attribute changes, retaining unseen payload fields and plain-content marks.
   * @param before - The structural attributes observed before this stage.
   * @param after - The accepted stage containing explicit attribute changes.
   * @throws {Error} If an attribute fact is invalid.
   */
  private properties(before: CompilerFrame, after: CompilerFrame): void {
    for (const node of after.nodes.values()) {
      const view = this.view();
      const observed = before.nodes.get(node.id);
      if (this.input.projection.index.opaque.has(node.id) && node.type === observed?.type) continue;
      const materializing = observed === undefined || this.input.projection.synthetic;
      const previous = materializing ? { ...node, ...bodyTreeRecordProperties(view, node.id) } : observed;
      const dependencies = this.dependencies(view, [node.id]);
      if (previous.type !== node.type) {
        const counter = Math.max(0, ...[...view.body.facts.values()].filter((fact) => fact.kind === 'nodeKind' && fact.owner === node.id).map((fact) => fact.kind === 'nodeKind' ? fact.counter : 0)) + 1;
        this.emit([{ id: this.id('kind'), kind: 'nodeKind', owner: node.id, value: node.type, counter, dependencies }]);
      }
      for (const [prefix, oldAttrs, newAttrs] of [['', previous.attrs, node.attrs], ['wrapper:', previous.wrapperAttrs, node.wrapperAttrs]] as const) {
        for (const name of new Set([...(materializing ? [] : Object.keys(oldAttrs)), ...Object.keys(newAttrs)])) {
          if (name === 'id' || jsonKey(oldAttrs[name] ?? null) === jsonKey(newAttrs[name] ?? null)) continue;
          const key = `${prefix}${name}`;
          const counter = Math.max(0, ...[...view.body.facts.values()].filter((fact) => fact.kind === 'attribute' && fact.owner === node.id && fact.name === key).map((fact) => fact.kind === 'attribute' ? fact.counter : 0)) + 1;
          this.emit([{ id: this.id('attribute'), kind: 'attribute', owner: node.id, name: key, value: newAttrs[name] ?? null, counter, dependencies }]);
        }
      }
    }
  }

  /**
   * Resolves observed IDs into descending ranges while keeping permanent cuts out of mutations.
   * @param ids - The observed native identities selected for mutation.
   * @returns Coalesced physical source ranges in descending mutation order.
   * @throws {Error} If an identity or scalar endpoint is invalid.
   */
  private nativeRanges(ids: readonly string[]): NativeRange[] {
    const view = this.view();
    const units = this.index(view).units;
    const selected = ids.map((id) => {
      const unit = units.get(id);
      requireCompiler(unit !== undefined, 'Compiler mutation names an absent native unit');
      return unit;
    }).sort((left, right) => left.source.localeCompare(right.source) || left.index - right.index);
    const ranges: { source: string; from: number; to: number }[] = [];
    for (const unit of selected) {
      const prior = ranges.at(-1);
      if (prior?.source === unit.source && prior.to === unit.index) prior.to += 1;
      else ranges.push({ source: unit.source, from: unit.index, to: unit.index + 1 });
    }
    for (const range of ranges) {
      const text = documentBodySource(this.planner, range.source);
      assertBodySourceBoundary(text, range.from);
      assertBodySourceBoundary(text, range.to);
    }
    return ranges.reverse();
  }

  /**
   * Deletes only native labels absent at this complete semantic boundary.
   * @param before - The native units present before this semantic action.
   * @param after - The surviving units at its complete accepted boundary.
   * @throws {Error} If a scalar or observed identity is invalid.
   */
  private removeNative(before: CompilerFrame, after: CompilerFrame): void {
    const alive = new Set(after.units.filter((unit) => unit.origin === 'existing').map((unit) => unit.token));
    const removed = before.units.filter((unit) => unit.origin === 'existing' && !alive.has(unit.token)).map((unit) => unit.token);
    for (const range of this.nativeRanges(removed)) documentBodySource(this.planner, range.source).delete(range.from, range.to - range.from);
    removed.forEach((id) => this.deleted.add(id));
  }

  /**
   * Finds or refines a cut whose selected left slot and optional right side share the requested gap.
   * @param owner - The current content owner of the boundary.
   * @param offset - The UTF-16 offset among its visible native units.
   * @param rightInside - Whether the right branch must begin at the same gap in this owner.
   * @returns The permanent cut identity representing this boundary.
   * @throws {Error} If an owner or scalar boundary is invalid.
   */
  private cut(owner: string, offset: number, rightInside = true): string {
    const view = this.view();
    const record = this.owner(view, owner);
    const point = bodyTreeSourcePoint(view, owner, offset);
    if (point === null) {
      const cuts = [...view.body.sources.values()].filter((entry) => entry.facet === record.facet).flatMap((entry) => [entry.tail, entry.head]);
      const cut = cuts.find((id) => this.under(view, `C:${id}`, record.facet));
      requireCompiler(cut !== undefined, 'An empty owner has no registered insertion boundary');
      return cut;
    }
    const text = documentBodySource(this.planner, point.source);
    const raw: { readonly value: unknown; readonly index: number }[] = [];
    let index = 0;
    for (const run of text.toDelta() as readonly { readonly insert: unknown }[]) {
      for (const value of typeof run.insert === 'string' ? run.insert.split('') : [run.insert]) raw.push({ value, index: index++ });
    }
    const existing = raw.find((entry) => entry.index === point.index && bodyCutId(entry.value) !== null)
      ?? raw.find((entry) => entry.index === point.index - 1 && bodyCutId(entry.value) !== null);
    const old = existing === undefined ? null : bodyCutId(existing.value);
    if (old !== null) {
      const points = this.index(view).points;
      const boundary = points.get(`C:${old}`);
      const right = points.get(`R:${old}`);
      const left = [...(view.tree.children.get(`C:${old}`) ?? [])].reverse().find((id) => view.tree.selected.get(id)!.order < RIGHT);
      const gap = left === undefined ? boundary?.from : points.get(left)?.to;
      if (boundary?.owner === owner && gap === offset && (!rightInside || right?.owner === owner && right.from === offset)) return old;
    }
    const originalText = documentBodySource(this.input.doc, point.source);
    const originalUnits = new Map([...this.originals.values()].filter((unit) => unit.source === point.source).map((unit) => [unit.id, unit]));
    const originalCuts = new Map([...this.input.projection.view.pieces.values()].filter((piece) => piece.source === point.source).map((piece) => [piece.cut, piece.start - 1]));
    const nextCut = [...view.pieces.values()].filter((piece) => piece.source === point.source && piece.start - 1 >= point.index && originalCuts.has(piece.cut)).sort((left, right) => left.start - right.start)[0];
    const next = view.units.filter((unit) => unit.source === point.source && unit.index >= point.index && originalUnits.has(unit.id)).sort((left, right) => left.index - right.index)[0];
    let anchor: number;
    // An existing cut is itself a native anchor. Skipping it for the next
    // character can register on the opposite side of an independently moved
    // R branch: REG stays visibly equal but USER sees a different C/R/P chain.
    if (nextCut !== undefined && (next === undefined || nextCut.start - 1 < next.index)) anchor = originalCuts.get(nextCut.cut)!;
    else if (next !== undefined) anchor = originalUnits.get(next.id)!.index;
    else {
      const prior = view.units.filter((unit) => unit.source === point.source && unit.index < point.index && originalUnits.has(unit.id)).sort((left, right) => right.index - left.index)[0];
      requireCompiler(prior !== undefined, 'A new permanent cut has no existing native anchor');
      anchor = originalUnits.get(prior.id)!.index + 1;
    }
    assertBodySourceBoundary(originalText, anchor);
    const at = Y.createRelativePositionFromTypeIndex(originalText, anchor, 0);
    const cut = this.id('cut');
    registerBodyCut(this.planner, point.source, cut, point.index);
    this.cuts.push({ source: point.source, cut, at });
    return cut;
  }

  /**
   * Chooses a destination from exact stage labels after removing the selected native interval.
   * @param frame - The accepted target stage with exact native labels.
   * @param owner - The target content owner.
   * @param selected - The native identities being moved, in source order.
   * @returns The exact target offset after removing the selected interval.
   * @throws {BodyProvenanceError} If a target predecessor is unavailable.
   */
  private destination(frame: CompilerFrame, owner: string, selected: readonly string[]): number {
    const expected = skeleton(frame, owner);
    const current = this.labels(this.view(), owner);
    const moving = new Set(selected);
    const start = expected.indexOf(selected[0]);
    requireCompiler(start >= 0, 'A declared move has no target occurrence');
    const next = expected.slice(start + selected.length).find((id) => !moving.has(id) && current.includes(id));
    if (next !== undefined) return current.indexOf(next);
    const previous = [...expected.slice(0, start)].reverse().find((id) => !moving.has(id) && current.includes(id));
    return previous === undefined ? 0 : current.indexOf(previous) + 1;
  }

  /**
   * Moves the complete current selected interval using maximal forest and suffix-retention planning.
   * @param selected - The exact contiguous native identities to transfer.
   * @param target - The destination content owner.
   * @param after - The accepted target stage defining their final location.
   * @throws {Error} If the declared native interval is not contiguous.
   */
  private move(selected: readonly string[], target: string, after: CompilerFrame): void {
    if (selected.length === 0) return;
    let view = this.view();
    const source = this.index(view).ownersByUnit.get(selected[0]);
    requireCompiler(source !== undefined, 'A transferred native unit has no current owner');
    const start = source.units.findIndex((unit) => unit.id === selected[0]);
    requireCompiler(source.units.slice(start, start + selected.length).every((unit, index) => unit.id === selected[index]), 'A declared native interval is not contiguous');
    const offset = this.destination(after, target, selected);
    if (source.id === target && (offset === start || offset === start + selected.length)) return;
    const endCut = this.cut(source.id, start + selected.length);
    const startCut = this.cut(source.id, start);
    const targetCut = this.cut(target, offset, false);
    view = this.view();
    this.structure(view, planBodyRangeMove(view, source.id, startCut, endCut, target, targetCut, this.id('range')));
  }

  /**
   * Consumes whole joined facets, including their empty branches and selected-path repairs.
   * @param before - The accepted stage with source owners before the action.
   * @param after - The stage with their content joined into surviving owners.
   * @throws {Error} If a facet join is invalid.
   */
  private joins(before: CompilerFrame, after: CompilerFrame): void {
    for (const [id] of before.owners) {
      if (after.owners.has(id)) continue;
      let view = this.view();
      const labels = this.labels(view, id);
      const sourceNode = before.nodes.get(id)!;
      const boundaryJoin = after.step instanceof ReplaceStep && after.step.slice.size === 0 && sourceNode.from === after.step.to
        ? [...before.nodes.values()].find((node) => node.owner && node.to === (after.step as ReplaceStep).from && after.owners.has(node.id))?.id
        : undefined;
      const target = labels.length === 0 ? boundaryJoin : [...after.owners.keys()].find((owner) => {
        const wanted = skeleton(after, owner);
        const at = wanted.indexOf(labels[0]);
        return at >= 0 && labels.every((label, index) => wanted[at + index] === label);
      });
      if (target === undefined) continue;
      const offset = labels.length === 0 ? this.labels(view, target).length : this.destination(after, target, labels);
      const cut = this.cut(target, offset, false);
      view = this.view();
      this.structure(view, planBodyJoin(view, target, id, cut, this.id('join')));
    }
  }

  /**
   * Transfers a new owner's complete native suffix through the approved split planner.
   * @param before - The accepted stage before new suffix owners appear.
   * @param after - The stage defining each new owner and its native suffix.
   * @throws {Error} If the split forest is invalid.
   */
  private splits(before: CompilerFrame, after: CompilerFrame): void {
    for (const [target] of after.owners) {
      if (before.owners.has(target)) continue;
      const wanted = skeleton(after, target);
      if (wanted.length === 0) continue;
      let view = this.view();
      const source = this.index(view).ownersByUnit.get(wanted[0]);
      if (source === undefined || source.id === target) continue;
      const start = source.units.findIndex((unit) => unit.id === wanted[0]);
      if (source.units.length - start !== wanted.length || !source.units.slice(start).every((unit, index) => unit.id === wanted[index])) continue;
      const cut = this.cut(source.id, start);
      view = this.view();
      this.structure(view, planBodySplit(view, source.id, cut, target, this.id('split')));
    }
  }

  /**
   * Replays the producer's exact selected native intervals instead of choosing a same-text complement.
   * @param before - The source stage named by the producer handoffs.
   * @param after - The accepted target stage carrying the complete operation.
   * @throws {Error} If a declared interval cannot be planned.
   */
  private declaredMoves(before: CompilerFrame, after: CompilerFrame): void {
    const operation = after.operation;
    if (operation === undefined) return;
    const selected = before.units.filter((unit) => unit.origin === 'existing' && operation.handoffs.some((handoff) =>
      handoff.kind === 'move' && unit.pos >= handoff.source.from && unit.pos + unit.width <= handoff.source.to,
    ));
    let group: string[] = [];
    let owner: string | undefined;
    let source: string | undefined;
    /**
     * Completes one exact contiguous source/target handoff group.
     * @throws {Error} If its forest is invalid.
     */
    const flush = (): void => {
      if (owner !== undefined && group.length > 0) this.move(group, owner, after);
      group = [];
    };
    for (const unit of selected) {
      const target = [...after.owners].find(([, units]) => units.some((candidate) => candidate.token === unit.token))?.[0];
      const sourceOwner = [...before.owners].find(([, units]) => units.some((candidate) => candidate.token === unit.token))?.[0];
      requireCompiler(target !== undefined, 'A declared existing move has no target owner');
      requireCompiler(sourceOwner !== undefined, 'A declared existing move has no source owner');
      if (target !== owner || sourceOwner !== source) flush();
      owner = target;
      source = sourceOwner;
      group.push(unit.token);
    }
    flush();
  }

  /**
   * Reconciles only stage-native labels retained by actual StepMaps, using shared interval forests.
   * @param after - The accepted stage whose retained native skeleton must be reproduced.
   * @throws {Error} If a stage identity or forest is inconsistent.
   */
  private nativeStage(after: CompilerFrame): void {
    for (const [owner] of after.owners) {
      if (this.input.projection.index.opaque.has(owner)) continue;
      const expected = skeleton(after, owner);
      for (let index = 0; index < expected.length; index += 1) {
        const view = this.view();
        const current = this.labels(view, owner);
        if (current[index] === expected[index]) continue;
        const source = this.index(view).ownersByUnit.get(expected[index]);
        requireCompiler(source !== undefined, 'A retained stage label has no native source');
        const start = source.units.findIndex((unit) => unit.id === expected[index]);
        let length = 1;
        while (index + length < expected.length && source.units[start + length]?.id === expected[index + length]) length += 1;
        this.move(expected.slice(index, index + length), owner, after);
      }
    }
    const checked = this.view();
    for (const [owner] of after.owners) {
      if (this.input.projection.index.opaque.has(owner)) continue;
      requireCompiler(JSON.stringify(this.labels(checked, owner)) === JSON.stringify(skeleton(after, owner)), 'Planned native skeleton differs from the accepted stage');
    }
  }

  /**
   * Registers an immutable actual mark instance with its complete current structural support.
   * @param payload - The complete current mark type and attributes.
   * @param dependencies - The selected structural support for this mark instance.
   * @returns The immutable fact identity for this mark and its support.
   * @throws {Error} If its dependencies are invalid.
   */
  private mark(payload: BodyMarkPayload, dependencies: readonly string[]): string {
    const key = jsonKey({ ...payload, dependencies });
    const prior = this.markFacts.get(key);
    if (prior !== undefined) return prior;
    const id = this.id('mark');
    this.emit([{ id, kind: 'mark', payload, dependencies }]);
    this.markFacts.set(key, id);
    return id;
  }

  /**
   * Applies only explicit PM mark-family changes, leaving plain projections and unknown native keys alone.
   * @param before - The stage before the explicit mark-family change.
   * @param after - The accepted stage containing the actual mark step.
   * @throws {Error} If a native format range is invalid.
   */
  private nativeMarks(before: CompilerFrame, after: CompilerFrame): void {
    if (!(after.step instanceof AddMarkStep) && !(after.step instanceof RemoveMarkStep) && !(after.step instanceof AddNodeMarkStep) && !(after.step instanceof RemoveNodeMarkStep)) return;
    const old = new Map(before.units.map((unit) => [unit.token, unit]));
    const updates = new Map<string, { readonly attributes: BodyJsonObject; readonly ids: string[] }>();
    for (const unit of after.units) {
      if (unit.origin !== 'existing') continue;
      const prior = old.get(unit.token);
      if (prior === undefined) continue;
      const left = new Map((before.document.nodeAt(prior.pos)?.marks ?? []).map((mark) => { const payload = markPayload(mark); return [semanticMarkKey(payload), payload]; }));
      const right = new Map((after.document.nodeAt(unit.pos)?.marks ?? []).map((mark) => { const payload = markPayload(mark); return [semanticMarkKey(payload), payload]; }));
      const view = this.view();
      const native = this.index(view).units.get(unit.token)!;
      const attributes: Record<string, BodyJsonValue> = {};
      for (const key of new Set([...left.keys(), ...right.keys()])) {
        const previous = left.get(key);
        const next = right.get(key);
        if (jsonKey(previous === undefined ? null : { ...previous }) === jsonKey(next === undefined ? null : { ...next })) continue;
        for (const [oldKey, value] of Object.entries(native.attributes)) {
          if (!oldKey.startsWith(BODY_MARK_ATTRIBUTE_PREFIX) || value === null || typeof value !== 'object' || !('factId' in value) || typeof value.factId !== 'string') continue;
          const fact = view.body.facts.get(value.factId);
          if (fact?.kind === 'mark' && semanticMarkKey(fact.payload) === key) attributes[oldKey] = null;
        }
        const payload = right.get(key);
        attributes[key] = payload === undefined ? null : { factId: this.mark(payload, this.dependencies(view, [native.piece])) };
      }
      if (Object.keys(attributes).length === 0) continue;
      this.formats.set(unit.token, { ...this.formats.get(unit.token), ...attributes });
      const key = jsonKey(attributes);
      const group = updates.get(key) ?? { attributes, ids: [] };
      group.ids.push(unit.token);
      updates.set(key, group);
    }
    for (const update of updates.values()) {
      for (const range of this.nativeRanges(update.ids)) documentBodySource(this.planner, range.source).format(range.from, range.to - range.from, update.attributes);
    }
  }

  /**
   * Hides final explicitly absent wrappers without confusing an intermediate replacement or a consumed facet.
   * @param initial - The initial accepted frame containing observed wrappers.
   * @param final - The final frame after all accepted semantic actions.
   * @throws {Error} If a delete fact is invalid.
   */
  private hideAbsent(initial: CompilerFrame, final: CompilerFrame): void {
    for (const node of initial.nodes.values()) {
      if (final.nodes.has(node.id)) continue;
      const view = this.view();
      const record = view.body.records.get(node.id);
      if (record?.kind === 'owner' && view.tree.parents.get(record.facet) !== node.id) continue;
      this.emit([{ id: this.id('delete'), kind: 'delete', owner: node.id, dependencies: this.dependencies(view, [node.id]) }]);
    }
  }

  /**
   * Selects the exact native gap among current C left slots, preferring fewer structural dependencies.
   * A fresh run typed before a join can therefore stay in the original left
   * gap instead of acquiring support for a later joined right facet.
   * @param owner - The content owner receiving the fresh run.
   * @param offset - Its exact gap among visible native units.
   * @returns The permanent cut parent and fractional order of the insertion slot.
   * @throws {BodyProvenanceError} If no permanent left slot represents the accepted gap.
   */
  private freshSlot(owner: string, offset: number): { readonly parent: string; readonly order: string } {
    this.cut(owner, offset, false);
    const view = this.view();
    const facet = this.owner(view, owner).facet;
    const points = this.index(view).points;
    const slots: { readonly parent: string; readonly before: string; readonly after: string; readonly dependencies: number; readonly depth: number }[] = [];
    for (const [id, point] of points) {
      if (point.owner !== owner || view.nodes.get(id)?.kind !== 'cut') continue;
      let ancestor = id;
      let depth = 0;
      while (ancestor !== facet) { ancestor = view.tree.parents.get(ancestor)!; depth += 1; }
      const dependencies = bodyTreeDependencies(view, id).length;
      const children = view.tree.children.get(id) ?? [];
      const last = children.length === 0 ? '' : view.tree.selected.get(children.at(-1)!)!.order;
      for (let index = 0; index < children.length; index += 1) {
        const child = children[index];
        const order = view.tree.selected.get(child)!.order;
        if (order <= RIGHT && points.get(child)?.from === offset) {
          slots.push({ parent: id, before: index === 0 ? '' : view.tree.selected.get(children[index - 1])!.order, after: order, depth, dependencies });
        }
      }
      if (last < RIGHT && point.to === offset) slots.push({ parent: id, before: last, after: RIGHT, depth, dependencies });
    }
    const slot = slots.sort((left, right) => left.dependencies - right.dependencies || left.depth - right.depth || left.parent.localeCompare(right.parent))[0];
    requireCompiler(slot !== undefined, 'A final fresh run has no exact native insertion slot');
    return { parent: slot.parent, order: bodyTreeOrderBetween(slot.before, slot.after, this.id('fresh-order')) };
  }

  /**
   * Registers an empty source for one final contiguous fresh run at its old-native gap.
   * @param frame - The final accepted frame holding actual PM payloads.
   * @param owner - The current owner of the fresh run.
   * @param units - The contiguous final fresh labels.
   * @param nativeOffset - The exact gap among this owner’s retained native units.
   * @throws {Error} If a target, inline payload or context is invalid.
   */
  private freshRun(frame: CompilerFrame, owner: string, units: readonly BodyInlineUnit[], nativeOffset: number): void {
    const slot = this.freshSlot(owner, nativeOffset);
    let view = this.view();
    const source: BodySource = { id: this.id('fresh-source'), facet: this.owner(view, owner).facet, head: this.id('fresh-head'), tail: this.id('fresh-tail') };
    this.register({ sources: [source] });
    view = this.view();
    this.structure(view, planBodyReparent(view, [{ child: `C:${source.head}`, parent: slot.parent, order: slot.order }], this.id('fresh-placement')));
    view = this.view();
    const dependencies = this.dependencies(view, [`P:${source.head}`]);
    const context = this.id('context');
    this.register({ contexts: [{ id: context, dependencies }] });
    const planned = units.map((unit) => {
      const node = frame.document.nodeAt(unit.pos);
      requireCompiler(node !== null, 'A final fresh occurrence has no actual PM node');
      const attributes: Record<string, BodyJsonValue> = { ctx: context };
      for (const mark of node.marks) {
        const payload = markPayload(mark);
        attributes[semanticMarkKey(payload)] = { factId: this.mark(payload, dependencies) };
      }
      const value: BodyJsonValue = node.isText ? unit.value : { bodyInline: { type: node.type.name, attrs: compilerJson(node.attrs) } };
      return { token: unit.token, value, attributes };
    });
    this.fresh.push({ source: source.id, units: planned });
  }

  /**
   * Emits final runs only; transient fresh labels never acquire a native source or mutation.
   * @param frame - The final frame whose fresh runs need independent native sources.
   * @throws {Error} If a final run cannot be registered.
   */
  private freshRuns(frame: CompilerFrame): void {
    for (const [owner, units] of frame.owners) {
      let offset = 0;
      for (let index = 0; index < units.length;) {
        if (units[index].origin === 'existing') { offset += 1; index += 1; continue; }
        const run: BodyInlineUnit[] = [];
        while (index < units.length && units[index].origin === 'fresh') run.push(units[index++]);
        this.freshRun(frame, owner, run, offset);
      }
    }
  }

  /**
   * Converts final explicit native mark states into coalescible writes without touching ctx.
   * @returns Explicit final native deletions and format updates.
   * @throws {never}
   */
  private nativeWrites(): BodyNativeWrite[] {
    const writes: BodyNativeWrite[] = this.deleted.size === 0 ? [] : [{ kind: 'delete', ids: [...this.deleted] }];
    const grouped = new Map<string, { readonly attributes: BodyJsonObject; readonly ids: string[] }>();
    for (const [id, attributes] of this.formats) {
      if (this.deleted.has(id)) continue;
      const key = jsonKey(attributes);
      const group = grouped.get(key) ?? { attributes, ids: [] };
      group.ids.push(id);
      grouped.set(key, group);
    }
    for (const group of grouped.values()) writes.push({ kind: 'format', ids: group.ids, attributes: group.attributes });
    return writes;
  }

  /**
   * Reproduces physical cut order when several planned boundaries share one original anchor.
   * The actual REG can resolve only original native anchors; registering these
   * cuts in final physical order keeps their default C/R/P chain identical.
   * @returns Planned cuts in the physical order required for actual registration.
   * @throws {BodyProvenanceError} If a registered permanent cut disappeared.
   */
  private orderedCuts(): readonly BodyPlannedCut[] {
    const positions = new Map<string, number>();
    for (const source of new Set(this.cuts.map((cut) => cut.source))) {
      let index = 0;
      for (const run of documentBodySource(this.planner, source).toDelta() as readonly { readonly insert: unknown }[]) {
        for (const value of typeof run.insert === 'string' ? run.insert.split('') : [run.insert]) {
          const cut = bodyCutId(value);
          if (cut !== null) positions.set(cut, index);
          index += 1;
        }
      }
    }
    requireCompiler(this.cuts.every((cut) => positions.has(cut.cut)), 'A planned permanent cut disappeared');
    return [...this.cuts].sort((left, right) => left.source.localeCompare(right.source) || positions.get(left.cut)! - positions.get(right.cut)!);
  }

  /**
   * Compiles every accepted semantic boundary and releases all private native planning state.
   * @returns The complete registration, native writes and fresh-source batch plan.
   * @throws {Error} If any explicit stage or source invariant fails.
   */
  run(): BodyBatchPlan {
    try {
      const frames = this.planningFrames(compilerFrames(this.input));
      // Defaults must be identical across concurrent first edits. Actual
      // first-edit properties are separate facts in the chronological loop.
      this.registerNodes(frames[0]);
      for (let index = 1; index < frames.length; index += 1) {
        const before = frames[index - 1];
        const after = frames[index];
        const firstFact = this.facts.length;
        this.registerNodes(after);
        this.removeNative(before, after);
        this.properties(before, after);
        this.positionNodes(after);
        this.joins(before, after);
        this.splits(before, after);
        this.declaredMoves(before, after);
        this.nativeStage(after);
        this.coalesceStructures(firstFact);
        this.nativeMarks(before, after);
      }
      const final = frames.at(-1)!;
      requireCompiler(final.document.eq(this.input.journal.doc), 'Compiler did not consume the complete accepted journal');
      this.hideAbsent(frames[0], final);
      this.freshRuns(final);
      return {
        id: this.input.batchId,
        registration: { records: this.records, sources: this.sources, facts: this.facts, groups: this.groups, contexts: this.contexts },
        cuts: this.orderedCuts(),
        native: this.nativeWrites(), fresh: this.fresh,
        enable: this.groups.map((group) => group.id),
        expected: rekeyedExpectation(final, this.input.journal.doc, this.input.journal.units),
      };
    } finally {
      this.planner.off('update', this.invalidateView);
      this.cachedView = undefined;
      this.planner.destroy();
    }
  }
}

/**
 * Compiles the complete accepted PM journal into zero-effect REG and one USER plan.
 * No sandbox update is copied: only typed descriptions, original-source cut
 * anchors, observed native writes and final fresh runs leave the planner.
 * @param input - The exact native source, original projection and complete journal.
 * @returns The explicit mutation plan consumed by the existing preflight engine.
 * @throws {BodyProvenanceError} If accepted identities or semantic stages are inconsistent.
 * @throws {Error} If shared forest planning or scalar-safe native validation fails.
 */
export function compileBodyBatch(input: CompileBodyBatchOptions): BodyBatchPlan {
  return new BodyBatchCompiler(input).run();
}
