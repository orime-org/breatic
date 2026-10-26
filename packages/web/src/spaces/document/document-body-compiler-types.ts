// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type * as Y from 'yjs';

import type { BodyProjection } from '@web/spaces/document/document-body-codec-types';
import type { BodyJournalSnapshot } from '@web/spaces/document/document-body-journal';

/** A complete accepted journal and the exact native frame it began from. */
export interface CompileBodyBatchOptions {
  readonly doc: Y.Doc;
  readonly projection: BodyProjection;
  readonly journal: BodyJournalSnapshot;
  readonly batchId: string;
}
