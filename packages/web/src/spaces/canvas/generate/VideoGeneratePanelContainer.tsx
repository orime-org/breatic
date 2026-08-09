// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { useQuery } from '@tanstack/react-query';
import * as React from 'react';
import type * as Y from 'yjs';

import { canvasApi } from '@web/data/api/canvas';
import { modelsApi } from '@web/data/api/models';
import { ApiException } from '@web/data/api/types';
import {
  getPromptFragment,
  isNodeHandling,
  isNodeLocked,
  readCanvasGraph,
  readNodeLeaseGen,
  setNodeModel,
  setNodeParams,
  type CanvasNodeView,
} from '@web/data/yjs/canvas-space';
import { useCanvasContext } from '@web/spaces/canvas/canvas-context';
import { useTranslation } from '@web/i18n/use-translation';
import { toast } from '@web/lib/toast';
import { useCanvasStore } from '@web/stores';
import { canExecuteGenerate } from '@web/spaces/canvas/generate/generate-guards';
import {
  CatalogGatedFrame,
  useOpenPanelNode,
} from '@web/spaces/canvas/generate/generate-panel-frame';
import { executeErrorMessage } from '@web/spaces/canvas/generate/execute-error-message';
import { resolveParamsForModel } from '@web/spaces/canvas/generate/model-params';
import { PromptEditor } from '@web/spaces/canvas/generate/PromptEditor';
import type { ReferenceRailItem } from '@web/spaces/canvas/generate/derive-references';
import { VideoGeneratePanel } from '@web/spaces/canvas/generate/VideoGeneratePanel';
import type { VideoParamsValue } from '@web/spaces/canvas/generate/VideoParamsPicker';
import { buildVideoTaskPayload } from '@web/spaces/canvas/generate/video-task-payload';
import {
  buildVideoPanelViewModel,
  selectVideoModeModels,
  type VideoGenMode,
} from '@web/spaces/canvas/generate/video-panel-view-model';
import { evaluateNodeGate } from '@web/spaces/canvas/node-gate';
import { warnNodeGate } from '@web/spaces/canvas/node-gate-toast';

/**
 * The only generation mode this slice offers. The mode control and the five
 * remaining modes arrive with the slices that give them something to work with
 * (sources, slots); until then the panel is text-to-video and says so by
 * having nothing to switch.
 */
const VIDEO_PANEL_MODE: VideoGenMode = 't2v';

/**
 * The prompt editor's reference pool, empty until the reference rail lands.
 * Module-level so it keeps one identity — a fresh `[]` each render would
 * rebuild the memoized editor element every time the canvas moves.
 */
const NO_REFERENCES: ReferenceRailItem[] = [];

interface VideoGeneratePanelContainerProps {
  /** Live canvas node views. */
  nodes: ReadonlyArray<Pick<CanvasNodeView, 'id' | 'data'>>;
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
 * @param root0.projectId - Project id.
 * @param root0.spaceId - Canvas space id.
 * @returns The video Generate panel.
 */
function VideoGeneratePanelBody({
  nodeId,
  nodes,
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
  // Nothing to report yet: this slice has no reference pool, so no `@` mention
  // can exist to be picked.
  const handleAtMentionsChange = React.useCallback(() => {}, []);

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

  const vm = React.useMemo(
    () =>
      buildVideoPanelViewModel({
        nodeId,
        nodes,
        models,
        mode: VIDEO_PANEL_MODE,
      }),
    [nodeId, nodes, models],
  );

  // Every write-callback re-derives from live Yjs at click time instead of
  // reading the render closure: that closure goes stale the moment a
  // collaborator edits the node, and building a task or a param write off it
  // would clobber their edit.
  const freshVm = React.useCallback(
    () =>
      buildVideoPanelViewModel({
        nodeId,
        nodes: readCanvasGraph(projectId, spaceId).nodes,
        models,
        mode: VIDEO_PANEL_MODE,
      }),
    [projectId, spaceId, nodeId, models],
  );

  // Stable identities for the memoized children: the view model rebuilds on
  // every canvas mutation, so a freshly-filtered array or a rebuilt params
  // object would defeat their React.memo on each frame of any node drag.
  const stableModels = React.useMemo(
    () => selectVideoModeModels(models, VIDEO_PANEL_MODE),
    [models],
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

  const onSelectModel = React.useCallback(
    (modelId: string) => {
      const picked = models.find((m) => m.name === modelId);
      if (!picked) {
        // The catalog refetched and dropped this model between render and
        // click — say so rather than silently ignore the selection.
        toast.error(t('canvas.generatePanel.modelUnavailable'));
        return;
      }
      const fresh = freshVm();
      setNodeModel(
        projectId,
        spaceId,
        nodeId,
        VIDEO_PANEL_MODE,
        modelId,
        resolveParamsForModel(picked, fresh.params),
      );
    },
    [models, projectId, spaceId, nodeId, freshVm, t],
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
    const freshPrompt = promptTextRef.current;
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

  // The two localized strings are depended on BY VALUE, not via `t`: `t` is a
  // stable module-level function whose identity never changes on an in-session
  // locale switch, so depending on it alone would freeze this copy in the old
  // language until the panel is reopened.
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
          fragment={fragment}
          placeholder={promptPlaceholder}
          onTextChange={handlePromptChange}
          onAtMentionsChange={handleAtMentionsChange}
          references={NO_REFERENCES}
          // Video reference images are never inert: every video mode that
          // takes them uses them.
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
 * @param props - Live nodes and the project / space ids.
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
