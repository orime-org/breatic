// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Which generation parameters the audio panel offers, and what each one looks
 * like (#1960).
 *
 * A model states its own: ElevenLabs takes stability and similarity, Fish
 * takes speed and volume, and both reach the vendor already
 * (`transports/elevenlabs.ts` sends `voice_settings`, `transports/fish.ts`
 * sends `prosody`). What was missing is only the control. Sonilo takes a clip
 * length, and its upstream refuses a request without one.
 *
 * The table below is the list of params this panel knows how to SHOW: a
 * parameter needs a human label, and a label has to be written by a human —
 * so a param nobody has named yet renders nothing rather than putting its
 * internal catalog name on screen. The table is also the whole rule: the label
 * key, the way its value reads, and nothing else decides what appears.
 */

import type { ModelEntry, ParamDescriptor } from '@breatic/shared';

/** The control a parameter's declaration calls for. */
export type AudioParamControl =
  | {
    name: string;
    labelKey: string;
    /** A short list of named stops — the model states `values`. */
    kind: 'choice';
    options: readonly number[];
  }
  | {
    name: string;
    labelKey: string;
    /** A continuous range — the model states bounds and an increment. */
    kind: 'range';
    min: number;
    max: number;
    step: number;
    /**
     * Positions on this range that the vendor gave a name, in ascending order.
     *
     * Absent on a range whose numbers speak for themselves. Present on one
     * where they do not: nothing about 0.50 says what it will sound like, and
     * the vendor describes exactly three points on that scale.
     */
    stops?: readonly { value: number; labelKey: string }[];
  }
  | {
    name: string;
    labelKey: string;
    /**
     * On or off — the model states a boolean default and nothing to move
     * through. A list of stops and a range both describe a quantity; this one
     * describes a decision, and the two existing kinds cannot carry it.
     */
    kind: 'toggle';
  };

/** The app's translator, as `useTranslation` hands it over. */
type Translate = (
  key: string,
  params?: Record<string, string | number | Date>,
) => string;

/**
 * How one parameter is named and read, for the params this panel shows.
 *
 * Two shapes, because a value is either a quantity or a state. A quantity
 * renders in its own unit; a state renders as its own name, since a switch has
 * no value beside itself — the switch IS the value. Splitting them is what
 * lets each entry state exactly one of the two.
 */
type AudioParamSpec = {
  labelKey: string;
} & (
  | {
      /** Renders a value for display — the unit belongs to the number. */
      format: (value: number, t: Translate) => string;
      /** Named positions on this param's scale, ascending. */
      stops?: readonly { value: number; labelKey: string }[];
    }
  | {
      /** What each state of a switch is called. */
      stateKeys: { readonly on: string; readonly off: string };
    }
);

const PARAMS: Readonly<Record<string, AudioParamSpec>> = {
  stability: {
    labelKey: 'canvas.generatePanel.voiceStability',
    format: (v) => v.toFixed(2),
    // ElevenLabs describes v3's stability at three points and nowhere else
    // (elevenlabs.io/docs/overview/capabilities/text-to-speech/best-practices).
    // The value travels as the 0-1 double every upstream takes; these are what
    // tell a reader which part of that range they are dragging into.
    stops: [
      { value: 0, labelKey: 'canvas.generatePanel.voiceStabilityCreative' },
      { value: 0.5, labelKey: 'canvas.generatePanel.voiceStabilityNatural' },
      { value: 1, labelKey: 'canvas.generatePanel.voiceStabilityRobust' },
    ],
  },
  similarity: {
    labelKey: 'canvas.generatePanel.voiceSimilarity',
    format: (v) => v.toFixed(2),
  },
  speed: {
    labelKey: 'canvas.generatePanel.voiceSpeed',
    // A multiplier, and `x` reads as one in every locale we ship.
    format: (v) => `${v.toFixed(2)}x`,
  },
  volume: {
    labelKey: 'canvas.generatePanel.voiceVolume',
    // Decibels — a unit symbol, not a word to translate.
    format: (v) => `${v > 0 ? '+' : ''}${v} dB`,
  },
  is_instrumental: {
    // Not `musicInstrumental` — that key names the backing-track slot. This
    // switch says "no vocals at all", which is a different sentence.
    labelKey: 'canvas.generatePanel.musicInstrumentalOnly',
    // Both states named, because the pill prints this the way it prints every
    // other param: the current value. The one model declaring this param
    // declares nothing else the panel can show, so this string is the whole
    // pill face — and a face reading "Instrumental only" while the switch is
    // off states the opposite of the truth.
    stateKeys: {
      on: 'canvas.generatePanel.musicInstrumentalOnly',
      off: 'canvas.generatePanel.musicWithVocals',
    },
  },
  duration: {
    labelKey: 'canvas.generatePanel.sfxDuration',
    // Seconds is a word in four of the five catalogs, so it goes through the
    // translator; the `x` above and the `dB` beside it are translated nowhere,
    // which is what makes those two symbols. The key is this panel's own: a
    // sound effect's length and a video's generated length read alike today
    // and are separate quantities, so wording either later leaves the other
    // alone (user 2026-09-05).
    format: (v, t) => t('canvas.generatePanel.sfxDurationSeconds', { n: v }),
  },
};

/**
 * The control one descriptor calls for, or null when it calls for none.
 *
 * `values` wins over bounds, the same precedence `paramValues` uses: a list is
 * the more precise statement, and a param stating both means the list. Bounds
 * without a step are refused rather than given a step of our choosing — how
 * finely a value may be set is the model's statement, and inventing one would
 * offer stops the vendor never described.
 * @param name - The catalog param name.
 * @param spec - How this panel names and reads that param.
 * @param descriptor - The model's own declaration.
 * @returns The control, or null when the declaration cannot drive one.
 */
function controlFor(
  name: string,
  spec: AudioParamSpec,
  descriptor: ParamDescriptor,
): AudioParamControl | null {
  if (descriptor.values) {
    const options = descriptor.values.filter(
      (v): v is number => typeof v === 'number' && Number.isFinite(v),
    );
    return options.length > 0
      ? { name, labelKey: spec.labelKey, kind: 'choice', options }
      : null;
  }
  // A boolean default with nothing to move through is a switch. Asked after
  // `values`, which keeps the precedence the whole table follows: a model
  // stating a list means the list, whatever its default happens to be.
  if (typeof descriptor.default === 'boolean') {
    return { name, labelKey: spec.labelKey, kind: 'toggle' };
  }
  const { min, max, step } = descriptor;
  if (typeof min !== 'number' || typeof max !== 'number' || typeof step !== 'number') {
    return null;
  }
  if (!Number.isFinite(min) || !Number.isFinite(max) || !Number.isFinite(step)) {
    return null;
  }
  // A step of zero or one that runs backwards leaves a control with no reachable
  // stop, and an empty range leaves it with exactly one.
  if (step <= 0 || max <= min) return null;
  return {
    name,
    labelKey: spec.labelKey,
    kind: 'range',
    min,
    max,
    step,
    ...('stops' in spec && spec.stops ? { stops: spec.stops } : {}),
  };
}

/**
 * The controls this model's declarations call for, in the table's order.
 *
 * Order comes from the table rather than from the model so that two models
 * declaring the same pair present it the same way round.
 * @param model - The model the panel currently has selected.
 * @returns One control per param the model declares and this panel can show.
 */
export function audioParamControls(model: ModelEntry): AudioParamControl[] {
  const out: AudioParamControl[] = [];
  for (const [name, spec] of Object.entries(PARAMS)) {
    const descriptor = model.params?.[name];
    if (!descriptor) continue;
    const control = controlFor(name, spec, descriptor);
    if (control) out.push(control);
  }
  return out;
}

/**
 * Whether a switch is on: what the node holds, else the model's own default.
 *
 * Two readers since #1960 — the params popover draws the switch from it, and
 * the execute gate asks whether the track is marked instrumental, because the
 * gateway lifts its lyrics requirement when it is. One copy, so the switch on
 * screen and the condition the gate judges can never disagree.
 * @param model - The active model.
 * @param name - The param name.
 * @param held - What the node holds for it, if anything.
 * @returns True when the switch is on; false when it is off or unstated.
 */
export function audioFlagValue(
  model: ModelEntry | undefined,
  name: string,
  held: unknown,
): boolean {
  if (typeof held === 'boolean') return held;
  return model?.params?.[name]?.default === true;
}

/** The param a music model states for "no vocals at all" (#1960). */
export const INSTRUMENTAL_PARAM = 'is_instrumental';

/**
 * A value as the user reads it, in that parameter's own unit.
 * @param name - The catalog param name.
 * @param value - The current value; a boolean for a switch.
 * @param t - The app's translator, for units that are words in some locale.
 * @returns The display string; the bare value when the param is unknown.
 */
export function formatAudioParam(
  name: string,
  value: number | boolean,
  t: Translate,
): string {
  const spec = PARAMS[name];
  if (typeof value === 'boolean') {
    return spec && 'stateKeys' in spec
      ? t(value ? spec.stateKeys.on : spec.stateKeys.off)
      : String(value);
  }
  return spec && 'format' in spec ? spec.format(value, t) : String(value);
}
