// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import * as React from 'react';
import { Lock, MoreHorizontal, Plus } from 'lucide-react';

import {
  SCENE_AMBIENT_INTENSITY_MAX, SCENE_LIGHT_TYPES, compareDirectorRecords, isSceneCamera, isSceneLight,
  type SceneCameraObject, type SceneLightObject, type SceneLightType,
} from '@breatic/shared';
import { Button } from '@web/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@web/components/ui/dropdown-menu';
import { Skeleton } from '@web/components/ui/skeleton';
import { Slider } from '@web/components/ui/slider';
import { Switch } from '@web/components/ui/switch';
import { Tooltip, TooltipContent, TooltipTrigger } from '@web/components/ui/tooltip';
import type { SceneEnvironmentValues } from '@web/data/yjs/scene-document';
import type { SceneSession, SceneSessionSnapshot } from '@web/data/yjs/scene-session';
import { useTranslation } from '@web/i18n/use-translation';
import { cn } from '@web/lib/utils';
import { SceneColorField, SceneDirectorFields } from '@web/spaces/three-d/SceneDirectorFields';
import type { SceneField, SceneFieldDraftOwner } from '@web/spaces/three-d/SceneField';
import { SceneIconButton } from '@web/spaces/three-d/SceneIconButton';
import { commitAfterChange } from '@web/spaces/three-d/use-control-press';
import { cameraFrameRatio } from '@web/spaces/three-d/viewfinder/viewfinder-geometry';
import type { LightsPlan } from '@web/spaces/three-d/viewport/director-lights';

/** Tallest a monitor picture is drawn, in pixels. */
const MONITOR_MAX_HEIGHT = 220;
/** The `spaces.threeD.director` key naming each light type. */
export const LIGHT_LABEL: Readonly<Record<SceneLightType, string>> = { directional: 'lightDirectional', point: 'lightPoint', spot: 'lightSpot' };
const plusIcon = <Plus className='size-4' />;
const moreIcon = <MoreHorizontal className='size-4' />;
const lockIcon = <Lock className='size-3.5 text-muted-foreground' />;


export interface SceneDirectorPanelProps extends SceneFieldDraftOwner {
  session: SceneSession;
  snapshot: SceneSessionSnapshot;
  spaceId: string;
  Field: typeof SceneField;
  /** Which lights shine and cast, as the viewport reported. */
  lightPlan: LightsPlan | null;
  maxLights: number | undefined;
  /** The camera being looked through. */
  lookingAt: string | null;
  /** The ambient light shown, a drag in progress included. */
  environment: SceneEnvironmentValues;
  onSaveView: () => void;
  onAddLight: (type: SceneLightType) => void;
  onLook: (id: string) => void;
  onMonitor: (id: string, canvas: HTMLCanvasElement | null) => void;
  onAmbientPreview: (values: Partial<SceneEnvironmentValues>) => void;
  onAmbientCommit: () => void;
  /** The view failed to load: every card shows the failure the main area shows. */
  viewFailed: boolean;
}

/**
 * One camera's card: its live picture, a row with its number, name, lens and frame, and its menu.
 * @param root0 - Props.
 * @param root0.camera - The camera.
 * @param root0.active - Whether it is being looked through.
 * @param root0.canEdit - Whether this user may edit.
 * @param root0.session - The command owner.
 * @param root0.onLook - Looks through it.
 * @param root0.onMonitor - Registers its picture's canvas.
 * @param root0.failed - Whether the view failed to load.
 * @param root0.children - Its fields when selected.
 * @returns The card.
 */
