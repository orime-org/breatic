// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';

import { AUTO_LIGHT_SWATCH, LIGHT_COLORS, lightColorOf, type ModelEntry } from '@breatic/shared';
import { Plus } from 'lucide-react';

import { Button } from '@web/components/ui/button';
import { Input } from '@web/components/ui/input';
import { LIGHT_SPHERE } from '@web/spaces/canvas/generate/angle-spheres';
import { CameraAngleControl } from '@web/spaces/canvas/generate/CameraAngleControl';
import { SWATCH, SWATCH_DOT, Tip } from '@web/spaces/canvas/mini-tool/DrawingControls';
import { EmptyImageColorPicker } from '@web/spaces/canvas/empty-image/EmptyImageColorPicker';
import { ItemsEditor } from '@web/spaces/canvas/generate/ItemsEditor';
import { lightTintOf } from '@web/spaces/canvas/generate/light-tint';
import { useTranslation } from '@web/i18n/use-translation';
import { cn } from '@web/lib/utils';
import { modelControls, type ModelControl } from '@web/spaces/canvas/generate/model-controls';
import { ParamOptionGroup } from '@web/spaces/canvas/generate/ParamOptionGroup';
import { ParamSliderRow } from '@web/spaces/canvas/generate/ParamSliderRow';
import { ParamToggleRow } from '@web/spaces/canvas/generate/ParamToggleRow';
import { useDraftBox } from '@web/spaces/canvas/generate/use-draft-box';

interface ModelParamControlsProps {
  /** The active model, whose own labelled params are drawn. */
  model: ModelEntry;
  /** The mode the panel is in; a control declared only for other modes is not drawn. */
  mode: string;
  /** What the node holds for this model, by param name. */
  value: Readonly<Record<string, unknown>>;
  /** Called with the changed param only. */
  onChange: (partial: Record<string, unknown>) => void;
  /** Spacing from whatever sits above, when anything does. */
  className?: string;
  /** Which of the model's own controls to draw; all of them when absent. */
  include?: (control: ModelControl) => boolean;
  /** The first image the model is sent, which a camera-angle control puts on its card. */
  subjectUrl?: string;
  /**
   * The controls to draw, in place of the model's own: a mini-tool's panel
   * passes the params its tool lists (inner#888 §5).
   */
  controls?: readonly ModelControl[];
  /** Said after an Auto value's name, when something else decides it (a light reference). */
  autoNote?: string;
  /** Whether option groups share their width evenly, as a mini-tool panel lays them (inner#1304). */
  evenOptions?: boolean;
}

/**
 * A 0–1 value as a whole percentage; rounded, so 0.55 reads 55% and not the
 * float it multiplies out to.
 * @param value - The value.
 * @returns The percentage.
 */
function asPercent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

/**
 * The controls only this model has, drawn in a params popover after the ones
 * the panel shares (#2156, design §12). Each is named from the locales by its
 * param name; which shape each takes comes from its declaration.
 * @param root0 - Component props.
 * @param root0.model - The active model.
 * @param root0.mode - The mode the panel is in.
 * @param root0.value - What the node holds for it.
 * @param root0.onChange - Called with the changed param.
 * @param root0.className - Spacing above the block.
 * @param root0.include - Which controls to draw.
 * @param root0.subjectUrl - The first image the model is sent.
 * @param root0.controls - The controls to draw in place of the model's own.
 * @param root0.autoNote - Said after an Auto value's name.
 * @param root0.evenOptions - Whether option groups share their width evenly.
 * @returns The controls, or null when the model has none of its own.
 */
