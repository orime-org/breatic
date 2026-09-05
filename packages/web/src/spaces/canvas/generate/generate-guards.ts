// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Guards for the Generate panel's execute action.
 */

import { extractPromptText } from '@breatic/shared';

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
  /**
   * How many characters the selected model takes in one request (#1960), read
   * off its catalog entry.
   *
   * Optional, and absent means uncapped: a model whose upstream publishes no
   * limit declares none, and a number invented for it would refuse text the
   * vendor accepts.
   */
  maxInputChars?: number;
  /**
   * Whether the selected model picks its voice from a catalog (#1960) — true
   * for a model declaring a param filled from the voice list.
   *
   * Optional because only one panel has voices at all: absent reads as "this
   * modality has none", which is the truth for image and video and spares
   * their four call sites a pair of literal falses that say nothing.
   */
  voiceRequired?: boolean;
  /**
   * The slots the active mode collects and needs at least one of (#1960).
   *
   * A set rather than the single `refAudioRequired` / `refAudioChosen` pair it
   * replaces: reference-to-music offers three references and takes any one, so
   * a boolean naming one slot greyed the button out for a user who had filled
   * all three under different names. Empty or absent means this mode demands
   * no source, which is the truth for image, video and the three audio modes
   * that collect nothing.
   */
  requiredSlots?: readonly string[];
  /** Which slots currently hold a pick. Read only against `requiredSlots`. */
  filledSlots?: readonly string[];
  /**
   * Whether the active mode insists on lyrics (#1960).
   *
   * Both music modes do: the gateway refuses a vocal run without them
   * (`invalid params, lyrics is required` from music-3.0, `2013 - invalid
   * params` from music-01, measured 2026-09-05), so the user would otherwise
   * watch a generation start, spin and fail. Optional because every other mode
   * has no lyrics box at all.
   */
  lyricsRequired?: boolean;
  /** What the lyrics box holds. Read only when `lyricsRequired`. */
  lyricsText?: string;
  /**
   * Whether the track is marked instrumental — no vocals at all (#1960).
   *
   * It lifts the lyrics requirement, because the gateway lifts it: measured
   * 2026-09-05, `lyrics: ""` with `is_instrumental: true` is accepted and
   * completes. Demanding words to sing for a track the user marked vocal-free
   * is a rule we would be inventing.
   *
   * Only text-to-music can answer yes — it is the one model declaring the
   * switch. Reference-to-music declares none, so nothing lifts its own
   * requirement.
   */
  instrumental?: boolean;
  /**
   * Whether the stored voice is one this deployment's provider accepts.
   *
   * Not "is the value non-null": one model defaults to null while the other
   * defaults to a display name that the direct connection rejects and the
   * gateway accepts, so the same stored value is valid on one deployment and
   * not the other. Which it is depends on the resolved provider, which this
   * module has no way to consult — the caller decides and passes the answer,
   * the same way it does for `promptRequired`.
   *
   * Optional for the same reason as `voiceRequired`, and only read when that
   * one is true.
   */
  voiceChosen?: boolean;
}

/**
 * Why Generate cannot be executed right now — the one condition that fails.
 *
 * A boolean could say "no" but not "why", so every one of these collapsed into
 * the same greyed-out button that explained nothing (#1949). Naming the reason
 * lets the button and the submit path treat them differently: the ones the
 * user can act on leave the button clickable, so the click can say what is
 * missing. Which ones those are is answered in one place —
 * {@link refusalToastKey} — and read from there by
 * {@link isExecuteButtonDisabled}.
 */
