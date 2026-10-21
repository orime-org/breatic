// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { useQuery } from '@tanstack/react-query';
import { useStore } from '@xyflow/react';
import * as React from 'react';

import {
  catalogEntryOf,
  defaultParamsOf,
  isModelTool,
  miniToolById,
  miniToolEstimateInput,
  tieredParamKeys,
  toolParamKeys,
  type MiniToolSnapshot,
  type MiniToolSpec,
} from '@breatic/shared/mini-tools';

import type { CanvasNodeView } from '@web/data/yjs/canvas-space';
import { asContentView } from '@web/data/yjs/node-view';
import { useTranslation } from '@web/i18n/use-translation';
import { toast } from '@web/lib/toast';
import { NodePanelMount } from '@web/spaces/canvas/_shared/NodePanelMount';
import { cropSourceSelector, intrinsicSize, isCropSource } from '@web/spaces/canvas/focus/crop-source';
import { canvasRootOf, useCanvasContext, useCanvasSession, useCanvasSessionStore } from '@web/spaces/canvas/canvas-context';
import { controlsForKeys } from '@web/spaces/canvas/generate/model-controls';
import { modelCatalogQuery } from '@web/spaces/canvas/generate/model-catalog-query';
import { useCreditText } from '@web/spaces/canvas/generate/use-credit-estimate';
import { useMiniToolRunning } from '@web/spaces/canvas/mini-tool/start-mini-tool-run';
import { MiniToolPanel } from '@web/spaces/canvas/mini-tool/MiniToolPanel';
import {
  creditMode,
  expandCapOf,
  readsShownSize,
  miniToolRefusal,
  resolvedParams,
  sizeTierChoices,
  slotLengthCap,
  type MiniToolSourceInfo,
} from '@web/spaces/canvas/mini-tool/mini-tool-view';
import { hasInk } from '@web/spaces/canvas/mini-tool/paint-drawing';
import { expandDrop, frameForRatio, ratioFits, type ExpandRatio } from '@web/spaces/canvas/mini-tool/expand-frame';
import type { MiniToolCapture } from '@web/spaces/canvas/mini-tool/start-mini-tool-run';
import { useEscapeInSpace } from '@web/spaces/canvas/use-escape-in-space';
import { visibleOps } from '@web/stores/drawing-draft';

/** The params a changed source resets: they are measured on, or picked from, the source. */
const SOURCE_BOUND = new Set(['rect', 'range', 'orient', 'cells']);

/** Nothing picked into any slot. */
const NO_SLOTS = {} as const;

export interface MiniToolPanelContainerProps {
  nodes: readonly CanvasNodeView[];
  /** Whether the last write to the document was this reader's. */
  getLastWriteWasLocal: () => boolean;
  /**
   * Run the tool on the snapshot taken at the press, with the drawing at the
   * press on a tool that draws. Resolves once a browser tool's file has
   * been made (or failed), or once a server tool's request has been answered
   * (or failed); a drawing tool's images are made and uploaded before that
   * request.
   */
  onRun: (
    nodeId: string,
    spec: MiniToolSpec,
    snapshot: MiniToolSnapshot,
    capture: MiniToolCapture | undefined,
    sourceSize: { width: number; height: number } | undefined,
  ) => Promise<unknown>;
}

/**
 * The pixel size of the picture or video the node is showing, read off the
 * element once it can be decoded. A size tier is measured on it when the
 * node's data does not carry the size.
 * @param spaceId - The Space the node is drawn in.
 * @param nodeId - The source node.
 * @param content - What the node shows, so a new one is read again.
 * @param wanted - Whether the tool measures anything on the source.
 * @returns The size, or null until it is known.
 */
