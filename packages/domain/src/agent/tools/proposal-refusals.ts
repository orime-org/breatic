// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Every way the proposal check can refuse, by name, and whether its reason
 * carries a fix (design 5.10).
 *
 * A reason says what is wrong, the rule from the catalog it breaks, and the
 * facts of the proposal the agent reasons from; the agent puts it right. A fix
 * is written only where one action on the element the refusal names is the
 * only way to clear it, the node's mode and model held as they are. Each name
 * is keyed here with that mark, and a test keyed by these names holds each
 * reason to its statements and each marked fix to clearing its refusal.
 */

/** Every refusal the proposal check gives, each marked with whether its reason carries the one fix. */
export const REFUSALS = {
  "nothing-generates": false,
  "nothing-generates-words": false,
  "edge-outside": true,
  "edge-self-loop": true,
  "edge-repeated": false,
  "edge-into-nothing-generating": false,
  "edge-not-allowed": true,
  "edge-ring": false,
  "group-unnamed": true,
  "template-unknown": false,
  "template-role": false,
  "template-type": false,
  "template-no-prompt": true,
  "sources-no-taker": false,
  "sources-over-room": false,
  "material-unused": false,
  "loose-without-note": false,
  "text-generates": false,
  "no-mode-model": false,
  "mode-unbacked": false,
  "no-model-for-kind": false,
  "model-not-in-mode": false,
  "shots-outside-multishot": true,
  "multishot-no-shots": true,
  "shots-with-prompt": true,
  "no-prompt-box": true,
  "ref-outside": true,
  "ref-self": true,
  "ref-arrives-otherwise": false,
  "ref-not-pooled": false,
  "ref-not-pooled-no-pool": true,
  "way-over-room": false,
  "ref-missing": false,
  "notes-missing": false,
  "shot-empty": false,
  "too-many-shots": false,
  "shot-too-long": false,
  "shots-duration": false,
  "prompt-missing": true,
  "lyrics-missing": false,
  "prompt-too-long": false,
  "script-too-long-for-shot": false,
  "written-takes-no-mark": true,
  "material-not-source": false,
  "material-not-ours": true,
  "material-missing": true,
  "material-wrong-kind": false,
  "text-source": false,
  "source-configured": false,
  "written-not-text": false,
  "written-configured": false,
  "written-empty": false,
  "mark-typed": false,
  "param-undeclared": true,
  "param-from-list": true,
  "param-box": true,
  "param-pool": true,
  "param-slot": true,
  "param-storyboard": true,
  "param-storyboard-other-mode": true,
  "param-no-control": true,
  "param-gated-off": false,
  "param-option": false,
  "param-not-number": false,
  "param-out-of-range": false,
  "param-off-step": false,
  "edge-kind-not-taken": false,
  "edge-kind-not-taken-link": false,
  "edge-into-ambiguous": false,
  "edge-not-an-entry": false,
  "fill-outside": true,
  "fill-self": true,
  "fill-not-a-slot": true,
  "fill-into-pool": true,
  "fill-no-material": true,
  "fill-wrong-kind": true,
  "fill-repeated": true,
  "fill-twice": false,
} as const satisfies Record<string, boolean>;

/** The name of one refusal. */
export type RefusalId = keyof typeof REFUSALS;

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
