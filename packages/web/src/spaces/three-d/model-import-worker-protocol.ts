// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type { SceneImportLimits } from '@breatic/shared';
import { contentFailure, restoreModelImportError } from '@web/spaces/three-d/model-import-errors';
import type { ModelImportBudget, ModelImportError, ModelImportErrorCode, ModelInspectionInfo } from '@web/spaces/three-d/model-import-errors';
import type { ModelPackage } from '@web/spaces/three-d/model-package';
import type { ModelSelection } from '@web/spaces/three-d/model-selection';
import type { ModelSource } from '@web/spaces/three-d/model-source';
import type { TextureFormatSupport } from '@web/spaces/three-d/model-texture-format';

/** Inspect a user's selection, or unpack a registered package, away from the page's main thread. */
export type ModelImportWorkerRequest =
  | { kind: 'selection'; files: readonly ModelSource[]; entry: string | undefined; limits: SceneImportLimits; support: TextureFormatSupport }
  | { kind: 'registered'; bytes: Uint8Array<ArrayBuffer>; limits: SceneImportLimits; support: TextureFormatSupport };
/** A worker failure; everything the worker throws judges the model, so it always carries a verdict. */
export interface SerializedWorkerError {
  code: ModelImportErrorCode;
  message: string;
  info?: ModelInspectionInfo;
  detail: string;
  budget?: ModelImportBudget;
}
export type ModelImportWorkerAnswer = { ok: true; selection: ModelSelection } | { ok: true; model: ModelPackage } | { ok: false; error: SerializedWorkerError };

/**
 * Carry a worker failure across the boundary without relying on Error cloning.
 * @param error - Any failure thrown inside the worker while it examines the model.
 * @returns A structured-cloneable verdict.
 * @throws {never} Never directly.
 */
export function serializeWorkerError(error: unknown): SerializedWorkerError {
  const failure = contentFailure(error);
  return { code: failure.code, message: failure.message, ...(failure.info ? { info: failure.info } : {}), detail: failure.detail, ...(failure.budget ? { budget: failure.budget } : {}) };
}

/**
 * Recreate the verdict the worker reached.
 * @param error - Worker-owned serialized diagnostic.
 * @returns The local verdict.
 * @throws {never} Never.
 */
export function deserializeWorkerError(error: SerializedWorkerError): ModelImportError {
  return restoreModelImportError(error.code, error.message, { detail: error.detail, info: error.info, budget: error.budget });
}
