// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { SlidersHorizontal } from 'lucide-react';
import * as React from 'react';

import type { ModelEntry } from '@breatic/shared';

import { Button } from '@web/components/ui/button';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@web/components/ui/popover';
import { Slider } from '@web/components/ui/slider';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@web/components/ui/tooltip';
import { useTranslation } from '@web/i18n/use-translation';
import { suppressTooltipFocusOpen } from '@web/lib/overlay-focus';
import {
  audioParamControls,
  audioParamOptionLabelKey,
  formatAudioParam,
  type AudioParamControl,
} from '@web/spaces/canvas/generate/audio-params';
import { ParamOptionGroup } from '@web/spaces/canvas/generate/ParamOptionGroup';
import { useFollowCanvasViewport } from '@web/spaces/canvas/generate/use-follow-canvas-viewport';

/** What this picker edits, by the catalog's own param names. */
export type AudioParamsValue = Record<string, number>;

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
 * The audio panel's speaking-parameter picker (#1960): an icon that opens a
 * popover holding one control per param the active model declares.
 *
 * An icon rather than the value pill the video panel uses, matching the camera
 * cluster: `16:9 · 1080p` reads on its own, `0.50 · 0.75` does not — a number
 * with no name beside it says nothing about what it would do to the voice.
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

  const triggerClass =
    'flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-border ' +
    'text-muted-foreground transition-colors hover:bg-accent hover:text-foreground ' +
    'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring';

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button
              type='button'
              variant={null}
              size={null}
              data-testid='generate-audio-params-trigger'
              aria-label={t('canvas.generatePanel.voiceParams')}
              // This button is BOTH a TooltipTrigger and a PopoverTrigger:
              // suppress the tooltip's focus-open so closing the popover
              // (Escape returns focus here) does not pop a stray tooltip.
              onFocusCapture={suppressTooltipFocusOpen}
              className={triggerClass}
            >
              <SlidersHorizontal className='h-4 w-4' aria-hidden='true' />
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side='top'>
          {t('canvas.generatePanel.voiceParams')}
        </TooltipContent>
      </Tooltip>
      <PopoverContent
        side='top'
        align='center'
        // Freeze on open (user 2026-07-18): no collision flip/shift — clips at
        // the screen edge like the panel rather than jumping near a border.
        avoidCollisions={false}
        aria-label={t('canvas.generatePanel.voiceParams')}
        className='w-64 p-3'
      >
        {controls.map((control, index) => (
          <ParamControlRow
            key={control.name}
            control={control}
            label={t(control.labelKey)}
            value={shownValue(model, control.name, value[control.name])}
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
  value: number | undefined;
  onChange: (partial: AudioParamsValue) => void;
  /** The last row carries no bottom margin. */
  last: boolean;
}

/**
 * One parameter, in the form its declaration calls for.
 *
 * A short list of stops reuses {@link ParamOptionGroup} — the shape every
 * option-style param in this product already has — so a stability row and a
 * ratio row cannot drift apart. A range gets its name and current value on one
 * line with the slider under them, because a slider position alone does not
 * say what value it is at.
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

  if (control.kind === 'choice') {
    return (
      <ParamOptionGroup
        label={label}
        options={control.options.map((option) => {
          const key = audioParamOptionLabelKey(control.name, option);
          return {
            value: option,
            // A stop the vendor names reads by that name; one it does not
            // reads as the number it is.
            label: key ? t(key) : formatAudioParam(control.name, option),
          };
        })}
        value={value}
        onSelect={(next) => onChange({ [control.name]: Number(next) })}
        testIdPrefix={`generate-audio-${control.name}-option`}
        className={spacing}
      />
    );
  }

  return (
    <ParamSliderRow
      control={control}
      label={label}
      value={value}
      onChange={onChange}
      className={spacing}
    />
  );
}

/** What {@link ParamSliderRow} needs. */
interface ParamSliderRowProps {
  control: Extract<AudioParamControl, { kind: 'range' }>;
  label: string;
  value: number | undefined;
  onChange: (partial: AudioParamsValue) => void;
  className: string | undefined;
}

/**
 * One numeric param as a slider, written to the document once per gesture.
 *
 * A drag crosses every step between where it starts and where it ends, and
 * Radix reports each one. Each report written straight through is one canvas
 * undo entry — that stack holds 50 and merges nothing by time — so a single
 * drag of `volume` (41 stops) would push out nearly everything the user could
 * still undo. `onValueCommit` fires once when a gesture ends and once per key
 * press, which is the granularity a person would name as one change.
 * @param root0 - Props.
 * @param root0.control - The control this param calls for.
 * @param root0.label - The localized param name.
 * @param root0.value - The stored value.
 * @param root0.onChange - Called with the committed param.
 * @param root0.className - Row spacing.
 * @returns The row.
 */
function ParamSliderRow({
  control,
  label,
  value,
  onChange,
  className,
}: ParamSliderRowProps): React.JSX.Element {
  // Where the thumb sits until the gesture ends. Held apart from `value` so
  // the control follows the pointer while the document does not.
  const [dragged, setDragged] = React.useState<number | null>(null);
  const shown = dragged ?? value;

  // A key the browser is repeating, and the step the last repeat reached.
  const repeatingRef = React.useRef(false);
  const repeatedToRef = React.useRef<number | null>(null);

  const onValueChange = React.useCallback(([next]: number[]) => setDragged(next), []);

  const onValueCommit = React.useCallback(
    ([next]: number[]) => {
      // Radix commits on every repeat of a held key. The press is the
      // decision and the repeats are it continuing, so they wait for the
      // release rather than each becoming its own undo entry.
      if (repeatingRef.current) {
        repeatedToRef.current = next;
        return;
      }
      setDragged(null);
      onChange({ [control.name]: next });
    },
    [onChange, control.name],
  );

  const endKeyGesture = React.useCallback((): void => {
    repeatingRef.current = false;
    const reached = repeatedToRef.current;
    repeatedToRef.current = null;
    // Also where the draft is released: Radix reports a keyboard commit
    // BEFORE it reports the change, so clearing it inside the commit is
    // written straight back, and a draft left set shows this client's number
    // over whatever a collaborator stores.
    setDragged(null);
    if (reached !== null) onChange({ [control.name]: reached });
  }, [onChange, control.name]);

  // Four ways a key gesture ends, and every one of them has to write. Keyup
  // alone leaves the flag set when the release lands on another window, and
  // a set flag holds back every commit after it — the pointer's included, so
  // the thumb would move under drags the node never hears about.
  const onKeyDown = React.useCallback(
    (event: React.KeyboardEvent): void => {
      if (event.repeat) {
        repeatingRef.current = true;
        return;
      }
      endKeyGesture();
    },
    [endKeyGesture],
  );

  return (
    <div className={className}>
      <div className='mb-1.5 flex items-center justify-between'>
        <span className='text-xs font-medium text-muted-foreground'>{label}</span>
        <span
          data-testid={`generate-audio-${control.name}-value`}
          // Digits line up as the value changes rather than shifting the label.
          className='text-xs tabular-nums text-muted-foreground'
        >
          {shown === undefined ? '' : formatAudioParam(control.name, shown)}
        </span>
      </div>
      <Slider
        className='text-foreground'
        data-testid={`generate-audio-${control.name}-slider`}
        aria-label={label}
        min={control.min}
        max={control.max}
        step={control.step}
        value={shown === undefined ? [control.min] : [shown]}
        // Radix reports a value already rounded to the step's decimal count
        // (`roundValue(…, getDecimalCount(step))` in its own snapping), so the
        // float error of repeated addition never reaches here.
        onValueChange={onValueChange}
        onValueCommit={onValueCommit}
        onKeyDown={onKeyDown}
        onKeyUp={endKeyGesture}
        onBlur={endKeyGesture}
        onPointerDown={endKeyGesture}
      />
    </div>
  );
}