const MonitorCard = React.memo(function MonitorCard({ camera, active, canEdit, session, onLook, onMonitor, failed, children }: {
  camera: SceneCameraObject; active: boolean; canEdit: boolean; session: SceneSession; onLook: (id: string) => void;
  onMonitor: (id: string, canvas: HTMLCanvasElement | null) => void; failed: boolean; children: React.ReactNode;
}): React.JSX.Element {
  const t = useTranslation();
  const { id } = camera;
  const canvasRef = React.useCallback((canvas: HTMLCanvasElement | null): void => onMonitor(id, canvas), [onMonitor, id]);
  const ratio = cameraFrameRatio(camera);
  const pictureStyle = React.useMemo(() => ({ aspectRatio: String(ratio), width: `min(100%, ${MONITOR_MAX_HEIGHT * ratio}px)` }), [ratio]);
  return <div data-testid={`scene-director-camera-${id}`}
    className={cn('overflow-hidden rounded-md border', active ? 'border-active-border' : 'border-border')}>
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant={null} size={null} data-testid={`scene-director-monitor-${id}`} className='grid w-full place-items-center bg-muted' onClick={() => onLook(id)}>
          <span className='relative block' style={pictureStyle}>
            <canvas ref={canvasRef} className='peer block size-full' />
            {failed
              ? <span className='absolute inset-0 grid place-items-center bg-muted p-2 text-xs text-muted-foreground'>{t('spaces.threeD.loadFailed')}</span>
              : <Skeleton className='absolute inset-0 rounded-none peer-data-[drawn]:hidden' />}
          </span>
        </Button>
      </TooltipTrigger>
      <TooltipContent>{t('spaces.threeD.director.look')}</TooltipContent>
    </Tooltip>
    <div className='flex items-center gap-2 px-2 py-1 text-xs'>
      <span className='grid size-5 shrink-0 place-items-center rounded-full bg-foreground text-2xs text-background'>{camera.number}</span>
      <span className='min-w-0 flex-1 truncate'>{camera.name}</span>
      <span className='shrink-0 tabular-nums text-muted-foreground'>{`${Number(camera.focalLength.toFixed(1))}mm · ${camera.frame === 'Free' ? camera.freeRatio.toFixed(2) : camera.frame}`}</span>
      {camera.locked ? lockIcon : null}
      <DropdownMenu>
        <DropdownMenuTrigger asChild><SceneIconButton label={t('spaces.threeD.director.more')}>{moreIcon}</SceneIconButton></DropdownMenuTrigger>
        <DropdownMenuContent align='end'>
          <DropdownMenuItem onSelect={() => session.select(id, false)}>{t('spaces.threeD.properties')}</DropdownMenuItem>
          <DropdownMenuItem disabled={!canEdit} onSelect={() => session.execute({ type: 'duplicate', copies: [{ sourceId: id, id: crypto.randomUUID() }] })}>{t('spaces.threeD.duplicate')}</DropdownMenuItem>
          <DropdownMenuItem disabled={!canEdit} onSelect={() => session.execute({ type: 'lock', ids: [id], locked: !camera.locked })}>{camera.locked ? t('spaces.threeD.unlock') : t('spaces.threeD.lock')}</DropdownMenuItem>
          <DropdownMenuItem disabled={!canEdit || camera.locked} onSelect={() => session.execute({ type: 'delete', ids: [id] })}>{t('spaces.threeD.delete')}</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
    {children}
  </div>;
});

/**
 * The director console (inner#1694 design 3.2): cameras with live monitors, lights and the ambient light.
 * @param props - See {@link SceneDirectorPanelProps}.
 * @returns The console.
 */
