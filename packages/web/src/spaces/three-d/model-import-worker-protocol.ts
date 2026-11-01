// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type { SceneImportLimits } from '@breatic/shared';
import { ModelImportError, restoreModelImportError } from '@web/spaces/three-d/model-import-errors';
import type { ModelImportBudget, ModelImportErrorCode, ModelInspectionInfo } from '@web/spaces/three-d/model-import-errors';
import type { ModelPackage } from '@web/spaces/three-d/model-package';
import type { ModelSelection } from '@web/spaces/three-d/model-selection';
import type { ModelSource } from '@web/spaces/three-d/model-source';

/** Inspect a user's selection, or unpack a registered package, away from the page's main thread. */
export type ModelImportWorkerRequest =
  | { kind: 'selection'; files: readonly ModelSource[]; entry: string | undefined; limits: SceneImportLimits }
  | { kind: 'registered'; bytes: Uint8Array<ArrayBuffer>; limits: SceneImportLimits };
export interface SerializedModelImportError {
  code: ModelImportErrorCode;
  message: string;
  info?: ModelInspectionInfo;
  detail: string;
  budget?: ModelImportBudget;
}
export type ModelImportWorkerAnswer = { ok: true; selection: ModelSelection } | { ok: true; model: ModelPackage } | { ok: false; error: SerializedModelImportError };

/**
 * Carry inspection facts across the worker boundary without relying on Error cloning.
 * @param error - Inspection failure from the worker's model checker.
 * @returns A structured-cloneable diagnostic with separate display facts.
 * @throws {never} Never directly.
 */
export function serializeModelImportError(error: unknown): SerializedModelImportError {
  return error instanceof ModelImportError
    ? { code: error.code, message: error.message, ...(error.info ? { info: error.info } : {}), detail: error.detail, ...(error.budget ? { budget: error.budget } : {}) }
    : { code: 'invalid', message: error instanceof Error ? error.message : String(error), detail: '' };
}

/**
 * Recreate the typed failure used by the document import controller and UI.
 * @param error - Worker-owned serialized diagnostic.
 * @returns A local inspection error retaining its paths and entry choices.
 * @throws {never} Never.
 */
export function deserializeModelImportError(error: SerializedModelImportError): ModelImportError {
  return restoreModelImportError(error.code, error.message, { detail: error.detail, info: error.info, budget: error.budget });
}
