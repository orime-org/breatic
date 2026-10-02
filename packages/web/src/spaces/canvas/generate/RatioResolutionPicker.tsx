// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { ChevronDown, ChevronLeft, ChevronRight } from 'lucide-react';
import * as React from 'react';

import type { ModelEntry } from '@breatic/shared';

import { Button } from '@web/components/ui/button';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@web/components/ui/popover';
import { useTranslation } from '@web/i18n/use-translation';
import { cn } from '@web/lib/utils';
import {
  CameraPicker,
  cameraSummary,
  CAMERA_SWITCH_PARAM,
  type CameraValue,
} from '@web/spaces/canvas/generate/CameraPicker';
import {
  ParamOptionGroup,
  type ParamOption,
} from '@web/spaces/canvas/generate/ParamOptionGroup';
import { paramValues } from '@breatic/shared';
import { PARAMS_PILL_CLASS } from '@web/spaces/canvas/generate/generate-tools';
import { ModelParamControls } from '@web/spaces/canvas/generate/ModelParamControls';
import { optionLabel, ownControlSummary } from '@web/spaces/canvas/generate/model-controls';
import { useFollowCanvasViewport } from '@web/spaces/canvas/generate/use-follow-canvas-viewport';
import { useSecondPanelSide } from '@web/spaces/canvas/generate/use-second-panel-side';

/** The subset of generate params this picker edits. */
interface RatioResolutionValue extends CameraValue {
  aspect_ratio?: string;
  resolution?: string;
}

/** The key the camera panel opens under, for the side it opens on. */
const CAMERA_PANEL = 'camera';

/**
 * How far the camera panel reaches beside the popover: its
 * `w-[min(520px,88vw)]` plus the `ml-2` / `mr-2` gap, at the window's width now.
 * @returns The span in pixels.
 */
function cameraPanelSpan(): number {
  return Math.min(520, window.innerWidth * 0.88) + 8;
}

interface RatioResolutionPickerProps {
  /** The current model, whose params define the allowed ratios / resolutions. */
  model: ModelEntry;
  /** What the node holds for this model: ratio and resolution, and the model's own params. */
  value: RatioResolutionValue & Readonly<Record<string, unknown>>;
  /** Called with the changed field only. */
  onChange: (partial: object) => void;
  /** Whether the model has the camera, which adds the row that opens its panel. */
  cameraSupported: boolean;
}

/**
 * The two params this picker draws a row for, as `[ratio, resolution]`.
 *
 * Read by position below, so the pair is an order this file fixes rather than
 * a description of one: the popover renders the resolution row first.
 *
 * Exported so the list the agent is answered out of can be pinned against what
 * this component actually draws.
 */
export const RATIO_RESOLUTION_PARAMS = ['aspect_ratio', 'resolution'] as const;

/**
 * The Generate panel's ratio + resolution picker: a pill showing the current
 * `ratio · resolution` that opens a popover with a resolution segmented row and
 * a ratio grid, both sourced from the current model's params (a model without a
 * given param omits that section). A model with the camera adds a row that
 * opens the camera panel beside the popover, like the audio panel's voice row
 * (#2254). Closes on Escape or an outside click.
 * @param root0 - Component props.
 * @param root0.model - The current model.
 * @param root0.value - The current ratio + resolution.
 * @param root0.onChange - Called with the changed field.
 * @param root0.cameraSupported - Whether to draw the camera row.
 * @returns The ratio + resolution picker.
 */
