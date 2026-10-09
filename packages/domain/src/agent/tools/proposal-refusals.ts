// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Every way the proposal check can refuse, by name.
 *
 * A refusal tells the agent what to change, and that advice is a claim about
 * every other check: do this and the proposal passes. The claim is only as
 * good as the proposal it is tried on, so each refusal carries a name, and a
 * test keyed by these names builds the proposal each refusal asks for and
 * holds the check to accepting it. A refusal added here without that case
 * does not compile in the test. One name stands for one piece of advice:
 * where a check says different things in different settings, each saying has
 * a name of its own, so none of them goes untried.
 */

/** The names of every refusal the proposal check gives. */
export const REFUSALS = [
  "nothing-generates",
  "nothing-generates-words",
  "edge-outside",
  "edge-self-loop",
  "edge-repeated",
  "edge-into-nothing-generating",
  "edge-not-allowed",
  "edge-ring",
  "group-unnamed",
  "template-unknown",
  "template-role",
  "template-type",
  "template-no-prompt",
  "sources-no-taker",
  "sources-over-room",
  "material-unused",
  "loose-without-note",
  "text-generates",
  "no-mode-model",
  "mode-unbacked",
  "no-model-for-kind",
  "model-not-in-mode",
  "shots-outside-multishot",
  "multishot-no-shots",
  "shots-with-prompt",
  "no-prompt-box",
  "ref-outside",
  "ref-self",
  "ref-arrives-otherwise",
  "ref-not-pooled",
  "ref-not-pooled-no-pool",
  "way-over-room",
  "way-over-room-other-way",
  "ref-missing",
  "notes-missing",
  "shot-empty",
  "too-many-shots",
  "shot-too-long",
  "shots-duration",
  "prompt-missing",
  "lyrics-missing",
  "prompt-too-long",
  "script-too-long-for-shot",
  "written-takes-no-mark",
  "material-not-source",
  "material-not-ours",
  "material-missing",
  "material-wrong-kind",
  "text-source",
  "source-configured",
  "written-not-text",
  "written-configured",
  "written-empty",
  "mark-typed",
  "param-undeclared",
  "param-from-list",
  "param-box",
  "param-pool",
  "param-slot",
  "param-storyboard",
  "param-storyboard-other-mode",
  "param-no-control",
  "param-gated-off",
  "param-option",
  "param-not-number",
  "param-out-of-range",
  "param-off-step",
  "edge-kind-not-taken",
  "edge-kind-not-taken-link",
  "edge-into-ambiguous",
  "edge-not-an-entry",
  "fill-outside",
  "fill-self",
  "fill-not-a-slot",
  "fill-into-pool",
  "fill-no-material",
  "fill-wrong-kind",
  "fill-repeated",
  "fill-twice",
] as const;

/** The name of one refusal. */
export type RefusalId = (typeof REFUSALS)[number];

/** A refusal: its name, and what the agent reads. */
export interface Refusal {
  ok: false;
  refusal: RefusalId;
  reason: string;
}

/**
 * A refusal, named.
 * @param refusal - Its name.
 * @param reason - What the agent reads.
 * @returns The refusal.
 * @throws {never} Never.
 */
export function refuse(refusal: RefusalId, reason: string): Refusal {
  return { ok: false, refusal, reason };
}
