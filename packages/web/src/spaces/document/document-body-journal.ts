// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type { Node as PMNode } from '@tiptap/pm/model';
import type { Transaction } from '@tiptap/pm/state';

import {
  assertBodyProvenance,
  bodyInlineOccurrences,
  bodyOperations,
  rebaseBodyOperation,
  type BodyInlineUnit,
  type BodyTransferOperation,
  type BodyTransferRange,
} from '@web/spaces/document/document-body-provenance-meta';

/** The unique naming scope of one accepted root and its append loop. */
export interface BodyJournalOptions {
  readonly batchId: string;
}

/** Inline names in the actual document before or after one accepted step. */
export interface BodyJournalStage {
  readonly step: number;
  readonly document: PMNode;
  readonly units: readonly BodyInlineUnit[];
}

/** All step boundaries of one accepted transaction. */
export interface BodyJournalTransaction {
  readonly ordinal: number;
  readonly transaction: Transaction;
  readonly stages: readonly BodyJournalStage[];
}

/** A published, immutable journal view for one accepted state. */
export interface BodyJournalSnapshot {
  readonly before: PMNode;
  readonly doc: PMNode;
  readonly units: readonly BodyInlineUnit[];
  readonly transactions: readonly BodyJournalTransaction[];
  readonly operations: readonly BodyTransferOperation[];
  readonly deleted: readonly BodyInlineUnit[];
}

/**
 * Copies occurrence names into a stage-owned immutable array.
 * @param units - The names at that stage.
 * @returns A snapshot ordered by actual document position.
 * @throws {never}
 */
function freezeUnits(units: readonly BodyInlineUnit[]): readonly BodyInlineUnit[] {
  return Object.freeze(units.map((unit) => Object.freeze({ ...unit })).sort((a, b) => a.pos - b.pos));
}

/**
 * Checks the complete occurrence index against an actual immutable document.
 * @param document - The document represented by the names.
 * @param units - The complete occurrence index.
 * @throws {BodyProvenanceError} If any identity, range or value is inconsistent.
 */
function validateUnits(document: PMNode, units: readonly BodyInlineUnit[]): void {
  const actual = bodyInlineOccurrences(document);
  assertBodyProvenance(actual.length === units.length, 'Source index does not cover the document');
  assertBodyProvenance(new Set(units.map((unit) => unit.token)).size === units.length, 'Duplicate source identity');
  for (let index = 0; index < actual.length; index += 1) {
    const occurrence = actual[index];
    const unit = units[index];
    assertBodyProvenance(typeof unit.token === 'string' && unit.token.length > 0, 'Invalid source identity');
    assertBodyProvenance(unit.origin === 'existing' || unit.origin === 'fresh', 'Invalid source origin');
    assertBodyProvenance(unit.pos === occurrence.pos && unit.width === occurrence.width && unit.value === occurrence.value && unit.block === occurrence.block, 'Source index differs from the document');
  }
}

/**
 * Captures one declared inline range without reading names from its content.
 * @param units - The actual names at the declared boundary.
 * @param range - The producer's source or target range.
 * @returns Every complete occurrence in that contiguous inline range.
 * @throws {BodyProvenanceError} If the range cuts a unit or includes structural gaps.
 */
function captureRange(units: readonly BodyInlineUnit[], range: BodyTransferRange): readonly BodyInlineUnit[] {
  const selected = units.filter((unit) => unit.pos >= range.from && unit.pos < range.to);
  let position = range.from;
  for (const unit of selected) {
    assertBodyProvenance(unit.pos === position && unit.pos + unit.width <= range.to, 'Invalid source range boundary');
    assertBodyProvenance(range.block === unit.block, 'Source range block differs from the actual occurrence');
    position += unit.width;
  }
  assertBodyProvenance(position === range.to, 'Source range does not cover complete inline occurrences');
  return selected;
}

/**
 * Compares a handoff boundary with its enclosing semantic operation.
 * @param range - The declared range.
 * @param transaction - The actual accepted transaction ordinal.
 * @param step - The actual operation boundary.
 * @throws {BodyProvenanceError} If coordinate spaces were mixed.
 */
function validateBoundary(range: BodyTransferRange, transaction: number, step: number): void {
  assertBodyProvenance(range.boundary.transaction === transaction && range.boundary.step === step, 'Source handoff boundary differs from its operation');
}

/**
 * Names a stage after all source transfers at that boundary have been applied.
 * @param step - The index of the next step, or the final boundary.
 * @param document - The actual document at this boundary.
 * @param units - Its complete source index.
 * @returns An immutable stage.
 * @throws {BodyProvenanceError} If its index is inconsistent.
 */
