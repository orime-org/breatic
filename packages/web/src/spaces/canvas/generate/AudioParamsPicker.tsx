// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { ChevronDown } from 'lucide-react';
import * as React from 'react';

import type { ModelEntry } from '@breatic/shared';

import { Button } from '@web/components/ui/button';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@web/components/ui/popover';
import { useTranslation } from '@web/i18n/use-translation';
import {
  audioFlagValue,
  audioParamControls,
  formatAudioParam,
  type AudioParamControl,
} from '@web/spaces/canvas/generate/audio-params';
import { ParamOptionGroup } from '@web/spaces/canvas/generate/ParamOptionGroup';
import { ParamSliderRow } from '@web/spaces/canvas/generate/ParamSliderRow';
import { ParamToggleRow } from '@web/spaces/canvas/generate/ParamToggleRow';
import { useFollowCanvasViewport } from '@web/spaces/canvas/generate/use-follow-canvas-viewport';

/**
 * What this picker edits, by the catalog's own param names.
 *
 * Booleans as well as numbers since #1960: the music models take a switch
 * ("no vocals at all"), which is a decision rather than a quantity.
 */
export type AudioParamsValue = Record<string, number | boolean>;

interface AudioParamsPickerProps {
  /** The current model, whose declarations decide what is offered. */
  model: ModelEntry;
  /**
   * Everything the node holds for the active model, by param name.
   *
   * Not {@link AudioParamsValue}: one record holds every param the model
   * declares, and the voice id among them is a string. Only the numeric ones
   * reach a control here, and {@link shownValue} is what decides that.
   */
  value: Record<string, unknown>;
  /** Called with the changed param only. */
  onChange: (partial: AudioParamsValue) => void;
}

/**
 * The value a control shows: what the node holds, or what the model would use.
 *
 * A node made before this control existed holds nothing, and an empty slider
 * would say the value is at its floor when the model will in fact send its
 * default. The default is read off the same descriptor the bounds came from.
 * @param model - The active model.
 * @param name - The param name.
 * @param held - What the node holds for it, if anything.
 * @returns The number to show, or undefined when neither is a number.
 */
function shownValue(
  model: ModelEntry,
  name: string,
  held: unknown,
): number | undefined {
  if (typeof held === 'number') return held;
  const fallback = model.params?.[name]?.default;
  return typeof fallback === 'number' ? fallback : undefined;
}

/**
 * The audio panel's parameter picker (#1960): a pill printing what
 * the params are set to, opening a popover holding one control per param the
 * active model declares.
 *
 * The pill is the shape VideoParamsPicker uses, down to the class string —
 * the same slot in the same row of the same panel family. Values read in
 * their own units, so the label is `0.50 · 0.75` for a voice and `1.00x ·
 * +2 dB` for the model that speaks in those.
 *
 * Which params appear, and whether one is a row of stops or a slider, comes
 * from the model's own declaration (see `audio-params.ts`). Nothing here knows
 * that ElevenLabs takes two and Fish takes two others.
 * @param root0 - Component props.
 * @param root0.model - The current model.
 * @param root0.value - The current selection.
 * @param root0.onChange - Called with the changed param.
 * @returns The picker, or null when this model declares nothing it can show.
 */