export const ModelParamControls = React.memo(function ModelParamControls({
  model,
  mode,
  value,
  onChange,
  className,
  include,
  subjectUrl,
  controls: given,
  autoNote,
  evenOptions = false,
}: ModelParamControlsProps): React.JSX.Element | null {
  const t = useTranslation();
  const controls = React.useMemo(
    () => (given ?? modelControls(model, mode)).filter((control) => include?.(control) ?? true),
    [given, model, mode, include],
  );
  const { light_color: lightColor, light_color_hex: lightHex, light_intensity: lightIntensity } = value;
  const tint = React.useMemo(
    () => lightTintOf({ light_color: lightColor, light_color_hex: lightHex, light_intensity: lightIntensity }),
    [lightColor, lightHex, lightIntensity],
  );
  if (controls.length === 0) return null;
  return (
    <div className={cn('flex flex-col gap-3', className)}>
      {controls.map((control) =>
        control.kind === 'cameraAngle' || control.kind === 'lightAngle' ? (
          <CameraAngleControl
            key={control.name}
            {...(control.kind === 'lightAngle' && { sphere: LIGHT_SPHERE, tint })}
            params={control.params}
            specs={model.params}
            value={value}
            onChange={onChange}
            subjectUrl={subjectUrl}
          />
        ) : (
          <ModelControlRow
            key={control.name}
            control={control}
            label={t(`canvas.generatePanel.param.${control.name}`)}
            shown={value[control.name]}
            customShown={control.kind === 'swatches' && control.custom !== undefined ? value[control.custom] : undefined}
            onChange={onChange}
            autoNote={autoNote}
            even={evenOptions}
          />
        ),
      )}
    </div>
  );
});

interface ModelControlRowProps {
  control: Exclude<ModelControl, { kind: 'cameraAngle' } | { kind: 'lightAngle' }>;
  label: string;
  shown: unknown;
  /** What a swatch row's hand-picked colour param holds. */
  customShown: unknown;
  onChange: (partial: Record<string, unknown>) => void;
  autoNote: string | undefined;
  /** Whether an option group's options share its width evenly. */
  even: boolean;
}

/**
 * One of a model's own params, in the shape its declaration calls for.
 * @param root0 - Props.
 * @param root0.control - The control this param calls for.
 * @param root0.label - Its name on screen.
 * @param root0.shown - What it is set to.
 * @param root0.customShown - What a swatch row's hand-picked colour param holds.
 * @param root0.onChange - Called with the changed param.
 * @param root0.autoNote - Said after an Auto value's name.
 * @param root0.even - Whether an option group's options share its width evenly.
 * @returns The row.
 */
function ModelControlRow({ control, label, shown, customShown, onChange, autoNote, even }: ModelControlRowProps): React.JSX.Element {
  const t = useTranslation();
  const prefix = `generate-param-${control.name}`;
  switch (control.kind) {
    case 'toggle':
      return (
        <ParamToggleRow
          id={`${prefix}-toggle`}
          label={label}
          checked={shown === true}
          onCheckedChange={(next) => onChange({ [control.name]: next })}
        />
      );
    case 'choice':
      return (
        <ParamOptionGroup
          label={label}
          options={control.options}
          value={typeof shown === 'string' || typeof shown === 'number' ? shown : undefined}
          onSelect={(next) => onChange({ [control.name]: next })}
          testIdPrefix={`${prefix}-option`}
          even={even}
        />
      );
    case 'range':
      return (
        <ParamSliderRow
          name={control.name}
          label={label}
          min={control.min}
          max={control.max}
          step={control.step}
          stops={control.stops}
          value={typeof shown === 'number' ? shown : undefined}
          format={control.display === 'percent' ? asPercent : String}
          onChange={onChange}
          testIdPrefix='generate-param'
          className={undefined}
        />
      );
    case 'items':
      return (
        <ItemsEditor
          name={control.name}
          label={label}
          max={control.max}
          fields={control.fields}
          fieldLabel={(field) => t(`canvas.generatePanel.paramField.${field}`)}
          held={shown}
          onChange={onChange}
        />
      );
    case 'swatches':
      return (
        <SwatchRow
          name={control.name}
          label={label}
          options={control.options}
          shown={shown}
          custom={control.custom}
          customShown={customShown}
          onChange={onChange}
          autoNote={autoNote}
        />
      );
    case 'text':
      return (
        <TextControl
          name={control.name}
          label={label}
          held={typeof shown === 'string' ? shown : ''}
          onChange={onChange}
        />
      );
  }
}

// Auto has no colour of its own: it follows the reference, or the picture.
const AUTO_SWATCH = `conic-gradient(${[LIGHT_COLORS.warm, LIGHT_COLORS.cool, LIGHT_COLORS.green, LIGHT_COLORS.sunset, LIGHT_COLORS.warm]
  .map((term) => term?.swatch)
  .join(', ')})`;

interface SwatchRowProps {
  name: string;
  label: string;
  options: readonly { value: string | number; label: string }[];
  shown: unknown;
  /** The param a colour picked by hand is written to, drawn as the `custom` cell. */
  custom: string | undefined;
  customShown: unknown;
  onChange: (partial: Record<string, unknown>) => void;
  autoNote: string | undefined;
}