export const RatioResolutionPicker = React.memo(function RatioResolutionPicker({
  model,
  value,
  onChange,
  cameraSupported,
}: RatioResolutionPickerProps): React.JSX.Element {
  const t = useTranslation();
  const [open, setOpen] = React.useState(false);
  const [cameraOpen, setCameraOpen] = React.useState(false);
  const [firstPanelRef, cameraOnLeft] = useSecondPanelSide(
    cameraOpen ? CAMERA_PANEL : null,
    cameraPanelSpan,
  );
  const cameraOn = value[CAMERA_SWITCH_PARAM] === true;
  const handleOpenChange = React.useCallback((next: boolean) => {
    setOpen(next);
    if (!next) setCameraOpen(false);
  }, []);
  // Keep the popover glued to its trigger as the canvas pans / zooms, matching
  // the generate panel (a ReactFlow NodeToolbar that tracks its node).
  useFollowCanvasViewport(open);
  // Image ratios / resolutions are strings in the catalog; String() is a
  // no-op for them and keeps this control honest if one ever is not.
  const [ratioParam, resolutionParam] = RATIO_RESOLUTION_PARAMS;
  const ratios: ParamOption[] = paramValues(model, ratioParam).map((v) => ({
    value: String(v),
    label: optionLabel({}, String(v)),
  }));
  const resolutions: ParamOption[] = paramValues(model, resolutionParam).map((v) => ({
    value: String(v),
    label: String(v),
  }));
  // A model with none of the shared two still has its own controls to open.
  // The pill reads in the popover's order, top to bottom.
  const label =
    [
      value.resolution,
      value.aspect_ratio === undefined ? undefined : optionLabel({}, value.aspect_ratio),
      ...ownControlSummary(model, value, (name) => t(`canvas.generatePanel.param.${name}`)),
      cameraSupported && cameraOn ? t('canvas.generatePanel.camera') : undefined,
    ]
      .filter(Boolean)
      .join(' · ') || t('canvas.generatePanel.imageParams');
  const onSelectRatio = React.useCallback(
    (v: string | number) => onChange({ aspect_ratio: String(v) }),
    [onChange],
  );
  const onSelectResolution = React.useCallback(
    (v: string | number) => onChange({ resolution: String(v) }),
    [onChange],
  );
  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <Button
          type='button'
          variant={null}
          size={null}
          data-testid='generate-ratio-trigger'
          className={PARAMS_PILL_CLASS}
        >
          {/* truncate: catalog aspect_ratio/resolution values carry no length
              cap at the sanitize boundary — unbounded, a verbose value would
              stretch the panel footer row (same class as the ModelPicker
              display_name fix). */}
          <span className='truncate'>{label}</span>
          <ChevronDown
            className='h-3.5 w-3.5 shrink-0 opacity-60'
            aria-hidden='true'
          />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        ref={firstPanelRef}
        side='top'
        align='center'
        // Freeze on open (user 2026-07-18): no collision flip/shift — clips at
        // the screen edge like the generate panel instead of jumping near a border.
        avoidCollisions={false}
        aria-label={t('canvas.generatePanel.ratio')}
        className='relative w-64 p-3 shadow-md'
      >
        <ParamOptionGroup
          label={t('canvas.generatePanel.resolution')}
          options={resolutions}
          value={value.resolution}
          onSelect={onSelectResolution}
          testIdPrefix='generate-resolution-option'
          className='mb-3'
        />
        <ParamOptionGroup
          label={t('canvas.generatePanel.ratio')}
          options={ratios}
          value={value.aspect_ratio}
          onSelect={onSelectRatio}
          testIdPrefix='generate-ratio-option'
        />
        <ModelParamControls
          model={model}
          value={value}
          onChange={onChange}
          className={ratios.length + resolutions.length > 0 ? 'mt-3 border-t border-border pt-3' : undefined}
        />
        {cameraSupported ? (
          <div className={ratios.length + resolutions.length > 0 ? 'mt-3 border-t border-border pt-2' : undefined}>
            <Button
              type='button'
              variant='ghost'
              size='menu-item'
              aria-expanded={cameraOpen}
              data-testid='generate-camera-row'
              className={cn(
                'grid w-full grid-cols-[72px_minmax(0,1fr)_16px] items-center gap-2 px-1',
                cameraOpen && 'bg-accent',
              )}
              onClick={() => setCameraOpen((was) => !was)}
            >
              <span
                className={cn(
                  'truncate text-left text-xs font-medium',
                  cameraOpen ? 'text-foreground' : 'text-muted-foreground',
                )}
              >
                {t('canvas.generatePanel.camera')}
              </span>
              <span className={cn('truncate text-left', !cameraOn && 'text-muted-foreground')}>
                {cameraOn ? cameraSummary(value) : t('canvas.generatePanel.switchOff')}
              </span>
              {cameraOnLeft ? (
                <ChevronLeft className='h-3.5 w-3.5 opacity-60' aria-hidden='true' />
              ) : (
                <ChevronRight className='h-3.5 w-3.5 opacity-60' aria-hidden='true' />
              )}
            </Button>
          </div>
        ) : null}
        {cameraSupported && cameraOpen ? (
          <div
            data-testid='generate-camera-panel'
            data-side={cameraOnLeft ? 'left' : 'right'}
            className={cn(
              'absolute bottom-0 w-[min(520px,88vw)] rounded-overlay border border-border bg-popover p-4 text-popover-foreground shadow-md',
              cameraOnLeft ? 'right-full mr-2' : 'left-full ml-2',
            )}
          >
            <CameraPicker model={model} value={value} onChange={onChange} />
          </div>
        ) : null}
      </PopoverContent>
    </Popover>
  );
});
