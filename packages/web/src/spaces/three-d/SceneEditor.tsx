// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { Lock } from 'lucide-react';

import { getLocale, isSceneCamera, isSceneLight, isSceneModelFile, nextDirectorNumber, SCENE_LIGHT_COLOR_DEFAULT, SCENE_LIGHT_INTENSITY, type SceneLightType, type SceneObject, type ViewfinderRatio } from '@breatic/shared';
import { Button } from '@web/components/ui/button';
import { getSceneControls, resolveSceneAsset, type SpaceTask } from '@web/data/api/scene';
import { docName } from '@web/data/yjs/manager';
import { isOlderSceneFormat, isSceneSizeRefusal, type SceneEnvironmentValues } from '@web/data/yjs/scene-document';
import type { ScenePeer, SceneSession, SceneSessionSnapshot } from '@web/data/yjs/scene-session';
import type { SocketState } from '@web/data/yjs/use-socket';
import { useTranslation } from '@web/i18n/use-translation';
import { readSceneView, writeSceneView } from '@web/lib/scene-view-storage';
import { toast } from '@web/lib/toast';
import type { SpaceBodyProps } from '@web/spaces';
import { useExclusiveOverlay } from '@web/features/exclusive-overlay/use-exclusive-overlay';
import { SceneCreationMenu } from '@web/spaces/three-d/SceneCreationMenu';
import { fillFromTask } from '@web/spaces/three-d/scene-generation';
import { useSceneProposals } from '@web/stores/scene-proposals';
import { useConversationRuntime } from '@web/stores/conversation-runtime';
import { useProjectSpaceList } from '@web/data/yjs/project-meta';
import { SceneViewfinder, sceneViewfinderSafeArea } from '@web/spaces/three-d/SceneViewfinder';
import { LIGHT_LABEL, SceneDirectorPanel } from '@web/spaces/three-d/SceneDirectorPanel';
import { cameraFrameRatio, clampFreeRatio, largestFrame, viewfinderRatioValue } from '@web/spaces/three-d/viewfinder/viewfinder-geometry';
import type { LightsPlan } from '@web/spaces/three-d/viewport/director-lights';
import { INITIAL_VIEWFINDER, cameraViewOf, viewfinderReducer, type ViewfinderAction } from '@web/spaces/three-d/viewfinder/viewfinder-state';
import { SceneField, type SceneFieldDraft } from '@web/spaces/three-d/SceneField';
import { SceneIconButton } from '@web/spaces/three-d/SceneIconButton';
import { SceneObjectList } from '@web/spaces/three-d/SceneObjectList';
import { SceneRightPanel } from '@web/spaces/three-d/SceneRightPanel';
import { SceneViewportToolbar, type ScenePanel } from '@web/spaces/three-d/SceneViewportToolbar';
import { SceneObjectToolbar } from '@web/spaces/three-d/SceneObjectToolbar';
import type { SceneCameraView, SceneFrameCapture, SceneModelAcquire, SceneModelState, ScenePilotControl, SceneSkeletonState, SceneTransformMode, SceneView, SceneViewportProps } from '@web/spaces/three-d/viewport/scene-viewport-props';
import { getModelImportController } from '@web/spaces/three-d/model-import-controller';
import type { ModelImportController, PreparedModel } from '@web/spaces/three-d/model-import-controller';
import type { ModelSource } from '@web/spaces/three-d/model-source';
import { budgetText, importErrorKey } from '@web/spaces/three-d/model-import-error-text';
import { pageSceneUploads } from '@web/spaces/three-d/scene-uploads';
import { SceneTaskList } from '@web/spaces/three-d/SceneTaskList';
import { useControlPress } from '@web/spaces/three-d/use-control-press';
import { ModelImportError } from '@web/spaces/three-d/model-import-errors';

const SceneViewport = React.lazy(() => import('@web/spaces/three-d/viewport/SceneViewport'));
const SceneInspector = React.lazy(() => import('@web/spaces/three-d/SceneInspector').then((module) => ({ default: module.SceneInspector })));
const SceneModelImportHost = React.lazy(() => import('@web/spaces/three-d/SceneModelImportHost'));


