// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type { SceneImportLimits } from '@breatic/shared';
import { ModelImportError } from '@web/spaces/three-d/model-import-errors';
import type { ModelImportErrorCode, ModelInspectionInfo } from '@web/spaces/three-d/model-import-errors';
import type { ModelSelection } from '@web/spaces/three-d/model-selection';
import type { ModelSource } from '@web/spaces/three-d/model-source';

export interface ModelImportWorkerRequest {
  files: readonly ModelSource[];
  entry: string | undefined;
  limits: SceneImportLimits;
}
export interface SerializedModelImportError {
  code: ModelImportErrorCode;
  message: string;
  info?: ModelInspectionInfo;
  detail: string;
}
export type ModelImportWorkerAnswer = { ok: true; selection: ModelSelection } | { ok: false; error: SerializedModelImportError };

/**
 * Carry inspection facts across the worker boundary without relying on Error cloning.
 * @param error - Inspection failure from the worker's model checker.
 * @returns A structured-cloneable diagnostic with separate display facts.
 * @throws {never} Never directly.
 */
export function serializeModelImportError(error: unknown): SerializedModelImportError {
  return error instanceof ModelImportError
    ? { code: error.code, message: error.message, ...(error.info ? { info: error.info } : {}), detail: error.detail }
    : { code: 'invalid', message: error instanceof Error ? error.message : String(error), detail: '' };
}

/**
 * Recreate the typed failure used by the document import controller and UI.
 * @param error - Worker-owned serialized diagnostic.
 * @returns A local inspection error retaining its paths and entry choices.
 * @throws {never} Never.
 */
export function deserializeModelImportError(error: SerializedModelImportError): ModelImportError {
  return new ModelImportError(error.code, error.message, error.info, error.detail);
}
