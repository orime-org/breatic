// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { useQuery } from '@tanstack/react-query';
import * as React from 'react';

import {
  catalogEntryOf,
  isModelTool,
  miniToolById,
  miniToolEstimateInput,
  toolParamKeys,
  type MiniToolSnapshot,
  type MiniToolSpec,
} from '@breatic/shared';

import type { CanvasNodeView } from '@web/data/yjs/canvas-space';
import { asContentView } from '@web/data/yjs/node-view';
import { useTranslation } from '@web/i18n/use-translation';
import { toast } from '@web/lib/toast';
import { NodePanelMount } from '@web/spaces/canvas/_shared/NodePanelMount';
import { useCanvasSession } from '@web/spaces/canvas/canvas-context';
import { controlsForKeys } from '@web/spaces/canvas/generate/model-controls';
import { modelCatalogQuery } from '@web/spaces/canvas/generate/model-catalog-query';
import { useCreditText } from '@web/spaces/canvas/generate/use-credit-estimate';
import { MiniToolPanel, type MiniToolSourceInfo } from '@web/spaces/canvas/mini-tool/MiniToolPanel';
import { creditMode, miniToolRefusal, resolvedParams } from '@web/spaces/canvas/mini-tool/mini-tool-view';
import { useEscapeInSpace } from '@web/spaces/canvas/use-escape-in-space';

/** The params a changed source resets: they are measured on the source. */
const SOURCE_BOUND = new Set(['rect', 'range', 'orient']);

/** Nothing picked into any slot. */
const NO_SLOTS = {} as const;

export interface MiniToolPanelContainerProps {
  nodes: readonly CanvasNodeView[];
  /** Whether the last write to the document was this reader's. */
  getLastWriteWasLocal: () => boolean;
  /**
   * Run the tool on the snapshot taken at the press. Resolves once a browser
   * tool's export has been made (or failed); a server tool resolves at once.
   */
  onRun: (nodeId: string, spec: MiniToolSpec, snapshot: MiniToolSnapshot) => Promise<void>;
}

/**
 * The open mini-tool panel (inner#888 §7): reads the draft from the canvas
 * session, the pinned model from the catalog and the source from the node,
 * and hangs the panel under the node.
 * @param root0 - Component props.
 * @param root0.nodes - The canvas's node views.
 * @param root0.getLastWriteWasLocal - Whether the last document write was this reader's.
 * @param root0.onRun - Run the tool on a snapshot.
 * @returns The panel, or null when no mini-tool panel is open.
 */
export function MiniToolPanelContainer({
  nodes,
  getLastWriteWasLocal,
  onRun,
}: MiniToolPanelContainerProps): React.JSX.Element | null {
  const kind = useCanvasSession((s) => s.panelKind);
  const host = useCanvasSession((s) => s.panelHostId);
  const draft = useCanvasSession((s) => s.miniTool);
  if (kind !== 'miniTool' || host === null || draft === null) return null;
  const spec = miniToolById(draft.toolId);
  const node = nodes.find((n) => n.id === host);
  if (spec === undefined || node === undefined) return null;
  return (
    <OpenMiniToolPanel
      key={`${host}:${spec.id}`}
      nodeId={host}
      node={node}
      spec={spec}
      getLastWriteWasLocal={getLastWriteWasLocal}
      onRun={onRun}
    />
  );
}

interface OpenMiniToolPanelProps {
  nodeId: string;
  node: CanvasNodeView;
  spec: MiniToolSpec;
  getLastWriteWasLocal: () => boolean;
  onRun: MiniToolPanelContainerProps['onRun'];
}

/**
 * The panel while it is open on one node and one tool.
 * @param root0 - Component props.
 * @param root0.nodeId - The source node.
 * @param root0.node - Its view.
 * @param root0.spec - The tool.
 * @param root0.getLastWriteWasLocal - Whether the last document write was this reader's.
 * @param root0.onRun - Run the tool on a snapshot.
 * @returns The mounted panel, or null while the pinned model is not known yet.
 */
