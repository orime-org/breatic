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
 * editor whose rows follow the entry's `fields`. A param declared for some
 * modes only is drawn in those modes only, so every reader names the mode.
 */

import {
  CAMERA_ANGLE_AXES,
  appliesInMode,
  nearestCameraAngle,
  type CameraAngle,
  type CameraAngleParams,
  type ItemField,
  type ModelEntry,
  type ParamDescriptor,
} from '@breatic/shared';

import type { ParamOption } from '@web/spaces/canvas/generate/ParamOptionGroup';

/** One field of a list editor's row. */
export type ItemFieldControl =
  | { name: string; kind: 'text' }
  | { name: string; kind: 'choice'; options: ParamOption[] };

/** One control a model's own param calls for. */
export type ModelControl =
  | { kind: 'toggle'; name: string }
  | { kind: 'choice'; name: string; options: ParamOption[] }
  | { kind: 'range'; name: string; min: number; max: number; step: number }
  | { kind: 'text'; name: string }
  | { kind: 'items'; name: string; max: number | undefined; fields: ItemFieldControl[] }
  | { kind: 'cameraAngle'; name: 'camera_angle'; params: CameraAngleParams };

/**
 * How a camera pose reads, azimuth then elevation then distance, each step
 * named by its param's `value_labels` (inner#830).
 * @param specs - The model's params.
 * @param params - The three param names.
 * @param pose - The pose; read at the nearest step of the grid.
 * @returns The three names.
 */
export function cameraAngleNames(
  specs: Readonly<Record<string, Pick<ParamDescriptor, 'value_labels'>>>,
  params: CameraAngleParams,
  pose: CameraAngle,
): [string, string, string] {
  const at = nearestCameraAngle(pose);
  return [
    optionLabel(specs[params.azimuth] ?? {}, at.azimuth),
    optionLabel(specs[params.elevation] ?? {}, at.elevation),
    optionLabel(specs[params.distance] ?? {}, at.distance),
  ];
}

/**
 * The params a control writes, by name.
 * @param control - One of a model's own controls.
 * @returns Its param names: three for a camera pose, one otherwise.
 */
export function controlParams(control: ModelControl): string[] {
  return control.kind === 'cameraAngle'
    ? CAMERA_ANGLE_AXES.map((axis) => control.params[axis])
    : [control.name];
}

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
 * @param spec - Its declaration.
 * @returns The control, or undefined for a shape nothing here draws.
 */
function controlFor(name: string, spec: ParamDescriptor): ModelControl | undefined {
  if (spec.type === 'items') {
    const fields = Object.entries(spec.fields ?? {}).map(([field, declared]) => fieldControl(field, declared));
    return { kind: 'items', name, max: spec.max_items, fields };
  }
  if (spec.type === 'text') return { kind: 'text', name };
  const values = spec.values;
  if (values && values.length > 0) {
    if (values.every((v) => typeof v === 'boolean')) return { kind: 'toggle', name };
    const options = values
      .filter((v): v is string | number => typeof v !== 'boolean')
      .map((v) => ({ value: v, label: optionLabel(spec, v) }));
    return { kind: 'choice', name, options };
  }
  if (typeof spec.min === 'number' && typeof spec.max === 'number') {
    return { kind: 'range', name, min: spec.min, max: spec.max, step: spec.step ?? 1 };
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
 * The controls only this model has in a mode, in the order it declares them.
 * @param model - The active model.
 * @param mode - The mode the panel is in.
 * @returns One control per labelled param the panel fills in that mode.
 */
export function modelControls(model: ModelEntry, mode: string): ModelControl[] {
  const controls: ModelControl[] = [];
  const pose = model.camera_angle;
  const inPose = new Set(pose ? CAMERA_ANGLE_AXES.map((axis) => pose[axis]) : []);
  for (const [name, spec] of Object.entries(model.params)) {
    if (spec.fill !== 'panel' || typeof spec.label !== 'string') continue;
    if (!appliesInMode(spec, mode)) continue;
    // The three params of one pose are one control, drawn where the first of them is declared.
    if (pose && inPose.has(name)) {
      if (!controls.some((c) => c.kind === 'cameraAngle')) controls.push({ kind: 'cameraAngle', name: 'camera_angle', params: pose });
      continue;
    }
    const control = controlFor(name, spec);
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
 * @param mode - The mode the panel is in.
 * @param params - Everything the node holds for it.
 * @returns The own controls' values, by param name.
 */
export function ownControlValues(
  model: ModelEntry | undefined,
  mode: string,
  params: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  if (!model) return {};
  const out: Record<string, unknown> = {};
  for (const control of modelControls(model, mode)) {
    for (const name of controlParams(control)) {
      if (params[name] !== undefined) out[name] = params[name];
    }
  }
  return out;
}

/**
 * What the model's own controls stand on, as the settings pill shows it: a
 * choice by its option's name, a range by its number, a switch by its name
 * while it is on, a text box or a list by its name while it holds something,
 * a camera pose by the names of its azimuth, elevation and distance.
 * @param model - The active model.
 * @param mode - The mode the panel is in.
 * @param params - What the node holds for it, with the model's defaults resolved in.
 * @param t - The translator; a param is named by `canvas.generatePanel.param.<name>`.
 * @param include - Which controls to summarise; all of them when absent.
 * @returns One part per control that has something to show, in declared order.
 */
export function ownControlSummary(
  model: ModelEntry,
  mode: string,
  params: Readonly<Record<string, unknown>>,
  t: (key: string) => string,
  include?: (control: ModelControl) => boolean,
): string[] {
  const parts: string[] = [];
  /**
   * A param's name on screen.
   * @param name - The param name.
   * @returns Its locale word.
   */
  const nameOf = (name: string): string => t(`canvas.generatePanel.param.${name}`);
  for (const control of modelControls(model, mode)) {
    if (include && !include(control)) continue;
    if (control.kind === 'cameraAngle') {
      const { azimuth, elevation, distance } = control.params;
      const [a, e, d] = [params[azimuth], params[elevation], params[distance]];
      if (typeof a === 'number' && typeof e === 'number' && typeof d === 'number') {
        parts.push(...cameraAngleNames(model.params, control.params, { azimuth: a, elevation: e, distance: d }));
      }
      continue;
    }
    const shown = params[control.name];
    if (control.kind === 'choice' && (typeof shown === 'string' || typeof shown === 'number')) {
      parts.push(optionLabel(model.params[control.name] ?? {}, shown));
    } else if (control.kind === 'range' && typeof shown === 'number') {
      parts.push(String(shown));
    } else if (control.kind === 'toggle' && shown === true) {
      parts.push(nameOf(control.name));
    } else if (control.kind === 'text' && typeof shown === 'string' && shown.trim() !== '') {
      parts.push(nameOf(control.name));
    } else if (control.kind === 'items' && Array.isArray(shown) && shown.length > 0) {
      parts.push(nameOf(control.name));
    }
  }
  return parts;
}