export type ExecuteRefusal =
  | 'node-gone'
  | 'no-model'
  | 'submitting'
  | 'prompt-missing'
  | 'prompt-too-long'
  | 'voice-missing'
  | 'ref-audio-missing'
  | 'reference-missing'
  | 'lyrics-missing';

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
  // Counted on the text the vendor will actually receive. The worker cleans
  // every AIGC prompt through this same function before the request goes out
  // (`prompt-params.ts`), and every rule in it shortens: counting the raw
  // editor text instead refuses messages the upstream would have taken — one
  // trailing space at exactly the cap is enough.
  //
  // In characters, the unit the vendors state their limits in. Spread rather
  // than `.length` because the latter counts UTF-16 units — two per emoji and
  // per rarer CJK glyph — and would refuse a message half the length of the
  // one the vendor would take.
  if (
    input.promptRequired &&
    input.maxInputChars !== undefined &&
    [...extractPromptText(input.promptText)].length > input.maxInputChars
  ) {
    return 'prompt-too-long';
  }
  // Reported right after the style brief, because the two are one statement:
  // a music model is handed a description and the words to sing, and a user
  // told to fix one and then the other would fix the same submit twice.
  //
  // Judged on the text the vendor will receive, the same rule the prompt's
  // length check follows above: the worker cleans the lyrics through this
  // function before the request goes out (`prompt-params.ts`), and everything
  // it does shortens. A box holding a zero-width space or an HTML comment
  // survives `.trim()` and reaches the gateway empty, which is the
  // `invalid params` the refusal exists to spare the user.
  if (
    input.lyricsRequired &&
    input.instrumental !== true &&
    extractPromptText(input.lyricsText).length === 0
  ) {
    return 'lyrics-missing';
  }
  // The remaining refusals name a control the user has to go and fill. Only
  // one can be live at a time: `voiceRequired` says the model picks from a
  // preset catalog, `requiredSlots` says the mode needs a source picked off
  // the canvas, and a model answering yes to both would be one whose panel
  // shows a picker and a slot for the same voice.
  if (input.voiceRequired && !input.voiceChosen) return 'voice-missing';
  const required = input.requiredSlots ?? [];
  const filled = input.filledSlots ?? [];
  if (required.length > 0 && !required.some((slot) => filled.includes(slot))) {
    // A mode demanding ONE slot names it; a mode offering several and taking
    // any one of them refuses with a sentence about the set, because naming
    // any single member of it would be the wrong sentence. Both sentences are
    // reached through `refusalToastKey`, the way every other refusal here is.
    return required.length === 1 ? 'ref-audio-missing' : 'reference-missing';
  }
  return null;
}

/**
 * Whether a refusal should grey the execute button out.
 *
 * Derived from {@link refusalToastKey} rather than restating its partition:
 * the two answer one question — can the user act on this — and a refusal that
 * speaks is one a click must be able to reach. Written out twice they were two
 * lists to extend, and a refusal added to one and not the other is either a
 * dead click or a message about a button nobody can press.
 *
 * Both panels ask this rather than each spelling the set out: two copies of
 * "which refusals grey the button" would drift, and that drift is the shape
 * #1949 set out to remove.
 *
 * The refusals that speak leave the button live, because they are the ones the
 * user can act on — the click then says what is wrong, which a greyed-out
 * button cannot (GOV.UK and Adam Silver both name the disabled-until-valid
 * button an anti-pattern for exactly this: it never tells anyone why). The
 * silent ones are facts about the environment, and a button that invites a
 * click it will not honour is worse than one that plainly cannot be pressed.
 * @param refusal - The failing condition from {@link evaluateExecute}, or null.
 * @returns True when the button must be disabled.
 */
export function isExecuteButtonDisabled(
  refusal: ExecuteRefusal | null,
): boolean {
  return refusal != null && refusalToastKey(refusal) === null;
}

/**
 * The i18n key a refusal says out loud on click, or null when it says nothing.
 *
 * The other half of {@link isExecuteButtonDisabled}, and here for the same
 * reason: "which refusals speak" was written out twice, once per panel, in
 * blocks that were byte-for-byte identical. Two copies of a policy are two
 * chances to change one and forget the other.
 *
 * Silent is not the same as unhandled. Both silent refusals keep the button
 * disabled, so neither is reachable from a click in the same render. The
 * submit path re-derives from live Yjs, so each has one narrow window where it
 * arrives anyway, and they differ in what the user sees:
 *
 * `node-gone` — a collaborator deleted the node between render and click. The
 * panel is anchored to that node and goes with it on the next frame, so the
 * panel vanishing already says it.
 *
 * `no-model` — unreachable since #1951, which is why it stays silent. This
 * function once carried a note that #1951 would give it a voice; the opposite
 * happened. Availability became the test at every layer that decides which
 * mode is current, so the mode a panel is on always has a model, and the
 * panel does not open at all for a modality that serves none. Writing copy
 * for it would have been describing a state instead of removing it (user
 * 2026-08-18). The branch stays as defence against a layer above breaking.
 * @param refusal - The failing condition from {@link evaluateExecute}.
 * @returns The i18n key to warn with, or null to refuse in silence.
 */
export function refusalToastKey(refusal: ExecuteRefusal): string | null {
  if (refusal === 'prompt-missing') {
    return 'canvas.generatePanel.refuseExecuteNoPrompt';
  }
  if (refusal === 'prompt-too-long') {
    return 'canvas.generatePanel.refuseExecuteTooLong';
  }
  if (refusal === 'voice-missing') {
    return 'canvas.generatePanel.refuseExecuteNoVoice';
  }
  if (refusal === 'ref-audio-missing') {
    return 'canvas.generatePanel.errorNoRefAudio';
  }
  if (refusal === 'reference-missing') {
    return 'canvas.generatePanel.refuseExecuteNoReference';
  }
  if (refusal === 'lyrics-missing') {
    return 'canvas.generatePanel.lyricsMissing';
  }
  return null;
}
