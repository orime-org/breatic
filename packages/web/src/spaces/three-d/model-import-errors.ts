// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

export type ModelImportErrorCode = 'missing' | 'entry' | 'unsupported' | 'empty' | 'budget' | 'invalid' | 'duplicate' | 'upload';
export interface ModelInspectionInfo {
  entries: readonly string[];
  paths: readonly string[];
  missing: readonly string[];
}

/** Carry localized display facts separately from an internal diagnostic. */
export class ModelImportError extends Error {
  /**
   * Describe a local inspection or upload failure without embedding UI copy.
   * @param code - Locale-key suffix for the failed operation.
   * @param message - Internal diagnostic used by logs and tests.
   * @param info - Known source paths and entry choices, when available.
   * @param detail - A source path or extension identifier shown as user data.
   * @throws {never} Never.
   */
  constructor(readonly code: ModelImportErrorCode, message: string, readonly info?: ModelInspectionInfo, readonly detail = '') {
    super(message);
    this.name = 'ModelImportError';
  }
}
