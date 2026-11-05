// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

export type ModelImportErrorCode = 'missing' | 'entry' | 'unsupported' | 'empty' | 'budget' | 'invalid' | 'duplicate';
export interface ModelInspectionInfo {
  /** The main file the failed check read, once the selection had one. */
  entry?: string;
  entries: readonly string[];
  paths: readonly string[];
  missing: readonly string[];
}
/** The configured import limit a selection exceeded. */
export type ModelImportLimit = 'input' | 'files' | 'expanded' | 'entryJson' | 'artifact' | 'textureEdge' | 'textureBytes';
/** Which limit was exceeded, its configured value and what the selection measured. */
export interface ModelImportBudget {
  limit: ModelImportLimit;
  allowed: number;
  actual: number;
}
/** What the user is shown beside a failure: where it is, the selection it belongs to and any exceeded limit. */
export interface ModelImportFacts {
  /** The resource path, archive entry or `images[N]` that failed; empty when the failure concerns the whole selection. */
  detail: string;
  info?: ModelInspectionInfo;
  budget?: ModelImportBudget;
}

/** Carry localized display facts separately from an internal diagnostic. */
export class ModelImportError extends Error {
  readonly detail: string;
  readonly info?: ModelInspectionInfo;
  readonly budget?: ModelImportBudget;

  /**
   * Describe a local inspection or upload failure without embedding UI copy.
   * Every failure states its location, and every budget failure states the limit it exceeded.
   * @param code - Locale-key suffix for the failed operation.
   * @param message - Internal diagnostic used by logs and tests.
   * @param facts - Where the failure is, the selection's paths and entries, and the exceeded limit.
   * @throws {never} Never.
   */
  constructor(code: 'budget', message: string, facts: ModelImportFacts & { budget: ModelImportBudget });
  constructor(code: Exclude<ModelImportErrorCode, 'budget'>, message: string, facts: ModelImportFacts & { budget?: never });
  constructor(readonly code: ModelImportErrorCode, message: string, facts: ModelImportFacts) {
    super(message);
    this.name = 'ModelImportError';
    this.detail = facts.detail;
    if (facts.info) this.info = facts.info;
    if (facts.budget) this.budget = facts.budget;
  }

  /**
   * Keep this failure's code, location and limit while stating the selection it occurred in.
   * @param info - Paths, entries and missing resources of the inspected selection.
   * @returns A copy of this failure carrying that selection.
   * @throws {never} Never.
   */
  withInfo(info: ModelInspectionInfo): ModelImportError {
    return restoreModelImportError(this.code, this.message, { detail: this.detail, info, budget: this.budget });
  }
}

/**
 * Rebuild a failure from facts carried across a boundary, keeping the rule that a budget failure names its limit.
 * @param code - The original failure code.
 * @param message - The original internal diagnostic.
 * @param facts - The original location, selection and limit.
 * @returns The typed failure; a budget failure that lost its limit reads as an unreadable model.
 * @throws {never} Never.
 */
export function restoreModelImportError(code: ModelImportErrorCode, message: string, facts: ModelImportFacts): ModelImportError {
  const { budget, ...rest } = facts;
  if (code === 'budget') return budget ? new ModelImportError(code, message, { ...rest, budget }) : new ModelImportError('invalid', message, rest);
  return new ModelImportError(code, message, rest);
}

/**
 * Judge a failure raised while the model's own bytes are examined (inside the inspection worker, during and after GLTFLoader parsing,
 * and while the parsed template is measured and rendered) as a content verdict. Failures outside those stages stay plain and retryable.
 * @param error - Any failure thrown in a content stage.
 * @returns The failure itself when it is already a verdict, otherwise an unreadable-model verdict carrying its message.
 * @throws {never} Never.
 */
export function contentFailure(error: unknown): ModelImportError {
  return error instanceof ModelImportError ? error : new ModelImportError('invalid', error instanceof Error ? error.message : String(error), { detail: '' });
}
