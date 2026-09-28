// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The controls only one model has (#2156, design §12).
 *
 * A panel draws its shared controls by name — ratio, resolution, duration —
 * and those carry their labels in the locales. A control only one model has
 * carries an English `label` in its yaml instead, and its shape comes from the
 * declaration: `values` is a row of options (a true/false pair is a switch),
 * `min`/`max` is a slider, `type: text` is a text box. The `label` is what
 * marks a param as one of these. A list of entries (`type: items`) is a list
 * editor whose rows follow the entry's `fields`; a list whose entries carry a
 * `prompt` and a `duration` is a storyboard, which stands in for the prompt
 * box rather than sitting in the popover.
 */

import type { ItemField, ModelEntry, ParamDescriptor } from '@breatic/shared';

import type { ParamOption } from '@web/spaces/canvas/generate/ParamOptionGroup';

/** One field of a list editor's row. */
export type ItemFieldControl =
  | { name: string; kind: 'text'; placeholder?: string }
  | { name: string; kind: 'choice'; options: ParamOption[]; initial?: string | number };

/** One control a model's own param calls for. */
export type ModelControl =
  | { kind: 'toggle'; name: string; label: string }
  | { kind: 'choice'; name: string; label: string; options: ParamOption[] }
  | { kind: 'range'; name: string; label: string; min: number; max: number; step: number }
  | { kind: 'text'; name: string; label: string }
  | { kind: 'items'; name: string; label: string; max: number | undefined; fields: ItemFieldControl[] };

/** A storyboard: shots, each with its own prompt and length (#2156). */
export interface StoryboardControl {
  name: string;
  label: string;
  max: number | undefined;
  /** One shot's fields, drawn by the same editor as any other list. */
  fields: ItemFieldControl[];
  /** The totals the run takes, in seconds: the model's own `duration` values. */
  lengths: number[];
}

/**
 * How one value of a choice reads on screen.
 * @param spec - The param's declaration.
 * @param value - One of its values.
 * @returns The declared label, else the value with a capital first letter.
 */
function optionLabel(spec: Pick<ParamDescriptor, 'value_labels'>, value: string | number): string {
  const raw = String(value);
  return spec.value_labels?.[raw] ?? raw.charAt(0).toUpperCase() + raw.slice(1);
}

/**
 * The control one labelled panel param calls for.
 * @param name - The param name.
 * @param label - Its English label.
 * @param spec - Its declaration.
 * @returns The control, or undefined for a shape nothing here draws.
 */
function controlFor(
  name: string,
  label: string,
  spec: ParamDescriptor,
): ModelControl | undefined {
  if (spec.type === 'items') {
    if (isStoryboard(spec)) return undefined;
    const fields = Object.entries(spec.fields ?? {}).map(([field, declared]) => fieldControl(field, declared));
    return { kind: 'items', name, label, max: spec.max_items, fields };
  }
  if (spec.type === 'text') return { kind: 'text', name, label };
  const values = spec.values;
  if (values && values.length > 0) {
    if (values.every((v) => typeof v === 'boolean')) return { kind: 'toggle', name, label };
    const options = values
      .filter((v): v is string | number => typeof v !== 'boolean')
      .map((v) => ({ value: v, label: optionLabel(spec, v) }));
    return { kind: 'choice', name, label, options };
  }
  if (typeof spec.min === 'number' && typeof spec.max === 'number') {
    return { kind: 'range', name, label, min: spec.min, max: spec.max, step: spec.step ?? 1 };
  }
  return undefined;
}

/**
 * The control one field of a list entry calls for.
 * @param name - The field name.
 * @param field - Its declaration.
 * @returns A choice when it states values, else a text box.
 */
function fieldControl(name: string, field: ItemField): ItemFieldControl {
  const values = (field.values ?? []).filter((v): v is string | number => typeof v !== 'boolean');
  if (values.length === 0) return { name, kind: 'text' };
  const options = values.map((v) => ({ value: v, label: optionLabel({}, v) }));
  const initial = values.find((v) => v === field.default);
  return initial === undefined ? { name, kind: 'choice', options } : { name, kind: 'choice', options, initial };
}

/**
 * Whether a list's entries are shots: a prompt and a length each.
 * @param spec - The list's declaration.
 * @returns True for a storyboard.
 */
function isStoryboard(spec: ParamDescriptor): boolean {
  return spec.fields?.prompt?.type === 'text' && (spec.fields.duration?.values?.length ?? 0) > 0;
}

/**
 * The storyboard this model offers, if any.
 * @param model - The active model.
 * @returns Its storyboard param, or undefined.
 */
export function storyboardControl(model: ModelEntry | undefined): StoryboardControl | undefined {
  for (const [name, spec] of Object.entries(model?.params ?? {})) {
    if (spec.fill !== 'panel' || spec.type !== 'items' || !isStoryboard(spec)) continue;
    return {
      name,
      label: spec.label ?? name,
      max: spec.max_items,
      fields: Object.entries(spec.fields ?? {}).map(([field, declared]) => fieldControl(field, declared)),
      lengths: (model?.params.duration?.values ?? []).filter((v): v is number => typeof v === 'number'),
    };
  }
  return undefined;
}

/**
 * The controls only this model has, in the order it declares them.
 * @param model - The active model.
 * @returns One control per labelled param the panel fills.
 */
export function modelControls(model: ModelEntry): ModelControl[] {
  const controls: ModelControl[] = [];
  for (const [name, spec] of Object.entries(model.params)) {
    if (spec.fill !== 'panel' || typeof spec.label !== 'string') continue;
    const control = controlFor(name, spec.label, spec);
    if (control) controls.push(control);
  }
  return controls;
}

/**
 * What the node holds for this model's own controls, and nothing else.
 *
 * A panel hands its pickers a record built from the handful of params it
 * draws, memoised on their values; the model's own ones join that record the
 * same way, so a change to any other param does not redraw the popover.
 * @param model - The active model, or undefined before one resolves.
 * @param params - Everything the node holds for it.
 * @returns The own controls' values, by param name.
 */
export function ownControlValues(
  model: ModelEntry | undefined,
  params: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  if (!model) return {};
  const out: Record<string, unknown> = {};
  for (const control of modelControls(model)) {
    if (params[control.name] !== undefined) out[control.name] = params[control.name];
  }
  return out;
}
