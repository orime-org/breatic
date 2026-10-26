// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { Lock } from 'lucide-react';

import { type SceneObject } from '@breatic/shared';
import { Button } from '@web/components/ui/button';
import { getSceneControls, resolveSceneAsset } from '@web/data/api/scene';
import type { ScenePeer, SceneSession, SceneSessionSnapshot } from '@web/data/yjs/scene-session';
import type { SocketState } from '@web/data/yjs/use-socket';
import { useTranslation } from '@web/i18n/use-translation';
import { readSceneView, writeSceneView } from '@web/lib/scene-view-storage';
import { toast } from '@web/lib/toast';
import type { SpaceBodyProps } from '@web/spaces';
import { useExclusiveOverlay } from '@web/features/exclusive-overlay/use-exclusive-overlay';
import { SceneCreationMenu } from '@web/spaces/three-d/SceneCreationMenu';
import { SceneIconButton } from '@web/spaces/three-d/SceneIconButton';
import { SceneObjectList } from '@web/spaces/three-d/SceneObjectList';
import { SceneRightPanel } from '@web/spaces/three-d/SceneRightPanel';
import { SceneViewportToolbar, type ScenePanel } from '@web/spaces/three-d/SceneViewportToolbar';
import { SceneObjectToolbar } from '@web/spaces/three-d/SceneObjectToolbar';
import type { SceneModelState, SceneTransformMode, SceneView } from '@web/spaces/three-d/viewport/scene-viewport-props';

const SceneViewport = React.lazy(() => import('@web/spaces/three-d/viewport/SceneViewport'));
const SceneInspector = React.lazy(() => import('@web/spaces/three-d/SceneInspector').then((module) => ({ default: module.SceneInspector })));

export interface SceneEditorProps extends SpaceBodyProps {
  userId: string;
  session: SceneSession;
  snapshot: SceneSessionSnapshot;
  connection: Pick<SocketState, 'status' | 'synced'>;
  namedPeers: readonly (ScenePeer & { name: string })[];
  readObjects: () => readonly SceneObject[];
  ownsKeyboard: (target: EventTarget | null) => boolean;
  UnlockIcon: React.ComponentType<{ className?: string }>;
}

/**
 * Render the approved object list, shared scene and property inspector against real services.
 * @param root0 - Scene identity and document bindings supplied across the lazy boundary.
 * @param root0.projectId - Project whose scene is being edited.
 * @param root0.spaceId - Space that owns the current scene.
 * @param root0.userId - Signed-in account owning this personal view.
 * @param root0.session - Document-scoped editing owner.
 * @param root0.snapshot - Current shared content and local selection projection.
 * @param root0.connection - The open tab's connection status.
 * @param root0.namedPeers - Validated collaborator hints with resolved display names.
 * @param root0.readObjects - Reader of the latest committed object values.
 * @param root0.ownsKeyboard - Shared keyboard and editable-target ownership check.
 * @param root0.UnlockIcon - The host's existing unlocked-state icon.
 * @returns The object list, shared scene, inspector and error feedback.
 */
