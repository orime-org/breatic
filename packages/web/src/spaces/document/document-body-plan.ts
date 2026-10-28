// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as Y from 'yjs';
import {
  assertBodySourceBoundary,
  BODY_MARK_ATTRIBUTE_PREFIX,
  BODY_REGISTRATION_ORIGIN,
  documentBodyRecords,
  documentBodySource,
  readBodyTree,
  registerBodyCut,
  registerDocumentBodyRecords,
  type BodyTreeUnit,
  type BodyTreeView,
} from '@breatic/shared';

import type {
  BodyBatchEnvironment,
  BodyBatchPlan,
  BodyBatchResult,
  BodyNativeWrite,
  BodyPlanProjection,
} from '@web/spaces/document/document-body-plan-types';

/** An isolated rehearsal grants this handle one synchronous commit attempt. */
export interface PreparedBodyBatch {
  readonly id: string;
  readonly revision: number;
}

/** Private evidence cannot be supplied by a compiler or another handle. */
interface PreparedEvidence {
  readonly environment: BodyBatchEnvironment;
  readonly plan: BodyBatchPlan;
  readonly before: BodyPlanProjection;
  readonly incarnation: symbol;
}

/** One scalar-safe physical range containing observed native units only. */
interface NativeRange {
  readonly source: string;
  readonly from: number;
  readonly to: number;
}

const preparedBatches = new WeakMap<PreparedBodyBatch, PreparedEvidence>();

/** A plan violated source identity, isolation or synchronous commit admission. */
export class BodyBatchError extends Error {
  /**
   * Records the failed contract without including user content.
   * @param message - The specific failed invariant.
   * @throws {never}
   */
  constructor(message: string) {
    super(message);
    this.name = 'BodyBatchError';
  }
}

/**
 * Checks a batch invariant before progressing to another write phase.
 * @param condition - The required invariant.
 * @param message - A content-free diagnostic.
 * @throws {BodyBatchError} If the invariant does not hold.
 */
function requireBatch(condition: unknown, message: string): asserts condition {
  if (!condition) throw new BodyBatchError(message);
}

/**
 * Reads complete source facts for native-ID based mutation.
 * @param doc - The current actual or isolated source.
 * @returns Its complete shared tree frame.
 * @throws {BodyBatchError} If dependencies are incomplete.
 * @throws {Error} If shared records are malformed.
 */
function sourceView(doc: Y.Doc): BodyTreeView {
  const read = readBodyTree(doc);
  requireBatch(read.status === 'ready', 'Batch source dependencies are incomplete');
  return read.view;
}

/**
 * Copies all mutable plan input while keeping immutable PM documents intact.
 * @param plan - Compiler output owned by the collecting batch.
 * @returns A private copy used by both rehearsal and actual writes.
 * @throws {Error} If the explicit serializable mutation plan cannot be cloned.
 */
function copyPlan(plan: BodyBatchPlan): BodyBatchPlan {
  return {
    id: plan.id,
    registration: structuredClone(plan.registration),
    cuts: plan.cuts.map((cut) => ({ ...cut, at: Y.decodeRelativePosition(Y.encodeRelativePosition(cut.at)) })),
    native: structuredClone(plan.native),
    fresh: structuredClone(plan.fresh),
    enable: [...plan.enable],
    expected: { doc: plan.expected.doc, units: plan.expected.units.map((unit) => ({ ...unit })) },
  };
}

/**
 * Compares full PM content and each inline occurrence against accepted names.
 * @param actual - The actual codec output after one explicit phase.
 * @param expected - The accepted frame for that phase.
 * @param aliases - Fresh labels finalized by this phase's actual native insertions.
 * @throws {BodyBatchError} If content, formatting or occurrence identities differ.
 */
function verifyProjection(actual: BodyPlanProjection, expected: BodyPlanProjection, aliases: ReadonlyMap<string, string> = new Map()): void {
  requireBatch(actual.doc.eq(expected.doc), 'Batch projection differs from the accepted document');
  requireBatch(actual.units.length === expected.units.length, 'Batch occurrence count differs');
  const identities = new Set<string>();
  for (const [index, unit] of actual.units.entries()) {
    const wanted = expected.units[index];
    requireBatch(unit.token === (aliases.get(wanted.token) ?? wanted.token), 'Batch native occurrence identity differs');
    requireBatch(unit.pos === wanted.pos && unit.width === wanted.width && unit.value === wanted.value && unit.block === wanted.block, 'Batch occurrence position or value differs');
    requireBatch(!identities.has(unit.token), 'Batch duplicates a native occurrence');
    identities.add(unit.token);
  }
}

