// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { NodeToolbar, Position } from '@xyflow/react';
import { useQuery } from '@tanstack/react-query';
import * as React from 'react';
import { toast } from 'sonner';
import type * as Y from 'yjs';

import { canvasApi } from '@web/data/api/canvas';
import { modelsApi } from '@web/data/api/models';
import { ApiException } from '@web/data/api/types';
import {
  getOrCreatePromptFragment,
  isNodeHandling,
  isNodeLocked,
  nodeExists,
  readCanvasGraph,
  readNodeLeaseGen,
  removeEdge,
  setNodeMode,
  setNodeModel,
  setNodeParams,
  type CanvasEdge,
  type CanvasNodeView,
} from '@web/data/yjs/canvas-space';
import { useTranslation } from '@web/i18n/use-translation';
import { GeneratePanel } from '@web/spaces/canvas/generate/GeneratePanel';
import { canExecuteGenerate } from '@web/spaces/canvas/generate/generate-guards';
import type { ImageGenMode } from '@web/spaces/canvas/generate/image-mode-selection';
import { resolveParamsForModel } from '@web/spaces/canvas/generate/model-params';
import {
  buildGeneratePanelViewModel,
  resolveModeSwitch,
  type GeneratePanelViewModel,
} from '@web/spaces/canvas/generate/panel-view-model';
import { PromptEditor } from '@web/spaces/canvas/generate/PromptEditor';
import { buildGenerateTaskPayload } from '@web/spaces/canvas/generate/task-payload';
import { useCanvasStore } from '@web/stores';

