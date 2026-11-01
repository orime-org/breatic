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
/** A worker failure: a content verdict keeps its facts; any other failure keeps only its message and stays retryable. */
export type SerializedWorkerError =
  | { kind: 'import'; code: ModelImportErrorCode; message: string; info?: ModelInspectionInfo; detail: string; budget?: ModelImportBudget }
  | { kind: 'error'; message: string };
export type ModelImportWorkerAnswer = { ok: true; selection: ModelSelection } | { ok: true; model: ModelPackage } | { ok: false; error: SerializedWorkerError };

/**
 * Carry a worker failure across the boundary without relying on Error cloning.
 * @param error - Any failure thrown inside the worker.
 * @returns A structured-cloneable diagnostic.
 * @throws {never} Never directly.
 */
export function serializeWorkerError(error: unknown): SerializedWorkerError {
  return error instanceof ModelImportError
    ? { kind: 'import', code: error.code, message: error.message, ...(error.info ? { info: error.info } : {}), detail: error.detail, ...(error.budget ? { budget: error.budget } : {}) }
    : { kind: 'error', message: error instanceof Error ? error.message : String(error) };
}

/**
 * Recreate a worker failure: a content verdict as ModelImportError, anything else as a plain Error.
 * @param error - Worker-owned serialized diagnostic.
 * @returns The local failure.
 * @throws {never} Never.
 */
export function deserializeWorkerError(error: SerializedWorkerError): Error {
  return error.kind === 'import' ? restoreModelImportError(error.code, error.message, { detail: error.detail, info: error.info, budget: error.budget }) : new Error(error.message);
}