function stageSnapshot(step: number, document: PMNode, units: readonly BodyInlineUnit[]): BodyJournalStage {
  const snapshot = freezeUnits(units);
  validateUnits(document, snapshot);
  return Object.freeze({ step, document, units: snapshot });
}

/** Collects complete accepted steps while keeping prior state snapshots intact. */
export class BodyJournal {
  private snapshot: BodyJournalSnapshot;
  private readonly initial: readonly BodyInlineUnit[];
  private readonly batchId: string;
  private usedTokens: Set<string>;
  private sequence = 0;

  /**
   * Starts a journal from the source names of the current bound document.
   * @param before - The actual document before the accepted root.
   * @param initial - One identity for every inline occurrence.
   * @param options - This batch's unique naming scope.
   * @throws {BodyProvenanceError} If the initial index is incomplete.
   */
  constructor(before: PMNode, initial: readonly BodyInlineUnit[], options: BodyJournalOptions) {
    assertBodyProvenance(options.batchId.length > 0, 'A body batch needs a naming scope');
    this.batchId = options.batchId;
    this.initial = freezeUnits(initial);
    validateUnits(before, this.initial);
    this.usedTokens = new Set(this.initial.map((unit) => unit.token));
    this.snapshot = Object.freeze({ before, doc: before, units: this.initial, transactions: Object.freeze([]), operations: Object.freeze([]), deleted: Object.freeze([]) });
  }

  /**
   * Reads the source index belonging to the last fully accepted state.
   * @returns The same immutable object until another transaction is accepted.
   * @throws {never}
   */
  read(): BodyJournalSnapshot {
    return this.snapshot;
  }

