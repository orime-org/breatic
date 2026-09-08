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
import type { VideoSlotUrls } from '@web/spaces/canvas/generate/video-slots';
import {
  ParamOptionGroup,
  type ParamOption,
} from '@web/spaces/canvas/generate/ParamOptionGroup';
import { ParamToggleRow } from '@web/spaces/canvas/generate/ParamToggleRow';
import { paramValues } from '@web/spaces/canvas/generate/param-values';
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
  /** The current selection. */
  value: VideoParamsValue;
  /**
   * What the node's slots hold (#1928).
   *
   * `keep_original_sound` describes the reference clip's audio, so it means
   * nothing until one is picked — the only param here whose offer depends on
   * something outside the model's own declaration.
   */
  slotUrls: VideoSlotUrls;
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
 * Reads the values this picker edits off a model's resolved params.
 *
 * Exported because the container has to hand the picker a referentially
 * stable object — the panel is memoized — and it has no business keeping its
 * own idea of which params this component edits.
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
 * identically-shaped option rows plus the audio switch.
 *
 * Every option comes from the active model's own param definitions, so a model
 * that does not declare a parameter simply has no group for it — several video
 * models declare no resolution, and not all of them can generate sound.
 * @param root0 - Component props.
 * @param root0.model - The current model.
 * @param root0.value - The current selection.
 * @param root0.onChange - Called with the changed field.
 * @returns The video params picker.
 */
export const VideoParamsPicker = React.memo(function VideoParamsPicker({
  model,
  value,
  slotUrls,
  onChange,
}: VideoParamsPickerProps): React.JSX.Element {
  const t = useTranslation();
  const [open, setOpen] = React.useState(false);
  // Keep the popover glued to its trigger as the canvas pans / zooms, matching
  // the generate panel (a ReactFlow NodeToolbar that tracks its node).
  useFollowCanvasViewport(open);

  // Ratios and resolutions are strings in the catalog; duration is a number,
  // and it keeps that type all the way to the payload (a provider given "6"
  // where it expects 6 is a rejected request).
  const ratios: ParamOption[] = paramValues(model, 'aspect_ratio').map((v) => ({
    value: String(v),
    label: String(v),
  }));
  const resolutions: ParamOption[] = paramValues(model, 'resolution').map((v) => ({
    value: String(v),
    label: String(v),
  }));
  const durations: ParamOption[] = paramValues(model, 'duration')
    .filter((v): v is number => typeof v === 'number')
    .map((v) => ({
      value: v,
      label: t('canvas.generatePanel.durationSeconds', { n: v }),
    }));
  const audioSupported = model.params?.generate_audio != null;
  // Two conditions, and the second is what makes this switch different from
  // the one above it: the model has to declare the param AND a clip has to be
  // picked, because the setting describes that clip's audio (#1928).
  const keepSoundOffered =
    model.params?.keep_original_sound != null &&
    Boolean(slotUrls.referenceVideo);

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
        className='w-64 p-3'
      >
        <ParamOptionGroup
          label={t('canvas.generatePanel.ratio')}
          options={ratios}
          value={value.aspect_ratio}
          onSelect={onSelectRatio}
          testIdPrefix='generate-video-ratio-option'
          className='mb-3'
        />
        <ParamOptionGroup
          label={t('canvas.generatePanel.resolution')}
          options={resolutions}
          value={value.resolution}
          onSelect={onSelectResolution}
          testIdPrefix='generate-video-resolution-option'
          className='mb-3'
        />
        <ParamOptionGroup
          label={t('canvas.generatePanel.duration')}
          options={durations}
          value={value.duration}
          onSelect={onSelectDuration}
          testIdPrefix='generate-video-duration-option'
          // Every gap in this popover is the preceding block's `mb-3`, carried
          // only while something follows it: one convention, and no group's
          // spacing depends on a group it does not itself decide.
          className={audioSupported || keepSoundOffered ? 'mb-3' : undefined}
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
