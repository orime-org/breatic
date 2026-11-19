// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A video mini-tool step that failed for good outside a model call: a container job, a ledger that failed its receipt,
 * an analysis object that could not be read (inner#1306 execution design §11.3). Its code is what the step's failure
 * records; a model call's failure is provider's `MediaRunFailed` instead.
 */
export class MiniToolStepFailed extends Error {
  /**
   * Record the code.
   * @param code - Why the step failed, as its failure records it.
   */
  constructor(readonly code: string) {
    super(code);
    this.name = "MiniToolStepFailed";
  }
}
