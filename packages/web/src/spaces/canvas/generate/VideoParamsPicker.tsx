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
  ParamOptionGroup,
  type ParamOption,
} from '@web/spaces/canvas/generate/ParamOptionGroup';
import { ParamToggleRow } from '@web/spaces/canvas/generate/ParamToggleRow';
import { paramValues } from '@breatic/shared';
import { useFollowCanvasViewport } from '@web/spaces/canvas/generate/use-follow-canvas-viewport';

/** The subset of generate params this picker edits. */
export interface VideoParamsValue {
  aspect_ratio?: string;
  resolution?: string;
  /** Seconds — a number in every catalog family that declares it. */
  duration?: number;
  generate_audio?: boolean;
  /** Whether the reference clip's own audio survives into the result (#1928). */
  keep_original_sound?: boolean;
}

interface VideoParamsPickerProps {
  /** The current model, whose params define what is offered. */
  model: ModelEntry;
  /**
   * What a submission through this panel would carry, keyed as the model
   * declares it: the node's params reconciled against the model.
   *
   * The whole record rather than the handful this picker edits, so a switch
   * a control waits on is read out of the value the run carries.
   */
  params: Readonly<Record<string, unknown>>;
  /** Called with the changed field only. */
  onChange: (partial: VideoParamsValue) => void;
}

/**
 * Narrows a param value to a string.
 * @param value - The raw value.
 * @returns The string, or undefined when it is anything else.
 */
function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/**
 * Narrows a param value to a number — every catalog family states duration
 * numerically, and a string would be rejected by the provider.
 * @param value - The raw value.
 * @returns The number, or undefined when it is anything else.
 */
function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

/**
 * Narrows a param value to a boolean, reading anything else as off.
 * @param value - The raw value.
 * @returns True only for a literal true.
 */
function asBoolean(value: unknown): boolean {
  return value === true;
}

/**
 * The params this pill edits, each with how its control reads a raw value.
 *
 * Two readers take it from here: the has-anything check below, and the value
 * the container hands down. Those were separate hand-written lists until one
 * fell behind, which left `keep_original_sound` stuck off — the switch
 * rendered, reported its flip, and read back a value the container never
 * passed.
 *
 * The groups in the component are a third copy kept in step by hand: a group
 * whose name is missing here gets no pill at all, so a model declaring only
 * that param renders nothing.
 */
const READERS = {
  aspect_ratio: asString,
  resolution: asString,
  duration: asNumber,
  generate_audio: asBoolean,
  keep_original_sound: asBoolean,
} as const;

/** The names {@link READERS} covers, for the has-anything check below. */
export const EDITED_PARAMS = Object.keys(READERS) as ReadonlyArray<
  keyof typeof READERS
>;

/**
 * Whether this model offers that control right now.
 *
 * Two questions with one answer, asked the same way for every control here:
 * the model has to declare the param, and whatever it says the control waits
 * on has to be satisfied. The one condition a model names is a switch that
 * has to be on (`when.flag_on`): setting this control is wasted until it is.
 * A control declaring no condition waits on nothing, which is how the catalog
 * projection reads an absent `when` too.
 * @param model - The current model, for what its control declares.
 * @param params - What a submission would carry.
 * @param param - The control's name.
 * @returns True when the control is ready to be drawn.
 */
function offers(
  model: ModelEntry,
  params: Readonly<Record<string, unknown>>,
  param: string,
): boolean {
  if (model.params?.[param] == null) return false;
  const flag = model.params[param].when?.flag_on;
  if (flag === undefined) return true;
  // A switch the record does not carry counts as whatever the model defaults
  // it to, the same fallback the agent's proposal check makes.
  return typeof params[flag] === 'boolean'
    ? params[flag] === true
    : model.params[flag]?.default === true;
}

/**
 * Reads the values this picker edits off a model's resolved params.
 *
 * Each value goes through its own narrowing, so a catalog or a collaborator
 * writing the wrong shape leaves that one control unset instead of putting a
 * string where a number is read.
 * @param params - The model's resolved params, as the view model builds them.
 * @returns Just the values this picker edits.
 */
export function editedParams(
  params: Readonly<Record<string, unknown>>,
): VideoParamsValue {
  const value: Record<string, unknown> = {};
  for (const [name, read] of Object.entries(READERS)) {
    value[name] = read(params[name]);
  }
  return value as VideoParamsValue;
}

/**
 * Whether this pill would have anything to show for a model (#1935).
 *
 * Each group already renders nothing when its model declares no options — see
 * this component's own rule, "a model that does not declare a parameter simply
 * has no group for it". This is the same question one level up, for the pill
 * that holds the groups: a model declaring none of them (the talking-head one
 * declares two sources and a seed, none of which this pill edits) would
 * otherwise get a pill with an empty label that opens onto nothing.
 * @param model - The model the panel currently has selected.
 * @returns True when the model declares at least one param this pill edits.
 */
export function videoParamsPickerHasOptions(model: ModelEntry): boolean {
  return EDITED_PARAMS.some((name) => model.params?.[name] != null);
}