export const AudioParamsPicker = React.memo(function AudioParamsPicker({
  model,
  value,
  onChange,
}: AudioParamsPickerProps): React.JSX.Element | null {
  const t = useTranslation();
  const [open, setOpen] = React.useState(false);
  // Keep the popover glued to its trigger as the canvas pans / zooms, matching
  // the panel it sits in (a ReactFlow NodeToolbar that tracks its node).
  useFollowCanvasViewport(open);

  const controls = audioParamControls(model);
  // No empty pill that opens onto nothing: a model declaring none of these has
  // no picker at all (the same rule the video params pill follows).
  if (controls.length === 0) return null;

  const label = controls
    .map((control) => {
      // A switch reads as the state it is in, which is how every other pill
      // here reads: the current value. Its value is a boolean rather than a
      // number, and that is the only difference.
      if (control.kind === 'toggle') {
        return formatAudioParam(
          control.name,
          audioFlagValue(model, control.name, value[control.name]),
          t,
        );
      }
      const shown = shownValue(model, control.name, value[control.name]);
      if (shown === undefined) return undefined;
      return formatAudioParam(control.name, shown, t);
    })
    .filter(Boolean)
    .join(' · ');

  const triggerClass =
    'flex h-8 shrink-0 items-center gap-1 whitespace-nowrap rounded-full border border-border ' +
    'bg-background px-2.5 text-xs text-foreground transition-colors hover:bg-accent ' +
    'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring';

  return (
    <Popover open={open} onOpenChange={setOpen}>
      {/* No tooltip, as on the other three pills in this row: the values are
          printed on the face, and the label names what they belong to. */}
      <PopoverTrigger asChild>
        <Button
          type='button'
          variant={null}
          size={null}
          data-testid='generate-audio-params-trigger'
          aria-label={t('canvas.generatePanel.audioParams')}
          className={triggerClass}
        >
          {/* truncate: a vendor could name a stop at any length, and the
              footer has five other controls to fit. */}
          <span className='max-w-[12rem] truncate'>{label}</span>
          <ChevronDown
            className='h-3.5 w-3.5 shrink-0 opacity-60'
            aria-hidden='true'
          />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        side='top'
        align='center'
        // Freeze on open (user 2026-07-18): no collision flip/shift — clips at
        // the screen edge like the panel rather than jumping near a border.
        avoidCollisions={false}
        aria-label={t('canvas.generatePanel.audioParams')}
        // The same width as the image and video params popovers.
        className='w-64 p-3 shadow-md'
      >
        {controls.map((control, index) => (
          <ParamControlRow
            key={control.name}
            control={control}
            label={t(control.labelKey)}
            value={
              control.kind === 'toggle'
                ? audioFlagValue(model, control.name, value[control.name])
                : shownValue(model, control.name, value[control.name])
            }
            onChange={onChange}
            last={index === controls.length - 1}
          />
        ))}
      </PopoverContent>
    </Popover>
  );
});

interface ParamControlRowProps {
  control: AudioParamControl;
  label: string;
  /** What this param is currently set to: a boolean on a switch, else a number. */
  value: number | boolean | undefined;
  onChange: (partial: AudioParamsValue) => void;
  /** The last row carries no bottom margin. */
  last: boolean;
}

/**
 * One parameter, in the form its declaration calls for.
 *
 * A param stating a short list of values reuses {@link ParamOptionGroup} — the
 * shape every option-style param in this product already has — so it cannot
 * drift from the ratio and camera rows. A range gets its name and current
 * value on one line with the slider under them, because a slider position
 * alone does not say what value it is at.
 * @param root0 - Component props.
 * @param root0.control - The control this param calls for.
 * @param root0.label - The localized param name.
 * @param root0.value - The value to show.
 * @param root0.onChange - Called with the changed param.
 * @param root0.last - Whether this is the last row.
 * @returns The row.
 */
function ParamControlRow({
  control,
  label,
  value,
  onChange,
  last,
}: ParamControlRowProps): React.JSX.Element {
  const t = useTranslation();
  const spacing = last ? undefined : 'mb-3';

  if (control.kind === 'toggle') {
    return (
      <ParamToggleRow
        id={`generate-audio-${control.name}-toggle`}
        label={label}
        checked={value === true}
        onCheckedChange={(next) => onChange({ [control.name]: next })}
        className={spacing}
      />
    );
  }

  // Past the switch branch the value is a number or absent: a boolean reaches
  // this row only on a toggle, and that branch has returned.
  const shown = typeof value === 'number' ? value : undefined;

  if (control.kind === 'choice') {
    return (
      <ParamOptionGroup
        label={label}
        options={control.options.map((option) => ({
          value: option,
          label: formatAudioParam(control.name, option, t),
        }))}
        value={shown}
        onSelect={(next) => onChange({ [control.name]: Number(next) })}
        testIdPrefix={`generate-audio-${control.name}-option`}
        className={spacing}
      />
    );
  }

  return (
    <ParamSliderRow
      name={control.name}
      label={label}
      min={control.min}
      max={control.max}
      step={control.step}
      stops={control.stops?.map((stop) => ({ value: stop.value, label: t(stop.labelKey) }))}
      value={shown}
      format={(v) => formatAudioParam(control.name, v, t)}
      onChange={onChange}
      testIdPrefix='generate-audio'
      className={spacing}
    />
  );
}
