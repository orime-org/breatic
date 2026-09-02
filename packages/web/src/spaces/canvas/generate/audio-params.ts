// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Which speaking parameters the audio panel offers, and what each one looks
 * like (#1960).
 *
 * A model states its own: ElevenLabs takes stability and similarity, Fish
 * takes speed and volume, and both reach the vendor already
 * (`transports/elevenlabs.ts` sends `voice_settings`, `transports/fish.ts`
 * sends `prosody`). What was missing is only the control.
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
  };

/**
 * How one parameter is named and read, for the params this panel shows.
 *
 * A vendor's own name for a value is part of that value: ElevenLabs describes
 * v3's three stability stops as Creative / Natural / Robust and never as
 * numbers, so showing 0 / 0.5 / 1 would name them something the vendor's own
 * documentation does not.
 */
interface AudioParamSpec {
  labelKey: string;
  /** Renders a value for display — the unit belongs to the number. */
  format: (value: number) => string;
  /** Translation key per stop, for a `choice` param whose stops are named. */
  optionLabelKeys?: Readonly<Record<string, string>>;
}

const PARAMS: Readonly<Record<string, AudioParamSpec>> = {
  stability: {
    labelKey: 'canvas.generatePanel.voiceStability',
    format: (v) => v.toFixed(2),
    // ElevenLabs v3's three named stops
    // (elevenlabs.io/docs/overview/capabilities/text-to-speech/best-practices).
    optionLabelKeys: {
      '0': 'canvas.generatePanel.voiceStabilityCreative',
      '0.5': 'canvas.generatePanel.voiceStabilityNatural',
      '1': 'canvas.generatePanel.voiceStabilityRobust',
    },
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
  return { name, labelKey: spec.labelKey, kind: 'range', min, max, step };
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
 * A value as the user reads it, in that parameter's own unit.
 * @param name - The catalog param name.
 * @param value - The current value.
 * @returns The display string; the bare number when the param is unknown.
 */
export function formatAudioParam(name: string, value: number): string {
  return PARAMS[name]?.format(value) ?? String(value);
}

/**
 * The translation key naming one stop of a `choice` param, when its stops have
 * names of their own.
 * @param name - The catalog param name.
 * @param option - The stop's value.
 * @returns The key, or undefined when this stop is read as a plain number.
 */
export function audioParamOptionLabelKey(
  name: string,
  option: number,
): string | undefined {
  return PARAMS[name]?.optionLabelKeys?.[String(option)];
}