interface GeneratePanelContainerProps {
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
 * Narrows an unknown param value to a string (the slice-1 picker value type).
 * @param value - The raw param value.
 * @returns The value when it is a string, else undefined.
 */
function asStr(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/**
 * Maps a failed execute request to a user-facing message. Credit / lock /
 * outage are the meaningful task-create failures (server `AppError`s).
 * @param status - The HTTP status, or undefined for a non-API error.
 * @param translate - The i18n translate function.
 * @returns A localized error message.
 */
function executeErrorMessage(
  status: number | undefined,
  translate: (key: string) => string,
): string {
  switch (status) {
    case 402:
      return translate('canvas.generatePanel.errorCredits');
    case 409:
      return translate('canvas.generatePanel.errorBusy');
    case 503:
      return translate('canvas.generatePanel.errorUnavailable');
    default:
      return translate('canvas.generatePanel.errorFailed');
  }
}

/**
 * Inner panel body — mounted only while a panel is open, so its data / catalog
 * hooks and the collaborative prompt editor come and go with the node. Wires
 * {@link GeneratePanel}'s render inputs + callbacks to the node's Yjs data, the
 * model catalog, and the task API.
 * @param root0 - Component props.
 * @param root0.nodeId - The node whose Generate panel is open.
 * @param root0.nodes - Live canvas node views.
 * @param root0.edges - Live canvas edges.
 * @param root0.projectId - Project id.
 * @param root0.spaceId - Canvas space id.
 * @returns The Generate panel.
 */
function GeneratePanelBody({
  nodeId,
  nodes,
  edges,
  projectId,
  spaceId,
}: GeneratePanelContainerProps & { nodeId: string }): React.JSX.Element {
  const t = useTranslation();
  const closeGeneratePanel = useCanvasStore((s) => s.closeGeneratePanel);
  const startReferencePick = useCanvasStore((s) => s.startReferencePick);

  const { data: catalog } = useQuery({
    queryKey: ['models'],
    queryFn: () => modelsApi.list(),
  });
  // `?? []` covers only the loading window (catalog is undefined until the query
  // resolves). Once resolved, modelsApi.list() has run the response through
  // sanitizeModelCatalog, so catalog.image is a guaranteed ModelEntry[] — no
  // per-field guarding needed here.
  const models = React.useMemo(() => catalog?.image ?? [], [catalog]);

  // Two mirrors of each execute-critical value: state drives the button's
  // enabled look (a frame of lag is fine there); a ref is read SYNCHRONOUSLY in
  // onExecute so a rapid re-click or a collaborator's keystroke that React has
  // batched-but-not-flushed can't submit a stale prompt or double-fire.
  const [promptText, setPromptText] = React.useState('');
  const promptTextRef = React.useRef('');
  const handlePromptChange = React.useCallback((text: string) => {
    promptTextRef.current = text;
    setPromptText(text);
  }, []);
  const [isSubmitting, setIsSubmitting] = React.useState(false);
  const submittingRef = React.useRef(false);
  // Marks this specific mount stale on unmount. Because the body is keyed by
  // nodeId, closing + reopening the panel on the SAME node remounts a fresh
  // instance; without this, an in-flight submit from the OLD instance would
  // close / mutate the NEW panel (the getState node check can't tell them
  // apart — same node id).
  const isMountedRef = React.useRef(true);
  React.useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  // Resolve the prompt fragment in an effect, NOT during render: on a node's
  // first open getOrCreatePromptFragment WRITES the fragment into the Yjs doc,
  // which synchronously fires the canvas observer (setState in the parent) —
  // doing that during render triggers React's "setState while rendering" warning.
  const [fragment, setFragment] = React.useState<Y.XmlFragment | null>(null);
  React.useEffect(() => {
    setFragment(getOrCreatePromptFragment(projectId, spaceId, nodeId));
  }, [projectId, spaceId, nodeId]);

  // The render-time view-model drives what the panel DISPLAYS (a frame of lag is
  // fine there). Every write-callback below instead re-derives from live Yjs via
  // freshVm() at click time — a render closure goes stale the moment a
  // collaborator edits the node, so building a task / param write off it would
  // submit deleted references or clobber a concurrent edit.
  const vm: GeneratePanelViewModel = React.useMemo(
    () => buildGeneratePanelViewModel({ nodeId, nodes, edges, models }),
    [nodeId, nodes, edges, models],
  );
  const freshVm = React.useCallback((): GeneratePanelViewModel => {
    const graph = readCanvasGraph(projectId, spaceId);
    return buildGeneratePanelViewModel({
      nodeId,
      nodes: graph.nodes,
      edges: graph.edges,
      models,
    });
  }, [projectId, spaceId, nodeId, models]);

  const canExecute = canExecuteGenerate({
    promptText,
    model: vm.model,
    nodeStatus: vm.nodeStatus,
    isSubmitting,
  });

  const onSelectModel = React.useCallback(
    (modelId: string) => {
      const picked = models.find((m) => m.name === modelId);
      if (!picked) {
        // The catalog refetched and dropped this model between render and click
        // — tell the user rather than silently ignore their selection.
        toast.error(t('canvas.generatePanel.modelUnavailable'));
        return;
      }
      // Record the pick under the ACTIVE mode (freshVm re-reads live Yjs) so a
      // later toggle back to this mode restores it (modelByMode memory).
      const fresh = freshVm();
      setNodeModel(
        projectId,
        spaceId,
        nodeId,
        fresh.mode,
        modelId,
        resolveParamsForModel(picked, fresh.params),
      );
    },
    [models, projectId, spaceId, nodeId, freshVm, t],
  );

  const onToggleMode = React.useCallback(
    (newMode: ImageGenMode) => {
      // Read the node fresh (a collaborator may have changed its modelByMode /
      // params), resolve the model + params for the TARGET mode, and write the
      // switch in one Yjs transaction. resolveModeSwitch resolves fresh for the
      // target mode (its remembered pick → recommended → first) — the current
      // model belongs to the old mode and is deliberately not carried over.
      const graph = readCanvasGraph(projectId, spaceId);
      const nodeData = graph.nodes.find((n) => n.id === nodeId)?.data;
      const content = nodeData && 'status' in nodeData ? nodeData : undefined;
      const { model, params } = resolveModeSwitch(content, newMode, models);
      setNodeMode(projectId, spaceId, nodeId, newMode, model, params);
    },
    [models, projectId, spaceId, nodeId],
  );

  const onChangeParams = React.useCallback(
    (partial: { aspect_ratio?: string; resolution?: string }) => {
      setNodeParams(projectId, spaceId, nodeId, {
        ...freshVm().params,
        ...partial,
      });
    },
    [projectId, spaceId, nodeId, freshVm],
  );

  const onAddReference = React.useCallback(
    () => startReferencePick(nodeId),
    [startReferencePick, nodeId],
  );

  const onRemoveReference = React.useCallback(
    (refId: string) => removeEdge(projectId, spaceId, refId),
    [projectId, spaceId],
  );

  const onExecute = React.useCallback(async () => {
    // Every execute-critical value is read SYNCHRONOUSLY here — never trusting a
    // render-time closure, which React batching + live collab make stale:
    //   - submittingRef: a synchronous re-entry latch (state lags a frame, so a
    //     rapid second click would slip past an isSubmitting-state guard).
    //   - nodeExists / isNodeHandling: fresh Yjs reads, so a node a collaborator
    //     just deleted or flipped to handling can't get a task submitted.
    //   - promptTextRef: the prompt at click time (a collaborator's batched
    //     keystroke may not have flushed into promptText state yet).
    if (submittingRef.current) return;
    if (!nodeExists(projectId, spaceId, nodeId)) return;
    if (isNodeHandling(projectId, spaceId, nodeId)) return;
    // A node a collaborator locked after the panel opened is frozen — never
    // submit against it (fresh Yjs read, not a captured menu / render value).
    if (isNodeLocked(projectId, spaceId, nodeId)) return;
    const freshPrompt = promptTextRef.current;
    // Re-derive model / params / references from LIVE Yjs — never the render
    // closure — so a collaborator's just-deleted reference or changed model
    // can't ride into the payload.
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
      // Payload build is INSIDE the try: if it (or the lease read) throws, the
      // catch resets the submitting latch — otherwise the panel would stick
      // permanently disabled.
      const payload = buildGenerateTaskPayload({
        nodeId,
        projectId,
        spaceId,
        model: fresh.model,
        params: fresh.params,
        promptText: freshPrompt,
        referenceUrls: fresh.referenceUrls,
        leaseGen: readNodeLeaseGen(projectId, spaceId, nodeId),
      });
      await canvasApi.createTask(payload);
      // Close only if THIS mount is still alive AND the panel is still on this
      // node — a stale submit from a since-unmounted instance (close+reopen on
      // the same node) must not close the freshly-reopened panel.
      if (
        isMountedRef.current &&
        useCanvasStore.getState().generatePanelNodeId === nodeId
      ) {
        closeGeneratePanel();
      }
    } catch (err) {
      if (!isMountedRef.current) return; // stale mount — don't toast / setState
      toast.error(
        executeErrorMessage(
          err instanceof ApiException ? err.status : undefined,
          t,
        ),
      );
      submittingRef.current = false;
      setIsSubmitting(false);
    }
  }, [
    nodeId,
    projectId,
    spaceId,
    freshVm,
    closeGeneratePanel,
    t,
  ]);

  return (
    <GeneratePanel
      models={vm.models}
      model={vm.model}
      mode={vm.mode}
      params={{
        aspect_ratio: asStr(vm.params.aspect_ratio),
        resolution: asStr(vm.params.resolution),
      }}
      references={vm.references}
      creditEstimate={vm.creditEstimate}
      canExecute={canExecute}
      promptSlot={
        fragment ? (
          <PromptEditor
            fragment={fragment}
            placeholder={t('canvas.generatePanel.promptPlaceholder')}
            onTextChange={handlePromptChange}
          />
        ) : null
      }
      onExit={closeGeneratePanel}
      onSelectModel={onSelectModel}
      onToggleMode={onToggleMode}
      onChangeParams={onChangeParams}
      onAddReference={onAddReference}
      onRemoveReference={onRemoveReference}
      onExecute={onExecute}
    />
  );
}

/**
 * The Generate panel's canvas integration point. Rendered once inside the
 * ReactFlow subtree; shows nothing until a node's panel is opened (store
 * `generatePanelNodeId`), then floats {@link GeneratePanel} below that node via
 * ReactFlow's `NodeToolbar` (which tracks the node without changing the
 * viewport — panel open never zooms or re-centers).
 * @param props - Live nodes / edges and the project / space ids.
 * @returns The floating Generate panel, or null when none is open.
 */
export function GeneratePanelContainer(
  props: GeneratePanelContainerProps,
): React.JSX.Element | null {
  const nodeId = useCanvasStore((s) => s.generatePanelNodeId);
  const closeGeneratePanel = useCanvasStore((s) => s.closeGeneratePanel);
  // Close the panel + end any reference pick when the target node disappears
  // (e.g. a collaborator deletes it) so we never render a stale panel or leave
  // pick mode pointing at a node that no longer exists.
  const nodeGone = nodeId != null && !props.nodes.some((n) => n.id === nodeId);
  React.useEffect(() => {
    if (nodeGone) closeGeneratePanel();
  }, [nodeGone, closeGeneratePanel]);
  if (nodeId == null || nodeGone) return null;
  return (
    <NodeToolbar nodeId={nodeId} isVisible position={Position.Bottom}>
      {/* key={nodeId} makes switching the panel to another node a full REMOUNT:
          promptText / promptTextRef / submittingRef all reset to the new node's
          fresh state, so a prompt typed for node A can never be submitted to
          node B (nor can the execute button show A's enabled state on B). */}
      <GeneratePanelBody {...props} key={nodeId} nodeId={nodeId} />
    </NodeToolbar>
  );
}
