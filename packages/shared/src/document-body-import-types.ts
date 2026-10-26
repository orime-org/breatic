// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/** A complete loading frame, with an explicit decision about persisting new bytes. */
export interface DocumentBodyImportResult {
  readonly status: "ready";
  readonly changed: boolean;
}
