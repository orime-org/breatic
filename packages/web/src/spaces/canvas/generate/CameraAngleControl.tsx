// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { RotateCcw } from 'lucide-react';
import * as React from 'react';

import {
  CAMERA_ANGLE_GRID,
  DEFAULT_CAMERA_ANGLE,
  nearestCameraAngle,
  stepCameraAngle,
  type CameraAngle,
  type CameraAngleAxis,
  type CameraAngleParams,
  type ParamDescriptor,
} from '@breatic/shared';

import { Button } from '@web/components/ui/button';
import { useTranslation } from '@web/i18n/use-translation';
import { corsUrl } from '@web/lib/cors-url';
import { cn } from '@web/lib/utils';
import type { CameraAngleSphereProps } from '@web/spaces/canvas/generate/camera-angle-sphere-props';
import { cameraAngleNames, optionLabel } from '@web/spaces/canvas/generate/model-controls';
import { ParamSliderRow, type SliderStop } from '@web/spaces/canvas/generate/ParamSliderRow';
import { useSphereColors } from '@web/spaces/canvas/generate/use-sphere-colors';

/** How far one wheel gesture has to scroll before the distance moves a step. */
const WHEEL_STEP_DELTA = 40;

/** How long the wheel has to stay still before a gesture counts as over, in ms. */
const WHEEL_SETTLE_MS = 150;

/** The azimuths named under the slider; the other four are named in the title. */
const NAMED_AZIMUTHS = [0, 90, 180, 270] as const;


/**
 * Says the 3D view could not load, in the sphere's place.
 * @returns The notice.
 */
function SphereUnavailable(): React.JSX.Element {
  const t = useTranslation();
  return (
    <div
      data-testid='generate-camera-angle-unavailable'
      className='flex h-full w-full items-center justify-center p-3 text-center text-xs text-muted-foreground'
    >
      {t('canvas.generatePanel.cameraAngle.loadFailed')}
    </div>
  );
}

// The sphere carries three.js, so it is fetched only when this control first
// draws. A chunk that cannot be fetched (a tab left open across a deploy) says
// so in the sphere's place; nothing reloads the tab.
const LazySphere = React.lazy(
  (): Promise<{ default: React.ComponentType<CameraAngleSphereProps> }> =>
    import('@web/spaces/canvas/generate/CameraAngleSphere').catch(() => ({ default: SphereUnavailable })),
);

interface CameraAngleControlProps {
  /** The three params the pose is written to. */
  params: CameraAngleParams;
  /** The model's params, whose `value_labels` name each step. */
  specs: Readonly<Record<string, ParamDescriptor>>;
  /** What the node holds, by param name. */
  value: Readonly<Record<string, unknown>>;
  /** Called with all three params at once, once per gesture. */
  onChange: (partial: Record<string, unknown>) => void;
  /** The first image the model is sent, which sits on the card; absent for a plain card. */
  subjectUrl: string | undefined;
}

/**
 * The pose the node holds, read off its three params.
 * @param params - The three param names.
 * @param value - What the node holds.
 * @returns The pose, each axis falling back to the default when unset.
 */
function storedPose(params: CameraAngleParams, value: Readonly<Record<string, unknown>>): CameraAngle {
  /**
   * One axis's number, or the default's.
   * @param name - The param name.
   * @param axis - The axis it stands for.
   * @returns The value.
   */
  const read = (name: string, axis: CameraAngleAxis): number => {
    const v = value[name];
    return typeof v === 'number' ? v : DEFAULT_CAMERA_ANGLE[axis];
  };
  return nearestCameraAngle({
    azimuth: read(params.azimuth, 'azimuth'),
    elevation: read(params.elevation, 'elevation'),
    distance: read(params.distance, 'distance'),
  });
}

/**
 * Whether two poses are the same.
 * @param a - One pose.
 * @param b - The other.
 * @returns True when every axis matches.
 */
