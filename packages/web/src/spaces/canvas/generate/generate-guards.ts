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
   * Whether the selected model takes a prompt at all (#1935, #1966).
   *
   * Asked of the MODEL, not of the mode: `takes_prompt` is declared per model
   * in the catalog and reaches the browser whole, the same fact the panel
   * already reads for the audio toggle and the reference cap. The talking-head
   * model declares `takes_prompt: false` — it takes a portrait and an audio
   * track and follows the audio — so demanding one there would be a
   * requirement we invented for a model with nothing to do with the answer.
   * Before #1966 this was inferred from whether the model declared a `prompt`
   * under `params`; no model declares that param any more, so the inference
   * would now switch the requirement off for the entire catalog.
   *
   * Whether one is SENT is a separate question this gate does not decide: the
   * prompt travels as its own argument rather than as a param, so any
   * non-empty text reaches the request body even for a model with no prompt
   * field (an empty one does not — the transport writes the field only when
   * there is something in it). The talking-head endpoint accepts the extra
   * field and ignores it — verified against it on 2026-08-12.
   *
   * Callers pass it rather than the gate deriving it: this module is given
   * everything it weighs, and it has no catalog to consult.
   */
  promptRequired: boolean;
}

/**
 * Why Generate cannot be executed right now — the one condition that fails.
 *
 * A boolean could say "no" but not "why", so every one of these collapsed into
 * the same greyed-out button that explained nothing (#1949). Naming the reason
 * lets the button and the submit path treat them differently: only
 * `prompt-missing` is something the user can act on, and only it leaves the
 * button clickable so the click can say what is missing.
 */
export type ExecuteRefusal =
  | 'node-gone'
  | 'no-model'
  | 'submitting'
  | 'prompt-missing';

/**
 * Which execute precondition fails, or null when Generate may proceed.
 *
 * The ORDER is the design, not an implementation detail: environment facts the
 * user cannot act on come first, and what they can fix comes last. Answering
 * `prompt-missing` first reads as helpful, but a mode that offers no model at
 * all reports BOTH (`promptRequired` stays true when no model resolves, and
 * `pickModelForMode` yields '' for an empty list) — so the button would
 * un-grey, tell the user to write a prompt, and grey out again the moment they
 * did. The same inversion bites mid-flight: the prompt editor is not disabled
 * while a submit is out and the prompt is a collaborative fragment, so clearing
 * it would swap the spinner back to a clickable arrow whose click dies silently
 * on the submitting latch.
 *
 * `handling` and `locked` are NOT weighed here (user 2026-07-18): the button
 * stays clickable and the node-state gate in the execute handler surfaces a
 * `warnNodeGate` toast on click — the same feedback pattern as a locked node,
 * instead of a silently-greyed button. The gate still blocks the actual submit.
 * A prior failure (`error`) stays executable so a user can retry.
 * @param input - The current prompt, model, node status, submitting flag, and whether the model consumes a prompt.
 * @returns The failing condition, or null when every precondition holds.
 */
export function evaluateExecute(
  input: ExecuteGateInput,
): ExecuteRefusal | null {
  // Nothing else is worth saying about a node that is gone.
  if (input.nodeStatus == null) return 'node-gone';
  // An empty catalog leaves no model, so submitting would send an invalid task.
  if (input.model.length === 0) return 'no-model';
  // Front-end idempotency. The backend lock is the airtight guard, but the
  // button must not invite a double-submit.
  if (input.isSubmitting) return 'submitting';
  if (input.promptRequired && input.promptText.trim().length === 0) {
    return 'prompt-missing';
  }
  return null;
}

/**
 * Whether a refusal should grey the execute button out.
 *
 * Both panels ask this rather than each spelling the set out: two copies of
 * "which refusals grey the button" would drift, and that drift is the shape
 * #1949 set out to remove.
 *
 * Only `prompt-missing` leaves the button live, because it is the only one the
 * user can act on — the click then says what is missing, which a greyed-out
 * button cannot (GOV.UK and Adam Silver both name the disabled-until-valid
 * button an anti-pattern for exactly this: it never tells anyone why). The
 * other three are facts about the environment, and a button that invites a
 * click it will not honour is worse than one that plainly cannot be pressed.
 * @param refusal - The failing condition from {@link evaluateExecute}, or null.
 * @returns True when the button must be disabled.
 */
export function isExecuteButtonDisabled(
  refusal: ExecuteRefusal | null,
): boolean {
  return refusal != null && refusal !== 'prompt-missing';
}
