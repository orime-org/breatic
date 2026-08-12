// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Guards for the Generate panel's execute action.
 */

/** Everything the execute gate must weigh before a task may be submitted. */
export interface ExecuteGateInput {
  /** The current prompt's plain text (rich-text prompt projected to text). */
  promptText: string;
  /** The effective model id; empty when the catalog is unavailable. */
  model: string;
  /** The target node's display status (`idle` / `handling` / `error`). */
  nodeStatus: string | undefined;
  /** Whether a submission is already in flight (front-end idempotency). */
  isSubmitting: boolean;
  /**
   * Whether the selected model takes a prompt at all (#1935).
   *
   * Asked of the MODEL, not of the mode: which params a model accepts is
   * declared per model in the catalog and reaches the browser whole, the same
   * fact the panel already reads for the audio toggle and the reference cap.
   * The talking-head model declares no `prompt`, so demanding one there would
   * be a requirement we invented — and one a caller could not honour, since
   * the worker drops params a model never declared.
   *
   * Callers pass it rather than the gate deriving it: this module is given
   * everything it weighs, and it has no catalog to consult.
   */
  promptRequired: boolean;
}

/**
 * Whether Generate may be executed. Requires visible prompt text WHEN the model
 * takes one (see {@link ExecuteGateInput.promptRequired}) AND a selected
 * model (an empty catalog leaves no model, so submitting would send an invalid
 * task), the node must still exist (`nodeStatus` is undefined once a collaborator
 * deletes it — never submit against a deleted node), and no submission may be in
 * flight (front-end idempotency — the backend lock is the airtight guard, but the
 * button must not invite a double-submit). A prior failure (`error`) stays
 * executable so a user can retry.
 *
 * `handling` and `locked` are NOT weighed here (user 2026-07-18): the button
 * stays clickable and the node-state gate in the execute handler surfaces a
 * `warnNodeGate` toast on click — the same feedback pattern as a locked node,
 * instead of a silently-greyed button. The gate still blocks the actual submit.
 * @param input - The current prompt, model, node status, submitting flag, and whether the model takes a prompt.
 * @returns True only when every execute precondition holds.
 */
export function canExecuteGenerate(input: ExecuteGateInput): boolean {
  return (
    (!input.promptRequired || input.promptText.trim().length > 0) &&
    input.model.length > 0 &&
    input.nodeStatus != null &&
    !input.isSubmitting
  );
}
