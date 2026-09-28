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
 * marks a param as one of these; a list (`type: items`) has an editor of its
 * own and is not drawn here.
 */

import type { ModelEntry, ParamDescriptor } from '@breatic/shared';

import type { ParamOption } from '@web/spaces/canvas/generate/ParamOptionGroup';

/** One control a model's own param calls for. */
export type ModelControl =
  | { kind: 'toggle'; name: string; label: string }
  | { kind: 'choice'; name: string; label: string; options: ParamOption[] }
  | { kind: 'range'; name: string; label: string; min: number; max: number; step: number }
  | { kind: 'text'; name: string; label: string };

/**
 * How one value of a choice reads on screen.
 * @param spec - The param's declaration.
 * @param value - One of its values.
 * @returns The declared label, else the value with a capital first letter.
 */
function optionLabel(spec: ParamDescriptor, value: string | number): string {
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
  if (spec.type === 'items') return undefined;
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
