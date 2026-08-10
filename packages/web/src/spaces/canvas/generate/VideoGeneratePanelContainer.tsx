// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { useQuery } from '@tanstack/react-query';
import * as React from 'react';
import type * as Y from 'yjs';

import { canvasApi } from '@web/data/api/canvas';
import { modelsApi } from '@web/data/api/models';
import { ApiException } from '@web/data/api/types';
import {
  clearNodeSlotUrl,
  getPromptFragment,
  isNodeHandling,
  isNodeLocked,
  readCanvasGraph,
  readNodeLeaseGen,
  removeEdge,
  setNodeMode,
  setNodeModel,
  setNodeParams,
  type CanvasEdge,
  type CanvasNodeView,
} from '@web/data/yjs/canvas-space';
import { useTextBodies } from '@web/data/yjs/use-text-body';
import { useCanvasContext } from '@web/spaces/canvas/canvas-context';
import { useTranslation } from '@web/i18n/use-translation';
import { toast } from '@web/lib/toast';
import { useCanvasStore } from '@web/stores';
import { canExecuteGenerate } from '@web/spaces/canvas/generate/generate-guards';
import {
  CatalogGatedFrame,
  useOpenPanelNode,
} from '@web/spaces/canvas/generate/generate-panel-frame';
import {
  deriveReferences,
  type ReferenceRailItem,
} from '@web/spaces/canvas/generate/derive-references';
import { executeErrorMessage } from '@web/spaces/canvas/generate/execute-error-message';
import { filterModelsByMode } from '@web/spaces/canvas/generate/mode-selection';
import { resolveParamsForModel } from '@web/spaces/canvas/generate/model-params';
import {
  PromptEditor,
  type PromptEditorHandle,
} from '@web/spaces/canvas/generate/PromptEditor';
import { VideoGeneratePanel } from '@web/spaces/canvas/generate/VideoGeneratePanel';
import type { VideoParamsValue } from '@web/spaces/canvas/generate/VideoParamsPicker';
import { VIDEO_MODE_OPTIONS } from '@web/spaces/canvas/generate/video-mode-options';
import {
  VIDEO_SLOTS,
  slotForPurpose,
} from '@web/spaces/canvas/generate/video-slots';
import type { VideoSlot } from '@web/spaces/canvas/generate/video-slots';
import { buildVideoTaskPayload } from '@web/spaces/canvas/generate/video-task-payload';
import {
  buildVideoPanelViewModel,
  nodeVideoMode,
  resolveVideoModeSwitch,
  selectVideoModeModels,
  type VideoGenMode,
} from '@web/spaces/canvas/generate/video-panel-view-model';
import { evaluateNodeGate } from '@web/spaces/canvas/node-gate';
import { warnNodeGate } from '@web/spaces/canvas/node-gate-toast';

/**
 * For the reference derivation that deliberately wants no body text. Shared so
 * it does not allocate a map per call. Not frozen — `ReadonlyMap` is a
 * compile-time view and `Object.freeze` would not stop `.set()` on a Map
 * anyway; nothing downstream writes to it, and the type says they may not.
 */
const EMPTY_TEXT: ReadonlyMap<string, string> = new Map();

interface VideoGeneratePanelContainerProps {
  /** Live canvas node views (target + reference sources). */
  nodes: ReadonlyArray<Pick<CanvasNodeView, 'id' | 'data'>>;
  /** Live canvas edges (incoming = references). */
  edges: ReadonlyArray<CanvasEdge>;
  /** Project the canvas space belongs to. */
  projectId: string;
  /** Canvas space id. */
  spaceId: string;
}

/**
 * Narrows an unknown param value to a string.
 * @param value - The raw param value.
 * @returns The value when it is a string, else undefined.
 */