/**
 * A choice of light colours as one row of swatches spread across the width,
 * each named in a hover tip (inner#1304). The `custom` value is the last
 * cell: it opens the colour picker and shows the colour picked.
 * @param root0 - Props.
 * @param root0.name - The param name.
 * @param root0.label - Its name on screen.
 * @param root0.options - Its values, with their names.
 * @param root0.shown - What it is set to.
 * @param root0.custom - The param a colour picked by hand is written to.
 * @param root0.customShown - What that param holds.
 * @param root0.onChange - Called with the chosen value.
 * @param root0.autoNote - Said after Auto's name.
 * @returns The row.
 */
function SwatchRow({ name, label, options, shown, custom, customShown, onChange, autoNote }: SwatchRowProps): React.JSX.Element {
  const picked = lightColorOf('custom', customShown);
  const chosen = options.find((option) => option.value === shown);
  const named =
    chosen?.value === 'auto' && autoNote !== undefined
      ? `${chosen.label} · ${autoNote}`
      : chosen?.value === 'custom' && picked !== undefined
        ? picked.phrase
        : chosen?.label;
  return (
    <div>
      <div className='mb-1.5 flex items-center justify-between gap-2 text-xs font-medium'>
        <span className='text-muted-foreground'>{label}</span>
        <span data-testid={`generate-param-${name}-value`} className='truncate text-foreground'>
          {named}
        </span>
      </div>
      <div className='flex justify-between'>
        {options.map((option) =>
          option.value === 'custom' && custom !== undefined ? (
            <EmptyImageColorPicker
              key={option.value}
              value={picked?.swatch ?? AUTO_LIGHT_SWATCH}
              onChange={(hex) => onChange({ [name]: 'custom', [custom]: hex })}
              inputTestId={`generate-param-${name}-custom-input`}
              tip={option.label}
              side='bottom'
              align='end'
              trigger={
                <Button
                  type='button'
                  variant={null}
                  size={null}
                  data-testid={`generate-param-${name}-swatch-custom`}
                  data-picked={picked !== undefined}
                  aria-label={option.label}
                  aria-pressed={shown === 'custom'}
                  className={SWATCH}
                >
                  {picked !== undefined ? (
                    <span className={SWATCH_DOT} style={{ background: picked.swatch }} />
                  ) : (
                    <span className='flex h-5 w-5 items-center justify-center rounded-full border border-dashed border-muted-foreground text-muted-foreground'>
                      <Plus className='h-3 w-3' aria-hidden='true' />
                    </span>
                  )}
                </Button>
              }
            />
          ) : (
            <Tip key={option.value} tip={option.label}>
              <Button
                type='button'
                variant={null}
                size={null}
                data-testid={`generate-param-${name}-swatch-${option.value}`}
                aria-label={option.label}
                aria-pressed={shown === option.value}
                onClick={() => onChange({ [name]: option.value })}
                className={SWATCH}
              >
                <span
                  className={SWATCH_DOT}
                  style={{ background: LIGHT_COLORS[String(option.value)]?.swatch ?? AUTO_SWATCH }}
                />
              </Button>
            </Tip>
          ),
        )}
      </div>
    </div>
  );
}

interface TextControlProps {
  name: string;
  label: string;
  held: string;
  onChange: (partial: Record<string, unknown>) => void;
}

/**
 * A free-text param, written to the node when the reader leaves the box.
 *
 * One write per edit rather than per key: every write is a canvas undo entry,
 * and a word typed a letter at a time would push out everything else.
 * @param root0 - Props.
 * @param root0.name - The param name.
 * @param root0.label - Its name on screen.
 * @param root0.held - What the node holds.
 * @param root0.onChange - Called with the committed text.
 * @returns The row.
 */
function TextControl({ name, label, held, onChange }: TextControlProps): React.JSX.Element {
  const id = React.useId();
  const commitText = React.useCallback(
    (next: string): void => onChange({ [name]: next }),
    [onChange, name],
  );
  const box = useDraftBox(held, commitText);
  return (
    <div>
      <label htmlFor={id} className='mb-1.5 block text-xs font-medium text-muted-foreground'>
        {label}
      </label>
      <Input
        autoComplete='off'
        id={id}
        data-testid={`generate-param-${name}-input`}
        {...box}
        className='h-8 text-xs'
      />
    </div>
  );
}
