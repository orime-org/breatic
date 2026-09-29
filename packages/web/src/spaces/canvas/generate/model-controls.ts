// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The controls only one model has (#2156, design §12).
 *
 * A panel draws its shared controls by name — ratio, resolution, duration.
 * A control only one model has is marked by a `label` in its yaml, and is
 * named on screen from the locales by its param name
 * (`canvas.generatePanel.param.<name>`); its shape comes from the
 * declaration: `values` is a row of options (a true/false pair is a switch),
 * `min`/`max` is a slider, `type: text` is a text box. The `label` is what
 * marks a param as one of these. A list of entries (`type: items`) is a list
 * editor whose rows follow the entry's `fields`.
 */

import type { ItemField, ModelEntry, ParamDescriptor } from '@breatic/shared';

import type { ParamOption } from '@web/spaces/canvas/generate/ParamOptionGroup';

/** One field of a list editor's row. */
export type ItemFieldControl =
  | { name: string; kind: 'text' }
  | { name: string; kind: 'choice'; options: ParamOption[] };

/** One control a model's own param calls for. */
export type ModelControl =
  | { kind: 'toggle'; name: string; label: string }
  | { kind: 'choice'; name: string; label: string; options: ParamOption[] }
  | { kind: 'range'; name: string; label: string; min: number; max: number; step: number }
  | { kind: 'text'; name: string; label: string }
  | { kind: 'items'; name: string; label: string; max: number | undefined; fields: ItemFieldControl[] };

/**
 * How one value of a choice reads on screen.
 * @param spec - The param's declaration.
 * @param value - One of its values.
 * @returns The declared label, else the value with a capital first letter.
 */
export function optionLabel(spec: Pick<ParamDescriptor, 'value_labels'>, value: string | number): string {
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
  return values.length > 0
    ? { name, kind: 'choice', options: values.map((v) => ({ value: v, label: optionLabel({}, v) })) }
    : { name, kind: 'text' };
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

/**
 * What the model's own controls stand on, as the settings pill shows it: a
 * choice by its option's name, a range by its number, a switch by its name
 * while it is on. The node's value, else the declared default.
 * @param model - The active model.
 * @param params - What the node holds for it.
 * @param nameOf - A param's name on screen.
 * @param include - Which controls to summarise; all of them when absent.
 * @returns One part per control that has something to show, in declared order.
 */
export function ownControlSummary(
  model: ModelEntry,
  params: Readonly<Record<string, unknown>>,
  nameOf: (name: string) => string,
  include?: (control: ModelControl) => boolean,
): string[] {
  const parts: string[] = [];
  for (const control of modelControls(model)) {
    if (include && !include(control)) continue;
    const shown = params[control.name] ?? model.params[control.name]?.default;
    if (control.kind === 'choice' && (typeof shown === 'string' || typeof shown === 'number')) {
      parts.push(optionLabel(model.params[control.name] ?? {}, shown));
    } else if (control.kind === 'range' && typeof shown === 'number') {
      parts.push(String(shown));
    } else if (control.kind === 'toggle' && shown === true) {
      parts.push(nameOf(control.name));
    }
  }
  return parts;
}