function asStr(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/**
 * Narrows an unknown param value to a number — duration is numeric upstream,
 * and a string would be rejected by the provider.
 * @param value - The raw param value.
 * @returns The value when it is a number, else undefined.
 */
function asNum(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
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
 * @returns The video Generate panel.
 */
function VideoGeneratePanelBody({
  nodeId,
  nodes,
  edges,
  projectId,
  spaceId,
}: VideoGeneratePanelContainerProps & {
  nodeId: string;
}): React.JSX.Element {
  const t = useTranslation();
  const closeActivePanel = useCanvasStore((s) => s.closeActivePanel);
  const { caretProvider } = useCanvasContext();

  const { data: catalog } = useQuery({
    queryKey: ['models'],
    queryFn: () => modelsApi.list(),
  });
  // `?? []` covers only the loading window; once resolved, modelsApi.list() has
  // run the response through sanitizeModelCatalog, so catalog.video is a
  // guaranteed ModelEntry[].
  const models = React.useMemo(() => catalog?.video ?? [], [catalog]);

  // Two mirrors of the prompt: state drives the button's enabled look (a frame
  // of lag is fine there); the ref is read SYNCHRONOUSLY in onExecute so a
  // rapid re-click, or a collaborator keystroke React has batched but not
  // flushed, cannot submit a stale prompt.
  const [promptText, setPromptText] = React.useState('');
  const promptTextRef = React.useRef('');
  const handlePromptChange = React.useCallback((text: string) => {
    promptTextRef.current = text;
    setPromptText(text);
  }, []);
  // Required by the editor so that forgetting it can never be an accident.
  // Nothing in this panel's submit reads the picked ids: a text chip
  // substitutes its source's words INSIDE the serialized prompt, and an image
  // chip becomes a model input only in reference-to-video, a mode this panel
  // does not offer yet. When it arrives, this is where the ids it needs come
  // from.
  const handleAtMentionsChange = React.useCallback(() => {}, []);
  // Click a reference-rail chip → insert its `@` mention at the prompt cursor
  // (user 2026-07-10 item 8); the editor places it at the caret or the end.
  const promptEditorRef = React.useRef<PromptEditorHandle>(null);
  const handleInsertReference = React.useCallback((item: ReferenceRailItem) => {
    promptEditorRef.current?.insertReference(item);
  }, []);

  const [isSubmitting, setIsSubmitting] = React.useState(false);
  const submittingRef = React.useRef(false);
  // Marks THIS mount stale on unmount. The body is keyed by nodeId, so closing
  // and reopening on the same node remounts a fresh instance; without this an
  // in-flight submit from the old one would close the new panel.
  const isMountedRef = React.useRef(true);
  React.useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  // Resolved in an effect, not during render: the node id can change under a
  // mounted panel and this keeps that transition in one place. Null means the
  // node predates prompt seeding (see getPromptFragment) — the panel then
  // renders without an editor rather than minting a fragment behind the user.
  const [fragment, setFragment] = React.useState<Y.XmlFragment | null>(null);
  React.useEffect(() => {
    setFragment(getPromptFragment(projectId, spaceId, nodeId));
  }, [projectId, spaceId, nodeId]);

  // The mode lives on the NODE, not in panel state: the switch is
  // collaborative, so a mode someone else picked has to show up here, and
  // reopening the panel has to land where it was left.
  const mode = nodeVideoMode(nodes, nodeId);

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
  const references = React.useMemo(
    () => deriveReferences(nodeId, nodes, edges, textById),
    [nodeId, nodes, edges, textById],
  );

  const vm = React.useMemo(
    () => buildVideoPanelViewModel({ nodeId, nodes, models, mode }),
    [nodeId, nodes, models, mode],
  );

  // Every write-callback re-derives from live Yjs at click time instead of
  // reading the render closure: that closure goes stale the moment a
  // collaborator edits the node, and building a task or a param write off it
  // would clobber their edit. The MODE is re-read too — a collaborator can
  // switch it between this render and the click, and it decides both the model
  // and whether the submission needs a source.
  const freshVm = React.useCallback(() => {
    const graph = readCanvasGraph(projectId, spaceId);
    return buildVideoPanelViewModel({
      nodeId,
      nodes: graph.nodes,
      models,
      mode: nodeVideoMode(graph.nodes, nodeId),
    });
  }, [projectId, spaceId, nodeId, models]);

  // Stable identities for the memoized children: the view model rebuilds on
  // every canvas mutation, so a freshly-filtered array or a rebuilt params
  // object would defeat their React.memo on each frame of any node drag.
  const stableModels = React.useMemo(
    () => selectVideoModeModels(models, mode),
    [models, mode],
  );
  const aspectRatio = asStr(vm.params.aspect_ratio);
  const resolution = asStr(vm.params.resolution);
  const duration = asNum(vm.params.duration);
  const generateAudio = vm.params.generate_audio === true;
  const stableParams = React.useMemo(
    () => ({
      aspect_ratio: aspectRatio,
      resolution,
      duration,
      generate_audio: generateAudio,
    }),
    [aspectRatio, resolution, duration, generateAudio],
  );
  // References change identity on every derive; key the memo on their CONTENT
  // (a small array — a stringify key is cheap and exact), or the rail's memo
  // would be defeated on every frame of any node drag.
  const referencesKey = JSON.stringify(references);
  const stableReferences = React.useMemo(
    () => references,
    // eslint-disable-next-line react-hooks/exhaustive-deps -- content identity: referencesKey IS the input, serialized
    [referencesKey],
  );
  // Whether ANY mode this panel offers has a model to switch to. Deliberately
  // not the active mode's subset: a node sitting in a mode the catalog no
  // longer serves must still be able to switch back to one that works.
  const catalogEmpty = React.useMemo(
    () =>
      !VIDEO_MODE_OPTIONS.some(
        (option) => filterModelsByMode(models, option.value).length > 0,
      ),
    [models],
  );

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
      // switch back to it restores this model rather than the default.
      setNodeModel(
        projectId,
        spaceId,
        nodeId,
        nodeVideoMode(graph.nodes, nodeId),
        modelId,
        resolveParamsForModel(picked, freshVm().params),
      );
    },
    [models, projectId, spaceId, nodeId, freshVm, t],
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
      const graph = readCanvasGraph(projectId, spaceId);
      const data = graph.nodes.find((n) => n.id === nodeId)?.data;
      const content = data && 'status' in data ? data : undefined;
      const { model, params } = resolveVideoModeSwitch(content, target, models);
      // Never persist an empty model: the catalog may still be loading / have
      // failed, or the target mode may offer nothing. Writing model='' plus
      // params={} would clobber the node's stored model AND params, and params
      // do not self-heal. (The toggle is also disabled while no offered mode
      // has a model; this backstops the target-mode-empty case.)
      if (!model) return;
      setNodeMode(projectId, spaceId, nodeId, target, model, params);
    },
    [models, projectId, spaceId, nodeId],
  );

  const onChangeParams = React.useCallback(
    (partial: VideoParamsValue) => {
      setNodeParams(projectId, spaceId, nodeId, {
        ...freshVm().params,
        ...partial,
      });
    },
    [projectId, spaceId, nodeId, freshVm],
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
  const referencePicking = useCanvasStore(
    (s) =>
      s.pickSession?.nodeId === nodeId && s.pickSession?.purpose === 'reference',
  );
  // One starter per slot. `Record<VideoSlot, …>` is what makes a new slot
  // impossible to half-wire: leaving it out here does not compile.
  const startSlotPick: Record<VideoSlot, (id: string) => void> = React.useMemo(
    () => ({ firstFrame: startFirstFramePick, endFrame: startEndFramePick }),
    [startFirstFramePick, startEndFramePick],
  );
  /** The slot whose pick is running on this node, if any. */
  const activeSlot = useCanvasStore((s) =>
    s.pickSession?.nodeId === nodeId
      ? slotForPurpose(s.pickSession.purpose)
      : undefined,
  );
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
      } else {
        startSlotPick[slot](nodeId);
      }
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
    }
  }, [slotsKey, nodeId, endPick]);

  const onRemoveReference = React.useCallback(
    (item: ReferenceRailItem) => {
      // A rail row IS an incoming edge here (video nodes carry no focus crops,
      // which is the image panel's other row source), so removing one is
      // removing that connection.
      removeEdge(projectId, spaceId, item.refId);
    },
    [projectId, spaceId],
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
      clearNodeSlotUrl(projectId, spaceId, nodeId, VIDEO_SLOTS[slot].field),
    [projectId, spaceId, nodeId],
  );

  const onExecute = React.useCallback(async () => {
    // Every execute-critical value is read SYNCHRONOUSLY here, never from a
    // render closure that React batching and live collaboration make stale.
    if (submittingRef.current) return;
    // A node a collaborator deleted since the panel opened is refused by the
    // execute gate below: it derives from a fresh graph read, so a vanished
    // node has no status and `canExecuteGenerate` returns false. There is no
    // separate existence check here — one would sit in front of a guard that
    // already covers it, and a line that can never change the outcome reads
    // to the next person as if it can.
    //
    // A locked node — or one a task started writing since the panel opened —
    // cannot submit. Toast the reason so a clickable Execute is an actionable
    // message rather than a dead control; editing the prompt stays allowed.
    const gateBlock = evaluateNodeGate(
      {
        locked: isNodeLocked(projectId, spaceId, nodeId),
        handling: isNodeHandling(projectId, spaceId, nodeId),
      },
      'generate',
    );
    if (gateBlock) {
      warnNodeGate(t(gateBlock.toastKey));
      return;
    }
    // Serialize the backend prompt AT CLICK TIME: a text chip substitutes its
    // source node's CURRENT words, and that node may have been edited since
    // the last prompt keystroke — the ref would carry the stale substitution.
    // Falls back to the ref when the editor is gone (unmounting).
    const freshPrompt =
      promptEditorRef.current?.serializePrompt() ?? promptTextRef.current;
    const fresh = freshVm();
    if (
      !canExecuteGenerate({
        promptText: freshPrompt,
        model: fresh.model,
        nodeStatus: fresh.nodeStatus,
        isSubmitting: false,
      })
    ) {
      return;
    }
    // The one check the mode's field set cannot make for itself: the fields
    // are built from the mode, but whether the user filled them is a question
    // only asked here (user 2026-08-10 — "one check at execute time is
    // enough"). Without a slot the provider refuses the call and the user is
    // left with an upstream error about a control nobody told them to fill.
    // Each slot names its own message, so the refusal says which one is
    // missing. Reject BEFORE the submitting latch — the button stays clickable
    // (not disabled), so this is an actionable message rather than a dead
    // control. The server re-checks before billing (defence in depth).
    const emptySlot = fresh.slots.find((slot) => !fresh.slotUrls[slot]);
    if (emptySlot) {
      toast.error(t(VIDEO_SLOTS[emptySlot].errorKey));
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
        promptText: freshPrompt,
        // The payload's source fields are built FROM the mode, so a pick left
        // behind by a mode switch has no way in and needs no gate here.
        mode: fresh.mode,
        slotUrls: fresh.slotUrls,
        leaseGen: readNodeLeaseGen(projectId, spaceId, nodeId),
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
  }, [nodeId, projectId, spaceId, freshVm, closeActivePanel, t]);

  // EVERY localized string below is depended on BY VALUE, not via `t`: `t` is a
  // stable module-level function whose identity never changes on an in-session
  // locale switch, so depending on it alone would freeze this copy in the old
  // language until the panel is reopened. The rule covers the whole group — a
  // string added here goes in the dependency array too.
  const promptPlaceholder = t('canvas.generatePanel.videoPromptPlaceholder');
  const mentionEmptyLabel = t('canvas.generatePanel.videoMentionEmpty');
  // A node made before video generation existed carries no prompt container,
  // and #1880 ratified that those are NOT repaired — creating one when the
  // panel opens is the exact race that decision removed (two people opening
  // at once each mint one under the same key, and last-write-wins drops a
  // container with everything typed into it). So the panel opens without an
  // editor and its arrow can never light; saying why is what keeps that from
  // reading as the feature being broken.
  const noPromptNotice = t('canvas.generatePanel.videoNoPrompt');
  const promptSlot = React.useMemo(
    () =>
      fragment ? (
        <PromptEditor
          ref={promptEditorRef}
          fragment={fragment}
          placeholder={promptPlaceholder}
          onTextChange={handlePromptChange}
          onAtMentionsChange={handleAtMentionsChange}
          references={stableReferences}
          // Same value, same reason as the rail's — see VideoGeneratePanel:
          // an image `@` chip contributes nothing in either mode this panel
          // offers, and dimming carries a cost of its own. #1903.
          imageRefsDisabled={false}
          mentionEmptyLabel={mentionEmptyLabel}
          caretProvider={caretProvider}
        />
      ) : (
        <p
          data-testid='generate-video-no-prompt'
          className='px-1 py-2 text-xs text-muted-foreground'
        >
          {noPromptNotice}
        </p>
      ),
    [
      fragment,
      promptPlaceholder,
      mentionEmptyLabel,
      noPromptNotice,
      stableReferences,
      handlePromptChange,
      handleAtMentionsChange,
      caretProvider,
    ],
  );

  return (
    <VideoGeneratePanel
      models={stableModels}
      model={vm.model}
      params={stableParams}
      creditEstimate={vm.creditEstimate}
      mode={mode}
      onToggleMode={onToggleMode}
      catalogEmpty={catalogEmpty}
      references={stableReferences}
      onAddReference={onAddReference}
      referencePicking={referencePicking}
      onRemoveReference={onRemoveReference}
      onInsertReference={handleInsertReference}
      // The slot appears exactly when the active mode needs a source asset,
      // The mode states which slots it collects, so a mode that takes no
      // source shows none rather than offering a pick the submit ignores.
      slots={vm.slots}
      slotUrls={vm.slotUrls}
      activeSlot={activeSlot}
      onPickSlot={onPickSlot}
      onClearSlot={onClearSlot}
      canExecute={canExecuteGenerate({
        promptText,
        model: vm.model,
        nodeStatus: vm.nodeStatus,
        isSubmitting,
      })}
      promptSlot={promptSlot}
      onExit={closeActivePanel}
      onSelectModel={onSelectModel}
      onChangeParams={onChangeParams}
      onExecute={onExecute}
    />
  );
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
    <CatalogGatedFrame nodeId={nodeId}>
      {/* key={nodeId} makes switching the panel to another node a full REMOUNT,
          so a prompt typed for node A can never be submitted to node B. */}
      <VideoGeneratePanelBody {...props} nodeId={nodeId} key={nodeId} />
    </CatalogGatedFrame>
  );
}
