// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import {
  documentSchemaConfigSchema,
  documentSchemaVersion,
  type DocumentSchema,
} from '@breatic/shared';

/**
 * Substituted at build time by `vite.config.mts`, which reads
 * `config/document-schema.yaml`. Typed `unknown` on purpose: it is a literal
 * pasted in by the bundler, so the only thing that can vouch for its shape is
 * parsing it, which is what happens below.
 */
declare const __DOCUMENT_SCHEMA__: unknown;

/**
 * This build's document Space vocabulary, compiled in from
 * `config/document-schema.yaml`.
 *
 * `vite.config.mts` reads that file at config time and substitutes it for
 * `__DOCUMENT_SCHEMA__`, so what lands in the bundle is a plain object literal
 * — the browser never parses YAML and never fetches anything. It is the same
 * file collab reads, which is the point: a second hand-kept copy on either side
 * would be the same agreement written down twice, and the halves would drift in
 * silence while the check kept passing.
 *
 * Parsed rather than cast, because a substituted literal is exactly as
 * trustworthy as the file behind it. If that file is malformed the failure
 * belongs at module load, where it names the problem, not later at a comparison
 * that quietly answers "no mismatch" forever.
 * @throws {Error} At module load, when the compiled-in value is not a valid vocabulary.
 */
export const DOCUMENT_SCHEMA: DocumentSchema =
  documentSchemaConfigSchema.parse(__DOCUMENT_SCHEMA__);

/**
 * This build's version of that vocabulary — what gets compared against meta.
 *
 * Computed here rather than read from the config, so that it cannot be left
 * behind when the lists change; see `documentSchemaVersion` for why that
 * mattered enough to stop writing it by hand. collab computes it the same way
 * from the same file, so the two agree exactly when the vocabularies do.
 */
export const DOCUMENT_SCHEMA_VERSION = documentSchemaVersion(DOCUMENT_SCHEMA);
