// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type { SceneImportLimits } from '@breatic/shared';

/** Approved runtime values supplied explicitly at the model-loading boundary. */
export const IMPORT_LIMITS: SceneImportLimits = {
  maxInputBytes: 67108864,
  maxExpandedBytes: 268435456,
  maxArtifactBytes: 268435456,
  maxFiles: 4096,
  maxEntryJsonBytes: 4194304,
  decoderWorkerLimit: 1,
  maxTextureEdge: 8192,
  maxTextureBytes: 268435456,
};
