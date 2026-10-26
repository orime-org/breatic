// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type { Node as PMNode } from '@tiptap/pm/model';
import { Mapping, type Step } from '@tiptap/pm/transform';
import type { BodyJsonObject } from '@breatic/shared';

import type { CompileBodyBatchOptions } from '@web/spaces/document/document-body-compiler-types';
import { BodyProvenanceError, type BodyInlineUnit, type BodyTransferOperation } from '@web/spaces/document/document-body-provenance';

/** A product node observed at one actual accepted semantic boundary. */
export interface CompilerNode {
  readonly id: string;
  readonly parent: string;
  readonly type: string;
  readonly owner: boolean;
  readonly temporary: boolean;
  readonly attrs: BodyJsonObject;
  readonly wrapperAttrs: BodyJsonObject;
  readonly before: number;
  readonly after: number;
  readonly from: number;
  readonly to: number;
}

/** Fresh units stay in this frame but never enter its native skeleton. */
export interface CompilerFrame {
  readonly document: PMNode;
  readonly units: readonly BodyInlineUnit[];
  readonly nodes: ReadonlyMap<string, CompilerNode>;
  readonly children: ReadonlyMap<string, readonly string[]>;
  readonly owners: ReadonlyMap<string, readonly BodyInlineUnit[]>;
  readonly operation?: BodyTransferOperation;
  readonly step?: Step;
}

/**
 * Copies PM attributes into the persisted JSON domain before registration.
 * @param value - Attributes owned by a real PM node or mark.
 * @returns Their complete serializable own JSON fields.
 * @throws {BodyProvenanceError} If attributes are not an object.
 * @throws {TypeError} If attributes are not serializable.
 */
export function compilerJson(value: unknown): BodyJsonObject {
  const copy: unknown = JSON.parse(JSON.stringify(value));
  if (copy === null || typeof copy !== 'object' || Array.isArray(copy)) throw new BodyProvenanceError('Body attributes must be JSON objects');
  return copy as BodyJsonObject;
}

/**
 * Resolves a temporary new-owner handle after the actual ID append named it.
 * @param aliases - Stage-to-stage handle assignments.
 * @param id - An observed stage handle.
 * @returns Its final registered identity.
 * @throws {BodyProvenanceError} If handle assignment contains a cycle.
 */
function resolve(aliases: ReadonlyMap<string, string>, id: string): string {
  const seen = new Set<string>();
  while (aliases.has(id)) {
    if (seen.has(id)) throw new BodyProvenanceError('Cyclic staged owner identity');
    seen.add(id);
    id = aliases.get(id)!;
  }
  return id;
}

/**
 * Reads real structural handles and exact inline ownership at one boundary.
 * @param input - The source frame being compiled.
 * @param document - Its actual stage document.
 * @param units - Its occurrence names from the real journal.
 * @param previous - The preceding semantic frame.
 * @param mapping - Only the steps between these two boundaries.
 * @param aliases - Local new-owner names assigned by later ID appends.
 * @param allocate - Allocates an internal handle for a new unnamed node.
 * @returns The complete observed PM frame.
 * @throws {BodyProvenanceError} If structural identities are ambiguous.
 */
