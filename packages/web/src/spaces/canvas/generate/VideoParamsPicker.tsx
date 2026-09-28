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
import { modelControls } from '@web/spaces/canvas/generate/model-controls';
import { ModelParamControls } from '@web/spaces/canvas/generate/ModelParamControls';
import { useFollowCanvasViewport } from '@web/spaces/canvas/generate/use-follow-canvas-viewport';

/** The subset of generate params this picker edits. */
export interface VideoParamsValue {
  aspect_ratio?: string;
  resolution?: string;
  /** Seconds — a number in every catalog family that declares it. */
  duration?: number;
  generate_audio?: boolean;
}

interface VideoParamsPickerProps {
  /** The current model, whose params define what is offered. */
  model: ModelEntry;
  /**
   * What a submission through this panel would carry, keyed as the model
   * declares it: the node's params reconciled against the model. The whole
   * record, so the model's own controls read their values out of it too.
   */
  params: Readonly<Record<string, unknown>>;
  /** Whether the length is set elsewhere — by a storyboard's shots — and so offered read-only. */
  durationLocked?: boolean;
  /** Called with the changed field only. */
  onChange: (partial: object) => void;
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
 * the container hands down, so the two cannot fall out of step.
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
} as const;

/** The names {@link READERS} covers, for the has-anything check below. */
export const EDITED_PARAMS = Object.keys(READERS) as ReadonlyArray<
  keyof typeof READERS
>;

/**
 * Whether this model offers that control.
 * @param model - The current model.
 * @param param - The control's name.
 * @returns True when the model declares the param.
 */
function offers(model: ModelEntry, param: string): boolean {
  return model.params?.[param] != null;
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
  return value;
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
  return (
    EDITED_PARAMS.some((name) => model.params?.[name] != null) ||
    modelControls(model).length > 0
  );
}

/**
 * The video panel's parameter picker: a pill showing the current
 * `ratio · resolution · duration` that opens a popover with those three as
 * identically-shaped option rows, followed by the sound switch and the
 * controls only this model has.
 *
 * A group appears only when the active model declares its param, so a model
 * that does not simply has no group for it — several video models declare no
 * resolution, and not all of them can generate sound.
 * @param root0 - Component props.
 * @param root0.model - The current model.
 * @param root0.params - The node's params for this model.
 * @param root0.durationLocked - Whether the length is set by a storyboard.
 * @param root0.onChange - Called with the changed field.
 * @returns The video params picker.
 */
export const VideoParamsPicker = React.memo(function VideoParamsPicker({
  model,
  params,
  durationLocked = false,
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
  const ratios: ParamOption[] = offers(model, 'aspect_ratio')
    ? paramValues(model, 'aspect_ratio').map((v) => ({ value: String(v), label: String(v) }))
    : [];
  const resolutions: ParamOption[] = offers(model, 'resolution')
    ? paramValues(model, 'resolution').map((v) => ({ value: String(v), label: String(v) }))
    : [];
  const durations: ParamOption[] = offers(model, 'duration')
    ? paramValues(model, 'duration')
      .filter((v): v is number => typeof v === 'number')
      .map((v) => ({ value: v, label: t('canvas.generatePanel.durationSeconds', { n: v }) }))
    : [];
  const audioSupported = offers(model, 'generate_audio');
  // While a storyboard is on its shots set the length, so the trigger still
  // states it and the popover offers no way to change it.
  const durationChoices = durationLocked ? [] : durations;

  // Every gap in this popover is the preceding block's `mb-3`, carried only
  // while something follows. A group renders nothing when the model declares
  // no options for it, so what follows is read off the options rather than off
  // the group being written — otherwise the last thing rendered leaves room
  // under itself that the popover's own padding never asked for (#2115).

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
    .join(' · ') || t('canvas.generatePanel.videoParams');
  const sharedShown =
    ratios.length + resolutions.length + durationChoices.length > 0 || audioSupported;

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
            resolutions.length > 0 || durationChoices.length > 0 || audioSupported
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
          className={durationChoices.length > 0 || audioSupported ? 'mb-3' : undefined}
        />
        <ParamOptionGroup
          label={t('canvas.generatePanel.duration')}
          options={durationChoices}
          value={value.duration}
          onSelect={onSelectDuration}
          testIdPrefix='generate-video-duration-option'
          className={audioSupported ? 'mb-3' : undefined}
        />
        {audioSupported ? (
          <ParamToggleRow
            id='generate-video-audio-toggle'
            label={t('canvas.generatePanel.generateAudio')}
            checked={value.generate_audio === true}
            onCheckedChange={(checked) => onChange({ generate_audio: checked })}
          />
        ) : null}
        <ModelParamControls
          model={model}
          value={params}
          onChange={onChange}
          className={sharedShown ? 'mt-3 border-t border-border pt-3' : undefined}
        />
      </PopoverContent>
    </Popover>
  );
});
