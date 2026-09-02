// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The audio Generate panel's canvas integration: everything the presentational
 * panel needs, read off live Yjs and the model catalog.
 *
 * Its own container rather than a branch in the video one, for the same reason
 * that one is not a branch of the image one: what a panel READS differs. This
 * one reads a live voice list off an endpoint, resolves the voice param under
 * whichever name the active vendor gave it, and states a rate instead of a
 * total. What the three do share — the task envelope, the execute gate, the
 * prompt editor, the reference rail — they share by calling the same code.
 */

import { useQuery } from '@tanstack/react-query';
import * as React from 'react';
import type * as Y from 'yjs';

import { canvasApi } from '@web/data/api/canvas';
import { ApiException } from '@web/data/api/types';
import { voicesApi } from '@web/data/api/voices';
import {
  getPromptFragment,
  isNodeHandling,
  isNodeLocked,
  readCanvasGraph,
  readNodeLeaseGen,
  setNodeModel,
  setNodeParams,
} from '@web/data/yjs/canvas-space';
import type { CanvasEdge, CanvasNodeView } from '@web/data/yjs/canvas-space';
import { useTextBodies } from '@web/data/yjs/use-text-body';
import { useTranslation } from '@web/i18n/use-translation';
import { toast } from '@web/lib/toast';
import { AUDIO_MODE_OPTIONS } from '@web/spaces/canvas/generate/audio-mode-options';
import { buildAudioPanelViewModel } from '@web/spaces/canvas/generate/audio-panel-view-model';
import { buildAudioTaskPayload } from '@web/spaces/canvas/generate/audio-task-payload';
import { AudioGeneratePanel } from '@web/spaces/canvas/generate/AudioGeneratePanel';
import type { AudioParamsValue } from '@web/spaces/canvas/generate/AudioParamsPicker';
import { useCanvasContext } from '@web/spaces/canvas/canvas-context';
import { deriveReferences } from '@web/spaces/canvas/generate/derive-references';
import type { ReferenceRailItem } from '@web/spaces/canvas/generate/derive-references';
import { executeErrorMessage } from '@web/spaces/canvas/generate/execute-error-message';
import {
  evaluateExecute,
  refusalToastKey,
} from '@web/spaces/canvas/generate/generate-guards';
import {
  CatalogGatedFrame,
  useOpenPanelNode,
} from '@web/spaces/canvas/generate/generate-panel-frame';
import { modelCatalogQuery } from '@web/spaces/canvas/generate/model-catalog-query';
import { resolveModelSwitch, resolveParamsEdit } from '@web/spaces/canvas/generate/model-params';
import { filterAvailableModes } from '@web/spaces/canvas/generate/mode-selection';
import { modelsForModality } from '@web/spaces/canvas/generate/modality-buckets';
import { PromptEditor } from '@web/spaces/canvas/generate/PromptEditor';
import type { PromptEditorHandle } from '@web/spaces/canvas/generate/PromptEditor';
import { removeReferenceRow } from '@web/spaces/canvas/generate/remove-reference-row';
import { useVoiceList } from '@web/spaces/canvas/generate/use-voice-list';
import { voiceParamName } from '@web/spaces/canvas/generate/voice-param';
import { evaluateNodeGate } from '@web/spaces/canvas/node-gate';
import { warnNodeGate } from '@web/spaces/canvas/node-gate-toast';
import type { ContentNodeView, NodeView } from '@web/spaces/canvas/types/node-view';
import { useCanvasStore } from '@web/stores';

/** Empty text map, for the pass that only needs to know WHICH rows exist. */
const EMPTY_TEXT: ReadonlyMap<string, string> = new Map();

