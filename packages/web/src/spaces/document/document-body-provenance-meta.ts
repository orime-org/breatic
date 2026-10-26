// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type { Node as PMNode } from '@tiptap/pm/model';
import type { Transaction } from '@tiptap/pm/state';

/** Transaction metadata carrying occurrence-specific source transfers. */
export const BODY_OPERATION_META = 'breatic.body.operations';

/** A name used exclusively by the isolated structural mirror. */
export const BODY_TRACE_MARK = '__breatic_body_origin';

/** Whether an inline name already has a shared source identity. */
export type BodyUnitOrigin = 'existing' | 'fresh';

/** One occurrence in a particular ProseMirror document. */
export interface BodyInlineOccurrence {
  readonly pos: number;
  readonly width: number;
  readonly value: string;
  readonly block: string | null;
}

/** An occurrence together with its existing source or batch-local name. */
export interface BodyInlineUnit extends BodyInlineOccurrence {
  readonly token: string;
  readonly origin: BodyUnitOrigin;
}

/** The document before a step, including the boundary after the final step. */
export interface BodyBoundary {
  readonly transaction: number;
  readonly step: number;
}

/** A contiguous inline range at a specified step boundary. */
export interface BodyTransferRange {
  readonly boundary: BodyBoundary;
  readonly from: number;
  readonly to: number;
  readonly block: string | null;
}

/** An explicit producer declaration that transfers existing occurrences. */
export interface BodyHandoff {
  readonly kind: 'move' | 'preserve';
  readonly token?: string;
  readonly source: BodyTransferRange;
  readonly target: BodyTransferRange;
}

/** One complete semantic command's source and destination declarations. */
export interface BodyTransferOperation {
  readonly id: string;
  readonly name: string;
  readonly source: BodyBoundary;
  readonly target: BodyBoundary;
  readonly handoffs: readonly BodyHandoff[];
  readonly created: readonly BodyInlineUnit[];
  readonly dropped?: readonly string[];
  readonly openStart?: number;
  readonly openEnd?: number;
}

/** The containing transaction's metadata coordinate system. */
export interface BodyOperationRebase {
  readonly stepOffset: number;
  readonly transaction: number;
}

/** A producer or journal violated the source-transfer contract. */
export class BodyProvenanceError extends Error {
  /**
   * Keeps a source failure distinct from a missing shared dependency.
   * @param message - The violated contract and its coordinates.
   * @throws {never}
   */
  constructor(message: string) {
    super(message);
    this.name = 'BodyProvenanceError';
  }
}

/**
 * Enforces a provenance invariant before a plan can mutate shared sources.
 * @param condition - The invariant being checked.
 * @param message - A diagnostic without document content.
 * @throws {BodyProvenanceError} If the invariant does not hold.
 */
export function assertBodyProvenance(condition: unknown, message: string): asserts condition {
  if (!condition) throw new BodyProvenanceError(message);
}

/**
 * Reads actual inline occurrences without assigning identities by content.
 * @param document - The immutable document at this stage.
 * @returns Its text units and inline leaves in document order.
 * @throws {RangeError} If ProseMirror cannot resolve a document position.
 */
export function bodyInlineOccurrences(document: PMNode): BodyInlineOccurrence[] {
  const result: BodyInlineOccurrence[] = [];
  document.descendants((node, pos) => {
    if (!node.isText && !(node.isInline && node.isLeaf)) return;
    const resolved = document.resolve(pos);
    let block: string | null = null;
    for (let depth = resolved.depth; depth > 0; depth -= 1) {
      const id: unknown = resolved.node(depth).attrs['id'];
      if (typeof id === 'string') {
        block = id;
        break;
      }
    }
    if (node.isText) {
      const text = node.text!;
      for (let index = 0; index < text.length; index += 1) {
        result.push({ pos: pos + index, width: 1, value: text.charAt(index), block });
      }
    } else {
      result.push({ pos, width: node.nodeSize, value: `<${node.type.name}>`, block });
    }
  });
  return result;
}