function OpenMiniToolPanel({
  nodeId,
  node,
  spec,
  getLastWriteWasLocal,
  onRun,
}: OpenMiniToolPanelProps): React.JSX.Element | null {
  const t = useTranslation();
  const draft = useCanvasSession((s) => s.miniTool);
  const pickSession = useCanvasSession((s) => s.pickSession);
  const closeActivePanel = useCanvasSession((s) => s.closeActivePanel);
  const setMiniToolParam = useCanvasSession((s) => s.setMiniToolParam);
  const setMiniToolPrompt = useCanvasSession((s) => s.setMiniToolPrompt);
  const clearMiniToolSlot = useCanvasSession((s) => s.clearMiniToolSlot);
  const resetMiniToolSource = useCanvasSession((s) => s.resetMiniToolSource);
  const startMiniToolSlotPick = useCanvasSession((s) => s.startMiniToolSlotPick);
  const endPick = useCanvasSession((s) => s.endPick);
  const [exporting, setExporting] = React.useState(false);

  const { data: catalog, isError } = useQuery(modelCatalogQuery());
  const entry =
    isModelTool(spec) && catalog !== undefined ? catalogEntryOf(catalog, spec.run.model) : undefined;
  const modelMissing = isModelTool(spec) && (isError || (catalog !== undefined && entry === undefined));
  React.useEffect(() => {
    if (!modelMissing) return;
    toast.error(t('canvas.generatePanel.catalogUnavailable'), { id: 'mini-tool-model-unavailable' });
    closeActivePanel();
  }, [modelMissing, closeActivePanel, t]);

  const view = asContentView(node.data);
  const content = view !== undefined && 'content' in view ? (view.content ?? '') : '';
  const source = React.useMemo<MiniToolSourceInfo>(
    () => ({
      width: view !== undefined && 'width' in view ? view.width : undefined,
      height: view !== undefined && 'height' in view ? view.height : undefined,
      duration: view !== undefined && 'duration' in view ? view.duration : undefined,
    }),
    [view],
  );

  // The source took new content while the panel was open: whatever was
  // measured on the old one is reset, and the reader is told (§7.2).
  const sourceContent = draft?.sourceContent;
  React.useEffect(() => {
    if (sourceContent === undefined || content === '' || content === sourceContent) return;
    if (pickSession !== null) endPick();
    const defaults = Object.fromEntries(
      isModelTool(spec)
        ? []
        : spec.params
          .filter((param) => SOURCE_BOUND.has(param.kind))
          .map((param) => [param.key, param.kind === 'orient' ? { turns: 0, flipX: false, flipY: false } : null]),
    );
    resetMiniToolSource(content, defaults);
    toast.warning(
      t(getLastWriteWasLocal() ? 'canvas.miniTool.panel.sourceChanged' : 'canvas.miniTool.panel.sourceChangedByPeer'),
    );
  }, [content, sourceContent, pickSession, endPick, spec, resetMiniToolSource, getLastWriteWasLocal, t]);

  const draftParams = draft?.params;
  const params = React.useMemo(
    () => resolvedParams(spec, entry, draftParams ?? {}),
    [spec, entry, draftParams],
  );
  const modelControls = React.useMemo(
    () => (entry === undefined ? undefined : controlsForKeys(entry, toolParamKeys(spec))),
    [entry, spec],
  );
  const slots = draft?.slots ?? NO_SLOTS;
  const prompt = draft?.prompt ?? '';
  const slotCaps = React.useMemo(
    () => Object.fromEntries(spec.slots.map((slot) => [slot.key, entry?.params[slot.param]?.max_items])),
    [spec, entry],
  );
  const snapshot = React.useMemo<MiniToolSnapshot>(
    () => ({
      params,
      prompt,
      source: { url: content, ...(source.duration !== undefined && { duration: source.duration }) },
      slots,
    }),
    [params, prompt, content, source.duration, slots],
  );
  const estimateInput = React.useMemo(() => miniToolEstimateInput(spec, snapshot), [spec, snapshot]);
  const estimate = useCreditText(entry, estimateInput, catalog?.credit_multiplier ?? 1);
  const mode = creditMode(spec);
  const creditText =
    mode === 'free'
      ? t('canvas.miniTool.panel.free')
      : mode === 'usage'
        ? t('canvas.miniTool.panel.usage')
        : (estimate ?? '');

  const refusal = miniToolRefusal({ spec, entry, prompt, slots, sourceShown: content !== '', exporting });
  const pickingSlot = pickSession?.purpose === 'miniToolSlot' ? (pickSession.slotKey ?? null) : null;

  const onParams = React.useCallback(
    (partial: Record<string, unknown>): void => {
      for (const [key, value] of Object.entries(partial)) setMiniToolParam(key, value);
    },
    [setMiniToolParam],
  );
  const onPickSlot = React.useCallback(
    (slotKey: string): void => {
      if (pickingSlot === slotKey) {
        endPick();
        return;
      }
      const slot = spec.slots.find((candidate) => candidate.key === slotKey);
      if (slot === undefined) return;
      startMiniToolSlotPick(nodeId, slotKey, slot.many ? slotCaps[slotKey] : undefined);
    },
    [pickingSlot, endPick, spec, startMiniToolSlotPick, nodeId, slotCaps],
  );
  const onRunPress = React.useCallback((): void => {
    if (refusal === 'sourceMissing') {
      toast.warning(t('canvas.miniTool.panel.sourceMissing'));
      return;
    }
    if (refusal !== null) return;
    const running = onRun(nodeId, spec, snapshot);
    if (spec.run.kind !== 'browser') return;
    setExporting(true);
    void running.finally(() => setExporting(false));
  }, [refusal, onRun, nodeId, spec, snapshot, t]);

  // Escape closes the panel; a running pick takes the press first.
  useEscapeInSpace(pickSession === null, closeActivePanel);

  if (isModelTool(spec) && entry === undefined) return null;
  return (
    <NodePanelMount nodeId={nodeId}>
      <MiniToolPanel
        spec={spec}
        modelControls={modelControls}
        modelEntry={entry}
        params={params}
        onParams={onParams}
        source={source}
        slots={slots}
        slotCaps={slotCaps}
        pickingSlot={pickingSlot}
        onPickSlot={onPickSlot}
        onClearSlot={clearMiniToolSlot}
        prompt={prompt}
        onPrompt={setMiniToolPrompt}
        creditText={creditText}
        refusal={refusal}
        onRun={onRunPress}
        onClose={closeActivePanel}
      />
    </NodePanelMount>
  );
}