interface AudioGeneratePanelContainerProps {
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
 * The node's content view, when it has one.
 * @param data - The node's data.
 * @returns The content view, or undefined for a node without one.
 */
function asContentView(data: NodeView | undefined): ContentNodeView | undefined {
  return data && 'status' in data ? data : undefined;
}

/**
 * The panel body, mounted once a catalog is in hand.
 * @param root0 - Container props plus the node the panel is open on.
 * @param root0.nodeId - The node the panel is open on.
 * @param root0.nodes - Live canvas node views.
 * @param root0.edges - Live canvas edges.
 * @param root0.projectId - Project the canvas space belongs to.
 * @param root0.spaceId - Canvas space id.
 * @returns The wired audio panel.
 */
function AudioGeneratePanelBody({
  nodeId,
  nodes,
  edges,
  projectId,
  spaceId,
}: AudioGeneratePanelContainerProps & { nodeId: string }): React.JSX.Element {
  const t = useTranslation();
  const closeActivePanel = useCanvasStore((s) => s.closeActivePanel);
  const endPick = useCanvasStore((s) => s.endPick);
  const startReferencePick = useCanvasStore((s) => s.startReferencePick);
  const referencePicking = useCanvasStore(
    (s) => s.pickSession?.nodeId === nodeId && s.pickSession.purpose === 'reference',
  );
  const { caretProvider } = useCanvasContext();

  const { data: catalog } = useQuery(modelCatalogQuery());
  const models = React.useMemo(() => modelsForModality(catalog, 'audio'), [catalog]);
  const availableModes = React.useMemo(
    () => filterAvailableModes(AUDIO_MODE_OPTIONS, models),
    [models],
  );
  const mode = availableModes[0]?.value ?? '';

  // Two mirrors of the prompt: state drives the button's enabled look, and the
  // ref is read synchronously at click time so a rapid re-click, or a
  // collaborator keystroke React has batched but not flushed, cannot submit a
  // stale prompt.
  const [promptText, setPromptText] = React.useState('');
  const promptTextRef = React.useRef('');
  const handlePromptChange = React.useCallback((text: string) => {
    promptTextRef.current = text;
    setPromptText(text);
  }, []);
  const promptEditorRef = React.useRef<PromptEditorHandle>(null);

  const [isSubmitting, setIsSubmitting] = React.useState(false);
  const submittingRef = React.useRef(false);
  // Marks THIS mount stale on unmount: the body is keyed by nodeId, so closing
  // and reopening on the same node remounts a fresh instance, and an in-flight
  // submit from the old one must not close the new panel.
  const isMountedRef = React.useRef(true);
  React.useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  // Resolved in an effect: the node id can change under a mounted panel. Null
  // means the node predates prompt seeding — the panel then says so instead of
  // offering an editor that stores nothing.
  const [fragment, setFragment] = React.useState<Y.XmlFragment | null>(null);
  React.useEffect(() => {
    setFragment(getPromptFragment(projectId, spaceId, nodeId));
  }, [projectId, spaceId, nodeId]);

  // The ids come off `deriveReferences` itself, so the followed set and the
  // rendered rows cannot drift. Following every text node on the board instead
  // would rebuild this on every keystroke anyone types anywhere.
  const textNodeIds = React.useMemo(
    () => [
      ...new Set(
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
    () => buildAudioPanelViewModel({ nodeId, nodes, models, mode, edges }),
    [nodeId, nodes, models, mode, edges],
  );

  // Every write re-derives from live Yjs at click time: the render closure goes
  // stale the moment a collaborator edits the node, and writing off it would
  // clobber their edit.
  const freshContent = React.useCallback(() => {
    const graph = readCanvasGraph(projectId, spaceId);
    return asContentView(graph.nodes.find((n) => n.id === nodeId)?.data);
  }, [projectId, spaceId, nodeId]);
  const freshVm = React.useCallback(() => {
    const graph = readCanvasGraph(projectId, spaceId);
    return buildAudioPanelViewModel({
      nodeId,
      nodes: graph.nodes,
      models,
      mode,
      edges: graph.edges,
    });
  }, [projectId, spaceId, nodeId, models, mode]);

  const voices = useVoiceList(vm.model);
  // The stored voice is an id; the trigger shows a name. One fetch per stored
  // id, cached by react-query — the list itself may not have been opened, and
  // when it has, the id may be on a page nobody scrolled to.
  const { data: selectedVoice } = useQuery({
    queryKey: ['voice', vm.model, vm.voiceSelectedId],
    queryFn: () => voicesApi.get(vm.model, vm.voiceSelectedId ?? ''),
    enabled: vm.model !== '' && vm.voiceSelectedId !== null,
  });

  const onSelectModel = React.useCallback(
    (modelId: string) => {
      const picked = models.find((m) => m.name === modelId);
      if (!picked) {
        // The catalog refetched and dropped this model between render and
        // click — say so rather than silently ignore the selection.
        toast.error(t('canvas.generatePanel.modelUnavailable'));
        return;
      }
      const { paramsByModel } = resolveModelSwitch(freshContent(), picked);
      setNodeModel(projectId, spaceId, nodeId, mode, modelId, paramsByModel);
    },
    [models, projectId, spaceId, nodeId, mode, freshContent, t],
  );

  const onChangeParams = React.useCallback(
    (partial: AudioParamsValue) => {
      // Keyed on the RESOLVED model — the one whose controls were just used.
      // The node's stored model can be absent or no longer offered, and keying
      // the record on that would write the edit where the panel never reads it.
      const paramsByModel = resolveParamsEdit(
        freshContent(),
        partial,
        freshVm().model,
      );
      setNodeParams(projectId, spaceId, nodeId, paramsByModel);
    },
    [projectId, spaceId, nodeId, freshVm, freshContent],
  );

  const onVoicePick = React.useCallback(
    (voice: { id: string }) => {
      const fresh = freshVm();
      const name = voiceParamName(fresh.modelEntry);
      // A model with no voice param has no picker open, so this is unreachable
      // from the UI; writing under a made-up key would put a value where the
      // submit reads none.
      if (!name) return;
      const paramsByModel = resolveParamsEdit(
        freshContent(),
        { [name]: voice.id },
        fresh.model,
      );
      setNodeParams(projectId, spaceId, nodeId, paramsByModel);
      voices.onOpenChange(false);
    },
    [projectId, spaceId, nodeId, freshVm, freshContent, voices],
  );

  const onAddReference = React.useCallback(() => {
    const session = useCanvasStore.getState().pickSession;
    if (session?.nodeId === nodeId && session.purpose === 'reference') {
      endPick();
    } else {
      startReferencePick(nodeId);
    }
  }, [startReferencePick, endPick, nodeId]);

  const onRemoveReference = React.useCallback(
    (item: ReferenceRailItem) => {
      removeReferenceRow({ item, projectId, spaceId, nodeId });
    },
    [projectId, spaceId, nodeId],
  );
  const onInsertReference = React.useCallback((item: ReferenceRailItem) => {
    promptEditorRef.current?.insertReference(item);
  }, []);

  const onExecute = React.useCallback(async () => {
    // Every execute-critical value is read synchronously here, never from a
    // render closure that batching and live collaboration make stale.
    if (submittingRef.current) return;
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
    const fresh = freshVm();
    // Serialize at click time: a text chip substitutes its source node's
    // CURRENT words, and that node may have been edited since the last
    // keystroke here.
    const freshPrompt = fresh.promptRequired
      ? (promptEditorRef.current?.serializePrompt() ?? promptTextRef.current)
      : '';
    const refusal = evaluateExecute({
      promptText: freshPrompt,
      model: fresh.model,
      nodeStatus: fresh.nodeStatus,
      // The synchronous latch above already answered this, and earlier than a
      // state flag can.
      isSubmitting: false,
      promptRequired: fresh.promptRequired,
      voiceRequired: fresh.voiceRequired,
      voiceChosen: fresh.voiceChosen,
    });
    if (refusal != null) {
      const key = refusalToastKey(refusal);
      if (key) toast.warning(t(key));
      return;
    }
    // Unreachable past the gate above — `no-model` covers it — and stated so
    // the payload builder gets an entry rather than undefined.
    if (!fresh.modelEntry) return;

    submittingRef.current = true;
    setIsSubmitting(true);
    try {
      const payload = buildAudioTaskPayload({
        nodeId,
        projectId,
        spaceId,
        model: fresh.modelEntry,
        params: fresh.params,
        promptText: freshPrompt,
        leaseGen: readNodeLeaseGen(projectId, spaceId, nodeId),
      });
      await canvasApi.createTask(payload);
      // Close only if THIS mount is alive AND the panel is still on this node.
      if (
        isMountedRef.current &&
        useCanvasStore.getState().panelHostId === nodeId &&
        useCanvasStore.getState().panelKind === 'generateAudio'
      ) {
        closeActivePanel();
      }
    } catch (err) {
      // Unconditional: a submit that failed after the user closed the panel
      // still explains itself. Only the state writes are gated on the mount.
      toast.error(
        executeErrorMessage(err instanceof ApiException ? err.status : undefined, t),
      );
      if (!isMountedRef.current) return;
      submittingRef.current = false;
      setIsSubmitting(false);
    }
  }, [nodeId, projectId, spaceId, freshVm, closeActivePanel, t]);

  // Depended on BY VALUE, not via `t`: `t` is a stable module-level function
  // whose identity never changes on an in-session locale switch, so depending
  // on it alone would freeze this copy in the old language.
  const promptPlaceholder = t('canvas.generatePanel.promptPlaceholder');
  const mentionEmptyLabel = t('canvas.generatePanel.mentionEmpty');
  const mentionNoMatchLabel = t('canvas.generatePanel.mentionNoMatch');
  const promptSlot = React.useMemo(
    () =>
      fragment ? (
        <PromptEditor
          ref={promptEditorRef}
          fragment={fragment}
          placeholder={promptPlaceholder}
          onTextChange={handlePromptChange}
          // An audio node collects only text rows, and a text chip serializes
          // into the prompt itself — no id ever becomes a model input here.
          onAtMentionsChange={noop}
          references={references}
          // An image `@` chip is a model input on the other two panels; here
          // there is no path for one to travel, and an audio node takes no
          // image edge to make one from.
          imageRefsDisabled
          mentionEmptyLabel={mentionEmptyLabel}
          mentionNoMatchLabel={mentionNoMatchLabel}
          caretProvider={caretProvider}
        />
      ) : null,
    [
      fragment,
      promptPlaceholder,
      handlePromptChange,
      references,
      mentionEmptyLabel,
      mentionNoMatchLabel,
      caretProvider,
    ],
  );

  return (
    <AudioGeneratePanel
      models={models}
      model={vm.model}
      mode={mode}
      modeOptions={availableModes}
      voiceList={voices.state}
      voiceSelectedId={vm.voiceSelectedId}
      voiceSelectedName={selectedVoice?.name ?? null}
      references={references}
      referencePicking={referencePicking}
      params={vm.params as AudioParamsValue}
      executeRefusal={evaluateExecute({
        promptText,
        model: vm.model,
        nodeStatus: vm.nodeStatus,
        isSubmitting,
        promptRequired: vm.promptRequired,
        voiceRequired: vm.voiceRequired,
        voiceChosen: vm.voiceChosen,
      })}
      promptSlot={promptSlot}
      onToggleMode={noop}
      onSelectModel={onSelectModel}
      onVoiceOpenChange={voices.onOpenChange}
      onVoiceQueryChange={voices.onQueryChange}
      onVoicePick={onVoicePick}
      onVoiceLoadMore={voices.onLoadMore}
      onAddReference={onAddReference}
      onRemoveReference={onRemoveReference}
      onInsertReference={onInsertReference}
      onChangeParams={onChangeParams}
      onExit={closeActivePanel}
      onExecute={onExecute}
    />
  );
}

/**
 * Does nothing, stably.
 */
function noop(): void {
  // Intentionally empty.
}

/**
 * The audio Generate panel's canvas integration point. Rendered once inside the
 * ReactFlow subtree; shows nothing until an audio node's Generate panel is
 * opened, then floats {@link AudioGeneratePanel} below that node.
 * @param props - Live nodes and edges, and the project / space ids.
 * @returns The floating panel, or null when none is open.
 */
export function AudioGeneratePanelContainer(
  props: AudioGeneratePanelContainerProps,
): React.JSX.Element | null {
  const nodeId = useOpenPanelNode('generateAudio', props.nodes);
  if (nodeId == null) return null;
  return (
    <CatalogGatedFrame nodeId={nodeId} modality='audio'>
      {/* key={nodeId} makes switching the panel to another node a full REMOUNT,
          so a prompt typed for node A can never be submitted to node B. */}
      <AudioGeneratePanelBody {...props} nodeId={nodeId} key={nodeId} />
    </CatalogGatedFrame>
  );
}
