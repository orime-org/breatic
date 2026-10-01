// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { useQuery } from '@tanstack/react-query';
import * as React from 'react';

import { canvasApi } from '@web/data/api/canvas';
import { ApiException } from '@web/data/api/types';
import {
  getPromptFragment,
  isNodeLocked,
  readCanvasGraph,
  setNodeMode,
  setNodeModel,
  runCanvasUndoBatch,
  setNodeParams,
  type CanvasEdge,
  type CanvasNodeView,
} from '@web/data/yjs/canvas-space';
import { useTextBodies } from '@web/data/yjs/use-text-body';
import {
  addStoryboardShot,
  enterStoryboardShots,
  readStoryboard,
  removeStoryboardShot,
  retotalStoryboard,
  setStoryboardKind,
  stepStoryboardShot,
  type StoryboardShotView,
} from '@web/data/yjs/node-storyboard';
import { useStoryboard } from '@web/data/yjs/use-storyboard';
import { useCanvasContext } from '@web/spaces/canvas/canvas-context';
import { useTranslation } from '@web/i18n/use-translation';
import { toast } from '@web/lib/toast';
import { useCanvasStore } from '@web/stores';
import {
  evaluateExecute,
  extractPromptText,
  effectiveStoryboardKind,
  storyboardSpec,
  type ExecuteVerdict,
  type ModelEntry,
  type ReferencePool,
  type StoryboardKind,
  type StoryboardSpec,
} from '@breatic/shared';
import { useCreditText } from '@web/spaces/canvas/generate/use-credit-estimate';
import { pickEndToastKey } from '@web/spaces/canvas/generate/pick-end-notice';
import {
  CatalogGatedFrame,
  useOpenPanelNode,
} from '@web/spaces/canvas/generate/generate-panel-frame';
import {
  deriveReferences,
  focusToRailItem,
  type ReferenceRailItem,
} from '@web/spaces/canvas/generate/derive-references';
import { executeErrorMessage } from '@web/spaces/canvas/generate/execute-error-message';
import { removeReferenceRow } from '@web/spaces/canvas/generate/remove-reference-row';
import {
  resolveModelSwitch,
  resolveParamsEdit,
} from '@web/spaces/canvas/generate/model-params';
import {
  filterAvailableModes,
  resolveModeSwitch,
} from '@web/spaces/canvas/generate/mode-selection';
import {
  asContentView,
  type ContentNodeView,
} from '@web/data/yjs/node-view';
import {
  PromptEditor,
  type PromptEditorHandle,
} from '@web/spaces/canvas/generate/PromptEditor';
import { ShotList, StoryboardSwitchRow } from '@web/spaces/canvas/generate/StoryboardControls';
import { mentionedSourceIds } from '@web/spaces/canvas/generate/fragment-prompt';
import { storyboardRun } from '@web/spaces/canvas/generate/storyboard-run';
import { VideoGeneratePanel } from '@web/spaces/canvas/generate/VideoGeneratePanel';
import {
  VIDEO_MODE_OPTIONS,
} from '@web/spaces/canvas/generate/video-mode-options';
import { modelsForModality } from '@web/spaces/canvas/generate/modality-buckets';
import { slotForPurpose, slotRefusalKey } from '@web/spaces/canvas/generate/slots';
import { poolCounts, poolKindOf, poolParams } from '@web/spaces/canvas/generate/reference-urls';
import { useReferenceKinds } from '@web/spaces/canvas/generate/use-reference-kinds';
import {
  videoMissing,
  VIDEO_SLOTS,
} from '@web/spaces/canvas/generate/video-slots';
import type { VideoSlot } from '@web/spaces/canvas/generate/video-slots';
import { clearSlot } from '@web/spaces/canvas/generate/slot-write';
import { buildVideoTaskPayload, videoEstimateInput } from '@web/spaces/canvas/generate/video-task-payload';
import {
  buildVideoPanelViewModel,
  nodeVideoMode,
  selectVideoModeModels,
  type VideoGenMode,
} from '@web/spaces/canvas/generate/video-panel-view-model';
import { evaluateNodeGate } from '@web/spaces/canvas/node-gate';
import { warnNodeGate } from '@web/spaces/canvas/node-gate-toast';
import { modelCatalogQuery } from '@web/spaces/canvas/generate/model-catalog-query';
import { useContentStable } from '@web/spaces/canvas/generate/use-content-stable';
import { useGenerateSubmitState } from '@web/spaces/canvas/generate/use-generate-submit-state';
import { PromptNotUsedNotice } from '@web/spaces/canvas/generate/PromptNotUsedNotice';

/**
 * For the reference derivation that deliberately wants no body text. Shared so
 * it does not allocate a map per call. Not frozen — `ReadonlyMap` is a
 * compile-time view and `Object.freeze` would not stop `.set()` on a Map
 * anyway; nothing downstream writes to it, and the type says they may not.
 */
const EMPTY_TEXT: ReadonlyMap<string, string> = new Map();

/**
 * What a shot box reports its words and mentions to: nobody, since they are
 * read off its fragment at submit.
 */
function IGNORE(): void {
  // Nothing to do.
}

/**
 * A model's storyboard, when it has one.
 * @param entry - The current model.
 * @returns Its storyboard spec.
 */
function specOf(entry: ModelEntry | undefined): StoryboardSpec | undefined {
  return entry ? storyboardSpec(entry.params) : undefined;
}

/**
 * The total seconds a run's shots have to add up to.
 * @param spec - The model's storyboard.
 * @param params - The run's params.
 * @returns The total, 0 when the model names none.
 */
function totalOf(spec: StoryboardSpec | undefined, params: Readonly<Record<string, unknown>>): number {
  const raw = spec?.totalParam === undefined ? undefined : params[spec.totalParam];
  return typeof raw === 'number' ? raw : 0;
}

