// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { Mapping } from '@tiptap/pm/transform';
import type { BodyProjection, BodyProjectionIndex, BodyNodePosition, BodyNativePoint } from '@web/spaces/document/document-body-codec-types';
import type { CompileBodyBatchOptions } from '@web/spaces/document/document-body-compiler-types';
import { compilerFrames } from '@web/spaces/document/document-body-compiler-frames';
import { nameBodyPoint } from '@web/spaces/document/document-body-positions';
import type { BodyAssociation, BodyPointName, BodyStagedTextPointName } from '@web/spaces/document/document-body-positions-types';
import type { BodyInlineUnit } from '@web/spaces/document/document-body-provenance';

/** A finalized local name shares the original holder's lifetime, not a global token map's. */
export type BodyStagedNameState =
  | { readonly status: 'pending' | 'disposed' }
  | { readonly status: 'final'; readonly point: BodyPointName; readonly character: boolean };

/** Only the current synchronous batch strongly retains unresolved name objects. */
interface HeldStagedName {
  readonly name: BodyStagedTextPointName;
  readonly owner: string | null;
  readonly before: readonly string[];
  readonly after: readonly string[];
}

const owners = new WeakMap<BodyStagedTextPointName, BodyStagedNames>();

/**
 * Reads a local name's final alias without retaining that name globally.
 * @param name - The actual name object held by a consumer.
 * @returns Its final native point, unresolved state or released handle state.
 * @throws {never}
 */
export function stagedBodyNameState(name: BodyStagedTextPointName): BodyStagedNameState {
  return owners.get(name)?.read(name) ?? { status: 'disposed' };
}

/** Handle-owned aliases are weak after each complete USER has been finalized. */
export class BodyStagedNames {
  private finalized = new WeakMap<BodyStagedTextPointName, BodyStagedNameState>();
  private readonly pending = new Map<string, HeldStagedName[]>();
  private disposed = false;

  /**
   * Names a fresh occurrence in the exact accepted PM state.
   * @param index - The accepted state's common index.
   * @param position - A current PM inline boundary.
   * @param assoc - The requested boundary affinity.
   * @returns A local fresh name, or null when the point is already native.
   * @throws {Error} If this registry has already been released.
   */
  name(index: BodyProjectionIndex, position: number, assoc: BodyAssociation): BodyStagedTextPointName | null {
    if (this.disposed) throw new Error('The staged body names have been disposed');
    const stage = index.staged;
    if (stage === undefined) return null;
    const right = stage.units.find((unit) => unit.pos === position);
    const left = stage.units.find((unit) => unit.pos + unit.width === position);
    const unit = assoc < 0 ? left ?? right : right ?? left;
    if (unit?.origin !== 'fresh') return null;
    const name: BodyStagedTextPointName = { version: 1, document: index.document, kind: 'stagedText', batch: stage.batch, token: unit.token, offset: position - unit.pos, assoc };
    const sameOwner = stage.units.filter((entry) => entry.block === unit.block);
    const ordinal = sameOwner.findIndex((entry) => entry.token === unit.token);
    const held = this.pending.get(stage.batch) ?? [];
    held.push({ name, owner: unit.block, before: sameOwner.slice(0, ordinal).map((entry) => entry.token).reverse(), after: sameOwner.slice(ordinal + 1).map((entry) => entry.token) });
    this.pending.set(stage.batch, held);
    owners.set(name, this);
    return name;
  }

  /**
   * Reads aliases only through a held name object.
   * @param name - The consumer-owned local name.
   * @returns The released, unresolved or finalized state.
   * @throws {never}
   */
  read(name: BodyStagedTextPointName): BodyStagedNameState {
    return this.disposed ? { status: 'disposed' } : this.finalized.get(name) ?? { status: 'pending' };
  }

