// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type { DOCUMENT_BODY_FORMAT, DOCUMENT_BODY_FORMAT_VERSION } from '@breatic/shared/document-body';
import type { DocumentBodyOptions } from '@web/spaces/document/document-body-binding-types';
import type { BodySelectionName } from '@web/spaces/document/document-body-positions-types';

/** Existing handle resources select records awareness without constructing XML plugins. */
export type DocumentCaretBodyOptions = Pick<DocumentBodyOptions, 'document' | 'runtime'>;

/** Awareness carries only finalized common names, never staged PM coordinates. */
export interface DocumentBodyCursor {
  readonly format: typeof DOCUMENT_BODY_FORMAT;
  readonly version: typeof DOCUMENT_BODY_FORMAT_VERSION;
  readonly document: string;
  readonly selection: BodySelectionName;
}