interface VideoGeneratePanelContainerProps {
  /** Live canvas node views (target + reference sources). */
  nodes: ReadonlyArray<Pick<CanvasNodeView, 'id' | 'data'>>;
  /** Live canvas edges (incoming = references). */
  edges: ReadonlyArray<CanvasEdge>;
  /** Project the canvas space belongs to. */
  projectId: string;
  /** Canvas space id. */
  spaceId: string;
  /**
   * Who made the newest document write, read at the moment it is needed.
   *
   * A function rather than a value: this panel reacts to a document change
   * inside an effect, and effects run child-first — a value mirrored by the
   * canvas above would still be the previous write's author on the very
   * commit that ends a pick.
   */
  getLastWriteWasLocal: () => boolean;
}

/**
 * Inner panel body — mounted only while the panel is open, so its catalog query
 * and the collaborative prompt editor come and go with the node.
 * @param root0 - Component props.
 * @param root0.nodeId - The node whose video Generate panel is open.
 * @param root0.nodes - Live canvas node views.
 * @param root0.edges - Live canvas edges.
 * @param root0.projectId - Project id.
 * @param root0.spaceId - Canvas space id.
 * @param root0.getLastWriteWasLocal - Reads who made the newest document write.
 * @returns The video Generate panel.
 */
function VideoGeneratePanelBody({
  nodeId,
  nodes,
  edges,
  projectId,
  spaceId,
  getLastWriteWasLocal,
}: VideoGeneratePanelContainerProps & {
  nodeId: string;
}): React.JSX.Element {
  const t = useTranslation();
  const closeActivePanel = useCanvasStore((s) => s.closeActivePanel);
  const { caretProvider } = useCanvasContext();

  const { data: catalog } = useQuery(modelCatalogQuery());
  // `?? []` is pure defence now: since #1966 this body mounts only inside
  // `CatalogGatedFrame`, which withholds it until the query has data. Once
  // resolved, modelsApi.list() has run the response through
  // sanitizeModelCatalog, so catalog.video is a guaranteed ModelEntry[].
  const models = React.useMemo(() => modelsForModality(catalog, 'video'), [catalog]);

  const {
    promptText,
    promptTextRef,
    onPromptChange,
    promptEditorRef,
    isSubmitting,
    setIsSubmitting,
    submittingRef,
    isMountedRef,
  } = useGenerateSubmitState();

  // The ids the prompt `@`-mentions right now. Kept in a ref rather than in
  // state because the only reader is the click handler: re-rendering the panel
  // on every keystroke that touches a chip would buy nothing, and reading the
  // ref at click time is what makes the submit send exactly what the prompt
  // says at that instant (#1927). A text chip substitutes its source's words
  // inside the serialized prompt and needs none of this; an image chip becomes
  // a model input, and that is what these ids are for.
  const atMentionedRef = React.useRef<string[]>([]);
  const handleAtMentionsChange = React.useCallback((sourceIds: string[]) => {
    atMentionedRef.current = sourceIds;
  }, []);

  // The mode lives on the NODE, not in panel state: the switch is
  // collaborative, so a mode someone else picked has to show up here, and
  // reopening the panel has to land where it was left.
  // The modes this deployment can serve (#1951). Memoized on [models] alone:
  // it flows into two React.memo components, and a freshly-filtered array
  // would defeat both on every frame of a node drag — the same reason
  // `stableModels` below exists. Also why it is not a view-model field.
  const availableModes = React.useMemo(
    () => filterAvailableModes(VIDEO_MODE_OPTIONS, models),
    [models],
  );
  const mode = nodeVideoMode(nodes, nodeId, availableModes);

  // Read during render: `getPromptFragment` is a synchronous document read with
  // no side effect. Each mode keeps its own prompt (#2218), so a mode switch
  // binds the editor to that mode's words. Null means the node has no seeded
  // prompt for this mode (see getPromptFragment) — the panel then renders without a prompt
  // editor rather than minting a fragment behind the user's back.
  const fragment = React.useMemo(
    () => getPromptFragment(projectId, spaceId, nodeId, mode),
    [projectId, spaceId, nodeId, mode],
  );

  // A referenced text node's body is a shared fragment the node view does not
  // carry (#1774), so the panel follows the ones it can reference. This is the
  // only source of what a text reference SAYS: the rail's previews read it,
  // and the editor's reference pool — which is what the prompt serializer
  // substitutes a text chip with at execute time — is built from it. Without
  // it every text chip would serialize to nothing.
  //
  // "The ones it can reference" is literal, BY CONSTRUCTION: the ids come off
  // `deriveReferences` itself, the only consumer of the map this feeds, so the
  // two sets cannot drift. Following every text node on the board instead
  // would attach observers to all of them and rebuild this on every keystroke
  // anyone types anywhere.
  const textNodeIds = React.useMemo(
    () => [
      ...new Set(
        // Empty map on purpose: this call wants the ROWS (which sources, of
        // what type), and what they say is the very thing being subscribed to
        // below. It has to be said out loud — the parameter is required
        // precisely so that omitting it can never be an accident.
        deriveReferences(nodeId, nodes, edges, EMPTY_TEXT)
          .filter((row) => row.sourceNodeType === 'text')
          .map((row) => row.sourceNodeId),
      ),
    ],
    [nodeId, nodes, edges],
  );
  const textById = useTextBodies(projectId, spaceId, textNodeIds);
  const vm = React.useMemo(
    () =>
      buildVideoPanelViewModel({ nodeId, nodes, edges, models, mode, textById }),
    [nodeId, nodes, edges, models, mode, textById],
  );
  const creditText = useCreditText(
    vm.modelEntry,
    videoEstimateInput(vm, extractPromptText(promptText)),
    catalog?.credit_multiplier ?? 1,
  );

  // The mode's storyboard (#2218). Only a model declaring one can use it, so
  // the tier in effect is the stored one on such a model and off on any other;
  // the stored one stays as it is while the reader moves between models.
  const spec = React.useMemo(() => specOf(vm.modelEntry), [vm.modelEntry]);
  const storyboard = useStoryboard(projectId, spaceId, nodeId, mode);
  const storedKind: StoryboardKind = storyboard?.kind ?? 'off';
  const tier = effectiveStoryboardKind(vm.modelEntry?.params ?? {}, storyboard?.kind);
  const total = totalOf(spec, vm.params);
  // A fresh list only when a shot is added, removed, brought back or given
  // other seconds; words typed in a shot leave it as it is (`useStoryboard`).
  const shots = storyboard?.shots;

  // The box the caret was last in, so the rail's insert button lands there:
  // the main prompt, or one shot's box by its id. Same shape as the audio
  // panel's `lastFocusedBox`.
  const lastFocusedBox = React.useRef<string>('main');
  const shotEditors = React.useRef(new Map<string, PromptEditorHandle>());
  // The rail refuses a row the prompt cannot take itself (#1966), so this
  // only routes the insert: the shot box the caret was last in, else the
  // first shot box, else the main prompt. Shot boxes are mounted only in the
  // per-shot tier and leave the map when they unmount.
  const handleInsertReference = React.useCallback(
    (item: ReferenceRailItem) => {
      (
        shotEditors.current.get(lastFocusedBox.current) ??
        shotEditors.current.values().next().value ??
        promptEditorRef.current
      )?.insertReference(item);
    },
    [promptEditorRef],
  );
  const references = vm.references;

  // Every write-callback re-derives from live Yjs at click time instead of
  // reading the render closure: that closure goes stale the moment a
  // collaborator edits the node, and building a task or a param write off it
  // would clobber their edit. The MODE is re-read too — a collaborator can
  // switch it between this render and the click, and it decides both the model
  // and whether the submission needs a source.
  const freshVm = React.useCallback(
    (atMentionedSourceIds?: ReadonlySet<string>) => {
      const graph = readCanvasGraph(projectId, spaceId);
      return buildVideoPanelViewModel({
        nodeId,
        nodes: graph.nodes,
        edges: graph.edges,
        models,
        mode: nodeVideoMode(graph.nodes, nodeId, availableModes),
        atMentionedSourceIds,
        // Empty on purpose. What a text reference SAYS never travels through
        // here: the prompt string is serialized by the editor from its own
        // reference pool, and nothing this call site's readers touch is
        // derived from a text body. Filling it in would read every text body
        // on the board on every click for a field nobody downstream looks at.
        // Stated rather than omitted — the parameter is required so that
        // leaving it out cannot be an oversight.
        textById: EMPTY_TEXT,
      });
    },
    [projectId, spaceId, nodeId, models, availableModes],
  );

  /**
   * The node's live content view, or undefined when the node is gone or is not
   * a content node. Read fresh at click time for the same reason freshVm is: a
   * collaborator may have changed the model or the per-model records since
   * this render.
   * @returns The node's content view, or undefined.
   */
  const freshContent = React.useCallback((): ContentNodeView | undefined => {
    const graph = readCanvasGraph(projectId, spaceId);
    return asContentView(graph.nodes.find((n) => n.id === nodeId)?.data);
  }, [projectId, spaceId, nodeId]);

  // Stable identities for the memoized children: the view model rebuilds on
  // every canvas mutation, so a freshly-filtered array or a rebuilt params
  // object would defeat their React.memo on each frame of any node drag.
  const stableModels = React.useMemo(
    () => selectVideoModeModels(models, mode),
    [models, mode],
  );
  // Content-stable because the panel below is memoized and the view model
  // rebuilds on every canvas mutation.
  const stableParams = useContentStable(vm.params);
  // Crops uploading right now, for THIS node (#1978). Without them the rail
  // stays empty from the moment the marquee is confirmed until the upload
  // lands — and on a node whose rail is otherwise empty the rail does not
  // render at all, so the row appears out of nowhere on success.
  const pendingFocusAll = useCanvasStore((s) => s.pendingFocusUploads);
  const pendingFocus = React.useMemo(
    () =>
      pendingFocusAll
        .filter((p) => p.nodeId === nodeId)
        .map((p) => ({ id: p.id, name: p.name })),
    [pendingFocusAll, nodeId],
  );
  // References change identity on every derive; key the memo on their CONTENT
  // (a small array — a stringify key is cheap and exact), or the rail's memo
  // would be defeated on every frame of any node drag.
  //
  // Two sources, one list (#1978): edge-derived rows, then this node's focus
  // crops turned into rows of the same shape. Downstream — rail, `@` pool,
  // submit — there is one code path, exactly as on the image panel.
  const stableReferences = useContentStable([
    ...references,
    ...vm.focusImages.map(focusToRailItem),
  ]);
  // The submit serializes shots itself and needs what each text chip says:
  // the latest rows the editors were handed.
  const referencesRef = React.useRef(stableReferences);
  referencesRef.current = stableReferences;
  // The picked slot URLs are a fresh object per view-model build, on the same
  // terms as the references above — at most one short string per slot, so a
  // stringify key is cheap and exact. Before the slots were collected into one
  // object the panel got a plain string and bailed on its own; keying on the
  // content keeps that.
  const stableSlotUrls = useContentStable(vm.slotUrls);
  // The display URLs are a second object rebuilt just as often, so they need
  // the same treatment: one unstable prop is enough to make both memos below
  // re-render on every frame of a drag.
  const stableSlotThumbnails = useContentStable(vm.slotThumbnails);

  const onSelectModel = React.useCallback(
    (modelId: string) => {
      const picked = models.find((m) => m.name === modelId);
      if (!picked) {
        // The catalog refetched and dropped this model between render and
        // click — say so rather than silently ignore the selection.
        toast.error(t('canvas.generatePanel.modelUnavailable'));
        return;
      }
      const graph = readCanvasGraph(projectId, spaceId);
      // Record the pick under the mode that is ACTIVE right now, so a later
      // switch back to it restores this model rather than the default, and
      // give the picked model its OWN params rather than the outgoing
      // model's (#1948).
      const { paramsByModel } = resolveModelSwitch(freshContent(), picked);
      setNodeModel(
        projectId,
        spaceId,
        nodeId,
        nodeVideoMode(graph.nodes, nodeId, availableModes),
        modelId,
        paramsByModel,
      );
    },
    [models, availableModes, projectId, spaceId, nodeId, freshContent, t],
  );

  const onToggleMode = React.useCallback(
    (next: string) => {
      // The picker only ever offers modes from VIDEO_MODE_OPTIONS, so the cast
      // narrows a string the component types loosely (one picker serves both
      // panels) back to what this one offers.
      const target = next as VideoGenMode;
      // Read the node fresh — a collaborator may have changed its per-mode
      // model memory or its params since this render — and write the switch in
      // one transaction.
      const { model, paramsByModel } = resolveModeSwitch(
        freshContent(),
        target,
        models,
      );
      // Never persist an empty model: the resolver pairs one with an empty
      // record set, and writing that clobbers the node's stored model AND
      // every model's records, not just the incoming one's.
      //
      // Unreachable since #1951 — the picker only offers modes this
      // deployment serves, so the target always resolves a model, and a
      // modality that serves none does not open a panel at all. Kept as
      // defence against a layer above breaking.
      if (!model) return;
      setNodeMode(projectId, spaceId, nodeId, target, model, paramsByModel);
    },
    [models, projectId, spaceId, nodeId, freshContent],
  );

  const onChangeParams = React.useCallback(
    (partial: object) => {
      // The edit lands on the record of the model it was made on, so coming
      // back to that model finds it (#1948).
      // freshVm().model is the RESOLVED model — the one whose controls the
      // user just used. The node's stored model can be absent (a node created
      // moments ago) or no longer offered under this mode, and keying the
      // record on that would write the edit where the panel never reads it.
      const live = freshVm();
      const paramsByModel = resolveParamsEdit(
        freshContent(),
        partial,
        live.model,
      );
      // A new total re-splits the shots in the per-shot tier (design §5.3);
      // `retotalStoryboard` leaves the other tiers' shots alone. One gesture,
      // so one undo takes back both.
      const liveSpec = specOf(live.modelEntry);
      const next = liveSpec?.totalParam === undefined
        ? undefined
        : (partial as Record<string, unknown>)[liveSpec.totalParam];
      runCanvasUndoBatch(projectId, spaceId, () => {
        setNodeParams(projectId, spaceId, nodeId, paramsByModel);
        if (typeof next === 'number') retotalStoryboard(projectId, spaceId, nodeId, live.mode, next);
      });
    },
    [projectId, spaceId, nodeId, freshVm, freshContent],
  );

  // Storyboard writes (#2218). Each reads the mode and the total off live
  // Yjs at click time, for the reason the other writes do: a collaborator may
  // have switched either since this render.
  const liveBoard = React.useCallback(() => {
    const live = freshVm();
    const spec = specOf(live.modelEntry);
    return { mode: live.mode, spec, total: totalOf(spec, live.params) };
  }, [freshVm]);
  const onToggleStoryboard = React.useCallback(
    (on: boolean) => setStoryboardKind(projectId, spaceId, nodeId, freshVm().mode, on ? 'auto' : 'off'),
    [projectId, spaceId, nodeId, freshVm],
  );
  const onEnterShots = React.useCallback(() => {
    const { mode: liveMode, total: liveTotal } = liveBoard();
    enterStoryboardShots(projectId, spaceId, nodeId, liveMode, liveTotal);
  }, [projectId, spaceId, nodeId, liveBoard]);
  const onBackToAuto = React.useCallback(
    () => setStoryboardKind(projectId, spaceId, nodeId, freshVm().mode, 'auto'),
    [projectId, spaceId, nodeId, freshVm],
  );
  const onAddShot = React.useCallback(() => {
    const { mode: liveMode, spec: liveSpec, total: liveTotal } = liveBoard();
    addStoryboardShot(projectId, spaceId, nodeId, liveMode, liveTotal, liveSpec?.maxShots ?? Number.POSITIVE_INFINITY);
  }, [projectId, spaceId, nodeId, liveBoard]);
  const onStepShot = React.useCallback(
    (shotId: string, delta: 1 | -1) => stepStoryboardShot(projectId, spaceId, nodeId, freshVm().mode, shotId, delta),
    [projectId, spaceId, nodeId, freshVm],
  );
  const onRemoveShot = React.useCallback(
    (shotId: string) => {
      const { mode: liveMode, total: liveTotal } = liveBoard();
      removeStoryboardShot(projectId, spaceId, nodeId, liveMode, shotId, liveTotal);
    },
    [projectId, spaceId, nodeId, liveBoard],
  );

  // Reference and first frame are TOGGLES: start the pick when this node is not
  // already in it, else leave. Both flags are read reactively so a button
  // un-highlights when a collaborator, a mode switch or Exit ends the pick —
  // not only on a local click. A pick is a single session, so starting one
  // purpose replaces the other.
  const endPick = useCanvasStore((s) => s.endPick);
  const startReferencePick = useCanvasStore((s) => s.startReferencePick);
  const startFirstFramePick = useCanvasStore((s) => s.startFirstFramePick);
  const startEndFramePick = useCanvasStore((s) => s.startEndFramePick);
  const startCharacterImagePick = useCanvasStore(
    (s) => s.startCharacterImagePick,
  );
  const startDrivingVideoPick = useCanvasStore((s) => s.startDrivingVideoPick);
  const startDrivingAudioPick = useCanvasStore((s) => s.startDrivingAudioPick);
  const startSourceVideoPick = useCanvasStore((s) => s.startSourceVideoPick);
  const startLeftAudioPick = useCanvasStore((s) => s.startLeftAudioPick);
  const startRightAudioPick = useCanvasStore((s) => s.startRightAudioPick);
  const referencePicking = useCanvasStore(
    (s) =>
      s.pickSession?.nodeId === nodeId && s.pickSession?.purpose === 'reference',
  );
  const focusPicking = useCanvasStore(
    (s) => s.pickSession?.nodeId === nodeId && s.pickSession?.purpose === 'focus',
  );
  // Focus pick, toggled from the toolbar (#1978). Same shape as the image
  // panel's: a second click on a running focus pick for THIS node ends it,
  // so the button is a real toggle rather than a one-way trip.
  const startFocusPick = useCanvasStore((s) => s.startFocusPick);
  const onFocus = React.useCallback(() => {
    const session = useCanvasStore.getState().pickSession;
    if (session?.nodeId === nodeId && session.purpose === 'focus') {
      endPick();
    } else {
      startFocusPick(nodeId);
    }
  }, [startFocusPick, endPick, nodeId]);

  // One starter per slot. `Record<VideoSlot, …>` is what makes a new slot
  // impossible to half-wire: leaving it out here does not compile.
  const startSlotPick: Record<VideoSlot, (id: string) => void> = React.useMemo(
    () => ({
      firstFrame: startFirstFramePick,
      endFrame: startEndFramePick,
      characterImage: startCharacterImagePick,
      drivingVideo: startDrivingVideoPick,
      drivingAudio: startDrivingAudioPick,
      sourceVideo: startSourceVideoPick,
      leftAudio: startLeftAudioPick,
      rightAudio: startRightAudioPick,
    }),
    [
      startSourceVideoPick,
      startLeftAudioPick,
      startRightAudioPick,
      startFirstFramePick,
      startEndFramePick,
      startCharacterImagePick,
      startDrivingVideoPick,
      startDrivingAudioPick,
    ],
  );
  /** The slot whose pick is running on this node, if any. */
  const activeSlot = useCanvasStore((s) => {
    if (s.pickSession?.nodeId === nodeId) {
      const name = slotForPurpose(s.pickSession.purpose);
      // The lookup spans every registry, and this panel draws only its own
      // slots — a pick that fills an audio slot leaves nothing highlighted here.
      if (name !== undefined && name in VIDEO_SLOTS) return name as VideoSlot;
    }
    return undefined;
  });
  const onAddReference = React.useCallback(() => {
    const session = useCanvasStore.getState().pickSession;
    if (session?.nodeId === nodeId && session.purpose === 'reference') {
      endPick();
    } else {
      startReferencePick(nodeId);
    }
  }, [startReferencePick, endPick, nodeId]);
  const onPickSlot = React.useCallback(
    (slot: VideoSlot) => {
      const session = useCanvasStore.getState().pickSession;
      if (
        session?.nodeId === nodeId &&
        session.purpose === VIDEO_SLOTS[slot].purpose
      ) {
        endPick();
        return;
      }
      startSlotPick[slot](nodeId);
    },
    [startSlotPick, endPick, nodeId],
  );
  // A running slot pick outlives the control that started it when the mode
  // changes (locally or via a collaborator's setNodeMode): the slot stops
  // rendering, so the pick loses the control that started it — the banner's
  // Exit would be the only way out, while the canvas kept dimming candidates
  // for a slot that is gone. Keyed on the mode's slot list, so it covers every
  // slot rather than the one it was first written for.
  const slotsKey = vm.slots.join(',');
  React.useEffect(() => {
    const session = useCanvasStore.getState().pickSession;
    if (!session || session.nodeId !== nodeId) return;
    const running = slotForPurpose(session.purpose);
    if (running && !slotsKey.split(',').includes(running)) {
      endPick();
      // The slot list comes from the mode, so this is a mode change reaching
      // the pick — and the write may well have been a collaborator's.
      toast.warning(
        t(
          pickEndToastKey(getLastWriteWasLocal()),
        ),
      );
    }
  }, [slotsKey, nodeId, endPick, t, getLastWriteWasLocal]);

  const onRemoveReference = React.useCallback(
    (item: ReferenceRailItem) => {
      removeReferenceRow({ item, projectId, spaceId, nodeId });
    },
    [projectId, spaceId, nodeId],
  );
  // A slot's ✕: clears the node's pick-time copy. Available whenever the slot
  // is — which is only in a mode that collects it. A copy left behind by a
  // mode switch is out of reach until the user switches back; it does not ride
  // the wire meanwhile (the payload is built from the mode's own field set),
  // so what it costs is the asset staying alive, not a wrong generation.
  // Deliberately NOT cleared on the switch: that would throw away a pick the
  // user may be coming back to.
  const onClearSlot = React.useCallback(
    (slot: VideoSlot) =>
      clearSlot(projectId, spaceId, nodeId, VIDEO_SLOTS[slot]),
    [projectId, spaceId, nodeId],
  );

  const onExecute = React.useCallback(async () => {
    // Every execute-critical value is read SYNCHRONOUSLY here, never from a
    // render closure that React batching and live collaboration make stale.
    if (submittingRef.current) return;
    // A node a collaborator deleted since the panel opened is refused by the
    // execute gate below: it derives from a fresh graph read, so a vanished
    // node has no status and `evaluateExecute` answers `node-gone`. There is no
    // separate existence check here — one would sit in front of a guard that
    // already covers it, and a line that can never change the outcome reads
    // to the next person as if it can.
    //
    // A locked node cannot submit. Toast the reason so a clickable Execute is
    // an actionable message rather than a dead control; editing the prompt
    // stays allowed.
    const gateBlock = evaluateNodeGate({
      locked: isNodeLocked(projectId, spaceId, nodeId),
    });
    if (gateBlock) {
      warnNodeGate(t(gateBlock.toastKey));
      return;
    }
    // Which sources the run sends depends on the tier in effect (design
    // §5.4): the main prompt's `@` under off and auto, the union of every
    // shot's under the per-shot tier, read off the shots the node holds right
    // now. The tier needs the model, so the model is read first.
    const probe = freshVm();
    const liveSpec = specOf(probe.modelEntry);
    const board = readStoryboard(projectId, spaceId, nodeId, probe.mode);
    const liveTier = effectiveStoryboardKind(probe.modelEntry?.params ?? {}, board?.kind);
    const liveShots = board?.shots ?? [];
    const mentioned = liveTier === 'custom'
      ? liveShots.flatMap((shot) => mentionedSourceIds(shot.prompt))
      : atMentionedRef.current;
    const fresh = freshVm(new Set(mentioned));
    const run = storyboardRun(
      liveSpec,
      liveTier,
      liveShots,
      totalOf(liveSpec, fresh.params),
      referencesRef.current,
      fresh.mentionTokens,
    );
    // Serialize the backend prompt AT CLICK TIME: a text chip substitutes its
    // source node's CURRENT words, and that node may have been edited since
    // the last prompt keystroke — the ref would carry the stale substitution.
    // Falls back to the ref when the editor is gone (unmounting).
    //
    // A model that declares no `prompt` sends none, and that takes this
    // explicit branch (#1950): not mounting the editor only stops someone
    // typing HERE. The mirror still holds whatever was typed under the
    // previous mode — `onPromptChange` is the only writer and nothing
    // clears it, and the editor does not call back on unmount — so without
    // this line a talking-head task would carry the last mode's words.
    const freshPrompt = fresh.promptRequired && run.sendsPrompt
      ? (promptEditorRef.current?.serializePrompt(fresh.mentionTokens) ?? promptTextRef.current)
      : '';
    // One evaluation, its own inputs: the button asked the same question of
    // the RENDER-time view model, this asks it of live Yjs. Never reuse the
    // button's answer — React batching and live collaboration make a render
    // closure stale, and `prompt-missing` in particular is judged against a
    // different value here (the editor re-serializes so a text chip carries
    // its source node's CURRENT words).
    //
    // `isSubmitting: false` because the synchronous latch above already
    // answered that question, and it answers it earlier than a state flag can
    // (a rapid second click would slip past a re-render). So `'submitting'`
    // never reaches the check below — it exists for the button.
    // Reject BEFORE the submitting latch — the button stays clickable (not
    // disabled), so every one of these is an actionable message rather than a
    // dead control. The server re-checks before billing (defence in depth).
    // What the model says it takes in one request, so the panel refuses the
    // same text the proposal tool already refuses (#1960).
    const maxInputChars = fresh.modelEntry?.max_input_chars;
    const verdict = evaluateExecute({
      promptText: freshPrompt,
      model: fresh.model,
      nodeStatus: fresh.nodeStatus,
      isSubmitting: false,
      promptRequired: fresh.promptRequired,
      maxInputChars,
      missing: videoMissing(
        fresh.modelEntry,
        fresh.mode,
        fresh.slots,
        fresh.slotUrls,
        fresh.referenceUrls,
      ),
      pools: poolCounts(fresh.pool, fresh.referenceUrls),
      storyboard: run.gate,
    });
    if (verdict != null) {
      // The limit is written out here so the check that every id reaches a
      // real message in all five catalogs can see it.
      if (verdict.refusal === 'too-many-references') {
        toast.warning(t('canvas.generatePanel.errorTooManyReferences', verdict.over));
        return;
      }
      const key = videoRefusalKey(verdict, fresh.slots, fresh.pool);
      // `max` comes from the same value the gate judged by, so the sentence
      // can never name a limit other than the one that refused; `kind` names
      // the reference that is missing.
      if (key) {
        toast.warning(t(key, {
          max: maxInputChars ?? 0,
          kind: poolKindOf(fresh.pool, verdict.slot) ?? 'other',
          // The storyboard refusals name the shot, the cap or the seconds.
          shot: verdict.shot ?? 0,
          limit: verdict.limit ?? 0,
          shots: verdict.seconds?.shots ?? 0,
          total: verdict.seconds?.total ?? 0,
        }));
      }
      return;
    }
    submittingRef.current = true;
    setIsSubmitting(true);
    try {
      // Inside the try: if the payload build or the lease read throws, the
      // catch resets the latch — otherwise the panel sticks disabled forever.
      const payload = buildVideoTaskPayload({
        nodeId,
        projectId,
        spaceId,
        model: fresh.model,
        params: fresh.params,
        promptText: run.sendsPrompt ? freshPrompt : undefined,
        storyboardParams: run.params,
        // The payload's source fields are built FROM the drawn slots, so a
        // pick left behind by a mode or model switch has no way in.
        slots: fresh.slots,
        slotUrls: fresh.slotUrls,
        poolParams: poolParams(fresh.pool, fresh.referenceUrls),
      });
      await canvasApi.createTask(payload);
      // Close only if THIS mount is alive AND the panel is still on this node:
      // a stale submit from a since-unmounted instance must not close a
      // freshly-reopened panel.
      if (
        isMountedRef.current &&
        useCanvasStore.getState().panelHostId === nodeId &&
        useCanvasStore.getState().panelKind === 'generateVideo'
      ) {
        closeActivePanel();
      }
    } catch (err) {
      // Unconditional (silent-fail mandate): a submit that failed after the
      // user closed the panel still explains itself. Only the state writes are
      // gated on the mount being alive.
      toast.error(
        executeErrorMessage(
          err instanceof ApiException ? err.status : undefined,
          t,
        ),
      );
      if (!isMountedRef.current) return;
      submittingRef.current = false;
      setIsSubmitting(false);
    }
  }, [
    nodeId,
    projectId,
    spaceId,
    freshVm,
    closeActivePanel,
    t,
    // Stable for this mount's lifetime; listed because they come from a hook,
    // where the linter cannot see that for itself.
    isMountedRef,
    promptEditorRef,
    promptTextRef,
    setIsSubmitting,
    submittingRef,
  ]);

  // EVERY localized string below is depended on BY VALUE, not via `t`: `t` is a
  // stable module-level function whose identity never changes on an in-session
  // locale switch, so depending on it alone would freeze this copy in the old
  // language until the panel is reopened. The rule covers the whole group — a
  // string added here goes in the dependency array too. What differs between
  // them is only what the editor does on arrival: the mention labels are baked
  // into its extensions and force a rebuild, while the placeholder is read live
  // through a ref and republished in place.
  // One statement of which references this model's pool takes here, read by
  // the prompt editor's chips and its `@` popup and by the rail.
  const referenceKinds = useReferenceKinds(vm.pool);
  // One string for every mode, deliberately. The gap a per-mode sentence was
  // written to close is real but lives elsewhere, and #1952 closed it there:
  // with only IMAGE references connected, typing `@` in a mode that cannot use
  // them used to open nothing at all — the popup hid itself at zero matches
  // rather than showing the empty-state label it was handed (#1901). It now
  // opens and says so. That was the silence to fix, not this sentence.
  const promptPlaceholder = t('canvas.generatePanel.videoPromptPlaceholder');
  const mentionEmptyLabel = t('canvas.generatePanel.mentionEmpty');
  const mentionNoMatchLabel = t('canvas.generatePanel.mentionNoMatch');
  // A node made before video generation existed carries no prompt container,
  // and #1880 ratified that those are NOT repaired — creating one when the
  // panel opens is the exact race that decision removed (two people opening
  // at once each mint one under the same key, and last-write-wins drops a
  // container with everything typed into it). Whenever the model takes a
  // prompt, such a node renders nothing here — the no-prompt branch below is
  // checked first — the same as the image panel (`GeneratePanelContainer.tsx:705`):
  // pre-launch we ship no compatibility branch for old data (#1950).
  //
  // The model decides, not the mode (#1935, #1950, #1966): a model that
  // declares `takes_prompt: false` has nothing to do with one, so the editor
  // does not mount and a line says this mode does not need a prompt. That line
  // names no modality on purpose (user 2026-08-17) — the trigger is a per-model
  // boolean, so copy tied to audio would appear under a mode with nothing to do
  // with audio the moment a second model declared it. Unmounting rather than hiding —
  // there is nothing to type into it here, and a mounted collaborative editor
  // costs a TipTap instance plus its bindings. The cost is the prompt's undo
  // history, which lives on the editor instance and dies with it (#1961).
  // A media chip's words follow the pool, and a new record on every derive
  // would rebuild the prompt slot each time the canvas moves.
  const stableMentionTokens = useContentStable(vm.mentionTokens);
  const shotPlaceholder = t('canvas.generatePanel.storyboard.shotPlaceholder');
  const mainEditor = React.useMemo(
    () =>
      fragment ? (
        <PromptEditor
          ref={promptEditorRef}
          fragment={fragment}
          placeholder={promptPlaceholder}
          onTextChange={onPromptChange}
          onAtMentionsChange={handleAtMentionsChange}
          onFocus={() => {
            lastFocusedBox.current = 'main';
          }}
          references={stableReferences}
          // Same signal as the rail's: a media `@` chip is a model input only
          // where the model's pool takes its kind. Both outlets have to agree,
          // or the rail would say "this model cannot use that" while typing
          // `@` still offered it at full strength.
          referenceKinds={referenceKinds}
          mentionEmptyLabel={mentionEmptyLabel}
          mentionNoMatchLabel={mentionNoMatchLabel}
          caretProvider={caretProvider}
          mentionTokens={stableMentionTokens}
        />
      ) : null,
    [
      fragment,
      promptPlaceholder,
      mentionEmptyLabel,
      mentionNoMatchLabel,
      stableReferences,
      onPromptChange,
      handleAtMentionsChange,
      // A mode switch changes this, and the editor is what shows it: without
      // the dependency the chips already in the prompt would stay at full
      // strength and the `@` popup would keep offering images the new mode
      // cannot use.
      referenceKinds,
      caretProvider,
      promptEditorRef,
      stableMentionTokens,
    ],
  );
  // One shot's box: the same editor as the main prompt, bound to that shot's
  // own fragment. Its words and mentions are read off the fragment at submit,
  // so it reports them to nobody.
  const renderShotEditor = React.useCallback(
    (shot: StoryboardShotView, index: number) => (
      <PromptEditor
        ref={(handle) => {
          if (handle) shotEditors.current.set(shot.id, handle);
          else shotEditors.current.delete(shot.id);
        }}
        testId={`generate-storyboard-shot-${index + 1}-editor`}
        startingHeight='half'
        fragment={shot.prompt}
        placeholder={shotPlaceholder}
        onTextChange={IGNORE}
        onAtMentionsChange={IGNORE}
        onFocus={() => {
          lastFocusedBox.current = shot.id;
        }}
        references={stableReferences}
        referenceKinds={referenceKinds}
        mentionEmptyLabel={mentionEmptyLabel}
        mentionNoMatchLabel={mentionNoMatchLabel}
        caretProvider={caretProvider}
        mentionTokens={stableMentionTokens}
      />
    ),
    [
      shotPlaceholder,
      stableReferences,
      referenceKinds,
      mentionEmptyLabel,
      mentionNoMatchLabel,
      caretProvider,
      stableMentionTokens,
    ],
  );
  const hasStoryboard = spec !== undefined;
  const maxShots = spec?.maxShots;
  const promptSlot = React.useMemo(() => {
    if (!vm.promptRequired) return <PromptNotUsedNotice />;
    const switchRow = hasStoryboard ? (
      <StoryboardSwitchRow kind={storedKind} onToggle={onToggleStoryboard} onEnterShots={onEnterShots} />
    ) : null;
    return tier === 'custom' && shots ? (
      <>
        <ShotList
          shots={shots}
          total={total}
          maxShots={maxShots}
          onBack={onBackToAuto}
          onStep={onStepShot}
          onRemove={onRemoveShot}
          onAdd={onAddShot}
          renderEditor={renderShotEditor}
        />
        {switchRow}
      </>
    ) : (
      <>
        {mainEditor}
        {switchRow}
      </>
    );
  }, [
    vm.promptRequired,
    hasStoryboard,
    storedKind,
    tier,
    shots,
    total,
    maxShots,
    mainEditor,
    renderShotEditor,
    onToggleStoryboard,
    onEnterShots,
    onBackToAuto,
    onStepShot,
    onRemoveShot,
    onAddShot,
  ]);

  return (
    <VideoGeneratePanel
      models={stableModels}
      model={vm.model}
      params={stableParams}
      creditText={creditText}
      mode={mode}
      referenceKinds={referenceKinds}
      onToggleMode={onToggleMode}
      modeOptions={availableModes}
      promptRequired={vm.promptRequired}
      references={stableReferences}
      pendingFocus={pendingFocus}
      onFocus={onFocus}
      focusPicking={focusPicking}
      onAddReference={onAddReference}
      referencePicking={referencePicking}
      onRemoveReference={onRemoveReference}
      onInsertReference={handleInsertReference}
      // The mode states which slots it collects, so a mode that takes no
      // source shows none rather than offering a pick the submit ignores.
      slots={vm.slots}
      slotUrls={stableSlotUrls}
      slotThumbnails={stableSlotThumbnails}
      activeSlot={activeSlot}
      onPickSlot={onPickSlot}
      onClearSlot={onClearSlot}
      executeRefusal={
        evaluateExecute({
          promptText,
          model: vm.model,
          nodeStatus: vm.nodeStatus,
          isSubmitting,
          promptRequired: vm.promptRequired,
          maxInputChars: vm.modelEntry?.max_input_chars,
          missing: videoMissing(
            vm.modelEntry,
            vm.mode,
            vm.slots,
            vm.slotUrls,
            vm.referenceUrls,
          ),
          pools: poolCounts(vm.pool, vm.referenceUrls),
        })?.refusal ?? null
      }
      promptSlot={promptSlot}
      durationFloor={tier === 'custom' ? shots?.length : undefined}
      onExit={closeActivePanel}
      onSelectModel={onSelectModel}
      onChangeParams={onChangeParams}
      onExecute={onExecute}
    />
  );
}