/**
 * Narrows unknown plugin metadata to a plain record.
 * @param value - The value supplied by a producer.
 * @returns Whether named fields can be inspected.
 * @throws {never}
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Validates a nonnegative step or transaction coordinate.
 * @param value - The producer coordinate.
 * @param field - The diagnostic coordinate name.
 * @returns The validated integer.
 * @throws {BodyProvenanceError} If the coordinate is invalid.
 */
function coordinate(value: unknown, field: string): number {
  assertBodyProvenance(typeof value === 'number' && Number.isSafeInteger(value) && value >= 0, `Invalid ${field}`);
  return value;
}

/**
 * Copies a validated boundary out of mutable plugin metadata.
 * @param value - The producer boundary.
 * @returns Its immutable coordinate pair.
 * @throws {BodyProvenanceError} If the boundary is malformed.
 */
function boundary(value: unknown): BodyBoundary {
  assertBodyProvenance(isRecord(value), 'Invalid operation boundary');
  return Object.freeze({ transaction: coordinate(value['transaction'], 'transaction'), step: coordinate(value['step'], 'step') });
}

/**
 * Copies a validated inline range.
 * @param value - The producer range.
 * @returns Its immutable coordinates and block identity.
 * @throws {BodyProvenanceError} If the range is malformed.
 */
function range(value: unknown): BodyTransferRange {
  assertBodyProvenance(isRecord(value), 'Invalid source or target range');
  const from = coordinate(value['from'], 'range start');
  const to = coordinate(value['to'], 'range end');
  const block = value['block'];
  assertBodyProvenance(to >= from && (block === null || typeof block === 'string'), 'Invalid source or target range');
  return Object.freeze({ boundary: boundary(value['boundary']), from, to, block });
}

/**
 * Copies a validated newly allocated occurrence.
 * @param value - The producer's new occurrence.
 * @returns Its immutable fresh label.
 * @throws {BodyProvenanceError} If the occurrence is malformed.
 */
function createdUnit(value: unknown): BodyInlineUnit {
  assertBodyProvenance(isRecord(value), 'Invalid created source unit');
  const token = value['token'];
  const origin = value['origin'];
  const content = value['value'];
  const block = value['block'];
  const width = coordinate(value['width'], 'unit width');
  assertBodyProvenance(typeof token === 'string' && token.length > 0 && origin === 'fresh', 'Invalid fresh source identity');
  assertBodyProvenance(typeof content === 'string' && width > 0 && (block === null || typeof block === 'string'), 'Invalid created source unit');
  return Object.freeze({ token, origin, value: content, pos: coordinate(value['pos'], 'unit position'), width, block });
}

/**
 * Copies the whole operation into immutable metadata.
 * @param value - The producer's semantic operation.
 * @returns Its validated immutable description.
 * @throws {BodyProvenanceError} If any source declaration is malformed.
 */
function operation(value: unknown): BodyTransferOperation {
  assertBodyProvenance(isRecord(value), 'Invalid body operation');
  const id = value['id'];
  const name = value['name'];
  const handoffs = value['handoffs'];
  const created = value['created'];
  assertBodyProvenance(typeof id === 'string' && id.length > 0 && typeof name === 'string', 'Invalid body operation identity');
  assertBodyProvenance(Array.isArray(handoffs) && Array.isArray(created), 'Invalid body operation effects');
  const result: BodyTransferOperation = {
    id, name, source: boundary(value['source']), target: boundary(value['target']),
    handoffs: Object.freeze(handoffs.map((item: unknown): BodyHandoff => {
      assertBodyProvenance(isRecord(item), 'Invalid source handoff');
      const kind = item['kind'];
      const token = item['token'];
      assertBodyProvenance(kind === 'move' || kind === 'preserve', 'Invalid source handoff kind');
      assertBodyProvenance(token === undefined || typeof token === 'string', 'Invalid source handoff identity');
      return Object.freeze({ kind, ...(token === undefined ? {} : { token }), source: range(item['source']), target: range(item['target']) });
    })),
    created: Object.freeze(created.map(createdUnit)),
  };
  const dropped = value['dropped'];
  const openStart = value['openStart'];
  const openEnd = value['openEnd'];
  assertBodyProvenance(dropped === undefined || (Array.isArray(dropped) && dropped.every((item) => typeof item === 'string')), 'Invalid dropped source identities');
  return Object.freeze({
    ...result,
    ...(dropped === undefined ? {} : { dropped: Object.freeze([...dropped]) }),
    ...(openStart === undefined ? {} : { openStart: coordinate(openStart, 'open start') }),
    ...(openEnd === undefined ? {} : { openEnd: coordinate(openEnd, 'open end') }),
  });
}

