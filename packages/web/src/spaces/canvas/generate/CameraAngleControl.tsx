// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { RotateCcw } from 'lucide-react';
import * as React from 'react';

import {
  CAMERA_ANGLE_AXES,
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

/** The keys that move the camera, and the axis and direction each steps. */
const KEY_STEPS: Readonly<Record<string, readonly [CameraAngleAxis, 1 | -1]>> = {
  ArrowRight: ['azimuth', 1],
  ArrowLeft: ['azimuth', -1],
  ArrowUp: ['elevation', 1],
  ArrowDown: ['elevation', -1],
  '+': ['distance', -1],
  '=': ['distance', -1],
  '-': ['distance', 1],
};

/**
 * The one gesture in progress and the pose it shows, or null between
 * gestures. One value, so two gestures cannot be in progress at once; a new
 * input takes over from whichever is (design §6).
 */
type Gesture = { kind: 'drag' | 'key' | 'slider'; pose: CameraAngle } | null;


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
 * and not at all when nothing changes. A wheel step is written as it is
 * taken (during a sphere drag it is held and written with the angle on
 * release); the rest of that wheel gesture moves nothing until the wheel has
 * been still for a moment.
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
  const [gesture, setGesture] = React.useState<Gesture>(null);
  const [unavailable, setUnavailable] = React.useState(false);
  const groupRef = React.useRef<HTMLDivElement>(null);

  // Read inside callbacks that outlive the render they were made in. The
  // gesture is kept here as it changes, so an event that lands before the last
  // one has rendered still starts from the pose on screen.
  const live = React.useRef({ stored, gesture: null as Gesture, mounted: true });
  live.current.stored = stored;
  const wheel = React.useRef<{ sum: number; moved: boolean; timer: ReturnType<typeof setTimeout> | undefined }>({
    sum: 0,
    moved: false,
    timer: undefined,
  });

  React.useEffect(() => {
    const state = live.current;
    state.mounted = true;
    return () => {
      // A control that goes away writes nothing it had not written: the
      // gesture in progress is dropped.
      state.mounted = false;
      clearTimeout(wheel.current.timer);
    };
  }, []);

  /**
   * Begin, move or end the gesture in progress.
   * @param next - The gesture now in progress, or null for none.
   */
  const track = React.useCallback((next: Gesture): void => {
    live.current.gesture = next;
    setGesture(next);
  }, []);

  /**
   * The pose on screen: the gesture's, else the stored one.
   * @returns The pose.
   */
  const onScreen = React.useCallback(
    (): CameraAngle => live.current.gesture?.pose ?? live.current.stored,
    [],
  );

  const commit = React.useCallback(
    (change: Partial<CameraAngle>): void => {
      if (!live.current.mounted) return;
      const next = nearestCameraAngle({ ...onScreen(), ...change });
      track(null);
      if (samePose(next, live.current.stored)) return;
      onChange(Object.fromEntries(CAMERA_ANGLE_AXES.map((axis) => [params[axis], next[axis]])));
    },
    [onChange, params, onScreen, track],
  );

  const onDragStart = React.useCallback((): void => {
    track({ kind: 'drag', pose: onScreen() });
  }, [onScreen, track]);
  const onDrag = React.useCallback(
    (pose: CameraAngle): void => {
      const current = live.current.gesture;
      if (current?.kind !== 'drag') return;
      track({ ...current, pose: { ...current.pose, azimuth: pose.azimuth, elevation: pose.elevation } });
    },
    [track],
  );
  const onDragEnd = React.useCallback((): void => {
    if (live.current.gesture?.kind === 'drag') commit({});
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
      const steps = wheel.current;
      clearTimeout(steps.timer);
      if (!steps.moved) {
        steps.sum += event.deltaY;
        if (Math.abs(steps.sum) >= WHEEL_STEP_DELTA) {
          steps.moved = true;
          const next = stepCameraAngle(onScreen(), 'distance', steps.sum > 0 ? 1 : -1);
          const current = live.current.gesture;
          // A gesture in progress carries the step and writes it when it ends.
          if (current) track({ ...current, pose: next });
          else commit({ distance: next.distance });
        }
      }
      // The rest of this wheel gesture, a trackpad's momentum included, moves
      // nothing more until the wheel has been still for a moment. Only this
      // listener and its timer touch this record.
      steps.timer = setTimeout(() => {
        wheel.current = { sum: 0, moved: false, timer: undefined };
      }, WHEEL_SETTLE_MS);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [commit, onScreen, track]);

  // A press writes one step; each repeat of a held key moves the picture, and
  // letting go of a camera key (or the sphere losing focus) writes where the
  // repeats reached, as a held slider key does.
  const onKeyDown = React.useCallback(
    (event: React.KeyboardEvent): void => {
      if (event.target !== event.currentTarget) return;
      const hit = KEY_STEPS[event.key];
      if (!hit) return;
      event.preventDefault();
      if (live.current.gesture?.kind === 'drag') return;
      const next = stepCameraAngle(onScreen(), hit[0], hit[1]);
      if (event.repeat) track({ kind: 'key', pose: next });
      else commit(next);
    },
    [commit, onScreen, track],
  );
  const endHeldKey = React.useCallback((): void => {
    if (live.current.gesture?.kind === 'key') commit({});
  }, [commit]);
  const onKeyUp = React.useCallback(
    (event: React.KeyboardEvent): void => {
      if (KEY_STEPS[event.key]) endHeldKey();
    },
    [endHeldKey],
  );

  const onSlider = React.useCallback(
    (partial: Record<string, number>): void => {
      const [[name, v] = []] = Object.entries(partial);
      if (name === undefined || v === undefined) return;
      const axis = CAMERA_ANGLE_AXES.find((a) => params[a] === name);
      if (!axis) return;
      // A slider's late write (a held key flushed on blur) belongs to a
      // gesture the sphere drag has already taken over from.
      if (live.current.gesture?.kind === 'drag') return;
      commit({ [axis]: v });
    },
    [commit, params],
  );
  /**
   * A slider moved without writing: the picture follows that axis.
   * @param axis - The slider's axis.
   * @param v - Where its thumb is.
   */
  const onSliderDraft = React.useCallback(
    (axis: CameraAngleAxis, v: number): void => {
      if (live.current.gesture?.kind === 'drag') return;
      track({ kind: 'slider', pose: { ...onScreen(), [axis]: v } });
    },
    [onScreen, track],
  );
  const onAzimuthDraft = React.useCallback((v: number) => onSliderDraft('azimuth', v), [onSliderDraft]);
  const onElevationDraft = React.useCallback((v: number) => onSliderDraft('elevation', v), [onSliderDraft]);
  const onDistanceDraft = React.useCallback((v: number) => onSliderDraft('distance', v), [onSliderDraft]);
  // A slider gesture that wrote nothing of its own (dragged back to where it
  // began) still writes what was folded into it, such as a wheel step.
  const onSliderDraftEnd = React.useCallback((): void => {
    if (live.current.gesture?.kind === 'slider') commit({});
  }, [commit]);

  const shown: CameraAngle = gesture?.pose ?? stored;
  const { azimuth: shownAzimuth, elevation: shownElevation, distance: shownDistance } = shown;
  const spherePose = React.useMemo(
    () => ({ azimuth: shownAzimuth, elevation: shownElevation, distance: shownDistance }),
    [shownAzimuth, shownElevation, shownDistance],
  );
  const named = nearestCameraAngle(spherePose);
  const poseWords = cameraAngleNames(specs, params, named);
  // The sliders follow the sphere and a held key; a dragged slider shows its own.
  const shownOnSliders = gesture?.kind === 'drag' || gesture?.kind === 'key' ? named : undefined;

  /**
   * One axis's named steps under its slider.
   * @param axis - The axis.
   * @returns The stops: four sides for the azimuth, every step otherwise.
   */
  const stopsOf = (axis: CameraAngleAxis): SliderStop[] =>
    (axis === 'azimuth' ? NAMED_AZIMUTHS : CAMERA_ANGLE_GRID[axis]).map((v) => ({
      value: v,
      label: optionLabel(specs[params[axis]] ?? {}, v),
    }));
  const degrees = React.useCallback((v: number): string => `${v}°`, []);
  const distanceSpec = specs[params.distance];
  const distanceWord = React.useCallback((v: number): string => optionLabel(distanceSpec ?? {}, v), [distanceSpec]);
  const drafts: Record<CameraAngleAxis, (v: number) => void> = {
    azimuth: onAzimuthDraft,
    elevation: onElevationDraft,
    distance: onDistanceDraft,
  };

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
          onKeyUp={onKeyUp}
          onBlur={endHeldKey}
          className={cn(
            'relative aspect-[4/3] w-full touch-none overflow-hidden rounded-chrome border border-border bg-muted outline-none',
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
      {CAMERA_ANGLE_AXES.map((axis) => {
        const grid = CAMERA_ANGLE_GRID[axis];
        return (
          <ParamSliderRow
            key={axis}
            name={params[axis]}
            label={t(`canvas.generatePanel.param.${params[axis]}`)}
            min={grid[0]}
            max={grid[grid.length - 1]}
            step={grid[1] - grid[0]}
            stops={stopsOf(axis)}
            value={stored[axis]}
            draft={shownOnSliders?.[axis]}
            onDraft={drafts[axis]}
            onDraftEnd={onSliderDraftEnd}
            format={axis === 'distance' ? distanceWord : degrees}
            onChange={onSlider}
            testIdPrefix='generate-param'
            className={undefined}
          />
        );
      })}
    </div>
  );
}