/**
 * The i18n key a refusal speaks with, in this panel's words.
 *
 * A refusal naming one of the toolbar's own places is worded by that place --
 * the panel calls it a first frame or a driving video, where the gate knows
 * only that it is empty.
 * @param verdict - What the gate answered.
 * @param slots - The slots the toolbar draws for this mode.
 * @param pool - The model's reference pool in this mode.
 * @returns The key, or null when the refusal says nothing.
 */
function videoRefusalKey(
  verdict: ExecuteVerdict,
  slots: readonly VideoSlot[],
  pool: ReferencePool,
): string | null {
  // An empty pool param, or a group any member of which would do — every video
  // model's group is the kinds its pool takes (the Reference to Video ones).
  if (poolKindOf(pool, verdict.slot) !== undefined || verdict.refusal === 'sources-missing') {
    return 'canvas.generatePanel.errorNoReferenceMention';
  }
  return slotRefusalKey(VIDEO_SLOTS, slots, verdict);
}

/**
 * The video Generate panel's canvas integration point. Rendered once inside
 * the ReactFlow subtree; shows nothing until a video node's Generate panel is
 * opened, then floats {@link VideoGeneratePanel} below that node.
 * @param props - Live nodes and edges, and the project / space ids.
 * @returns The floating panel, or null when none is open.
 */
export function VideoGeneratePanelContainer(
  props: VideoGeneratePanelContainerProps,
): React.JSX.Element | null {
  const nodeId = useOpenPanelNode('generateVideo', props.nodes);
  if (nodeId == null) return null;
  return (
    <CatalogGatedFrame nodeId={nodeId} modality='video'>
      {/* key={nodeId} makes switching the panel to another node a full REMOUNT,
          so a prompt typed for node A can never be submitted to node B. */}
      <VideoGeneratePanelBody {...props} nodeId={nodeId} key={nodeId} />
    </CatalogGatedFrame>
  );
}