/**
 * Reads validated producer metadata from a real transaction.
 * @param transaction - The transaction carrying producer declarations.
 * @returns Its complete semantic operations.
 * @throws {BodyProvenanceError} If metadata is malformed or repeats an operation ID.
 */
export function bodyOperations(transaction: Transaction): readonly BodyTransferOperation[] {
  const raw: unknown = transaction.getMeta(BODY_OPERATION_META);
  if (raw === undefined) return [];
  assertBodyProvenance(Array.isArray(raw), 'Invalid body operation metadata');
  const operations = raw.map(operation);
  assertBodyProvenance(new Set(operations.map((item) => item.id)).size === operations.length, 'Duplicate body operation identity');
  return Object.freeze(operations);
}

/**
 * Records one complete semantic operation at its actual step coordinates.
 * @param transaction - The real producer transaction.
 * @param value - The complete operation and its handoffs.
 * @returns The same transaction with immutable source metadata.
 * @throws {BodyProvenanceError} If the operation is malformed or repeats an ID.
 */
export function recordBodyOperation(transaction: Transaction, value: BodyTransferOperation): Transaction {
  const previous = bodyOperations(transaction);
  const next = operation(value);
  assertBodyProvenance(!previous.some((item) => item.id === next.id), 'Duplicate body operation identity');
  return transaction.setMeta(BODY_OPERATION_META, Object.freeze([...previous, next]));
}

/**
 * Re-expresses one command in its containing transaction's coordinates.
 * @param value - The command's immutable local metadata.
 * @param rebase - Its actual step offset and transaction ordinal.
 * @returns The same ranges at the new step boundaries.
 * @throws {BodyProvenanceError} If the new coordinates are invalid.
 */
export function rebaseBodyOperation(value: BodyTransferOperation, rebase: BodyOperationRebase): BodyTransferOperation {
  coordinate(rebase.stepOffset, 'step offset');
  coordinate(rebase.transaction, 'transaction');
  const source = { transaction: rebase.transaction, step: value.source.step + rebase.stepOffset };
  const target = { transaction: rebase.transaction, step: value.target.step + rebase.stepOffset };
  return operation({ ...value, source, target, handoffs: value.handoffs.map((handoff) => ({
    ...handoff,
    source: { ...handoff.source, boundary: { transaction: rebase.transaction, step: handoff.source.boundary.step + rebase.stepOffset } },
    target: { ...handoff.target, boundary: { transaction: rebase.transaction, step: handoff.target.boundary.step + rebase.stepOffset } },
  })) });
}

/**
 * Copies a child command's source metadata after its steps have been adopted.
 * @param from - The third-party child transaction.
 * @param to - The containing transaction that received those exact steps.
 * @param rebase - The containing transaction's actual coordinates.
 * @returns The containing transaction with all child operations preserved.
 * @throws {BodyProvenanceError} If metadata is malformed or conflicts.
 */
export function transferBodyOperations(from: Transaction, to: Transaction, rebase: BodyOperationRebase): Transaction {
  for (const value of bodyOperations(from)) recordBodyOperation(to, rebaseBodyOperation(value, rebase));
  return to;
}