export const SceneDirectorPanel = React.memo(function SceneDirectorPanel(props: SceneDirectorPanelProps): React.JSX.Element {
  const { session, snapshot, spaceId, Field, fieldDrafts, onFieldDraftChange, lightPlan, maxLights, lookingAt, environment,
    onSaveView, onAddLight, onLook, onMonitor, onAmbientPreview, onAmbientCommit, viewFailed } = props;
  const t = useTranslation();
  const ids = React.useId();
  const { canEdit } = snapshot;
  const cameras = React.useMemo(() => snapshot.objects.filter(isSceneCamera).sort(compareDirectorRecords), [snapshot.objects]);
  const lights = React.useMemo(() => snapshot.objects.filter(isSceneLight).sort(compareDirectorRecords), [snapshot.objects]);
  const selectedId = snapshot.selectedIds.length === 1 ? snapshot.selectedIds[0] : undefined;
  const atLimit = maxLights === undefined || lights.length >= maxLights;
  const onAmbientCommitAfterChange = React.useMemo(() => commitAfterChange(onAmbientCommit), [onAmbientCommit]);
  /**
   * The fields of a selected camera or light.
   * @param object - The record.
   * @returns Its fields under a rule, or nothing when it is not the selection.
   */
  const fields = (object: SceneCameraObject | SceneLightObject): React.ReactNode => object.id === selectedId
    ? <div className='border-t border-border p-2'><SceneDirectorFields object={object} session={session} canEdit={canEdit} spaceId={spaceId}
      Field={Field} compact fieldDrafts={fieldDrafts} onFieldDraftChange={onFieldDraftChange} /></div> : null;
  return <div className='space-y-4 p-3' data-testid='scene-director-panel'>
    <section className='space-y-2'>
      <div className='flex items-center justify-between'>
        <h3 className='text-xs font-medium text-muted-foreground'>{t('spaces.threeD.director.cameras')}</h3>
        <SceneIconButton label={t('spaces.threeD.director.saveView')} disabled={!canEdit} onClick={onSaveView}>{plusIcon}</SceneIconButton>
      </div>
      {cameras.length === 0
        ? <p className='rounded-md border border-dashed border-border p-4 text-center text-xs text-muted-foreground'>{t('spaces.threeD.director.camerasEmpty')}</p>
        : <div className='space-y-2'>{cameras.map((camera) => <MonitorCard key={camera.id} camera={camera} active={lookingAt === camera.id} canEdit={canEdit} failed={viewFailed}
          session={session} onLook={onLook} onMonitor={onMonitor}>{fields(camera)}</MonitorCard>)}</div>}
    </section>
    <section className='space-y-2'>
      <div className='flex items-center justify-between'>
        <h3 className='text-xs font-medium text-muted-foreground'>{t('spaces.threeD.director.lights')}</h3>
        <DropdownMenu>
          <DropdownMenuTrigger asChild disabled={!canEdit}>
            <SceneIconButton label={t('spaces.threeD.director.addLight')} disabled={!canEdit}>{plusIcon}</SceneIconButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent align='end'>
            {SCENE_LIGHT_TYPES.map((type) => <DropdownMenuItem key={type} disabled={atLimit} onSelect={() => onAddLight(type)}>{t(`spaces.threeD.director.${LIGHT_LABEL[type]}`)}</DropdownMenuItem>)}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {lights.length > 0 && maxLights !== undefined && lights.length >= maxLights
        ? <p className='text-xs text-muted-foreground'>{t('spaces.threeD.director.lightLimit', { max: maxLights })}</p> : null}
      {lights.length === 0
        ? <p className='rounded-md border border-dashed border-border p-4 text-center text-xs text-muted-foreground'>{t('spaces.threeD.director.lightsEmpty')}</p>
        : <div className='space-y-1'>{lights.map((light) => {
          const note = lightPlan?.lights[light.id]?.note ?? null;
          return <div key={light.id} data-testid={`scene-director-light-${light.id}`} className={cn('rounded-md', light.id === selectedId && 'bg-accent')}>
            <div className='flex items-center gap-2 px-2 py-1 text-xs'>
              <Button variant={null} size={null} className='flex min-w-0 flex-1 items-center gap-2 text-left' onClick={() => session.select(light.id, false)}>
                <span className='size-3 shrink-0 rounded-full border border-border' style={{ backgroundColor: light.color }} />
                <span className='min-w-0 flex-1 truncate'>{light.name}</span>
                <span className='shrink-0 text-muted-foreground'>{t(`spaces.threeD.director.${LIGHT_LABEL[light.model.type]}`)}</span>
              </Button>
              <span id={`${ids}-${light.id}-shadow`} className='shrink-0 text-muted-foreground'>{t('spaces.threeD.castShadow')}</span>
              <Switch aria-labelledby={`${ids}-${light.id}-shadow`} checked={light.castShadow} disabled={!canEdit || light.locked}
                onCheckedChange={(castShadow) => session.execute({ type: 'patch', patches: [{ id: light.id, castShadow }] })} />
            </div>
            {note ? <p className='px-2 pb-1 text-xs text-muted-foreground'>{t(note === 'overLimit' ? 'spaces.threeD.director.lightOverLimit' : 'spaces.threeD.director.shadowBudget')}</p> : null}
            {fields(light)}
          </div>;
        })}</div>}
    </section>
    <section className='space-y-2' data-testid='scene-director-ambient'>
      <h3 className='text-xs font-medium text-muted-foreground'>{t('spaces.threeD.director.ambient')}</h3>
      <div className='flex items-center justify-between gap-3'>
        <span id={`${ids}-ambient-color`} className='text-xs'>{t('spaces.threeD.color')}</span>
        <SceneColorField value={environment.ambientColor} disabled={!canEdit} labelId={`${ids}-ambient-color`}
          onPreview={(ambientColor) => onAmbientPreview({ ambientColor })} onCommit={onAmbientCommit} />
      </div>
      <div className='flex items-center justify-between gap-3'>
        <span id={`${ids}-ambient-intensity`} className='text-xs'>{t('spaces.threeD.intensity')}</span>
        <div className='flex items-center gap-2'>
          <Slider aria-labelledby={`${ids}-ambient-intensity`} className='w-28' min={0} max={SCENE_AMBIENT_INTENSITY_MAX} step={0.1} disabled={!canEdit}
            value={[environment.ambientIntensity]} onValueChange={([ambientIntensity]) => { if (ambientIntensity !== undefined) onAmbientPreview({ ambientIntensity }); }}
            onValueCommit={onAmbientCommitAfterChange} onPointerUp={onAmbientCommit} />
          <span className='w-10 text-right text-xs tabular-nums text-muted-foreground'>{environment.ambientIntensity.toFixed(1)}</span>
        </div>
      </div>
    </section>
  </div>;
});