  /**
   * Replays one accepted transaction and commits its journal snapshot atomically.
   * @param transaction - The actual root or accepted appended transaction.
   * @returns The complete batch snapshot through this transaction.
   * @throws {BodyProvenanceError} If the before document or source metadata is inconsistent.
   */
  accept(transaction: Transaction): BodyJournalSnapshot {
    const previous = this.snapshot;
    assertBodyProvenance(transaction.before.eq(previous.doc), 'Transaction before document differs from the accepted journal');
    const ordinal = previous.transactions.length;
    const operations = bodyOperations(transaction).map((operation) => {
      assertBodyProvenance((operation.source.transaction === 0 || operation.source.transaction === ordinal) && operation.target.transaction === operation.source.transaction, 'Invalid source transaction ordinal');
      assertBodyProvenance(operation.handoffs.every((handoff) => handoff.source.boundary.transaction === operation.source.transaction && handoff.target.boundary.transaction === operation.target.transaction), 'Mixed source transaction ordinals');
      return rebaseBodyOperation(operation, { transaction: ordinal, stepOffset: 0 });
    });
    const known = new Set(this.usedTokens);
    const reservedFresh = operations.flatMap((operation) => operation.created.map((unit) => unit.token));
    assertBodyProvenance(new Set(reservedFresh).size === reservedFresh.length && reservedFresh.every((token) => !known.has(token)), 'Duplicate created source identity');
    reservedFresh.forEach((token) => known.add(token));
    let sequence = this.sequence;
    let currentStep = 0;
    let units = [...previous.units];
    const stages: BodyJournalStage[] = [stageSnapshot(0, transaction.before, units)];
    const prefix = `${this.batchId}:fresh:`;

    /**
     * Allocates only batch-local names for genuinely unclaimed occurrences.
     * @returns A fresh occurrence identity unique to this batch.
     * @throws {never}
     */
    function freshToken(): string {
      let token: string;
      do {
        token = `${prefix}${sequence++}`;
      } while (known.has(token));
      known.add(token);
      return token;
    }

    /**
     * Advances real StepMaps, preserving their surviving gaps and naming new positions.
     * @param end - The next step boundary to materialize.
     * @throws {BodyProvenanceError} If a stage is invalid.
     */
    function advance(end: number): void {
      assertBodyProvenance(end >= currentStep && end <= transaction.steps.length, 'Invalid source boundary order');
      for (; currentStep < end; currentStep += 1) {
        const map = transaction.mapping.maps[currentStep];
        const nextDocument = transaction.docs[currentStep + 1] ?? transaction.doc;
        const carried = new Map<number, BodyInlineUnit>();
        for (const unit of units) {
          const left = map.mapResult(unit.pos, 1);
          const right = map.mapResult(unit.pos + unit.width, -1);
          if (left.deleted || right.deleted || right.pos - left.pos !== unit.width) continue;
          assertBodyProvenance(!carried.has(left.pos), 'Overlapping mapped source identities');
          carried.set(left.pos, { ...unit, pos: left.pos });
        }
        units = bodyInlineOccurrences(nextDocument).map((occurrence) => {
          const source = carried.get(occurrence.pos);
          if (source !== undefined) {
            assertBodyProvenance(source.width === occurrence.width && source.value === occurrence.value, 'Surviving source unit changed content');
            return { ...source, ...occurrence };
          }
          const token = freshToken();
          return { ...occurrence, token, origin: 'fresh' as const };
        });
        stages.push(stageSnapshot(currentStep + 1, nextDocument, units));
      }
    }

    for (const operation of operations) {
      const sourceStep = operation.source.step;
      const targetStep = operation.target.step;
      assertBodyProvenance(targetStep >= sourceStep, 'Source target precedes its operation');
      advance(sourceStep);
      const moving: { readonly source: BodyInlineUnit; readonly pos: number; readonly block: string | null }[] = [];
      const selected = new Set<string>();
      for (const handoff of operation.handoffs) {
        validateBoundary(handoff.source, ordinal, sourceStep);
        validateBoundary(handoff.target, ordinal, targetStep);
        const captured = captureRange(units, handoff.source);
        assertBodyProvenance(handoff.source.to - handoff.source.from === handoff.target.to - handoff.target.from, 'Invalid source or target width');
        if (handoff.token !== undefined) assertBodyProvenance(captured.length === 1 && captured[0].token === handoff.token, 'Invalid source identity for the declared range');
        for (const unit of captured) {
          assertBodyProvenance(!selected.has(unit.token), 'Repeated source in one semantic operation');
          selected.add(unit.token);
          moving.push({ source: unit, pos: handoff.target.from + unit.pos - handoff.source.from, block: handoff.target.block });
        }
      }
      advance(targetStep);
      const actualTargets = new Map(units.map((unit) => [unit.pos, unit]));
      const replacements = new Map<number, BodyInlineUnit>();
      for (const item of moving) {
        const target = actualTargets.get(item.pos);
        assertBodyProvenance(target !== undefined && target.width === item.source.width && target.value === item.source.value && target.block === item.block, 'Source handoff target differs from the actual document');
        assertBodyProvenance(!replacements.has(item.pos), 'Overlapping target identities');
        replacements.set(item.pos, { ...item.source, pos: item.pos, block: item.block });
      }
      for (const created of operation.created) {
        const target = actualTargets.get(created.pos);
        assertBodyProvenance(target !== undefined && target.width === created.width && target.value === created.value && target.block === created.block, 'Created source target differs from the actual document');
        assertBodyProvenance(!replacements.has(created.pos), 'Overlapping created source identity');
        replacements.set(created.pos, created);
      }
      units = units.flatMap((unit) => {
        const replacement = replacements.get(unit.pos);
        if (replacement !== undefined) return [replacement];
        return selected.has(unit.token) ? [] : [unit];
      });
      const document = transaction.docs[targetStep] ?? transaction.doc;
      stages[targetStep] = stageSnapshot(targetStep, document, units);
    }
    advance(transaction.steps.length);
    const final = freezeUnits(units);
    validateUnits(transaction.doc, final);
    const alive = new Set(final.map((unit) => unit.token));
    const entry = Object.freeze({ ordinal, transaction, stages: Object.freeze(stages) });
    const snapshot = Object.freeze({
      before: previous.before,
      doc: transaction.doc,
      units: final,
      transactions: Object.freeze([...previous.transactions, entry]),
      operations: Object.freeze([...previous.operations, ...operations]),
      deleted: Object.freeze(this.initial.filter((unit) => !alive.has(unit.token))),
    });
    this.snapshot = snapshot;
    this.usedTokens = known;
    this.sequence = sequence;
    return snapshot;
  }
}

/**
 * Reconstructs a complete accepted root and append batch from real steps.
 * @param before - The bound document before the root.
 * @param initial - The source index of that document.
 * @param accepted - Only transactions accepted by ProseMirror.
 * @param options - The batch-local naming scope.
 * @returns The same snapshot produced by incremental journal acceptance.
 * @throws {BodyProvenanceError} If a source declaration violates the contract.
 */
export function replayBodyJournal(
  before: PMNode,
  initial: readonly BodyInlineUnit[],
  accepted: readonly Transaction[],
  options: BodyJournalOptions,
): BodyJournalSnapshot {
  const journal = new BodyJournal(before, initial, options);
  for (const transaction of accepted) journal.accept(transaction);
  return journal.read();
}
