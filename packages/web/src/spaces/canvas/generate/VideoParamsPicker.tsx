// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { ChevronDown } from 'lucide-react';
import * as React from 'react';

import type { ModelEntry } from '@breatic/shared';

import { Button } from '@web/components/ui/button';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@web/components/ui/popover';
import { Switch } from '@web/components/ui/switch';
import { useTranslation } from '@web/i18n/use-translation';
import {
  ParamOptionGroup,
  type ParamOption,
} from '@web/spaces/canvas/generate/ParamOptionGroup';
import { paramValues } from '@web/spaces/canvas/generate/param-values';
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
  /** The current selection. */
  value: VideoParamsValue;
  /** Called with the changed field only. */
  onChange: (partial: VideoParamsValue) => void;
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
/** The params this pill edits. Named once so the check below cannot drift. */
const EDITED_PARAMS = [
  'aspect_ratio',
  'resolution',
  'duration',
  'generate_audio',
] as const;

/**
 * Whether this pill would have anything to show for a model (#1935).
 *
 * Each group already renders nothing when its model declares no options — see
 * this component's own rule, "a model that does not declare a parameter simply
 * has no group for it". This is the same question one level up, for the pill
 * that holds the groups: a model declaring none of them (the talking-head one
 * declares only its two sources) would otherwise get a pill with an empty
 * label that opens onto nothing.
 * @param model - The model the panel currently has selected.
 * @returns True when the model declares at least one param this pill edits.
 */
export function videoParamsPickerHasOptions(model: ModelEntry): boolean {
  return EDITED_PARAMS.some((name) => model.params?.[name] != null);
}

export const VideoParamsPicker = React.memo(function VideoParamsPicker({
  model,
  value,
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
          className={audioSupported ? 'mb-3' : undefined}
        />
        {audioSupported ? (
          <div>
            <p className='mb-1.5 text-xs font-medium text-muted-foreground'>
              {t('canvas.generatePanel.generateAudio')}
            </p>
            {/* Word left of the switch, matching the camera picker's switch. */}
            <label className='flex w-fit cursor-pointer items-center gap-2'>
              <span className='text-xs text-muted-foreground'>
                {value.generate_audio
                  ? t('canvas.generatePanel.switchOn')
                  : t('canvas.generatePanel.switchOff')}
              </span>
              <Switch
                data-testid='generate-video-audio-toggle'
                checked={value.generate_audio === true}
                onCheckedChange={(checked) =>
                  onChange({ generate_audio: checked })
                }
              />
            </label>
          </div>
        ) : null}
      </PopoverContent>
    </Popover>
  );
});