  /**
   * Finalizes actual fresh IDs after the real USER, before publishing consumers.
   * @param batch - The accepted batch being completed.
   * @param frame - The actual final native projection.
   * @param aliases - Actual fresh-label to native-ID assignments.
   * @throws {Error} If the final frame cannot name a retained boundary.
   */
  finalize(batch: string, frame: BodyProjection, aliases: ReadonlyMap<string, string>): void {
    const held = this.pending.get(batch) ?? [];
    const units = new Map(frame.index.units.map((unit) => [unit.token, unit]));
    for (const entry of held) {
      const token = aliases.get(entry.name.token);
      const actual = token === undefined ? undefined : units.get(token);
      let point: BodyPointName;
      if (actual !== undefined) point = nameBodyPoint(frame.index, { kind: 'text', pos: actual.pos + entry.name.offset, assoc: entry.name.assoc });
      else {
        const before = entry.before.map((id) => units.get(aliases.get(id) ?? id)).find((unit) => unit !== undefined);
        const after = entry.after.map((id) => units.get(aliases.get(id) ?? id)).find((unit) => unit !== undefined);
        const neighbor = entry.name.assoc < 0 ? before ?? after : after ?? before;
        if (neighbor !== undefined) point = nameBodyPoint(frame.index, { kind: 'text', pos: neighbor === before ? neighbor.pos + neighbor.width : neighbor.pos, assoc: entry.name.assoc });
        else if (entry.owner !== null && frame.index.nodes.has(entry.owner)) point = nameBodyPoint(frame.index, { kind: 'node', node: entry.owner, side: 'inside' });
        else point = nameBodyPoint(frame.index, { kind: 'bodyEdge', edge: 'start' });
      }
      this.finalized.set(entry.name, { status: 'final', point, character: actual !== undefined });
    }
    this.pending.delete(batch);
  }

  /**
   * Releases unresolved batches and every final alias at handle disposal.
   * @throws {never}
   */
  dispose(): void {
    this.disposed = true;
    this.pending.clear();
    this.finalized = new WeakMap();
  }
}

/**
 * Reuses the compiler's real structural frames for the accepted state's common index.
 * @param input - The original final frame and complete accepted journal.
 * @param names - This handle's local-to-native name ownership.
 * @returns A frame matching the exact accepted PM root, with fresh units kept local.
 * @throws {BodyProvenanceError} If accepted structural handles are ambiguous.
 */
export function stageBodyProjection(input: CompileBodyBatchOptions, names: BodyStagedNames): BodyProjection {
  const current = compilerFrames(input).at(-1)!;
  const nodes = new Map<string, BodyNodePosition>();
  const nativeOwners = new Map<string, BodyNodePosition>();
  for (const node of current.nodes.values()) {
    const position = { id: node.id, type: node.type, from: node.before, to: node.after, contentFrom: node.from, contentTo: node.to };
    nodes.set(node.id, position);
    if (node.owner) nativeOwners.set(node.id, position);
  }
  nodes.set(input.projection.view.root, { id: input.projection.view.root, type: 'doc', from: 0, to: current.document.content.size, contentFrom: 0, contentTo: current.document.content.size });
  const native = new Map(input.projection.index.units.map((unit) => [unit.token, unit]));
  const units = current.units.flatMap((unit) => {
    const original = native.get(unit.token);
    return original === undefined ? [] : [{ ...original, ...unit, owner: unit.block ?? original.owner }];
  });
  const stage: { readonly batch: string; readonly units: readonly BodyInlineUnit[]; readonly names: BodyStagedNames } = { batch: input.batchId, units: input.journal.units, names };
  const mapping = new Mapping();
  for (const transaction of input.journal.transactions) mapping.appendMapping(transaction.transaction.mapping);
  const nativePoints = new Map<string, BodyNativePoint>([...input.projection.index.nativePoints].map(([id, point]) => [id, {
    ...(point.before === undefined ? {} : { before: mapping.map(point.before, 1) }),
    ...(point.after === undefined ? {} : { after: mapping.map(point.after, -1) }),
  }]));
  for (const unit of units) nativePoints.set(unit.token, { before: unit.pos, after: unit.pos + unit.width });
  return { ...input.projection, doc: input.journal.doc, units: input.journal.units,
    index: { ...input.projection.index, doc: input.journal.doc, nodes, owners: nativeOwners, units, nativePoints, staged: stage } };
}