const lockIcon = <Lock className='size-4' />;
/** The frame a camera saved from the plain view gets (inner#1694 design 3.5). */
const SAVED_CAMERA_FRAME: ViewfinderRatio = '16:9';
const stageStyle = { '--color-background': 'var(--color-canvas)' } as React.CSSProperties;

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
 * @param root0 - Scene identity and document bindings supplied by the Space host.
 * @param root0.projectId - Project whose scene is being edited.
 * @param root0.spaceId - Space that owns the current scene.
 * @param root0.myRole - The member's project role, which gates the rail's create entries.
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
const SceneEditor = React.memo(function SceneEditor({ projectId, spaceId, myRole, userId, session, snapshot, connection,
  namedPeers, readObjects, ownsKeyboard, UnlockIcon }: SceneEditorProps): React.JSX.Element {
  const t = useTranslation();
  const figureName = t('spaces.threeD.figure');
  const boxName = t('spaces.threeD.box');
  const loadingText = t('spaces.threeD.loading');
  const placeFailedText = t('spaces.threeD.taskList.placeFailed');
  const lockText = t('spaces.threeD.lock');
  const unlockText = t('spaces.threeD.unlock');
  const controls = useQuery({ queryKey: ['scene-controls', projectId, userId],
    queryFn: ({ signal }) => getSceneControls(projectId, signal) });
  const [mode, setMode] = React.useState<SceneTransformMode>('translate');
  const [focusRevision, setFocusRevision] = React.useState(0);
  const [modelRetryRevision, setModelRetryRevision] = React.useState(0);
  const [rendererRevision, setRendererRevision] = React.useState(0);
  const [rendererFailed, setRendererFailed] = React.useState(false);
  // The main area and every monitor card show the same failure.
  const viewFailed = controls.isError || rendererFailed;
  const [modelStates, setModelStates] = React.useState<ReadonlyMap<string, SceneModelState>>(new Map());
  const [modelErrors, setModelErrors] = React.useState<ReadonlyMap<string, Error>>(new Map());
  const [fieldDrafts, setFieldDrafts] = React.useState<ReadonlyMap<string, SceneFieldDraft>>(new Map());
  const [skeletonStates, setSkeletonStates] = React.useState<ReadonlyMap<string, SceneSkeletonState>>(new Map());
  const [jointMode, setJointMode] = React.useState(false);
  const [selectedJoint, setSelectedJoint] = React.useState<string | null>(null);
  const [viewfinder, dispatchViewfinder] = React.useReducer(viewfinderReducer, INITIAL_VIEWFINDER);
  const framing = viewfinder.phase !== 'off';
  // From Capture until Reframe or close the frame holds the still, so the view is locked and the object toolbar is put away.
  const shotTaken = framing && viewfinder.phase !== 'framing';
  const viewfinderPhase = React.useRef(viewfinder.phase);
  viewfinderPhase.current = viewfinder.phase;
  const [frameCapture, setFrameCapture] = React.useState<SceneFrameCapture | null>(null);
  /** Hold the viewport's capture while it lives. */
  const onCapture = React.useCallback((capture: SceneFrameCapture | null): void => setFrameCapture(() => capture), []);
  const projectSpaces = useProjectSpaceList(projectId);
  const spaceName = projectSpaces.find((space) => space.id === spaceId)?.name ?? '';
  const chatSwitching = useConversationRuntime((s) => s.navigatingByProject[projectId] === true);
  /**
   * Turn joint mode on or off; either way no joint is selected yet.
   * @param next - The requested joint mode.
   * @throws {never} Never.
   */
  const changeJointMode = React.useCallback((next: boolean): void => { setJointMode(next); setSelectedJoint(null); }, []);
  /** Leave joint mode (design 5.2): any selection, lock, permission, panel or transform-tool change. */
  const leaveJointMode = React.useCallback((): void => changeJointMode(false), [changeJointMode]);
  /** Remember what the viewport found in a loaded model's skeleton. */
  const onSkeletonState = React.useCallback((id: string, state: SceneSkeletonState): void => {
    setSkeletonStates((previous) => previous.get(id) === state ? previous : new Map(previous).set(id, state));
  }, []);
  /**
   * Retain temporary field input for this Activity's lifetime, outside its floating panel.
   * @throws {never} Never.
   */
  const onFieldDraftChange = React.useCallback((key: string, draft: SceneFieldDraft | undefined): void => {
    setFieldDrafts((previous) => {
      const next = new Map(previous);
      if (draft) next.set(key, draft);
      else next.delete(key);
      return next;
    });
  }, []);
  const pendingFocusIds = React.useRef(new Set<string>());
  /** Placed objects whose model this editor still holds, until the viewport holds them too. */
  const placements = React.useRef(new Map<string,() => void>());
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
  // Cameras and lights keep a unit scale and a point light has no direction (design 3.3).
  const canScale = selected.every((object) => isSceneModelFile(object.model));
  const canRotate = selected.every((object) => !(isSceneLight(object) && object.model.type === 'point'));
  React.useEffect(() => {
    if ((mode === 'scale' && !canScale) || (mode === 'rotate' && !canRotate)) setMode('translate');
  }, [mode, canScale, canRotate]);
  // Cameras and lights load no model file, so only models count as loading or failed (design 5).
  const models = snapshot.objects.filter((object) => isSceneModelFile(object.model));
  const failedModels = models.some((object) => modelStates.get(object.id) === 'failed');
  const modelsLoading = models.some((object) => {
    const state = modelStates.get(object.id);
    return state === undefined || state === 'loading';
  });
  const director = controls.data?.director;
  const lookCamera = React.useMemo(() => {
    const source = viewfinder.source;
    const found = source.kind === 'camera' ? snapshot.objects.find((object) => object.id === source.id) : undefined;
    return found && isSceneCamera(found) ? found : null;
  }, [viewfinder.source, snapshot.objects]);
  const nextCameraView = cameraViewOf(viewfinder, lookCamera, snapshot.canEdit);
  const cameraViewKey = JSON.stringify(nextCameraView);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- the key holds every field; the value stays the same object while it is unchanged
  const cameraView = React.useMemo<SceneCameraView | null>(() => nextCameraView, [cameraViewKey]);
  const cameraViewRef = React.useRef(cameraView);
  cameraViewRef.current = cameraView;
  const viewFrame = cameraView === null ? null : viewfinder.frame;
  const [ambientDraft, setAmbientDraft] = React.useState<Partial<SceneEnvironmentValues> | null>(null);
  const environment = React.useMemo(() => (ambientDraft ? { ...snapshot.environment, ...ambientDraft } : snapshot.environment), [ambientDraft, snapshot.environment]);
  const ambientDraftRef = React.useRef(ambientDraft);
  ambientDraftRef.current = ambientDraft;
  const ambientOpen = React.useCallback((): boolean => session.getSnapshot().canEdit, [session]);
  const ambientPress = useControlPress(ambientOpen);
  const [lightPlan, setLightPlan] = React.useState<LightsPlan | null>(null);
  const [monitors, setMonitors] = React.useState<ReadonlyMap<string, HTMLCanvasElement>>(new Map());
  const pilotControl = React.useRef<ScenePilotControl | null>(null);
  /**
   * End an ambient press without writing it; its later changes are ignored until the next press starts.
   * @returns Whether its drag was still open.
   */
  const dropAmbient = React.useCallback((): boolean => {
    const open = ambientPress.end();
    ambientDraftRef.current = null;
    setAmbientDraft(null);
    return open;
  }, [ambientPress]);
  /**
   * Apply a personal history step (design 3.8): a pending pilot wheel step is written first, and every press in
   * progress ends without writing it.
   * @param step - Undo or redo.
   * @throws {never} Never.
   */
  const onHistory = React.useCallback((step: 'undo' | 'redo'): void => {
    pilotControl.current?.flush();
    dropAmbient();
    session.historyStep(step);
  }, [session, dropAmbient]);
  const failures = snapshot.objects.flatMap((object) => {
    const error = modelStates.get(object.id) === 'failed' ? modelErrors.get(object.id) : undefined;
    return error ? [error] : [];
  });
  // A model whose content was refused fails again on retry; only transport failures can succeed.
  const cause = failures.find((error): error is ModelImportError => error instanceof ModelImportError);
  const modelRetryable = !failures.length || failures.some((error) => !(error instanceof ModelImportError));

  React.useEffect(() => {
    session.setVisible(true);
    /** Re-evaluate focus and page visibility from the browser's current facts. */
    const syncFocus = (): void => {
      const focused = document.hasFocus() && document.visibilityState === 'visible';
      if (!focused) dropAmbient();
      session.setFocused(focused);
    };
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
  }, [session, userId, projectId, spaceId, t, dropAmbient]);

  React.useEffect(() => {
    const error = snapshot.commandError;
    // A size refusal is reported by its own warning.
    if (error && !isSceneSizeRefusal(error.reason) && error !== reportedCommandError.current) {
      if (error.reason === 'lightLimit') toast.warning(t('spaces.threeD.director.lightLimit', { max: director?.maxLights ?? 0 }));
      else toast.error(t('spaces.threeD.commandFailed'));
    }
    reportedCommandError.current = error;
  }, [snapshot.commandError, director, t]);

  React.useEffect(() => {
    if (director) session.setLimits({ maxLights: director.maxLights });
  }, [session, director]);

  // A camera deleted while it is the source: framing closes, a still stays with a free source (design 6.1).
  const lookSourceId = viewfinder.source.kind === 'camera' ? viewfinder.source.id : null;
  React.useEffect(() => {
    if (lookSourceId === null || lookCamera !== null || snapshot.status !== 'ready') return;
    dispatchViewfinder({ type: 'cameraDeleted', id: lookSourceId });
    toast.info(t('spaces.threeD.director.cameraDeleted'));
  }, [lookSourceId, lookCamera, snapshot.status, t]);

  const couldEdit = React.useRef(snapshot.canEdit);
  React.useEffect(() => {
    if (couldEdit.current && !snapshot.canEdit) { dispatchViewfinder({ type: 'permissionLost' }); dropAmbient(); }
    couldEdit.current = snapshot.canEdit;
  }, [snapshot.canEdit, dropAmbient]);

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
      if (session.getSnapshot().status !== 'ready') return;
      const modifier = event.metaKey || event.ctrlKey;
      const key = event.key.toLowerCase();
      if (event.key === 'Escape') {
        if (event.repeat) return;
        event.preventDefault();
        // One step per press: cancel the drag, then step the viewfinder back (#1411 design 3.7; its
        // canvas list closes itself), then clear the selection. Joint mode lives only while the
        // properties panel is open, and the panel's own Escape leaves it first.
        if (session.getSnapshot().gestureActive) session.endGesture(false);
        else if (pilotControl.current?.escape()) return;
        else if (viewfinderPhase.current === 'picking') return;
        else if (viewfinderPhase.current !== 'off') dispatchViewfinder({ type: 'escape' });
        else session.select(null, false);
        return;
      }
      if (!modifier && !event.altKey && key === 'f') { event.preventDefault(); setFocusRevision((value) => value + 1); return; }
      if (modifier && !event.altKey && key === 'z') { event.preventDefault(); onHistory(event.shiftKey ? 'redo' : 'undo'); return; }
      if (event.ctrlKey && !event.metaKey && !event.altKey && key === 'y') { event.preventDefault(); onHistory('redo'); return; }
      if (modifier && !event.altKey && !event.shiftKey && key === 'd') { event.preventDefault(); if (!event.repeat) duplicate(); return; }
      if (!modifier && !event.altKey && !event.shiftKey && (event.key === 'Delete' || event.key === 'Backspace')) {
        event.preventDefault();
        if (!event.repeat) session.execute({ type: 'delete', ids: session.getSnapshot().selectedIds });
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return (): void => window.removeEventListener('keydown', onKeyDown);
  }, [session, duplicate, ownsKeyboard, onHistory]);

  /** Resolve one registered model through the same Project's access boundary. */
  const resolveAsset = React.useCallback((assetId: string, signal: AbortSignal): Promise<{ url: string; mimeType: string; sizeBytes: number }> =>
    resolveSceneAsset(projectId, assetId, signal), [projectId]);

  /** Persist only the personal camera; it never enters shared content or awareness. */
  const onViewChange = React.useCallback((next: SceneView): void => {
    view.current = next;
    if (!writeSceneView(userId, projectId, spaceId, next)) toast.error(t('spaces.threeD.viewFailed'));
  }, [userId, projectId, spaceId, t]);

  /** Show model failures and finish a placement's requested focus after asynchronous loading. */
  const onModelStateChange = React.useCallback((id: string, state: SceneModelState, error?: Error): void => {
    setModelStates((previous) => previous.get(id) === state ? previous : new Map(previous).set(id, state));
    setModelErrors((previous) => {
      if (state === 'failed' && error) return new Map(previous).set(id, error);
      if (!previous.has(id)) return previous;
      const next = new Map(previous);
      next.delete(id);
      return next;
    });
    if (state === 'ready' && pendingFocusIds.current.delete(id)) setFocusRevision((value) => value + 1);
    // The viewport holds the placed model itself now, or never will.
    if (state !== 'loading') {
      placements.current.get(id)?.();
      placements.current.delete(id);
    }
  }, []);

  /**
   * Place one built-in source through the scene create command.
   * @param kind - Built-in figure or stage-block source to place.
   */
  const addBuiltin = React.useCallback((kind: 'figure' | 'box'): void => {
    const id = crypto.randomUUID();
    pendingFocusIds.current.add(id);
    const object: SceneObject = { id, model: { kind: 'builtin', id: kind },
      name: kind === 'figure' ? figureName : boxName,
      position: [session.getSnapshot().objects.length * 1.6, kind === 'box' ? 0.5 : 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1], locked: false };
    if (!session.execute({ type: 'create', objects: [object] }).ok) pendingFocusIds.current.delete(id);
  }, [session, figureName, boxName]);

  const stage = React.useRef<HTMLDivElement>(null);
  const rightPanel = React.useRef<HTMLDivElement>(null);
  const automaticPanel = React.useRef(false);
  const returnTarget = React.useRef<HTMLElement | null>(null);
  const [panel, setPanel] = React.useState<ScenePanel>('properties');
  const [rightOpen, setRightOpen] = useExclusiveOverlay(`scene:${spaceId}:right`);
  const [importOpen, setImportOpen] = useExclusiveOverlay(`scene:${spaceId}:model-import`);
  const [importController, setImportController] = React.useState<ModelImportController | null>(null);
  const importLimits = controls.data?.import;
  /** Inspect in an operation-owned worker and validate a real native preview. */
  const prepareImport = React.useCallback(async (files: readonly ModelSource[], entry: string | undefined, signal: AbortSignal): Promise<PreparedModel> => {
    if (!importLimits) throw new Error('Scene model import configuration is unavailable');
    const { prepareSceneModel } = await import('@web/spaces/three-d/model-import-preparation');
    signal.throwIfAborted();
    return prepareSceneModel(files, entry, signal, importLimits);
  }, [importLimits]);
  const uploads = React.useMemo(pageSceneUploads, []);
  /** Start the page-held upload of a checked model under its name. */
  const startImport = React.useCallback((file: File, name: string) => uploads.start({ projectId, spaceId, file, label: name }), [uploads, projectId, spaceId]);
  React.useEffect(() => {
    if (!importLimits) return;
    setImportController(getModelImportController(session.doc, docName.threeDSpace(projectId, spaceId), { prepare: prepareImport, start: startImport }));
    return (): void => { setImportOpen(false); };
  }, [session, projectId, spaceId, importLimits, prepareImport, startImport, setImportOpen]);
  /** Open the import dialog. */
  const showImport = React.useCallback((): void => setImportOpen(true), [setImportOpen]);
  const [handedOff, setHandedOff] = React.useState<string | null>(null);
  const [focusTaskId, setFocusTaskId] = React.useState<string | null>(null);
  /** Take the new upload's row from the import dialog; it is shown once this Space is on screen. */
  const importStarted = React.useCallback((taskId: string): void => setHandedOff(taskId), []);
  React.useEffect(() => {
    // Effects stay down while the tab's Activity is hidden, so a hand-off answered then claims the shared overlay slot on return.
    if (handedOff === null) return;
    returnTarget.current = null;
    automaticPanel.current = false;
    setPanel('tasks');
    setRightOpen(true);
    setFocusTaskId(handedOff);
    setHandedOff(null);
  }, [handedOff, setRightOpen]);
  /** The handed row has been shown; a later reopening of the task list starts where the user left it. */
  const taskFocused = React.useCallback((): void => setFocusTaskId(null), []);
  /** Open the generation dialog filled from a generation row's Retry (design 4.6). */
  const retryGeneration = React.useCallback((task: SpaceTask): void => useSceneProposals.getState().request(fillFromTask(task)), []);
  const [filterHost, setFilterHost] = React.useState<HTMLSpanElement | null>(null);

  // A placement holds its model through the viewport's own cache until the
  // viewport holds the placed object too, so the model is loaded once.
  const acquireModel = React.useRef<SceneModelAcquire | null>(null);
  const acquireWaiters = React.useRef<((acquire: SceneModelAcquire) => void)[]>([]);
  /** Take the viewport's model holder, or let it go when the viewport goes. */
  const onResources = React.useCallback((acquire: SceneModelAcquire | null): void => {
    acquireModel.current = acquire;
    if (acquire) acquireWaiters.current.splice(0).forEach((resolve) => resolve(acquire));
    else placements.current.clear();
  }, []);
  React.useEffect(() => {
    const present = new Set(snapshot.objects.map((object) => object.id));
    for (const [id, release] of [...placements.current]) {
      if (present.has(id)) continue;
      release();
      placements.current.delete(id);
    }
  }, [snapshot.objects]);
  const keepTasksPanel = React.useRef(false);
  /**
   * Put one finished model into the scene at the personal view's centre, on the ground.
   * @param task - The finished row.
   * @returns Once placed or refused.
   */
  const placeTask = React.useCallback(async (task: SpaceTask): Promise<void> => {
    if (task.assetId === null) return;
    const acquire = acquireModel.current ?? await new Promise<SceneModelAcquire>((resolve) => { acquireWaiters.current.push(resolve); });
    const lease = acquire({ kind: 'asset', assetId: task.assetId });
    let bounds;
    try {
      bounds = await lease.bounds;
    } catch (error) {
      lease.release();
      // The viewport went (its Space closed or was hidden) and took the load with it: the press is cancelled, whatever shape the abort took.
      if (acquireModel.current !== acquire) return;
      // A refused model says why, as the viewport's failure notice does; a transport failure has nothing to add.
      toast.error(error instanceof ModelImportError ? `${placeFailedText} ${t(importErrorKey(error.code))}` : placeFailedText);
      return;
    }
    const id = crypto.randomUUID();
    const result = session.execute({ type: 'create', objects: [{ id, name: task.label, model: { kind: 'asset', assetId: task.assetId },
      position: [view.current.target[0] - bounds.center[0], -bounds.min[1], view.current.target[2] - bounds.center[2]],
      rotation: [0, 0, 0, 1], scale: [1, 1, 1], locked: false }] });
    // A refused command is reported by the session's own command feedback.
    if (!result.ok) {
      lease.release();
      return;
    }
    placements.current.set(id, lease.release);
    pendingFocusIds.current.add(id);
    keepTasksPanel.current = true;
    session.select(id, false);
  }, [session, placeFailedText, t]);

  const placedAssetIds = React.useMemo(() => new Set(snapshot.objects.flatMap((object) => (object.model.kind === 'asset' ? [object.model.assetId] : []))), [snapshot.objects]);
  /**
   * Select the scene's objects of one model and frame them all, keeping the task list open.
   * @param assetId - The model.
   */
  const locateAsset = React.useCallback((assetId: string): void => {
    const ids = snapshot.objects.filter((object) => object.model.kind === 'asset' && object.model.assetId === assetId).map((object) => object.id);
    if (ids.length === 0) return;
    keepTasksPanel.current = true;
    ids.forEach((id, index) => session.select(id, index > 0));
    setFocusRevision((value) => value + 1);
  }, [snapshot.objects, session]);

  const wasRightOpen = React.useRef(false);
  React.useEffect(() => {
    if (wasRightOpen.current && !rightOpen) setFieldDrafts(new Map());
    wasRightOpen.current = rightOpen;
  }, [rightOpen]);
  const [minimap, setMinimap] = React.useState(true);
  const [stageSize, setStageSize] = React.useState({ width: 0, height: 0 });
  React.useEffect(() => {
    const element = stage.current;
    if (!element) return;
    /**
     * Follow the stage's size for the viewfinder's safe area.
     * @returns Nothing.
     */
    const measure = (): void => setStageSize((previous) => previous.width === element.clientWidth && previous.height === element.clientHeight
      ? previous : { width: element.clientWidth, height: element.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const [overviewHost, setOverviewHost] = React.useState<HTMLDivElement | null>(null);
  const [viewfinderHost, setViewfinderHost] = React.useState<HTMLDivElement | null>(null);
  const selection = JSON.stringify([...snapshot.selectedIds].sort());
  const lastSelection = React.useRef('[]');
  React.useEffect(() => {
    if (selection === lastSelection.current) return;
    lastSelection.current = selection;
    setFieldDrafts(new Map());
    leaveJointMode();
    if (keepTasksPanel.current) {
      // A model placed from the task list is selected there; the list stays open for the next one.
      keepTasksPanel.current = false;
    } else if (viewfinderPhase.current !== 'off' || (panel === 'director' && rightOpen)) {
      // While framing or with the director console open, the panel follows only its own buttons (#1411 design 3.2, inner#1694 design 3.2).
    } else if (snapshot.selectedIds.length > 0 && !importOpen) {
      // An open import dialog keeps the overlay slot; a collaborator's change to the selection must not close it.
      automaticPanel.current = true;
      returnTarget.current = stage.current?.querySelector('canvas') ?? null;
      setPanel('properties'); setRightOpen(true);
    } else if (panel === 'properties') setRightOpen(false);
  }, [selection, snapshot.selectedIds.length, panel, rightOpen, setRightOpen, importOpen, leaveJointMode]);
  React.useEffect(() => {
    if (!mutable || panel !== 'properties' || !rightOpen) leaveJointMode();
  }, [mutable, panel, rightOpen, leaveJointMode]);
  React.useEffect(() => (): void => {
    // Activity hiding releases the overlay while the editor retains unfinished input.
    wasRightOpen.current = false;
    setRightOpen(false);
  }, [setRightOpen]);
  /**
   * Run a viewfinder action; opening it closes the right panel so the frame has the whole view.
   * @param action - The action.
   */
  const viewfinderAction = React.useCallback((action: ViewfinderAction): void => {
    if (action.type === 'open') setRightOpen(false);
    dispatchViewfinder(action);
  }, [setRightOpen]);
  /**
   * Switch a right panel while recording a valid keyboard return target.
   * @param next - The requested right panel.
   * @throws {never} Never directly.
   */
  const showPanel = React.useCallback((next: ScenePanel): void => {
    automaticPanel.current = false;
    if (panel !== next || rightOpen) setFieldDrafts(new Map());
    returnTarget.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (panel === next && rightOpen) { setRightOpen(false); return; }
    setPanel(next); setRightOpen(true);
  }, [panel, rightOpen, setRightOpen]);
  /**
   * Give an in-progress native transform, then joint mode, ownership of the panel's Escape.
   * @returns Whether this press cancelled the current personal gesture or left joint mode.
   * @throws {never} Cancellation uses the existing session owner.
   */
  const cancelGesture = React.useCallback((): boolean => {
    if (dropAmbient()) return true;
    if (session.getSnapshot().gestureActive) session.endGesture(false);
    else if (pilotControl.current?.escape()) return true;
    // During a camera view the viewfinder steps back first and the panel stays (design 3.8); its canvas list closes itself.
    else if (cameraViewRef.current !== null) { if (viewfinderPhase.current !== 'picking') dispatchViewfinder({ type: 'escape' }); }
    else if (jointMode) changeJointMode(false);
    else return false;
    return true;
  }, [session, jointMode, changeJointMode, dropAmbient]);
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

  /**
   * Select against the current document session.
   * @throws {never} Never.
   */
  const onSelect = React.useCallback<SceneViewportProps['onSelect']>((id, additive) => session.select(id, additive), [session]);
  /**
   * Begin the personal native transform draft.
   * @throws {never} Never.
   */
  const onGestureStart = React.useCallback<SceneViewportProps['onGestureStart']>(() => session.beginGesture(), [session]);
  /**
   * Preview complete transform fields without committing.
   * @throws {never} Never.
   */
  const onGestureChange = React.useCallback<SceneViewportProps['onGestureChange']>((patches) => session.previewGesture(patches), [session]);
  /**
   * Finish or cancel the current personal draft.
   * @throws {never} Never.
   */
  const onGestureEnd = React.useCallback<SceneViewportProps['onGestureEnd']>((commit) => session.endGesture(commit), [session]);
  /**
   * Present native renderer failure through the editor.
   * @throws {never} Never.
   */
  const onError = React.useCallback((): void => setRendererFailed(true), []);
  /**
   * Toggle the personal minimap.
   * @throws {never} Never.
   */
  const toggleMinimap = React.useCallback((): void => setMinimap((value) => !value), []);
  /**
   * Release the current draft before switching tools.
   * @throws {never} Never.
   */
  const onMode = React.useCallback((next: SceneTransformMode): void => { session.endGesture(false); setMode(next); leaveJointMode(); }, [session, leaveJointMode]);
  /**
   * Frame the current selection.
   * @throws {never} Never.
   */
  const onFocus = React.useCallback((): void => setFocusRevision((value) => value + 1), []);
  /**
   * Delete the latest selection rather than a captured snapshot.
   * @throws {never} Never.
   */
  const onDelete = React.useCallback((): void => { session.execute({ type: 'delete', ids: session.getSnapshot().selectedIds }); }, [session]);
  /**
   * Save what the user sees as a new camera (design 3.5): the pose of the still on screen, a copy of the camera being
   * looked through live, the open free frame, or the largest 16:9 frame of the plain view.
   */
  const saveView = React.useCallback(async (): Promise<void> => {
    const current = session.getSnapshot();
    const number = nextDirectorNumber(current.objects, 'camera');
    const base = { id: crypto.randomUUID(), name: t('spaces.threeD.director.cameraName', { n: number }), model: { kind: 'camera' as const },
      scale: [1, 1, 1] as [number, number, number], locked: false, number };
    if (viewfinder.frozen === null && lookCamera !== null) {
      pilotControl.current?.flush();
      const record = session.getSnapshot().objects.find((object) => object.id === lookCamera.id);
      if (!record || !isSceneCamera(record)) return;
      session.execute({ type: 'create', objects: [{ ...base, position: record.position, rotation: record.rotation,
        focalLength: record.focalLength, frame: record.frame, freeRatio: record.freeRatio } satisfies SceneObject] });
      return;
    }
    const { cameraFromStill, cameraFromView } = await import('@web/spaces/three-d/viewfinder/camera-from-frame');
    if (viewfinder.frozen !== null) {
      session.execute({ type: 'create', objects: [{ ...base, ...cameraFromStill(viewfinder.frozen) } satisfies SceneObject] });
      return;
    }
    const freeOpen = viewfinder.phase !== 'off';
    const frame = freeOpen ? viewfinder.frame : largestFrame(viewfinderRatioValue(SAVED_CAMERA_FRAME) ?? 1, sceneViewfinderSafeArea(stageSize, rightOpen));
    if (frame.width <= 0 || frame.height <= 0) return;
    const pose = cameraFromView(view.current, frame, stageSize);
    const ratio = freeOpen ? viewfinder.ratio : SAVED_CAMERA_FRAME;
    session.execute({ type: 'create', objects: [{ ...base, ...pose, frame: ratio,
      ...(ratio === 'Free' ? { freeRatio: clampFreeRatio(frame.width / frame.height) } : {}) } satisfies SceneObject] });
  }, [session, t, lookCamera, viewfinder, stageSize, rightOpen]);
  const onSaveView = React.useCallback((): void => { void saveView(); }, [saveView]);
  /**
   * Add a light of one type aimed at the orbit centre (design 3.6); through a camera, or on its still, the centre and
   * the viewer are that camera's.
   * @param type - The light type.
   */
  const addLight = React.useCallback(async (type: SceneLightType): Promise<void> => {
    const { newLightPose } = await import('@web/spaces/three-d/viewfinder/camera-from-frame');
    const current = session.getSnapshot();
    const number = nextDirectorNumber(current.objects, 'light');
    const anchor = pilotControl.current?.lightAnchor() ?? null;
    const pose = newLightPose(anchor?.centre ?? view.current.target, anchor?.viewer ?? view.current.position);
    session.execute({ type: 'create', objects: [{ id: crypto.randomUUID(), model: { kind: 'light', type }, number,
      name: t('spaces.threeD.director.lightName', { type: t(`spaces.threeD.director.${LIGHT_LABEL[type]}`), n: number }),
      position: pose.position, rotation: type === 'point' ? [0, 0, 0, 1] : pose.rotation, scale: [1, 1, 1], locked: false,
      color: SCENE_LIGHT_COLOR_DEFAULT, intensity: SCENE_LIGHT_INTENSITY[type].initial, castShadow: true } satisfies SceneObject] });
  }, [session, t]);
  const onAddLight = React.useCallback((type: SceneLightType): void => { void addLight(type); }, [addLight]);
  /**
   * Look through a camera with the frame of its ratio.
   * @param id - The camera.
   */
  const onLook = React.useCallback((id: string): void => {
    const camera = session.getSnapshot().objects.find((object) => object.id === id);
    if (!camera || !isSceneCamera(camera)) return;
    pilotControl.current?.flush();
    dispatchViewfinder({ type: 'look', id, view: view.current, frame: largestFrame(cameraFrameRatio(camera), sceneViewfinderSafeArea(stageSize, rightOpen)) });
  }, [session, stageSize, rightOpen]);
  /**
   * Follow a monitor card's canvas.
   * @param id - The camera.
   * @param canvas - Its canvas, or null when it unmounts.
   */
  const onMonitor = React.useCallback((id: string, canvas: HTMLCanvasElement | null): void => {
    setMonitors((previous) => {
      if ((previous.get(id) ?? null) === canvas) return previous;
      const next = new Map(previous);
      if (canvas) next.set(id, canvas); else next.delete(id);
      return next;
    });
  }, []);
  const onAmbientPreview = React.useCallback((values: Partial<SceneEnvironmentValues>): void => {
    if (!ambientPress.change()) return;
    // The ref leads the state so a commit queued right after this change reads it before React renders.
    ambientDraftRef.current = { ...ambientDraftRef.current, ...values };
    setAmbientDraft(ambientDraftRef.current);
  }, [ambientPress]);
  const onAmbientCommit = React.useCallback((): void => {
    const draft = ambientDraftRef.current;
    const open = ambientPress.end();
    ambientDraftRef.current = null;
    setAmbientDraft(null);
    if (open && draft) session.execute({ type: 'environment', set: draft });
  }, [session, ambientPress]);
  /**
   * Write a typed ambient colour as a command of its own.
   * @param ambientColor - The colour.
   * @throws {never} Never.
   */
  const onAmbientWrite = React.useCallback((ambientColor: string): void => { session.execute({ type: 'environment', set: { ambientColor } }); }, [session]);
  /**
   * Change the frame of the camera being looked through.
   * @param frame - The new frame or free ratio.
   */
  const onCameraFrame = React.useCallback((frame: { frame?: ViewfinderRatio; freeRatio?: number }): void => {
    if (lookCamera) session.execute({ type: 'patch', patches: [{ id: lookCamera.id, ...frame }] });
  }, [session, lookCamera]);
  const onPilotPreview = React.useCallback<NonNullable<SceneViewportProps['onPilotPreview']>>((id, position, rotation) => session.previewPilot(id, position, rotation), [session]);
  const onPilotEnd = React.useCallback((commit: boolean): void => session.endPilot(commit), [session]);
  const onPilotLocked = React.useCallback((): void => { toast.warning(t('spaces.threeD.director.cameraLocked')); }, [t]);
  const onPilotControl = React.useCallback((control: ScenePilotControl | null): void => { pilotControl.current = control; }, []);
  const unlockedIcon = React.useMemo(() => <UnlockIcon className='size-4' />, [UnlockIcon]);
  const panelActions = React.useMemo(() => panel === 'properties' && selected.length > 0
    ? <SceneIconButton label={allSelectedLocked ? unlockText : lockText} data-testid='scene-selection-lock'
      aria-pressed={allSelectedLocked} disabled={!snapshot.canEdit} onClick={toggleSelectionLock}>
      {allSelectedLocked ? lockIcon : unlockedIcon}
    </SceneIconButton> : panel === 'tasks' ? <span ref={setFilterHost} className='inline-flex' /> : null,
  [panel, selected.length, allSelectedLocked, unlockText, lockText, snapshot.canEdit, toggleSelectionLock, unlockedIcon]);
  const inspectorFallback = React.useMemo(() => <p className='p-4 text-sm text-muted-foreground'>{loadingText}</p>, [loadingText]);
  const viewportFallback = React.useMemo(() => <div className='grid h-full place-items-center text-sm'>{loadingText}</div>, [loadingText]);
  const panelContent = React.useMemo(() => panel === 'properties'
    ? <React.Suspense fallback={inspectorFallback}>
      <SceneInspector session={session} snapshot={snapshot} readObjects={readObjects} namedPeers={namedPeers} spaceId={spaceId} Field={SceneField}
        fieldDrafts={fieldDrafts} onFieldDraftChange={onFieldDraftChange}
        skeletonStates={skeletonStates} jointMode={jointMode} onJointModeChange={changeJointMode} />
    </React.Suspense>
    : panel === 'director' ? <SceneDirectorPanel session={session} snapshot={snapshot} spaceId={spaceId} Field={SceneField} fieldDrafts={fieldDrafts}
      onFieldDraftChange={onFieldDraftChange} lightPlan={lightPlan} maxLights={director?.maxLights} lookingAt={lookCamera?.id ?? null}
      environment={environment} onSaveView={onSaveView} onAddLight={onAddLight} onLook={onLook} onMonitor={onMonitor}
      onAmbientPreview={onAmbientPreview} onAmbientCommit={onAmbientCommit} onAmbientCancel={dropAmbient} ambientPress={ambientPress} onAmbientWrite={onAmbientWrite} viewFailed={viewFailed} />
      : panel === 'objects' ? <SceneObjectList session={session} snapshot={snapshot} modelStates={modelStates} onSelect={showSelectedProperties} />
        : <SceneTaskList projectId={projectId} spaceId={spaceId} userId={userId} canEdit={snapshot.canEdit} canGenerate={myRole !== 'viewer'} uploads={uploads}
          remoteUploads={snapshot.remoteUploads} onPlace={placeTask} focusTaskId={focusTaskId} onFocused={taskFocused}
          onRetryGeneration={retryGeneration} placedAssetIds={placedAssetIds} onLocate={locateAsset} filterHost={filterHost} />,
  [panel, inspectorFallback, session, snapshot, readObjects, namedPeers, spaceId, fieldDrafts, onFieldDraftChange, skeletonStates, jointMode, changeJointMode, modelStates, showSelectedProperties,
    projectId, userId, myRole, uploads, placeTask, focusTaskId, taskFocused, retryGeneration, placedAssetIds, locateAsset, filterHost,
    lightPlan, director, lookCamera, environment, onSaveView, onAddLight, onLook, onMonitor, onAmbientPreview, onAmbientCommit, dropAmbient, ambientPress, onAmbientWrite, viewFailed]);
  // An older-format scene is never opened, so no editing chrome is shown around its message.
  if (snapshot.status === 'unsupported' && isOlderSceneFormat(snapshot.version)) {
    return <div ref={stage} className='relative isolate h-full min-h-0 min-w-0 bg-canvas' data-testid='three-d-space'>
      <div className='flex h-full items-center justify-center p-4 text-sm' data-testid='scene-stage'><p>{t('spaces.threeD.unsupportedOld')}</p></div>
    </div>;
  }
  return <div ref={stage} className='relative isolate h-full min-h-0 min-w-0 bg-canvas' data-testid='three-d-space'>
    <div className='absolute inset-0' data-testid='scene-stage' style={stageStyle}>
      {snapshot.status === 'unsupported' ? <div className='flex h-full flex-col items-center justify-center gap-3 p-4 text-sm'>
        <p>{t('spaces.threeD.unsupported')}</p><Button onClick={() => window.location.reload()}>{t('spaces.threeD.reload')}</Button></div>
        : snapshot.status === 'loading' ? <div className='grid h-full place-items-center p-4 text-sm'>{connection.status === 'authFailed' ? t('spaces.threeD.refused') : t('spaces.threeD.loading')}</div>
          : viewFailed ? <div className='flex h-full flex-col items-center justify-center gap-3 p-4 text-sm'><p>{t('spaces.threeD.loadFailed')}</p><Button onClick={() => {
            setRendererFailed(false); setRendererRevision((value) => value + 1); void controls.refetch();
          }}>{t('spaces.threeD.retry')}</Button></div>
            : controls.isPending ? <div className='grid h-full place-items-center text-sm'>{t('spaces.threeD.loading')}</div>
              : <React.Suspense fallback={viewportFallback}>
                <SceneViewport key={`${userId}:${spaceId}:${rendererRevision}`} objects={snapshot.objects} selectedIds={snapshot.selectedIds}
                  overviewHost={overviewHost} mode={mode} readOnly={!mutable} view={view.current} focusRevision={focusRevision} cancelRevision={snapshot.cancelRevision}
                  remotePeers={snapshot.remotePeers} scaleSensitivity={controls.data.scaleSensitivity} importLimits={controls.data.import} modelRetryRevision={modelRetryRevision}
                  jointMode={jointMode} selectedJoint={selectedJoint} onJointSelect={setSelectedJoint} onSkeletonState={onSkeletonState}
                  onSelect={onSelect} onGestureStart={onGestureStart}
                  onGestureChange={onGestureChange} onGestureEnd={onGestureEnd}
                  onViewChange={onViewChange} onError={onError} onModelStateChange={onModelStateChange} resolveAsset={resolveAsset} onResources={onResources}
                  onCapture={onCapture} viewLocked={shotTaken} cameraView={cameraView} viewFrame={viewFrame} environment={environment} director={director}
                  onPilotPreview={onPilotPreview} onPilotEnd={onPilotEnd} onPilotLocked={onPilotLocked} onPilotControl={onPilotControl}
                  onLightPlan={setLightPlan} monitors={monitors} />
              </React.Suspense>}
      {failedModels ? <div className='absolute left-20 top-3 flex max-w-[calc(100%_-_5rem_-_var(--space-5))] items-center justify-between gap-2 rounded-chrome border border-border bg-background p-2 text-xs'>
        <span className='min-w-0'>{t('spaces.threeD.modelFailed')}{cause && <> {t(importErrorKey(cause.code))}{cause.budget && <> {budgetText(t, cause.budget, getLocale())}</>}{cause.detail && <span className='block break-all text-muted-foreground'>{cause.detail}</span>}</>}</span>
        {modelRetryable && <Button size='sm' variant='ghost' onClick={() => setModelRetryRevision((value) => value + 1)}>{t('spaces.threeD.retry')}</Button>}
      </div> : null}
    </div>
    {framing ? null : <SceneCreationMenu projectId={projectId} spaceId={spaceId} myRole={myRole} canEdit={snapshot.canEdit && importController !== null} onAdd={addBuiltin} onImport={showImport}
      onGenerated={importStarted} />}
    {importController && importLimits && <React.Suspense fallback={null}><SceneModelImportHost controller={importController}
      open={importOpen} onOpenChange={setImportOpen} canEdit={snapshot.canEdit} maxInputBytes={importLimits.maxInputBytes} onStarted={importStarted} /></React.Suspense>}
    <SceneRightPanel open={rightOpen} onOpenChange={setRightOpen} automatic={automaticPanel} stage={stage} returnTarget={returnTarget} cancelGesture={cancelGesture} contentRef={rightPanel}
      title={panel === 'properties' ? t('spaces.threeD.properties') : panel === 'objects' ? t('spaces.threeD.objects') : panel === 'director' ? t('spaces.threeD.director.open') : t('spaces.threeD.tasks')}
      actions={panelActions}>
      {panelContent}
    </SceneRightPanel>
    <div className='absolute bottom-[61px] right-[var(--space-5)] z-10'>
      {minimap && !framing ? <div ref={setOverviewHost} data-testid='scene-map' className='h-[142px] w-[202px] overflow-hidden rounded-overlay border border-border bg-popover shadow' /> : null}
    </div>
    <SceneViewportToolbar undo={snapshot.canEdit && snapshot.canUndo} redo={snapshot.canEdit && snapshot.canRedo}
      onHistory={onHistory} hasSelection={selected.length > 0} onPanel={showPanel} minimap={minimap} minimapDisabled={framing} onMinimap={toggleMinimap} viewfinderHost={setViewfinderHost} />
    <SceneViewfinder host={viewfinderHost} state={viewfinder} dispatch={viewfinderAction} stage={stageSize} rightPanelOpen={rightOpen} capture={frameCapture}
      modelsLoading={modelsLoading} disabled={myRole === 'viewer' || snapshot.status !== 'ready'} chatSwitching={chatSwitching} projectId={projectId} spaceId={spaceId}
      spaceName={spaceName} userId={userId} config={controls.data?.capture} spaces={projectSpaces}
      camera={lookCamera} canEdit={snapshot.canEdit} onCameraFrame={onCameraFrame} />
    {selected.length > 0 && !shotTaken ? <SceneObjectToolbar mode={mode} jointMode={jointMode} mutable={mutable} canRotate={canRotate} canScale={canScale} canDuplicate={snapshot.canEdit}
      onMode={onMode} onFocus={onFocus} onDuplicate={duplicate} onDelete={onDelete} /> : null}
  </div>;
});

export default SceneEditor;
