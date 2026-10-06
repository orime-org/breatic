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
import { modelControls, optionLabel, ownControlSummary } from '@web/spaces/canvas/generate/model-controls';
import { useFollowCanvasViewport } from '@web/spaces/canvas/generate/use-follow-canvas-viewport';
import { SecondPanelFrame, SecondPanelRow, useSecondPanelSide } from '@web/spaces/canvas/generate/second-panel';

/** The subset of generate params this picker edits. */
interface RatioResolutionValue extends CameraValue {
  aspect_ratio?: string;
  resolution?: string;
}

/** A line under the shared ratio / resolution, before the model's own section. */
const SECTION_BREAK = 'mt-3 border-t border-border pt-3';

/** The key the camera panel opens under, for the side it opens on. */
const CAMERA_PANEL = 'camera';

/** The camera panel's width in pixels, room for four wheels in a line. */
const CAMERA_PANEL_WIDTH = 520;

interface RatioResolutionPickerProps {
  /** The current model, whose params define the allowed ratios / resolutions. */
  model: ModelEntry;
  /** The mode the panel is in; a control declared only for other modes is not drawn. */
  mode: string;
  /** What the node holds for this model: ratio and resolution, and the model's own params. */
  value: RatioResolutionValue & Readonly<Record<string, unknown>>;
  /** Called with the changed field only. */
  onChange: (partial: object) => void;
  /** The first image the model is sent, which a camera-angle control puts on its card. */
  subjectImageUrl?: string;
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
 * @param root0.mode - The mode the panel is in.
 * @param root0.value - The current ratio + resolution.
 * @param root0.onChange - Called with the changed field.
 * @param root0.subjectImageUrl - The first image the model is sent.
 * @returns The ratio + resolution picker.
 */
export const RatioResolutionPicker = React.memo(function RatioResolutionPicker({
  model,
  mode,
  value,
  onChange,
  subjectImageUrl,
}: RatioResolutionPickerProps): React.JSX.Element {
  const t = useTranslation();
  const [open, setOpen] = React.useState(false);
  const [cameraOpen, setCameraOpen] = React.useState(false);
  const [firstPanelRef, cameraOnLeft] = useSecondPanelSide(
    cameraOpen ? CAMERA_PANEL : null,
    CAMERA_PANEL_WIDTH,
  );
  // A model without the camera omits its params, so `params.camera` is absent.
  const cameraSupported = model.params.camera != null;
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
  const hasShared = ratios.length + resolutions.length > 0;
  const hasOwn = modelControls(model, mode).length > 0;
  // A model with none of the shared two still has its own controls to open.
  // The pill reads in the popover's order, top to bottom.
  const label =
    [
      value.resolution,
      value.aspect_ratio === undefined ? undefined : optionLabel({}, value.aspect_ratio),
      ...ownControlSummary(model, mode, value, (name) => t(`canvas.generatePanel.param.${name}`)),
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
        // A camera-angle control names four heights and three distances under
        // its sliders; at w-64 those words overlap in English and Japanese.
        className={cn('relative p-3 shadow-md', model.camera_angle ? 'w-80' : 'w-64')}
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
          mode={mode}
          value={value}
          onChange={onChange}
          className={hasShared ? SECTION_BREAK : undefined}
          subjectUrl={subjectImageUrl}
        />
        {cameraSupported ? (
          // The camera sits in the model's own section, under its switches.
          <div className={hasOwn ? 'mt-3' : hasShared ? SECTION_BREAK : undefined}>
            <SecondPanelRow
              label={t('canvas.generatePanel.camera')}
              value={cameraOn ? cameraSummary(value) : t('canvas.generatePanel.switchOff')}
              valueMuted={!cameraOn}
              open={cameraOpen}
              onLeft={cameraOnLeft}
              testId='generate-camera-row'
              // Bleeds 4px into the popover's padding on each side, so its name and
              // chevron line up with the names and switches of the rows above.
              className='-mx-1 w-[calc(100%+0.5rem)]'
              onClick={() => setCameraOpen((was) => !was)}
            />
          </div>
        ) : null}
        {cameraSupported && cameraOpen ? (
          <SecondPanelFrame
            onLeft={cameraOnLeft}
            maxWidth={CAMERA_PANEL_WIDTH}
            testId='generate-camera-panel'
            className='p-4'
          >
            <CameraPicker model={model} value={value} onChange={onChange} />
          </SecondPanelFrame>
        ) : null}
      </PopoverContent>
    </Popover>
  );
});