/**
 * Validates new-source and user-enable identities before the isolated rehearsal.
 * @param doc - The baseline source prior to registration.
 * @param plan - The copied explicit plan.
 * @throws {BodyBatchError} If a fresh identity is reused or an enable is outside this batch.
 */
function validateNewIdentities(doc: Y.Doc, plan: BodyBatchPlan): void {
  const roots = documentBodyRecords(doc);
  const sources = new Set<string>();
  const tokens = new Set<string>();
  const newSources = new Set((plan.registration.sources ?? []).map((source) => source.id));
  const newGroups = new Set((plan.registration.groups ?? []).map((group) => group.id));
  requireBatch(plan.id.length > 0, 'Batch identity is empty');
  requireBatch(new Set(plan.enable).size === plan.enable.length, 'Batch enables a group twice');
  for (const group of plan.enable) {
    requireBatch(newGroups.has(group) && !roots.groups.has(group), 'Batch enables a group outside its new registration');
  }
  for (const run of plan.fresh) {
    requireBatch(newSources.has(run.source) && !roots.sources.has(run.source) && !sources.has(run.source), 'Fresh run requires its own new source');
    requireBatch(run.units.length > 0, 'Fresh run cannot be empty');
    sources.add(run.source);
    for (const unit of run.units) {
      requireBatch(!tokens.has(unit.token) && unit.token.length > 0, 'Fresh occurrence identity is reused');
      requireBatch(typeof unit.value !== 'string' || unit.value.length === 1, 'Fresh string units must use UTF-16 names');
      tokens.add(unit.token);
    }
  }
  const wanted = plan.expected.units.filter((unit) => unit.origin === 'fresh').map((unit) => unit.token);
  requireBatch(wanted.length === tokens.size && wanted.every((token) => tokens.has(token)), 'Fresh runs differ from accepted fresh occurrences');
}

/**
 * Registers all descriptors and permanent cuts in one source transaction.
 * @param doc - The actual or isolated source.
 * @param plan - The complete explicit mutation plan.
 * @param origin - This phase's unique registration token.
 * @throws {Error} If registration, native anchors or observers fail.
 */
function applyRegistration(doc: Y.Doc, plan: BodyBatchPlan, origin: object): void {
  doc.transact(() => {
    registerDocumentBodyRecords(doc, plan.registration);
    for (const cut of plan.cuts) {
      const absolute = Y.createAbsolutePositionFromRelativePosition(cut.at, doc);
      const text = documentBodySource(doc, cut.source);
      requireBatch(absolute !== null && absolute.type === text, 'Permanent cut has an unresolved source anchor');
      registerBodyCut(doc, cut.source, cut.cut, absolute.index);
    }
  }, origin);
}

/**
 * Resolves exact current native identities into descending scalar-safe ranges.
 * @param doc - The source after complete registration.
 * @param ids - Observed native IDs from the accepted journal.
 * @returns Disjoint physical ranges that never contain a permanent cut.
 * @throws {BodyBatchError} If an identity is absent or repeated.
 * @throws {Error} If a range splits a Unicode scalar or source records are malformed.
 */
function nativeRanges(doc: Y.Doc, ids: readonly string[]): readonly NativeRange[] {
  const view = sourceView(doc);
  const byIdentity = new Map(view.units.map((unit) => [unit.id, unit]));
  requireBatch(new Set(ids).size === ids.length, 'Native mutation repeats an observed identity');
  const units = ids.map((id) => {
    const unit = byIdentity.get(id);
    requireBatch(unit !== undefined, 'Observed native identity is no longer live');
    return unit;
  }).sort((a, b) => a.source.localeCompare(b.source) || a.index - b.index);
  const ranges: { source: string; from: number; to: number }[] = [];
  for (const unit of units) {
    const prior = ranges.at(-1);
    if (prior !== undefined && prior.source === unit.source && prior.to === unit.index) prior.to += 1;
    else ranges.push({ source: unit.source, from: unit.index, to: unit.index + 1 });
  }
  for (const range of ranges) {
    const text = documentBodySource(doc, range.source);
    assertBodySourceBoundary(text, range.from);
    assertBodySourceBoundary(text, range.to);
  }
  return ranges.reverse();
}