/**
 * The video panel's parameter picker: a pill showing the current
 * `ratio · resolution · duration` that opens a popover with those three as
 * identically-shaped option rows, followed by up to two switch rows.
 *
 * A group appears only when the active model declares its param, so a model
 * that does not simply has no group for it — several video models declare no
 * resolution, and not all of them can generate sound.
 * @param root0 - Component props.
 * @param root0.model - The current model.
 * @param root0.params - The node's params for this model.
 * @param root0.onChange - Called with the changed field.
 * @returns The video params picker.
 */
export const VideoParamsPicker = React.memo(function VideoParamsPicker({
  model,
  params,
  onChange,
}: VideoParamsPickerProps): React.JSX.Element {
  const t = useTranslation();
  const [open, setOpen] = React.useState(false);
  // Keep the popover glued to its trigger as the canvas pans / zooms, matching
  // the generate panel (a ReactFlow NodeToolbar that tracks its node).
  useFollowCanvasViewport(open);

  const value = editedParams(params);

  // Ratios and resolutions are strings in the catalog; duration is a number,
  // and it keeps that type all the way to the payload (a provider given "6"
  // where it expects 6 is a rejected request).
  const ratios: ParamOption[] = offers(model, params, 'aspect_ratio')
    ? paramValues(model, 'aspect_ratio').map((v) => ({ value: String(v), label: String(v) }))
    : [];
  const resolutions: ParamOption[] = offers(model, params, 'resolution')
    ? paramValues(model, 'resolution').map((v) => ({ value: String(v), label: String(v) }))
    : [];
  const durations: ParamOption[] = offers(model, params, 'duration')
    ? paramValues(model, 'duration')
      .filter((v): v is number => typeof v === 'number')
      .map((v) => ({ value: v, label: t('canvas.generatePanel.durationSeconds', { n: v }) }))
    : [];
  const audioSupported = offers(model, params, 'generate_audio');
  const keepSoundOffered = offers(model, params, 'keep_original_sound');

  // Every gap in this popover is the preceding block's `mb-3`, carried only
  // while something follows. A group renders nothing when the model declares
  // no options for it, so what follows is read off the options rather than off
  // the group being written — otherwise the last thing rendered leaves room
  // under itself that the popover's own padding never asked for (#2115).
  const switchesShown = audioSupported || keepSoundOffered;

  // The trigger states only what this model actually has: a fixed
  // `ratio · resolution · duration` shape would show gaps for the several
  // models that declare no resolution.
  const durationLabel =
    typeof value.duration === 'number'
      ? t('canvas.generatePanel.durationSeconds', { n: value.duration })
      : undefined;
  const label = [
    ratios.length > 0 ? value.aspect_ratio : undefined,
    resolutions.length > 0 ? value.resolution : undefined,
    durations.length > 0 ? durationLabel : undefined,
  ]
    .filter(Boolean)
    .join(' · ');

  const onSelectRatio = React.useCallback(
    (v: string | number) => onChange({ aspect_ratio: String(v) }),
    [onChange],
  );
  const onSelectResolution = React.useCallback(
    (v: string | number) => onChange({ resolution: String(v) }),
    [onChange],
  );
  const onSelectDuration = React.useCallback(
    (v: string | number) => onChange({ duration: Number(v) }),
    [onChange],
  );

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type='button'
          variant={null}
          size={null}
          data-testid='generate-video-params-trigger'
          className='flex h-8 shrink-0 items-center gap-1 whitespace-nowrap rounded-full border border-border bg-background px-2.5 text-xs text-foreground transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring'
        >
          {/* truncate: catalog values carry no length cap at the sanitize
              boundary — unbounded, a verbose value would stretch the footer. */}
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
        // the screen edge like the generate panel instead of jumping near a border.
        avoidCollisions={false}
        aria-label={t('canvas.generatePanel.videoParams')}
        className='w-64 p-3 shadow-md'
      >
        <ParamOptionGroup
          label={t('canvas.generatePanel.ratio')}
          options={ratios}
          value={value.aspect_ratio}
          onSelect={onSelectRatio}
          testIdPrefix='generate-video-ratio-option'
          className={
            resolutions.length > 0 || durations.length > 0 || switchesShown
              ? 'mb-3'
              : undefined
          }
        />
        <ParamOptionGroup
          label={t('canvas.generatePanel.resolution')}
          options={resolutions}
          value={value.resolution}
          onSelect={onSelectResolution}
          testIdPrefix='generate-video-resolution-option'
          className={durations.length > 0 || switchesShown ? 'mb-3' : undefined}
        />
        <ParamOptionGroup
          label={t('canvas.generatePanel.duration')}
          options={durations}
          value={value.duration}
          onSelect={onSelectDuration}
          testIdPrefix='generate-video-duration-option'
          className={switchesShown ? 'mb-3' : undefined}
        />
        {audioSupported ? (
          <ParamToggleRow
            id='generate-video-audio-toggle'
            label={t('canvas.generatePanel.generateAudio')}
            checked={value.generate_audio === true}
            onCheckedChange={(checked) => onChange({ generate_audio: checked })}
            className={keepSoundOffered ? 'mb-3' : undefined}
          />
        ) : null}
        {keepSoundOffered ? (
          <ParamToggleRow
            id='generate-video-keep-original-sound-toggle'
            label={t('canvas.generatePanel.keepOriginalSound')}
            checked={value.keep_original_sound === true}
            onCheckedChange={(checked) =>
              onChange({ keep_original_sound: checked })
            }
          />
        ) : null}
      </PopoverContent>
    </Popover>
  );
});