function readFrame(
  input: CompileBodyBatchOptions,
  document: PMNode,
  units: readonly BodyInlineUnit[],
  previous: CompilerFrame | undefined,
  mapping: Mapping,
  aliases: Map<string, string>,
  allocate: () => string,
): CompilerFrame {
  const nodes = new Map<string, CompilerNode>();
  const children = new Map<string, string[]>();
  const owners = new Map<string, readonly BodyInlineUnit[]>();
  const initialPositions = new Map([...input.projection.index.nodes].filter(([id]) => id !== input.projection.view.root).map(([id, node]) => [node.from, id]));

  /**
   * Visits structural nodes; block content belongs to its wrapper's owner.
   * @param node - The actual structural node in this accepted stage.
   * @param before - Its absolute position before the node.
   * @param parent - Its current structural parent identity.
   * @throws {BodyProvenanceError} If a handle is repeated.
   */
  function visit(node: PMNode, before: number, parent: string): void {
    const owner = node.type.name === 'blockContainer';
    const content = owner ? node.firstChild : node;
    if (content === null) throw new BodyProvenanceError('A body owner has no content');
    const rawId: unknown = node.attrs['id'];
    const explicit = typeof rawId === 'string' && rawId.length > 0 ? rawId : undefined;
    const mapped = previous === undefined ? undefined : [...previous.nodes.values()].find((candidate) =>
      candidate.owner === owner &&
      (owner || candidate.type === node.type.name) &&
      mapping.map(candidate.before + 1, 1) === before + 1,
    );
    const sameParent = previous === undefined ? undefined : [...previous.nodes.values()].find((candidate) =>
      !owner && !candidate.owner && candidate.type === node.type.name &&
      resolve(aliases, candidate.parent) === resolve(aliases, parent) && !nodes.has(resolve(aliases, candidate.id)),
    );
    const known = previous === undefined ? initialPositions.get(before) : undefined;
    if (explicit !== undefined && mapped?.temporary === true && explicit !== mapped.id) aliases.set(mapped.id, explicit);
    const id = resolve(aliases, explicit ?? known ?? mapped?.id ?? sameParent?.id ?? allocate());
    if (nodes.has(id)) throw new BodyProvenanceError('Repeated body node handle in an accepted stage');
    const from = before + (owner ? 2 : 1);
    const current: CompilerNode = {
      id, parent, type: content.type.name, owner,
      temporary: explicit === undefined && known === undefined && (mapped?.temporary ?? sameParent?.temporary ?? true),
      attrs: compilerJson(content.attrs), wrapperAttrs: owner ? compilerJson(node.attrs) : {},
      before, after: before + node.nodeSize, from, to: owner ? from + content.content.size : before + node.nodeSize - 1,
    };
    nodes.set(id, current);
    const siblings = children.get(parent) ?? [];
    siblings.push(id);
    children.set(parent, siblings);
    if (owner) owners.set(id, units.filter((unit) => unit.pos >= current.from && unit.pos < current.to));
    node.forEach((child, offset) => {
      if (owner && child === content) return;
      if (!child.isInline) visit(child, before + 1 + offset, id);
    });
  }

  document.forEach((child, offset) => { visit(child, offset, input.projection.view.root); });
  return { document, units, nodes, children, owners };
}

/**
 * Builds frames at complete semantic boundaries, excluding a move's temporary deletion.
 * @param input - The complete accepted journal and its original projection.
 * @returns Chronological actual frames with final new-owner handles.
 * @throws {BodyProvenanceError} If an operation boundary overlaps another operation.
 */
export function compilerFrames(input: CompileBodyBatchOptions): readonly CompilerFrame[] {
  const aliases = new Map<string, string>();
  let sequence = 0;
  /**
   * Allocates an internal identity without relying on words or reused block IDs.
   * @returns The next temporary identity for an unnamed stage node.
   * @throws {never}
   */
  function allocate(): string { return `${input.batchId}:unnamed:${sequence++}`; }
  const frames: CompilerFrame[] = [readFrame(input, input.projection.doc, input.projection.units, undefined, new Mapping(), aliases, allocate)];
  for (const transaction of input.journal.transactions) {
    const operations = input.journal.operations.filter((operation) => operation.source.transaction === transaction.ordinal);
    let previous = 0;
    for (let step = 1; step < transaction.stages.length; step += 1) {
      if (operations.some((operation) => operation.source.step < step && operation.target.step > step)) continue;
      const ending = operations.filter((operation) => operation.target.step === step && operation.source.step !== step);
      if (ending.length > 1) throw new BodyProvenanceError('Overlapping body operation boundaries');
      const stage = transaction.stages[step];
      const frame = readFrame(input, stage.document, stage.units, frames.at(-1), transaction.transaction.mapping.slice(previous, step), aliases, allocate);
      frames.push({ ...frame, ...(ending[0] === undefined ? {} : { operation: ending[0] }), ...(step - previous === 1 ? { step: transaction.transaction.steps[previous] } : {}) });
      previous = step;
    }
  }
  return frames.map((frame) => {
    const nodes = new Map([...frame.nodes.values()].map((node) => {
      const id = resolve(aliases, node.id);
      return [id, { ...node, id, parent: resolve(aliases, node.parent), ...(node.owner ? { wrapperAttrs: { ...node.wrapperAttrs, id } } : Object.hasOwn(node.attrs, 'id') ? { attrs: { ...node.attrs, id } } : {}) }] as const;
    }));
    return {
      ...frame, nodes,
      children: new Map([...frame.children].map(([id, ids]) => [resolve(aliases, id), ids.map((child) => resolve(aliases, child))])),
      owners: new Map([...frame.owners].map(([id, units]) => [resolve(aliases, id), units])),
    };
  });
}