/**
 * Applies one observed deletion or independent semantic mark change.
 * @param doc - The actual or isolated source in its USER transaction.
 * @param write - Explicit current native identities and semantic mark values.
 * @throws {Error} If current source identities or scalar endpoints are invalid.
 */
function applyNativeWrite(doc: Y.Doc, write: BodyNativeWrite): void {
  if (write.kind === 'format') {
    requireBatch(Object.keys(write.attributes).every((key) => key.startsWith(BODY_MARK_ATTRIBUTE_PREFIX)), 'Native formatting may only change semantic mark keys');
  }
  for (const range of nativeRanges(doc, write.ids)) {
    const text = documentBodySource(doc, range.source);
    if (write.kind === 'delete') text.delete(range.from, range.to - range.from);
    else text.format(range.from, range.to - range.from, write.attributes);
  }
}

/**
 * Writes final fresh runs and all user-visible facts in exactly one transaction.
 * @param doc - The actual or isolated source after registration.
 * @param plan - The complete explicit mutation plan.
 * @param origin - The handle's unique user origin.
 * @throws {Error} If source identities, fresh destinations or observers fail.
 */
function applyUser(doc: Y.Doc, plan: BodyBatchPlan, origin: object): void {
  doc.transact(() => {
    for (const write of plan.native) applyNativeWrite(doc, write);
    for (const run of plan.fresh) {
      const text = documentBodySource(doc, run.source);
      requireBatch(text.length === 2, 'Fresh destination source is no longer empty');
      let offset = 1;
      for (let index = 0; index < run.units.length;) {
        const unit = run.units[index];
        if (typeof unit.value !== 'string') {
          requireBatch(typeof unit.value === 'object' && unit.value !== null && !Array.isArray(unit.value) && 'bodyInline' in unit.value, 'Fresh embed must use the product inline encoding');
          text.insertEmbed(offset++, unit.value, unit.attributes);
          index += 1;
          continue;
        }
        let value = unit.value;
        index += 1;
        const attributes = JSON.stringify(unit.attributes);
        while (index < run.units.length && typeof run.units[index].value === 'string' && JSON.stringify(run.units[index].attributes) === attributes) {
          value += run.units[index++].value;
        }
        requireBatch(value.isWellFormed(), 'Fresh formatting divides a Unicode surrogate pair');
        text.insert(offset, value, unit.attributes);
        offset += value.length;
      }
    }
    const { enabled } = documentBodyRecords(doc);
    for (const group of plan.enable) enabled.set(group, true);
  }, origin);
}

/**
 * Maps final fresh labels onto identities allocated by this source's USER write.
 * @param doc - The actual or isolated source after USER.
 * @param plan - The compiler's final source runs.
 * @returns One finalized native identity for every surviving fresh label.
 * @throws {BodyBatchError} If a fresh run has a different native unit count.
 */
function freshAliases(doc: Y.Doc, plan: BodyBatchPlan): ReadonlyMap<string, string> {
  const units = new Map<string, BodyTreeUnit[]>();
  for (const unit of sourceView(doc).units) {
    const run = units.get(unit.source) ?? [];
    run.push(unit);
    units.set(unit.source, run);
  }
  const aliases = new Map<string, string>();
  for (const run of plan.fresh) {
    const actual = (units.get(run.source) ?? []).sort((a, b) => a.index - b.index);
    requireBatch(actual.length === run.units.length, 'Fresh native count differs from the accepted run');
    for (const [index, unit] of run.units.entries()) aliases.set(unit.token, actual[index].id);
  }
  return aliases;
}

/**
 * Checks the current handle, role and runtime at a final mutation boundary.
 * @param environment - The handle used by the operation owner.
 * @param incarnation - Its original in-memory identity.
 * @throws {BodyBatchError} If current write admission is unavailable.
 */
function assertAdmission(environment: BodyBatchEnvironment, incarnation: symbol): void {
  requireBatch(environment.canWrite() && environment.runtime.canWrite(true, incarnation), 'Batch write admission is unavailable');
}