export default function SceneEditor({ projectId, spaceId, userId, session, snapshot, connection,
  namedPeers, readObjects, ownsKeyboard, UnlockIcon }: SceneEditorProps): React.JSX.Element {
  const t = useTranslation();
  const controls = useQuery({ queryKey: ['scene-controls', projectId, userId],
    queryFn: ({ signal }) => getSceneControls(projectId, signal) });
  const [mode, setMode] = React.useState<SceneTransformMode>('translate');
  const [focusRevision, setFocusRevision] = React.useState(0);
  const [modelRetryRevision, setModelRetryRevision] = React.useState(0);
  const [rendererRevision, setRendererRevision] = React.useState(0);
  const [rendererFailed, setRendererFailed] = React.useState(false);
  const [modelStates, setModelStates] = React.useState<ReadonlyMap<string, SceneModelState>>(new Map());
  const pendingFocusIds = React.useRef(new Set<string>());
  const reportedCommandError = React.useRef<SceneSessionSnapshot['commandError']>(null);
  const [initialView] = React.useState<SceneView>(() => {
    const stored = readSceneView(userId, projectId, spaceId);
    return stored ? { position: [...stored.position], target: [...stored.target] }
      : { position: [5, 4, 7], target: [0, 1, 0] };
  });
  const view = React.useRef<SceneView>(initialView);
  const selected = snapshot.objects.filter((object) => snapshot.selectedIds.includes(object.id));
  const mutable = snapshot.canEdit && selected.length > 0 && selected.every((object) => !object.locked);
  const allSelectedLocked = selected.length > 0 && selected.every((object) => object.locked);
  const failedModels = snapshot.objects.some((object) => modelStates.get(object.id) === 'failed');

  React.useEffect(() => {
    session.setVisible(true);
    /** Re-evaluate focus and page visibility from the browser's current facts. */
    const syncFocus = (): void => { session.setFocused(document.hasFocus() && document.visibilityState === 'visible'); };
    syncFocus();
    window.addEventListener('focus', syncFocus);
    window.addEventListener('blur', syncFocus);
    document.addEventListener('visibilitychange', syncFocus);
    return (): void => {
      session.setVisible(false);
      if (!writeSceneView(userId, projectId, spaceId, view.current)) toast.error(t('spaces.threeD.viewFailed'));
      window.removeEventListener('focus', syncFocus);
      window.removeEventListener('blur', syncFocus);
      document.removeEventListener('visibilitychange', syncFocus);
    };
  }, [session, userId, projectId, spaceId, t]);

  React.useEffect(() => {
    if (snapshot.commandError && snapshot.commandError !== reportedCommandError.current) {
      toast.error(t('spaces.threeD.commandFailed'));
    }
    reportedCommandError.current = snapshot.commandError;
  }, [snapshot.commandError, t]);

  /** Create independent selected copies of committed objects, including locked sources. */
  const duplicate = React.useCallback((): void => {
    const copies = session.getSnapshot().selectedIds.map((sourceId) => ({ sourceId, id: crypto.randomUUID() }));
    copies.forEach((copy) => pendingFocusIds.current.add(copy.id));
    const result = session.execute({ type: 'duplicate', copies });
    if (!result.ok) copies.forEach((copy) => pendingFocusIds.current.delete(copy.id));
  }, [session]);

  React.useEffect(() => {
    /**
     * Route Space shortcuts while preserving text editing and portal keyboard ownership.
     * @param event - Keyboard event routed through the active region and editing target.
     */
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || !ownsKeyboard(event.target) || event.isComposing || event.keyCode === 229) return;
      const modifier = event.metaKey || event.ctrlKey;
      const key = event.key.toLowerCase();
      if (event.key === 'Escape') {
        if (event.repeat) return;
        event.preventDefault();
        if (session.getSnapshot().gestureActive) session.endGesture(false);
        else session.select(null, false);
        return;
      }
      if (!modifier && !event.altKey && key === 'f') { event.preventDefault(); setFocusRevision((value) => value + 1); return; }
      if (modifier && !event.altKey && key === 'z') { event.preventDefault(); session.historyStep(event.shiftKey ? 'redo' : 'undo'); return; }
      if (event.ctrlKey && !event.metaKey && !event.altKey && key === 'y') { event.preventDefault(); session.historyStep('redo'); return; }
      if (modifier && !event.altKey && !event.shiftKey && key === 'd') { event.preventDefault(); if (!event.repeat) duplicate(); return; }
      if (!modifier && !event.altKey && !event.shiftKey && (event.key === 'Delete' || event.key === 'Backspace')) {
        event.preventDefault();
        if (!event.repeat) session.execute({ type: 'delete', ids: session.getSnapshot().selectedIds });
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return (): void => window.removeEventListener('keydown', onKeyDown);
  }, [session, duplicate, ownsKeyboard]);

  /** Resolve one registered model through the same Project's access boundary. */
  const resolveAsset = React.useCallback((assetId: string, signal: AbortSignal): Promise<{ url: string; mimeType: string }> =>
    resolveSceneAsset(projectId, assetId, signal), [projectId]);

  /** Persist only the personal camera; it never enters shared content or awareness. */
  const onViewChange = React.useCallback((next: SceneView): void => {
    view.current = next;
    if (!writeSceneView(userId, projectId, spaceId, next)) toast.error(t('spaces.threeD.viewFailed'));
  }, [userId, projectId, spaceId, t]);

  /** Show model failures and finish a placement's requested focus after asynchronous loading. */
  const onModelStateChange = React.useCallback((id: string, state: SceneModelState): void => {
    setModelStates((previous) => previous.get(id) === state ? previous : new Map(previous).set(id, state));
    if (state === 'ready' && pendingFocusIds.current.delete(id)) setFocusRevision((value) => value + 1);
  }, []);

  /**
   * Place one built-in source using the same command used by model result adapters.
   * @param kind - Built-in figure or stage-block source to place.
   */
  const addBuiltin = (kind: 'figure' | 'box'): void => {
    const id = crypto.randomUUID();
    pendingFocusIds.current.add(id);
    const object: SceneObject = { id, model: { kind: 'builtin', id: kind },
      name: t(kind === 'figure' ? 'spaces.threeD.figure' : 'spaces.threeD.box'),
      position: [snapshot.objects.length * 1.6, kind === 'box' ? 0.5 : 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1], locked: false, exists: true };
    if (!session.execute({ type: 'create', objects: [object] }).ok) pendingFocusIds.current.delete(id);
  };

  const stage = React.useRef<HTMLDivElement>(null);
  const rightPanel = React.useRef<HTMLDivElement>(null);
  const automaticPanel = React.useRef(false);
  const returnTarget = React.useRef<HTMLElement | null>(null);
  const [panel, setPanel] = React.useState<ScenePanel>('properties');
  const [rightOpen, setRightOpen] = useExclusiveOverlay(`scene:${spaceId}:right`);
  const [minimap, setMinimap] = React.useState(true);
  const [overviewHost, setOverviewHost] = React.useState<HTMLDivElement | null>(null);
  const selection = JSON.stringify([...snapshot.selectedIds].sort());
  const lastSelection = React.useRef('[]');
  React.useEffect(() => {
    if (selection === lastSelection.current) return;
    lastSelection.current = selection;
    if (snapshot.selectedIds.length > 0) {
      automaticPanel.current = true;
      returnTarget.current = stage.current?.querySelector('canvas') ?? null;
      setPanel('properties'); setRightOpen(true);
    } else if (panel === 'properties') setRightOpen(false);
  }, [selection, snapshot.selectedIds.length, panel, setRightOpen]);
  React.useEffect(() => () => setRightOpen(false), [setRightOpen]);
  /**
   * Switch a right panel while recording a valid keyboard return target.
   * @param next - The requested right panel.
   * @throws {never} Never directly.
   */
  const showPanel = (next: ScenePanel): void => {
    automaticPanel.current = false;
    returnTarget.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (panel === next && rightOpen) { setRightOpen(false); return; }
    setPanel(next); setRightOpen(true);
  };
  /**
   * Give an in-progress native transform ownership of its cancellation key.
   * @returns Whether this press cancelled the current personal gesture.
   * @throws {never} Cancellation uses the existing session owner.
   */
  const cancelGesture = (): boolean => {
    if (!session.getSnapshot().gestureActive) return false;
    session.endGesture(false);
    return true;
  };
  /**
   * Keep keyboard ownership in the persistent panel before its selected row unmounts.
   * @throws {never} Never directly.
   */
  const showSelectedProperties = React.useCallback((): void => {
    if (session.getSnapshot().selectedIds.length === 0) return;
    rightPanel.current?.focus();
    setPanel('properties');
  }, [session]);
  /**
   * Toggle the current selection's explicit document lock through the shared command owner.
   * @throws {never} Command refusals are reported by the session owner.
   */
  const toggleSelectionLock = React.useCallback((): void => {
    const current = session.getSnapshot();
    const objects = current.objects.filter((object) => current.selectedIds.includes(object.id));
    if (objects.length === 0) return;
    session.execute({ type: 'lock', ids: current.selectedIds, locked: !objects.every((object) => object.locked) });
  }, [session]);
  return <div ref={stage} className='relative isolate h-full min-h-0 min-w-0 bg-canvas' data-testid='three-d-space'>
    <div className='absolute inset-0' data-testid='scene-stage' style={{ '--color-background': 'var(--color-canvas)' } as React.CSSProperties}>
      {snapshot.status === 'unsupported' ? <div className='flex h-full flex-col items-center justify-center gap-3 p-4 text-sm'><p>{t('spaces.threeD.unsupported')}</p><Button onClick={() => window.location.reload()}>{t('spaces.threeD.reload')}</Button></div>
        : snapshot.status === 'loading' ? <div className='grid h-full place-items-center p-4 text-sm'>{connection.status === 'authFailed' ? t('spaces.threeD.refused') : t('spaces.threeD.loading')}</div>
          : controls.isError || rendererFailed ? <div className='flex h-full flex-col items-center justify-center gap-3 p-4 text-sm'><p>{t('spaces.threeD.loadFailed')}</p><Button onClick={() => {
            setRendererFailed(false); setRendererRevision((value) => value + 1); void controls.refetch();
          }}>{t('spaces.threeD.retry')}</Button></div>
            : controls.isPending ? <div className='grid h-full place-items-center text-sm'>{t('spaces.threeD.loading')}</div>
              : <React.Suspense fallback={<div className='grid h-full place-items-center text-sm'>{t('spaces.threeD.loading')}</div>}>
                <SceneViewport key={`${userId}:${spaceId}:${rendererRevision}`} objects={snapshot.objects} selectedIds={snapshot.selectedIds}
                  overviewHost={overviewHost} mode={mode} readOnly={!mutable} view={view.current} focusRevision={focusRevision} cancelRevision={snapshot.cancelRevision}
                  remotePeers={snapshot.remotePeers} scaleSensitivity={controls.data.scaleSensitivity} modelRetryRevision={modelRetryRevision}
                  onSelect={(id, additive) => session.select(id, additive)} onGestureStart={() => session.beginGesture()}
                  onGestureChange={(patches) => session.previewGesture(patches)} onGestureEnd={(commit) => session.endGesture(commit)}
                  onViewChange={onViewChange} onError={() => setRendererFailed(true)} onModelStateChange={onModelStateChange} resolveAsset={resolveAsset} />
              </React.Suspense>}
      {failedModels ? <div className='absolute left-20 top-3 flex max-w-[calc(100%-6rem)] items-center justify-between gap-2 rounded-chrome border border-border bg-background p-2 text-xs'>
        <span>{t('spaces.threeD.modelFailed')}</span><Button size='sm' variant='ghost' onClick={() => setModelRetryRevision((value) => value + 1)}>{t('spaces.threeD.retry')}</Button>
      </div> : null}
    </div>
    <SceneCreationMenu canEdit={snapshot.canEdit} onAdd={addBuiltin} />
    <SceneRightPanel open={rightOpen} onOpenChange={setRightOpen} automatic={automaticPanel} stage={stage} returnTarget={returnTarget} cancelGesture={cancelGesture} contentRef={rightPanel}
      title={panel === 'properties' ? t('spaces.threeD.properties') : panel === 'objects' ? t('spaces.threeD.objects') : t('spaces.threeD.tasks')}
      actions={panel === 'properties' && selected.length > 0 ? <SceneIconButton label={allSelectedLocked ? t('spaces.threeD.unlock') : t('spaces.threeD.lock')}
        data-testid='scene-selection-lock' aria-pressed={allSelectedLocked} disabled={!snapshot.canEdit} onClick={toggleSelectionLock}>
        {allSelectedLocked ? <Lock className='size-4' /> : <UnlockIcon className='size-4' />}
      </SceneIconButton> : null}>
      {panel === 'properties' ? <React.Suspense fallback={<p className='p-4 text-sm text-muted-foreground'>{t('spaces.threeD.loading')}</p>}>
        <SceneInspector session={session} snapshot={snapshot} readObjects={readObjects} namedPeers={namedPeers} />
      </React.Suspense>
        : panel === 'objects' ? <SceneObjectList session={session} snapshot={snapshot} modelStates={modelStates} onSelect={showSelectedProperties} />
          : <p className='p-4 text-sm text-muted-foreground' data-testid='scene-tasks-panel'>{t('spaces.threeD.generationDev')}</p>}
    </SceneRightPanel>
    <div className='absolute bottom-[61px] right-[var(--space-5)] z-10'>
      {minimap ? <div ref={setOverviewHost} data-testid='scene-map' className='h-[142px] w-[202px] overflow-hidden rounded-overlay border border-border bg-popover shadow' /> : null}
    </div>
    <SceneViewportToolbar undo={snapshot.canEdit && snapshot.canUndo} redo={snapshot.canEdit && snapshot.canRedo}
      onHistory={(step) => session.historyStep(step)} hasSelection={selected.length > 0} onPanel={showPanel} minimap={minimap} onMinimap={() => setMinimap((value) => !value)} />
    {selected.length > 0 ? <SceneObjectToolbar mode={mode} mutable={mutable} canDuplicate={snapshot.canEdit}
      onMode={(next) => { session.endGesture(false); setMode(next); }} onFocus={() => setFocusRevision((value) => value + 1)} onDuplicate={duplicate}
      onDelete={() => session.execute({ type: 'delete', ids: snapshot.selectedIds })} /> : null}
  </div>;
}
