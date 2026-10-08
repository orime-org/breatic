// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Guards for the Generate panel's execute action.
 */

import { extractPromptText } from "@shared/agent/extract-prompt.js";
import { referenceCapExceeded } from "@shared/reference-cap.js";
import type { ReferenceKind } from "@shared/reference-pool.js";
import type { MissingSource } from "@shared/missing-sources.js";

/** Everything the execute gate must weigh before a task may be submitted. */
export interface ExecuteGateInput {
  /** The current prompt's plain text (rich-text prompt projected to text). */
  promptText: string;
  /** The effective model id; empty when the catalog is unavailable. */
  model: string;
  /** Whether the target node is still on the board. */
  nodeExists: boolean;
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
   * What the run still needs, as `missingSources` answers it for the active
   * mode (#2156): each unmet requirement, required params first in the order
   * the model declares them, then its "any one of these" groups.
   *
   * Empty or absent means the run has every source it needs — the truth for
   * text-to-image and every mode that collects nothing.
   */
  missing?: readonly MissingSource[];
  /**
   * How many references of each kind the pool holds, against the most the
   * model takes of that kind (#2156) — `cap` undefined means uncapped.
   *
   * The server re-checks before enqueue; refusing here is what turns that
   * into something the user can act on, since the worker would otherwise
   * truncate the extras without saying so.
   */
  pools?: ReadonlyArray<{ kind: ReferenceKind; count: number; cap: number | undefined }>;
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
  /**
   * Whether a dialogue holds fewer complete speakers than the model takes
   * (#2156, design §16) — counted with `completeEntries`, the same entries the
   * worker would send. Optional because only a model reading its script as a
   * dialogue has speakers.
   */
  speakersShort?: boolean;
  /**
   * The shots of a run in the multi-shot mode, present only there. The main
   * prompt is not sent then, so the empty-prompt check gives way to these:
   * every shot written, no more shots than the model takes, none longer than
   * it takes, and shot seconds adding up to the total — Kling fails a run
   * whose shots do not (probed 2026-09-30).
   */
  storyboard?: {
    shots: ReadonlyArray<{ text: string; duration: number }>;
    total: number;
    maxShots?: number;
    maxChars?: number;
  };
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
  | 'style-missing'
  | 'prompt-too-long'
  | 'voice-missing'
  | 'speakers-missing'
  | 'source-missing'
  | 'sources-missing'
  | 'too-many-references'
  | 'lyrics-missing'
  | 'storyboard-shot-empty'
  | 'storyboard-too-many'
  | 'storyboard-shot-too-long'
  | 'storyboard-duration-mismatch';

/**
 * Why Generate cannot run, and the detail a sentence about it needs.
 *
 * Which material is missing and how far over the cap a submit is are facts
 * about this run, not about the refusal, and the sentence naming them is the
 * panel's: it calls a first frame a first frame and a voice sample a voice
 * sample, where this module knows only that a place is empty.
 */
export interface ExecuteVerdict {
  /** The precondition that failed. */
  readonly refusal: ExecuteRefusal;
  /** Which place is empty, when one of them is. */
  readonly slot?: string;
  /** What the too-many sentence interpolates: the cap, and of which kind. */
  readonly over?: { limit: number; kind: ReferenceKind };
  /** The shot a storyboard refusal is about, counted from 1. */
  readonly shot?: number;
  /** The cap a storyboard refusal names. */
  readonly limit?: number;
  /** The shot seconds and the total that do not match. */
  readonly seconds?: { shots: number; total: number };
}

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
 * `locked` is NOT weighed here (user 2026-07-18): the button stays clickable
 * and the node gate in the execute handler surfaces a `warnNodeGate` toast on
 * click instead of a silently-greyed button. Tasks running on the node do not
 * stop a new run.
 * @param input - The current prompt, model, whether the node exists, submitting flag, and whether the model consumes a prompt.
 * @returns The failing condition, or null when every precondition holds.
 */
export function evaluateExecute(
  input: ExecuteGateInput,
): ExecuteVerdict | null {
  // Nothing else is worth saying about a node that is gone.
  if (!input.nodeExists) return { refusal: 'node-gone' };
  // An empty catalog leaves no model, so submitting would send an invalid task.
  if (input.model.length === 0) return { refusal: 'no-model' };
  // Front-end idempotency. The backend lock is the airtight guard, but the
  // button must not invite a double-submit.
  if (input.isSubmitting) return { refusal: 'submitting' };
  // Two refusals for one empty box, because the box has two names. A panel
  // showing it alone calls it the prompt and labels nothing; a music mode puts
  // a lyrics box under it and labels the pair Style and Lyrics, where a
  // sentence saying "write a prompt" names neither of the two things on
  // screen.
  //
  // Judged on the text the worker sends (`prompt-params.ts`): a box holding
  // only characters that function removes reaches the vendor empty.
  if (input.storyboard !== undefined) {
    const verdict = storyboardRefusal(input.storyboard);
    if (verdict) return verdict;
  } else if (input.promptRequired && extractPromptText(input.promptText).length === 0) {
    return { refusal: input.lyricsRequired ? 'style-missing' : 'prompt-missing' };
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
  //
  // In the multi-shot mode `promptText` is what goes out in place of the main
  // prompt: the shots written into one prompt, or nothing for a model that
  // takes its shots in a field of their own.
  if (
    input.promptRequired &&
    input.maxInputChars !== undefined &&
    [...extractPromptText(input.promptText)].length > input.maxInputChars
  ) {
    return { refusal: 'prompt-too-long' };
  }
  // Right after the style brief, the order the two boxes sit in on screen.
  //
  // Judged on the text the vendor will receive, the same rule the prompt's
  // length check follows above: the worker cleans the lyrics through this
  // function before the request goes out (`prompt-params.ts`), and everything
  // it does shortens. A box holding a zero-width space or an HTML comment
  // survives `.trim()` and reaches the gateway empty, which is the
  // `invalid params` the refusal exists to spare the user.
  if (input.lyricsRequired && extractPromptText(input.lyricsText).length === 0) {
    return { refusal: 'lyrics-missing' };
  }
  // The remaining refusals name a control the user has to go and fill. Only
  // one can be live at a time: `voiceRequired` says the model picks from a
  // preset catalog, `missing` says the model needs a source picked off
  // the canvas, and a model answering yes to both would be one whose panel
  // shows a picker and a slot for the same voice.
  if (input.voiceRequired && !input.voiceChosen) return { refusal: 'voice-missing' };
  // The dialogue's own form of the same question: who reads which line.
  if (input.speakersShort) return { refusal: 'speakers-missing' };
  // The first unmet requirement is the one named. One param names its place;
  // a group any member of which would do refuses with a sentence about the
  // set, because naming a single member of it would be the wrong sentence.
  const first = input.missing?.[0];
  if (first !== undefined) {
    return first.length === 1
      ? { refusal: 'source-missing', slot: first[0] }
      : { refusal: 'sources-missing' };
  }
  // The other end of the same question: more than the model takes. Naming the
  // limit is the point -- otherwise the only way to find it is to remove one
  // and try again.
  for (const pool of input.pools ?? []) {
    const over = referenceCapExceeded(pool.count, pool.cap);
    if (over) return { refusal: 'too-many-references', over: { ...over, kind: pool.kind } };
  }
  return null;
}

/**
 * What is wrong with the shots of a multi-shot run, the first thing found, judged on
 * the text the worker will send.
 * @param storyboard - The shots, the total and the model's caps.
 * @returns The refusal, or null when the shots can go.
 */
function storyboardRefusal(
  storyboard: NonNullable<ExecuteGateInput["storyboard"]>,
): ExecuteVerdict | null {
  const { shots, total, maxShots, maxChars } = storyboard;
  const texts = shots.map((shot) => extractPromptText(shot.text));
  const empty = texts.findIndex((text) => text.length === 0);
  if (empty !== -1) return { refusal: 'storyboard-shot-empty', shot: empty + 1 };
  if (maxShots !== undefined && shots.length > maxShots) {
    return { refusal: 'storyboard-too-many', limit: maxShots };
  }
  if (maxChars !== undefined) {
    const long = texts.findIndex((text) => [...text].length > maxChars);
    if (long !== -1) return { refusal: 'storyboard-shot-too-long', shot: long + 1, limit: maxChars };
  }
  const sum = shots.reduce((acc, shot) => acc + shot.duration, 0);
  if (sum !== total) return { refusal: 'storyboard-duration-mismatch', seconds: { shots: sum, total } };
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
 * Every panel asks this rather than each spelling the set out: two copies of
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
 * What each refusal says out loud on click, and null for the ones that say
 * nothing.
 *
 * The other half of {@link isExecuteButtonDisabled}, and here for the same
 * reason: "which refusals speak" was written out twice, once per panel, in
 * blocks that were byte-for-byte identical. Two copies of a policy are two
 * chances to change one and forget the other.
 *
 * A record keyed on the union rather than a chain of comparisons, so a refusal
 * added without a sentence fails typecheck here. A chain ends in a fallback,
 * and falling through it means both no toast and — since
 * {@link isExecuteButtonDisabled} reads this — a button greyed with nothing
 * said, which is the one outcome this whole mechanism exists to prevent.
 *
 * Silent is not the same as unhandled. A silent refusal keeps the button
 * disabled, so none of them is reachable from a click in the same render. The
 * submit path re-derives from live Yjs, so each has one narrow window where it
 * arrives anyway, and they differ in what the user sees:
 *
 * `node-gone` — a collaborator deleted the node between render and click. The
 * panel is anchored to that node and goes with it on the next frame, so the
 * panel vanishing already says it.
 *
 * `no-model` — unreachable since #1951, which is why it stays silent. This
 * table once carried a note that #1951 would give it a voice; the opposite
 * happened. Availability became the test at every layer that decides which
 * mode is current, so the mode a panel is on always has a model, and the
 * panel does not open at all for a modality that serves none. Writing copy
 * for it would have been describing a state instead of removing it (user
 * 2026-08-18). The entry stays as defence against a layer above breaking.
 *
 * `submitting` — the button is a spinner while the POST is out, and the click
 * that got past it dies on the latch a frame later.
 */
export const REFUSAL_TOAST_KEY: Record<ExecuteRefusal, string | null> = {
  'node-gone': null,
  'no-model': null,
  submitting: null,
  'prompt-missing': 'canvas.generatePanel.refuseExecuteNoPrompt',
  'style-missing': 'canvas.generatePanel.refuseExecuteNoStyle',
  'prompt-too-long': 'canvas.generatePanel.refuseExecuteTooLong',
  'voice-missing': 'canvas.generatePanel.refuseExecuteNoVoice',
  'speakers-missing': 'canvas.generatePanel.refuseExecuteNoSpeakers',
  // The two a panel may word for itself, by naming the place it draws. The
  // sentences here are what it falls back to when it has none of its own.
  'source-missing': 'canvas.generatePanel.errorNoRefAudio',
  'sources-missing': 'canvas.generatePanel.refuseExecuteNoReference',
  'too-many-references': 'canvas.generatePanel.errorTooManyReferences',
  'lyrics-missing': 'canvas.generatePanel.lyricsMissing',
  'storyboard-shot-empty': 'canvas.generatePanel.refuseStoryboardShotEmpty',
  'storyboard-too-many': 'canvas.generatePanel.refuseStoryboardTooMany',
  'storyboard-shot-too-long': 'canvas.generatePanel.refuseStoryboardShotTooLong',
  'storyboard-duration-mismatch': 'canvas.generatePanel.refuseStoryboardDurationMismatch',
};

/**
 * The i18n key a refusal says out loud on click, or null when it says nothing.
 * @param refusal - The failing condition from {@link evaluateExecute}.
 * @returns The i18n key to warn with, or null to refuse in silence.
 */
export function refusalToastKey(refusal: ExecuteRefusal): string | null {
  return REFUSAL_TOAST_KEY[refusal];
}