/**
 * Rehearses a complete explicit plan against an isolated current Yjs snapshot.
 * @param environment - The current handle and legal codec projection.
 * @param input - Compiler output for the full accepted root and append loop.
 * @returns A private, single-attempt proof tied to this source revision.
 * @throws {Error} If registration has an effect, USER differs or admission changes.
 */
export function prepareBodyBatch(environment: BodyBatchEnvironment, input: BodyBatchPlan): PreparedBodyBatch {
  const incarnation = environment.runtime.incarnation;
  assertAdmission(environment, incarnation);
  const revision = environment.runtime.revision();
  const plan = copyPlan(input);
  const before = environment.project(environment.doc);
  validateNewIdentities(environment.doc, plan);
  const rehearsal = new Y.Doc({ gc: false });
  try {
    Y.applyUpdate(rehearsal, Y.encodeStateAsUpdate(environment.doc));
    applyRegistration(rehearsal, plan, {});
    verifyProjection(environment.project(rehearsal), before);
    applyUser(rehearsal, plan, {});
    verifyProjection(environment.project(rehearsal), plan.expected, freshAliases(rehearsal, plan));
  } finally {
    rehearsal.destroy();
  }
  assertAdmission(environment, incarnation);
  requireBatch(environment.runtime.revision() === revision, 'Batch source revision changed during preflight');
  const prepared = Object.freeze({ id: plan.id, revision });
  preparedBatches.set(prepared, { environment, plan, before, incarnation });
  return prepared;
}

/**
 * Commits only a rehearsed plan, with all REG writes preceding one USER write.
 * @param environment - The same handle that prepared the plan.
 * @param prepared - The single-attempt proof returned by isolated preflight.
 * @returns The actual final projection and freshly allocated native aliases.
 * @throws {Error} If revision, admission, registration, USER or publication fails.
 */
export function commitPreparedBodyBatch(environment: BodyBatchEnvironment, prepared: PreparedBodyBatch): BodyBatchResult {
  const evidence = preparedBatches.get(prepared);
  requireBatch(evidence !== undefined && evidence.environment === environment, 'Batch proof belongs to a different handle or was already consumed');
  assertAdmission(environment, evidence.incarnation);
  requireBatch(environment.runtime.revision() === prepared.revision, 'Batch source revision changed after preflight');
  preparedBatches.delete(prepared);
  environment.onCommitPhase?.('registering');
  assertAdmission(environment, evidence.incarnation);
  requireBatch(environment.runtime.revision() === prepared.revision, 'Batch source revision changed before registration');
  const registrationOrigin = Object.freeze({ registration: BODY_REGISTRATION_ORIGIN, batch: prepared });
  let ownUpdates = 0;
  let externalUpdate = false;
  /**
   * Separates this registration's delta from reentrant source updates.
   * @param _update - The actual native delta.
   * @param origin - The transaction origin that produced it.
   * @throws {never}
   */
  function trackRegistration(_update: Uint8Array, origin: unknown): void {
    if (origin === registrationOrigin) ownUpdates += 1;
    else externalUpdate = true;
  }
  environment.doc.on('update', trackRegistration);
  try {
    applyRegistration(environment.doc, evidence.plan, registrationOrigin);
  } finally {
    environment.doc.off('update', trackRegistration);
  }
  requireBatch(!externalUpdate && environment.runtime.revision() === prepared.revision + ownUpdates, 'Batch source revision changed during registration');
  verifyProjection(environment.project(environment.doc), evidence.before);
  environment.onCommitPhase?.('committing');
  assertAdmission(environment, evidence.incarnation);
  requireBatch(environment.runtime.revision() === prepared.revision + ownUpdates, 'Batch source revision changed before USER');
  if (environment.writeState !== undefined) environment.writeState.started = true;
  applyUser(environment.doc, evidence.plan, environment.userOrigin);
  if (environment.writeState !== undefined) environment.writeState.returned = true;
  environment.onCommitPhase?.('written');
  environment.onCommitPhase?.('projecting');
  const aliases = freshAliases(environment.doc, evidence.plan);
  const projection = environment.project(environment.doc);
  verifyProjection(projection, evidence.plan.expected, aliases);
  return { projection, aliases };
}