function useShownSize(
  spaceId: string,
  nodeId: string,
  content: string,
  wanted: boolean,
): { width: number; height: number } | null {
  const [size, setSize] = React.useState<{ width: number; height: number } | null>(null);
  React.useEffect(() => {
    setSize(null);
    if (!wanted || content === '') return undefined;
    const el = canvasRootOf(spaceId).querySelector(cropSourceSelector(nodeId));
    if (!isCropSource(el)) return undefined;
    /** Take the size once the element can say it. */
    const read = (): void => {
      const found = intrinsicSize(el);
      if (found.width > 0 && found.height > 0) setSize(found);
    };
    read();
    el.addEventListener('load', read);
    el.addEventListener('loadedmetadata', read);
    return () => {
      el.removeEventListener('load', read);
      el.removeEventListener('loadedmetadata', read);
    };
  }, [spaceId, nodeId, content, wanted]);
  return size;
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
  const setExpand = useCanvasSession((s) => s.setExpand);
  const setMiniToolSourceSize = useCanvasSession((s) => s.setMiniToolSourceSize);
  const sessionStore = useCanvasSessionStore();

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
  // A crop is converted with the size the node's crop box read off the shown
  // picture, the size the export crops in (inner#888 §7.4.1).
  const crops = !isModelTool(spec) && spec.params.some((param) => param.kind === 'rect');
  const measured = draft?.sourceSize ?? null;
  const { spaceId } = useCanvasContext();
  // A press of this tool on this node still waiting (inner#1490) holds the
  // button the way an export does: it outlives the panel it was made in.
  const running = useMiniToolRunning(spaceId, nodeId, spec.id);
  const exporting = (draft?.exporting ?? false) || running;
  const dataWidth = view !== undefined && 'width' in view ? view.width : undefined;
  const dataHeight = view !== undefined && 'height' in view ? view.height : undefined;
  // The picture is read off the node only when its data does not carry the size.
  const shown = useShownSize(
    spaceId,
    nodeId,
    content,
    readsShownSize(spec) && (dataWidth === undefined || dataHeight === undefined),
  );
  const source = React.useMemo<MiniToolSourceInfo>(
    () => ({
      width: crops ? measured?.width : (dataWidth ?? shown?.width),
      height: crops ? measured?.height : (dataHeight ?? shown?.height),
      duration: view !== undefined && 'duration' in view ? view.duration : undefined,
      url: content === '' ? undefined : content,
    }),
    [crops, measured, dataWidth, dataHeight, view, shown, content],
  );

  // An expand frame is held as shares of the source and sized against the
  // source's pixels, which go into the draft (`sourceSize`) that
  // `ExpandFrameOverlay` reads; the overlay reads the model's cap itself.
  const expandDraft = draft?.expand ?? null;
  // The panel hangs under the expand frame, which reaches past the node. Read
  // from the draft and the node's size, which the canvas keeps while the node
  // is off screen; the panel re-renders only when the reach itself changes.
  const drop = useStore((s) =>
    expandDraft === null ? 0 : expandDrop(expandDraft, s.nodeLookup.get(nodeId)?.measured.height ?? 0, s.transform[2]),
  );
  const sourceWidth = source.width;
  const sourceHeight = source.height;
  const heldSize = draft?.sourceSize;
  React.useEffect(() => {
    if (spec.expand === undefined || sourceWidth === undefined || sourceHeight === undefined) return;
    if (heldSize?.width === sourceWidth && heldSize.height === sourceHeight) return;
    setMiniToolSourceSize({ width: sourceWidth, height: sourceHeight });
  }, [spec, sourceWidth, sourceHeight, heldSize, setMiniToolSourceSize]);
  // Built from the ratio alone, so dragging the frame does not re-render the
  // panel; a ratio reads the frame as it stands when picked.
  const expandRatio = expandDraft?.ratio;
  const expand = React.useMemo(() => {
    if (expandRatio === undefined || sourceWidth === undefined || sourceHeight === undefined) return undefined;
    const size = { width: sourceWidth, height: sourceHeight };
    return {
      ratio: expandRatio,
      fits: (ratio: ExpandRatio): boolean => ratioFits(ratio, size, expandCapOf(entry)),
      onRatio: (ratio: ExpandRatio): void => {
        const frame = sessionStore.getState().miniTool?.expand?.frame;
        if (frame !== undefined) setExpand({ frame: frameForRatio(ratio, size, frame), ratio });
      },
    };
  }, [expandRatio, sourceWidth, sourceHeight, entry, setExpand, sessionStore]);

  // The source took new content while the panel was open: whatever was
  // measured on the old one is reset, and the reader is told (§7.2).
  const sourceContent = draft?.sourceContent;
  React.useEffect(() => {
    if (sourceContent === undefined || content === '' || content === sourceContent) return;
    if (pickSession !== null) endPick();
    const all = defaultParamsOf(spec);
    const defaults = Object.fromEntries(
      isModelTool(spec)
        ? []
        : spec.params.filter((param) => SOURCE_BOUND.has(param.kind)).map((param) => [param.key, all[param.key]]),
    );
    resetMiniToolSource(content, defaults);
    toast.warning(
      t(getLastWriteWasLocal() ? 'canvas.miniTool.panel.sourceChanged' : 'canvas.miniTool.panel.sourceChangedByPeer'),
    );
  }, [content, sourceContent, pickSession, endPick, spec, resetMiniToolSource, getLastWriteWasLocal, t]);

  const draftParams = draft?.params;
  const sizeTiers = React.useMemo(
    () => sizeTierChoices(spec, entry, draftParams ?? {}, source),
    [spec, entry, draftParams, source],
  );
  const slots = draft?.slots ?? NO_SLOTS;
  const params = React.useMemo(
    () => resolvedParams(spec, entry, draftParams ?? {}, source, sizeTiers, slots),
    [spec, entry, draftParams, source, sizeTiers, slots],
  );
  // A param chosen as an output size draws as tiers; the rest as the model's controls.
  const modelControls = React.useMemo(() => {
    if (entry === undefined) return undefined;
    const tiered = new Set(tieredParamKeys(spec));
    const display = Object.fromEntries(
      isModelTool(spec) ? spec.params.flatMap((param) => (param.display === undefined ? [] : [[param.key, param.display]])) : [],
    );
    return controlsForKeys(entry, toolParamKeys(spec).filter((key) => !tiered.has(key)), display);
  }, [entry, spec]);
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

  const drawingSteps = draft?.drawing?.steps;
  const inked = React.useMemo(() => {
    if (spec.drawing === undefined || drawingSteps === undefined) return false;
    // The shape only scales the probe; a square stands in until the size is known.
    const aspect = source.width !== undefined && source.height !== undefined ? source.width / source.height : 1;
    return hasInk(visibleOps(drawingSteps), spec.drawing.kind, aspect);
  }, [spec, drawingSteps, source.width, source.height]);

  const refusal = miniToolRefusal({
    spec,
    entry,
    prompt,
    slots,
    sourceShown: content !== '' && (!crops || measured !== null),
    source,
    tiers: sizeTiers,
    exporting,
    inked,
    params,
    expandFrame: draft?.expand?.frame,
    mark: draft?.mark,
  });
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
    if (refusal === 'noUsableTier') {
      toast.warning(t('canvas.miniTool.panel.noUsableTier'));
      return;
    }
    if (refusal === 'sourceTooLargeToExpand') {
      toast.warning(t('canvas.miniTool.panel.sourceTooLargeToExpand'));
      return;
    }
    if (refusal === 'slotTooLong') {
      toast.warning(t('canvas.miniTool.panel.slotTooLong', { limit: slotLengthCap(spec, entry, slots) ?? 0 }));
      return;
    }
    if (refusal !== null) return;
    // What the reader made on the node is copied out now, so a later change
    // to the draft does not reach this run.
    const expandFrame = sessionStore.getState().miniTool?.expand?.frame;
    let capture: MiniToolCapture | undefined =
      spec.drawing !== undefined && drawingSteps !== undefined
        ? { kind: 'strokes', ops: visibleOps(drawingSteps) }
        : spec.expand !== undefined && expandFrame !== undefined && source.width !== undefined && source.height !== undefined
          ? { kind: 'expand', frame: { ...expandFrame }, sourceSize: { width: source.width, height: source.height } }
          : undefined;
    if (spec.markup === true) {
      // A text being edited is written back first, so the press takes it.
      const session = sessionStore.getState();
      if (session.miniTool?.mark?.editingText != null) session.markChannel?.exitEditing();
      const objects = sessionStore.getState().miniTool?.mark?.objects ?? [];
      // §6.6: the press acts on what leaving the edit left.
      if (objects.length === 0) return;
      capture = { kind: 'mark', objects };
    }
    // A grid lays its tiles out from the source's pixels before the export.
    const sourceSize =
      source.width !== undefined && source.height !== undefined ? { width: source.width, height: source.height } : undefined;
    // Pressing Run leaves picking, as pressing generate does (inner#1304).
    if (sessionStore.getState().pickSession !== null) endPick();
    void onRun(nodeId, spec, snapshot, capture, sourceSize);
  }, [refusal, onRun, nodeId, spec, entry, slots, snapshot, drawingSteps, source.width, source.height, sessionStore, endPick, t]);

  // Escape closes the panel; a running pick takes the press first.
  useEscapeInSpace(pickSession === null, closeActivePanel);

  if (isModelTool(spec) && entry === undefined) return null;
  return (
    <NodePanelMount nodeId={nodeId} drop={drop}>
      <MiniToolPanel
        spec={spec}
        modelControls={modelControls}
        sizeTiers={sizeTiers}
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
        expand={expand}
      />
    </NodePanelMount>
  );
}
