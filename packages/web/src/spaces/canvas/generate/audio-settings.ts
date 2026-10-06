// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What the audio panel's voice-and-settings pill holds (#2156, design §16).
 *
 * The layout comes from the model's declarations, never from its name: a
 * stand-in pair is a two-way switch at the top, a choice longer than
 * {@link LONG_CHOICE} and a list of entries each get a row that opens a second
 * panel beside the first, the voice is a row of its own, and everything else
 * is set in place.
 */

import type { ModelEntry, ParamDescriptor } from '@breatic/shared';

import { audioParamControls } from '@web/spaces/canvas/generate/audio-params';
import { modelControls, optionLabel, type ModelControl } from '@web/spaces/canvas/generate/model-controls';
import { isStandInOn, standInOf, type StandIn } from '@web/spaces/canvas/generate/stand-in';
import { voiceParamName } from '@web/spaces/canvas/generate/voice-param';

/**
 * The most options a choice lays out in place. Past this a row of buttons
 * wraps into a grid whose labels no longer fit (Gemini's 24 languages were
 * four cramped columns), so the choice becomes a searchable list instead.
 */
export const LONG_CHOICE = 8;

/** A row in the first panel that opens the second one. */
export type SettingsRow =
  | { readonly kind: 'voice'; readonly name: string }
  | { readonly kind: 'choice'; readonly name: string }
  | { readonly kind: 'items'; readonly name: string }
  | { readonly kind: 'speaker'; readonly name: string; readonly index: number };

/** Everything the first panel shows for one model, in order. */
export interface SettingsLayout {
  /** The single / dialogue switch, when the model declares a stand-in. */
  readonly standIn: StandIn | null;
  /** Rows that open the second panel, top to bottom. */
  readonly rows: readonly SettingsRow[];
  /** The model's own controls set in place. */
  readonly inline: readonly ModelControl[];
}

/**
 * Whether one of the model's own controls opens the second panel.
 * @param control - The control.
 * @returns True for a long choice or a list of entries.
 */
function opensSecondPanel(control: ModelControl): boolean {
  return control.kind === 'items' || (control.kind === 'choice' && control.options.length > LONG_CHOICE);
}

/**
 * How the first panel lays out for this model.
 * @param model - The active model.
 * @param mode - The mode the panel is in.
 * @param params - Its param record, which says which side of a stand-in is in use.
 * @returns The layout.
 */
export function settingsLayout(
  model: ModelEntry,
  mode: string,
  params: Readonly<Record<string, unknown>>,
): SettingsLayout {
  const standIn = standInOf(model);
  const on = standIn !== null && isStandInOn(params);
  const own = modelControls(model, mode);
  const rows: SettingsRow[] = own
    .filter(opensSecondPanel)
    .filter((control) => control.name !== standIn?.name)
    .map((control) => ({ kind: control.kind === 'items' ? 'items' : 'choice', name: control.name }));
  const voice = voiceParamName(model);
  if (on && standIn) {
    // One row per speaker the dialogue holds, each opening that speaker.
    const speakers = model.params[standIn.name]?.max_items ?? standIn.min;
    for (let index = 0; index < speakers; index += 1) rows.push({ kind: 'speaker', name: standIn.name, index });
  }
  else if (voice !== null) rows.push({ kind: 'voice', name: voice });
  return {
    standIn,
    rows,
    inline: own.filter((control) => !opensSecondPanel(control)),
  };
}

/**
 * Whether the pill has anything to open onto.
 * @param model - The active model.
 * @param mode - The mode the panel is in.
 * @returns False for a model with no voice and no control at all.
 */
export function hasSettings(model: ModelEntry, mode: string): boolean {
  return voiceParamName(model) !== null || modelControls(model, mode).length > 0 || audioParamControls(model).length > 0;
}

/**
 * How one value of a choice reads in the reader's language: a language named
 * through its BCP-47 tag, anything else as {@link optionLabel} reads it.
 * @param spec - The param's declaration.
 * @param value - One of its values.
 * @param locale - The interface language.
 * @returns The label.
 */
export function choiceLabel(
  spec: Pick<ParamDescriptor, 'values' | 'value_locales' | 'value_labels'>,
  value: string | number,
  locale: string,
): string {
  const at = (spec.values ?? []).findIndex((v) => v === value);
  const tag = at >= 0 ? spec.value_locales?.[at] : undefined;
  if (tag !== undefined) {
    const named = languageName(tag, locale);
    if (named !== undefined) return named;
  }
  return optionLabel(spec, value);
}

/**
 * A language tag named in another language.
 * @param tag - The BCP-47 tag to name.
 * @param locale - The language to name it in.
 * @returns The name, or undefined when the runtime cannot name it.
 */
function languageName(tag: string, locale: string): string | undefined {
  try {
    return new Intl.DisplayNames([locale], { type: 'language', languageDisplay: 'standard' }).of(tag);
  } catch {
    // An unknown tag or a runtime without the data: the declared spelling is
    // what the reader gets instead, which is still the right language.
    return undefined;
  }
}