function samePose(a: CameraAngle, b: CameraAngle): boolean {
  return a.azimuth === b.azimuth && a.elevation === b.elevation && a.distance === b.distance;
}

/**
 * Whether the reader asked for less motion.
 * @returns True under prefers-reduced-motion.
 */
function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
}

/**
 * One camera pose — azimuth, elevation and distance — set on a 3D sphere or
 * on three sliders under it (inner#830, design §5.2).
 *
 * Every way of changing the pose ends in one `commit`, which writes all three
 * params together from what the node holds plus the change, once per gesture,
 * and not at all when nothing changes. A wheel step waits for the wheel to
 * settle; any other write in the meantime carries it along.
 * @param root0 - Props.
 * @param root0.params - The three param names.
 * @param root0.specs - The model's params.
 * @param root0.value - What the node holds.
 * @param root0.onChange - Called with the three params.
 * @param root0.subjectUrl - The picture on the card.
 * @returns The control.
 */
export function CameraAngleControl({ params, specs, value, onChange, subjectUrl }: CameraAngleControlProps): React.JSX.Element {
  const t = useTranslation();
  const colors = useSphereColors();
  const stored = storedPose(params, value);
  const [drag, setDrag] = React.useState<CameraAngle | null>(null);
  const [sliderDraft, setSliderDraft] = React.useState<Partial<CameraAngle>>({});
  const [pendingDistance, setPendingDistance] = React.useState<number | null>(null);
  const [unavailable, setUnavailable] = React.useState(false);
  const groupRef = React.useRef<HTMLDivElement>(null);

  // Read inside callbacks that outlive the render they were made in.
  const live = React.useRef({ stored, pending: pendingDistance, mounted: true });
  live.current.stored = stored;
  live.current.pending = pendingDistance;
  const wheel = React.useRef<{ sum: number; moved: boolean; timer: ReturnType<typeof setTimeout> | undefined }>({
    sum: 0,
    moved: false,
    timer: undefined,
  });

  React.useEffect(() => {
    const state = live.current;
    state.mounted = true;
    return () => {
      // A control that goes away writes nothing it had not written: a drag in
      // progress and a wheel step still settling are both dropped.
      state.mounted = false;
      clearTimeout(wheel.current.timer);
    };
  }, []);

  const commit = React.useCallback(
    (change: Partial<CameraAngle>): void => {
      if (!live.current.mounted) return;
      const base = live.current.stored;
      const pending = live.current.pending;
      clearTimeout(wheel.current.timer);
      wheel.current = { sum: 0, moved: false, timer: undefined };
      setPendingDistance(null);
      setSliderDraft({});
      const next = nearestCameraAngle({ ...base, distance: pending ?? base.distance, ...change });
      if (samePose(next, base)) return;
      onChange({ [params.azimuth]: next.azimuth, [params.elevation]: next.elevation, [params.distance]: next.distance });
    },
    [onChange, params],
  );

  // The pose under the pointer, kept beside the state so a release that lands
  // before the last move has rendered still writes where the pointer was.
  const dragRef = React.useRef<CameraAngle | null>(null);
  const onDragStart = React.useCallback((): void => {
    clearTimeout(wheel.current.timer);
    dragRef.current = live.current.stored;
    setDrag(live.current.stored);
  }, []);
  const onDrag = React.useCallback((pose: CameraAngle): void => {
    dragRef.current = pose;
    setDrag(pose);
  }, []);
  const onDragEnd = React.useCallback((): void => {
    const pose = dragRef.current;
    dragRef.current = null;
    setDrag(null);
    if (pose === null) return;
    commit({ azimuth: pose.azimuth, elevation: pose.elevation });
  }, [commit]);
  const onUnavailable = React.useCallback((): void => setUnavailable(true), []);

  React.useEffect(() => {
    const el = groupRef.current;
    if (!el) return;
    /**
     * One wheel event: the page never scrolls or zooms under the sphere, and a
     * gesture moves the distance at most one step.
     * @param event - The wheel event.
     */
    const onWheel = (event: WheelEvent): void => {
      event.preventDefault();
      const gesture = wheel.current;
      clearTimeout(gesture.timer);
      if (!gesture.moved) {
        gesture.sum += event.deltaY;
        if (Math.abs(gesture.sum) >= WHEEL_STEP_DELTA) {
          gesture.moved = true;
          const from = live.current.pending ?? live.current.stored.distance;
          const next = stepCameraAngle({ ...live.current.stored, distance: from }, 'distance', gesture.sum > 0 ? 1 : -1);
          setPendingDistance(next.distance);
          live.current.pending = next.distance;
        }
      }
      gesture.timer = setTimeout(() => {
        const settled = wheel.current;
        wheel.current = { sum: 0, moved: false, timer: undefined };
        // A step taken during a drag is written with the angle on release.
        if (settled.moved && dragRef.current === null) commit({});
      }, WHEEL_SETTLE_MS);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [commit]);

  const onKeyDown = React.useCallback(
    (event: React.KeyboardEvent): void => {
      if (dragRef.current !== null || event.target !== event.currentTarget) return;
      const step: Record<string, [CameraAngleAxis, 1 | -1]> = {
        ArrowRight: ['azimuth', 1],
        ArrowLeft: ['azimuth', -1],
        ArrowUp: ['elevation', 1],
        ArrowDown: ['elevation', -1],
        '+': ['distance', -1],
        '=': ['distance', -1],
        '-': ['distance', 1],
      };
      const hit = step[event.key];
      if (!hit) return;
      event.preventDefault();
      const base = { ...live.current.stored, distance: live.current.pending ?? live.current.stored.distance };
      commit(stepCameraAngle(base, hit[0], hit[1]));
    },
    [commit],
  );

  const onSlider = React.useCallback(
    (partial: Record<string, number>): void => {
      const [[name, v] = []] = Object.entries(partial);
      if (name === undefined || v === undefined) return;
      const axis = (Object.keys(params) as CameraAngleAxis[]).find((a) => params[a] === name);
      if (axis) commit({ [axis]: v });
    },
    [commit, params],
  );
  const onAzimuthDraft = React.useCallback((v: number) => setSliderDraft({ azimuth: v }), []);
  const onElevationDraft = React.useCallback((v: number) => setSliderDraft({ elevation: v }), []);
  const onDistanceDraft = React.useCallback((v: number) => setSliderDraft({ distance: v }), []);

  // What the sphere draws: the pointer while dragging, otherwise the stored
  // pose with a settling wheel step and a dragged slider laid over it.
  const resting: CameraAngle = { ...stored, distance: pendingDistance ?? stored.distance, ...sliderDraft };
  const spherePose = drag ? { ...drag, distance: pendingDistance ?? stored.distance } : resting;
  const named = drag ? nearestCameraAngle(spherePose) : resting;
  const poseWords = cameraAngleNames(specs, params, named);
  // The sliders show a draft only while the sphere or the wheel moves the pose.
  const shownOnSliders = drag !== null || pendingDistance !== null ? named : undefined;

  /**
   * One axis's named steps under its slider.
   * @param name - The axis's param.
   * @param steps - The values to name.
   * @returns The stops.
   */
  const stopsOf = (name: string, steps: readonly number[]): SliderStop[] =>
    steps.map((v) => ({ value: v, label: optionLabel(specs[name] ?? {}, v) }));
  const azimuthStops = stopsOf(params.azimuth, NAMED_AZIMUTHS);
  const elevationStops = stopsOf(params.elevation, CAMERA_ANGLE_GRID.elevation);
  const distanceStops = stopsOf(params.distance, CAMERA_ANGLE_GRID.distance);
  const degrees = React.useCallback((v: number): string => `${v}°`, []);
  const distanceSpec = specs[params.distance];
  const distanceWord = React.useCallback((v: number): string => optionLabel(distanceSpec ?? {}, v), [distanceSpec]);

  return (
    <div className='flex flex-col gap-3'>
      <div>
        <div className='mb-1.5 flex items-center justify-between gap-2 text-xs font-medium'>
          <span className='shrink-0 whitespace-nowrap text-muted-foreground'>{t('canvas.generatePanel.cameraAngle.title')}</span>
          <span data-testid='generate-camera-angle-pose' className='truncate text-foreground'>
            {poseWords.join(' · ')}
          </span>
        </div>
        {/* `application` is the ARIA role for a widget that draws itself and
            takes the keyboard over, as this one does: the arrow keys and +/-
            move the camera. There is no standard role for a pose picked on a
            sphere, and the lint rules' allow-lists cover only the built-in
            interactive roles; the same reasoning as the crop region in
            `ImageCropDialog.tsx`. It is focusable, labelled, keyboard-operable
            and shows a focus ring. */}
        {/* eslint-disable jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/no-noninteractive-tabindex */}
        <div
          ref={groupRef}
          role='application'
          tabIndex={0}
          aria-label={t('canvas.generatePanel.cameraAngle.title')}
          data-testid='generate-camera-angle'
          onKeyDown={onKeyDown}
          className={cn(
            'relative aspect-[4/3] w-full touch-none overflow-hidden rounded-md border border-border bg-muted outline-none',
            'focus-visible:ring-1 focus-visible:ring-ring',
          )}
        >
          {unavailable ? (
            <SphereUnavailable />
          ) : (
            <React.Suspense fallback={null}>
              <LazySphere
                pose={spherePose}
                subjectUrl={subjectUrl === undefined ? undefined : corsUrl(subjectUrl)}
                colors={colors}
                animate={!prefersReducedMotion()}
                onDragStart={onDragStart}
                onDrag={onDrag}
                onDragEnd={onDragEnd}
                onUnavailable={onUnavailable}
              />
            </React.Suspense>
          )}
          <Button
            type='button'
            variant='outline'
            size='sm'
            data-testid='generate-camera-angle-reset'
            onClick={() => commit(DEFAULT_CAMERA_ANGLE)}
            className='absolute right-1.5 top-1.5 h-6 gap-1 px-2 text-2xs'
          >
            <RotateCcw className='h-3 w-3' aria-hidden='true' />
            {t('canvas.generatePanel.cameraAngle.reset')}
          </Button>
        </div>
        {/* eslint-enable jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/no-noninteractive-tabindex */}
      </div>
      <ParamSliderRow
        name={params.azimuth}
        label={t(`canvas.generatePanel.param.${params.azimuth}`)}
        min={0}
        max={315}
        step={45}
        stops={azimuthStops}
        value={stored.azimuth}
        draft={shownOnSliders?.azimuth}
        onDraft={onAzimuthDraft}
        format={degrees}
        onChange={onSlider}
        testIdPrefix='generate-param'
        className={undefined}
      />
      <ParamSliderRow
        name={params.elevation}
        label={t(`canvas.generatePanel.param.${params.elevation}`)}
        min={-30}
        max={60}
        step={30}
        stops={elevationStops}
        value={stored.elevation}
        draft={shownOnSliders?.elevation}
        onDraft={onElevationDraft}
        format={degrees}
        onChange={onSlider}
        testIdPrefix='generate-param'
        className={undefined}
      />
      <ParamSliderRow
        name={params.distance}
        label={t(`canvas.generatePanel.param.${params.distance}`)}
        min={0}
        max={2}
        step={1}
        stops={distanceStops}
        value={stored.distance}
        draft={shownOnSliders?.distance}
        onDraft={onDistanceDraft}
        format={distanceWord}
        onChange={onSlider}
        testIdPrefix='generate-param'
        className={undefined}
      />
    </div>
  );
}
