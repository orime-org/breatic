// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { NodeToolbar, Position } from '@xyflow/react';
import { useQuery } from '@tanstack/react-query';
import * as React from 'react';
import { toast } from '@web/lib/toast';
import type * as Y from 'yjs';

import { assetsApi } from '@web/data/api/assets';
import { canvasApi } from '@web/data/api/canvas';
import { modelsApi } from '@web/data/api/models';
import { ApiException } from '@web/data/api/types';
import {
  clearNodeStyleImage,
  getOrCreatePromptFragment,
  isNodeHandling,
  isNodeLocked,
  nodeExists,
  readCanvasGraph,
  readNodeLeaseGen,
  removeEdge,
  removeNodeFocusImage,
  setNodeMode,
  setNodeModel,
  setNodeParams,
  type CanvasEdge,
  type CanvasNodeView,
} from '@web/data/yjs/canvas-space';
import {
  assetUrlSurvives,
  isReportableAssetUrl,
} from '@web/spaces/canvas/canvas-upload';
import { docName, getDoc } from '@web/data/yjs/manager';
import { useSocket } from '@web/data/yjs/use-socket';
import { useTranslation } from '@web/i18n/use-translation';
import { resolvePaletteHex, userPaletteHue } from '@web/lib/user-color';
import type { CameraValue } from '@web/spaces/canvas/generate/CameraPicker';
import { GeneratePanel } from '@web/spaces/canvas/generate/GeneratePanel';
import { canExecuteGenerate } from '@web/spaces/canvas/generate/generate-guards';
import { evaluateNodeGate } from '@web/spaces/canvas/node-gate';
import { warnNodeGate } from '@web/spaces/canvas/node-gate-toast';
import type { ImageGenMode } from '@web/spaces/canvas/generate/image-mode-selection';
import { resolveParamsForModel } from '@web/spaces/canvas/generate/model-params';
import {
  buildGeneratePanelViewModel,
  selectModeModels,
  resolveModeSwitch,
  type GeneratePanelViewModel,
} from '@web/spaces/canvas/generate/panel-view-model';
import {
  focusIdOfRefId,
  focusToRailItem,
  type ReferenceRailItem,
} from '@web/spaces/canvas/generate/derive-references';
import {
  PromptEditor,
  type PromptEditorHandle,
} from '@web/spaces/canvas/generate/PromptEditor';
import { buildGenerateTaskPayload } from '@web/spaces/canvas/generate/task-payload';
import { useCanvasStore } from '@web/stores';
import { useCurrentUserStore } from '@web/stores/current-user';

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
 * Narrows an unknown param value to a number — focal_length is numeric, and a
 * string would fail the worker's enum check and silently reset to the default.
 * @param value - The raw param value.
 * @returns The value when it is a number, else undefined.
 */
function asNum(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
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
  const startStylePick = useCanvasStore((s) => s.startStylePick);

  // Collaborator carets (batch-2 item 14): the prompt fragment lives in the
  // canvas-space doc, so its provider's AWARENESS is the caret channel.
  // useSocket ref-counts the shared provider (SpaceDocSync already holds a
  // ref while the tab is open, so this acquire is a cheap share, never a
  // second socket). Identity = display name + deterministic palette color.
  const canvasDocName = docName.canvasSpace(projectId, spaceId);
  const canvasDoc = React.useMemo(
    () => getDoc(canvasDocName),
    [canvasDocName],
  );
  const { provider: caretProvider } = useSocket({
    name: canvasDocName,
    doc: canvasDoc,
  });
  const currentUser = useCurrentUserStore((s) => s.user);
  const caretUser = React.useMemo(() => {
    if (!currentUser) return null;
    const hue = userPaletteHue(currentUser.id);
    return {
      name: currentUser.name || currentUser.email,
      // The wire carries a concrete hex (y-prosemirror validates user.color
      // as 6-digit hex — anything else warns on every caret update) + the
      // hue breatic receivers actually render from (viewer-theme adaptive).
      color: resolvePaletteHex(hue),
      hue,
    };
  }, [currentUser]);

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
  // The `@`-picked source ids, mirrored to a ref for the same reason as the
  // prompt text: onExecute reads them SYNCHRONOUSLY so the i2i source subset is
  // the prompt's state at click time (state would lag a frame). No React state
  // mirror — nothing in the render tree depends on the picks (the rail shows the
  // full pool; requiresSource is model-derived).
  const atMentionedRef = React.useRef<string[]>([]);
  const handleAtMentionsChange = React.useCallback((sourceIds: string[]) => {
    atMentionedRef.current = sourceIds;
  }, []);
  // Click a reference-rail chip → insert its @-mention at the prompt cursor
  // (user 2026-07-10 item 8); the editor places it at the caret or the end.
  const promptEditorRef = React.useRef<PromptEditorHandle>(null);
  const handleInsertReference = React.useCallback((item: ReferenceRailItem) => {
    promptEditorRef.current?.insertReference(item);
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
  // Stable model-list identity for the memo'd pickers: the vm rebuilds on
  // EVERY canvas graph mutation (nodes/edges deps), and its freshly-filtered
  // models array would defeat ModelPicker's React.memo each frame of any node
  // drag (memo discipline: a memo'd component's props must all be stable).
  // Same selection as vm.models, memoized on [models, mode] alone.
  const stableModels = React.useMemo(
    () => selectModeModels(models, vm.mode),
    [models, vm.mode],
  );
  // Same discipline for the sibling props (round-3 adversarial): params and
  // references are rebuilt with the vm every canvas mutation; without a
  // content-stable identity they defeat the React.memo on GeneratePanel /
  // ReferenceRail / RatioResolutionPicker each frame of any node drag.
  const aspectRatio = asStr(vm.params.aspect_ratio);
  const resolution = asStr(vm.params.resolution);
  // Camera cluster (#1788) rides the same stable-identity discipline: key the
  // memo on the primitives so a canvas mutation doesn't rebuild the params
  // object and defeat CameraPicker's React.memo each drag frame.
  const camera = asStr(vm.params.camera);
  const lens = asStr(vm.params.lens);
  const focalLength = asNum(vm.params.focal_length);
  const aperture = asStr(vm.params.aperture);
  const enableCamera = vm.params.enable_camera === true;
  const stableParams = React.useMemo(
    () => ({
      aspect_ratio: aspectRatio,
      resolution,
      camera,
      lens,
      focal_length: focalLength,
      aperture,
      enable_camera: enableCamera,
    }),
    [aspectRatio, resolution, camera, lens, focalLength, aperture, enableCamera],
  );
  // References change identity on every derive; key the memo on their CONTENT
  // (small array — a stringify key is cheap and exact). The pool the rail /
  // mention plumbing consumes is node references + focus crops mapped into
  // the same row shape (#1782) — one list, one code path downstream.
  const referencesKey =
    JSON.stringify(vm.references) + JSON.stringify(vm.focusImages);
  const stableReferences = React.useMemo(
    () => [...vm.references, ...vm.focusImages.map(focusToRailItem)],
    // eslint-disable-next-line react-hooks/exhaustive-deps -- content identity: referencesKey IS both inputs, serialized
    [referencesKey],
  );
  const freshVm = React.useCallback(
    (atMentionedSourceIds?: ReadonlySet<string>): GeneratePanelViewModel => {
      const graph = readCanvasGraph(projectId, spaceId);
      return buildGeneratePanelViewModel({
        nodeId,
        nodes: graph.nodes,
        edges: graph.edges,
        models,
        atMentionedSourceIds,
      });
    },
    [projectId, spaceId, nodeId, models],
  );

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
      // Never persist an empty model: the catalog may still be loading / have
      // failed (models === []), or the target mode may offer nothing. Writing
      // model='' + params={} would clobber the node's stored model AND params
      // in Yjs — params does NOT self-heal. Bail (the toggle is also disabled
      // while the catalog is empty; this backstops the target-mode-empty case).
      if (!model) return;
      setNodeMode(projectId, spaceId, nodeId, newMode, model, params);
    },
    [models, projectId, spaceId, nodeId],
  );

  const onChangeParams = React.useCallback(
    (partial: { aspect_ratio?: string; resolution?: string } & CameraValue) => {
      setNodeParams(projectId, spaceId, nodeId, {
        ...freshVm().params,
        ...partial,
      });
    },
    [projectId, spaceId, nodeId, freshVm],
  );

  // The Reference / Style buttons are TOGGLES (G, user 2026-07-12): start the
  // pick when this node isn't already in that pick, else exit it. Both flags are
  // read reactively so the button highlights while active and un-highlights when
  // a collaborator / mode-switch / Exit ends the pick — not just on local click.
  // A pick is a single session, so starting one purpose replaces the other.
  const endPick = useCanvasStore((s) => s.endPick);
  const referencePicking = useCanvasStore(
    (s) => s.pickSession?.nodeId === nodeId && s.pickSession?.purpose === 'reference',
  );
  const stylePicking = useCanvasStore(
    (s) => s.pickSession?.nodeId === nodeId && s.pickSession?.purpose === 'style',
  );
  const focusPicking = useCanvasStore(
    (s) => s.pickSession?.nodeId === nodeId && s.pickSession?.purpose === 'focus',
  );
  // In-flight focus uploads for THIS node → rail placeholders (#1782). The
  // memo keys on the store array identity (immer replaces it on change).
  const pendingFocusAll = useCanvasStore((s) => s.pendingFocusUploads);
  const pendingFocus = React.useMemo(
    () =>
      pendingFocusAll
        .filter((p) => p.nodeId === nodeId)
        .map((p) => ({ id: p.id, name: p.name })),
    [pendingFocusAll, nodeId],
  );
  const onAddReference = React.useCallback(() => {
    const session = useCanvasStore.getState().pickSession;
    if (session?.nodeId === nodeId && session.purpose === 'reference') {
      endPick();
    } else {
      startReferencePick(nodeId);
    }
  }, [startReferencePick, endPick, nodeId]);
  const onStyle = React.useCallback(() => {
    const session = useCanvasStore.getState().pickSession;
    if (session?.nodeId === nodeId && session.purpose === 'style') {
      endPick();
    } else {
      startStylePick(nodeId);
    }
  }, [startStylePick, endPick, nodeId]);
  const startFocusPick = useCanvasStore((s) => s.startFocusPick);
  const onFocus = React.useCallback(() => {
    const session = useCanvasStore.getState().pickSession;
    if (session?.nodeId === nodeId && session.purpose === 'focus') {
      endPick();
    } else {
      startFocusPick(nodeId);
    }
  }, [startFocusPick, endPick, nodeId]);

  // End a running FOCUS pick the moment the mode becomes t2i (adversarial
  // round-2, narrowed #1788 batch-3 #1): a focus crop IS an image source, so the
  // Focus button stays DISABLED in t2i — a focus pick left running after a t2i
  // switch is a zombie session whose banner lingers with a disabled trigger
  // (which strands keyboard focus). A REFERENCE pick is NOT ended here anymore:
  // t2i no longer disables references, it text-scopes them (image sources dim,
  // text stays pickable), so a reference pick started in i2i stays valid after a
  // t2i flip — killing it would strand the user mid-pick. A STYLE pick is exempt
  // too (style images survive t2i, #1664). The mode can flip locally or via a
  // collaborator writing setNodeMode, so react to vm.mode, not just the toggle.
  React.useEffect(() => {
    const session = useCanvasStore.getState().pickSession;
    if (
      vm.mode === 't2i' &&
      session?.nodeId === nodeId &&
      session.purpose === 'focus'
    ) {
      endPick();
    }
  }, [vm.mode, nodeId, endPick]);
  // Same zombie guard for the STYLE pick (adversarial 2026-07-16): switching to
  // a model without style capability (locally or via a collaborator's
  // setNodeModel) DISABLES the Style trigger, so a running style pick would
  // strand its banner + keyboard focus exactly like the t2i reference case.
  React.useEffect(() => {
    const session = useCanvasStore.getState().pickSession;
    if (
      !vm.styleSupported &&
      session?.nodeId === nodeId &&
      session.purpose === 'style'
    ) {
      endPick();
    }
  }, [vm.styleSupported, nodeId, endPick]);

  const onRemoveReference = React.useCallback(
    (item: ReferenceRailItem) => {
      // Routed by the ROW's identity, never by parsing the id string: edge
      // ids are untrusted collaborative data, and a crafted edge id starting
      // with `focus:` must not misroute the ✕ (adversarial round-2). Only a
      // real focus row carries `focus: true` (built locally from sanitized
      // crops), so its refId is trusted to parse.
      if (item.focus === true) {
        const focusId = focusIdOfRefId(item.refId);
        if (focusId === null) return;
        // Gate everything below on the ACTUAL removal: a double-click (or
        // a ✕ after the remote removal already synced in) hits a no-op
        // here, and reporting it anyway would append a duplicate
        // asset:deleted activity row (round-3). TRULY concurrent
        // cross-client ✕ (both inside the sync-latency window) still
        // double-reports — accepted residual, audit-feed row only; a real
        // fix needs a server-side idempotency key (round-5).
        const removed = removeNodeFocusImage(projectId, spaceId, nodeId, focusId);
        if (!removed) return;
        // Delete-side ledger report (adversarial round-2): a crop is an
        // uploaded asset — mirror the node-delete accounting. The survivor
        // check reads the FRESH post-removal graph, so the removed instance
        // is naturally excluded; dedup-shared URLs still alive elsewhere
        // are not reported. Silent catch: the removal already succeeded, a
        // toast would read as a failed remove (reportDeletedAssets parity).
        const url = item.thumbnail;
        if (
          typeof url === 'string' &&
          isReportableAssetUrl(url) &&
          !assetUrlSurvives(url, readCanvasGraph(projectId, spaceId).nodes)
        ) {
          void assetsApi
            .reportDeleted({
              projectId,
              entries: [{ fileUrl: url, kind: 'image', nodeId, spaceId }],
            })
            .catch(() => {
              // Silent: audit-feed miss at worst (see reportDeletedAssets).
            });
        }
        return;
      }
      removeEdge(projectId, spaceId, item.refId);
    },
    [projectId, spaceId, nodeId],
  );
  // The Style slot's ✕ (#1664): clears the node's pick-time copy. Always
  // available — even when the active model gates picking off, a stale copy
  // must be removable.
  const onClearStyle = React.useCallback(
    () => clearNodeStyleImage(projectId, spaceId, nodeId),
    [projectId, spaceId, nodeId],
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
    // Node-state gate (bug 2): a locked node — or one a task started writing
    // since the panel opened — can't submit. Fresh Yjs reads (never a captured
    // menu / render value). Toast the reason so a locked node's clickable
    // Execute is an actionable message, not a dead control (the button is
    // disabled only while handling). Editing the prompt stays allowed; the gate
    // blocks the submit alone.
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
    // Serialize the backend prompt AT CLICK TIME (spec §9.1): a text chip
    // substitutes its source node's CURRENT words, and that node may have been
    // edited since the last prompt keystroke — the ref would carry the stale
    // substitution. Falls back to the ref when the editor is gone (unmounting).
    const freshPrompt =
      promptEditorRef.current?.serializePrompt() ?? promptTextRef.current;
    // Re-derive model / params / references from LIVE Yjs — never the render
    // closure — so a collaborator's just-deleted reference or changed model
    // can't ride into the payload. The `@`-picked source ids are read
    // synchronously from the ref (the prompt's state at click time) so i2i sends
    // exactly the images the prompt @-mentions right now (design B).
    const fresh = freshVm(new Set(atMentionedRef.current));
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
    // #1675 execute gate: an i2i / edit model needs a source image. With no
    // @-picked reference the payload would carry no images, so the model would
    // fail (Nano Banana Edit requires images ≥ 1) or silently degrade. Reject
    // with a toast BEFORE the submitting latch — the button stays clickable (not
    // disabled), so the user gets an actionable message, not a dead control. The
    // server re-checks this before billing (defence in depth).
    if (fresh.requiresSource && fresh.referenceUrls.length === 0) {
      toast.error(t('canvas.generatePanel.errorNoSourceImage'));
      return;
    }
    // #1735 count gate: too many @-picked reference images for this model. Toast
    // BEFORE the submitting latch (button stays clickable, actionable message).
    // The server re-checks before enqueue — otherwise the worker silently
    // truncates the extras (design decision A: toast, not a node error state).
    if (
      typeof fresh.maxReferences === 'number' &&
      fresh.referenceUrls.length > fresh.maxReferences
    ) {
      toast.error(
        t('canvas.generatePanel.errorTooManyReferences', {
          limit: fresh.maxReferences,
        }),
      );
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
        // Capability gate (#1664): the style copy rides the payload ONLY when
        // the active model declares style_images — a stale copy under a
        // non-style model must not be sent (the server would reject or the
        // worker silently drop it).
        styleImageUrl: fresh.styleSupported ? fresh.styleImageUrl : undefined,
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
      // The failure toast is UNCONDITIONAL (silent-fail mandate): sonner is a
      // global outlet, so a submit that failed AFTER the user closed the panel
      // (fire-and-move-on, then 402/409/503) still explains itself — the old
      // stale-mount early-return silently swallowed exactly those failures
      // (round-2 adversarial). Only the React state writes stay gated.
      toast.error(
        executeErrorMessage(
          err instanceof ApiException ? err.status : undefined,
          t,
        ),
      );
      if (!isMountedRef.current) return; // stale mount — skip setState only
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

  // Stabilize the prompt-editor element (#1783): `GeneratePanel` is `React.memo`,
  // so an inline element here would be a fresh object on every container render
  // and defeat the memo (the whole panel re-renders). Its inner props are all
  // already stable (useCallback / useMemo), so memoizing the element on those
  // deps lets the panel bail when nothing prompt-related changed.
  //
  // The two localized strings MUST be depended on by VALUE, not via `t`: `t`
  // (useTranslation) is a stable module-level function whose identity never
  // changes on an in-session locale switch (locale updates re-render via
  // useSyncExternalStore), so depending on `t` alone would freeze the
  // placeholder / mention-empty label in the old language until the panel is
  // reopened. Compute them here (cheap) and depend on the strings, so a locale
  // switch re-creates the element and PromptEditor rebuilds with the new copy.
  const promptPlaceholder = t('canvas.generatePanel.promptPlaceholder');
  const mentionEmptyLabel = t('canvas.generatePanel.mentionEmpty');
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
          mode={vm.mode}
          mentionEmptyLabel={mentionEmptyLabel}
          caretProvider={caretProvider}
          caretUser={caretUser}
        />
      ) : null,
    [
      fragment,
      promptPlaceholder,
      mentionEmptyLabel,
      handlePromptChange,
      handleAtMentionsChange,
      stableReferences,
      vm.mode,
      caretProvider,
      caretUser,
    ],
  );

  return (
    <GeneratePanel
      models={stableModels}
      model={vm.model}
      mode={vm.mode}
      catalogEmpty={vm.catalogEmpty}
      params={stableParams}
      references={stableReferences}
      creditEstimate={vm.creditEstimate}
      canExecute={canExecute}
      promptSlot={promptSlot}
      onExit={closeGeneratePanel}
      onSelectModel={onSelectModel}
      onToggleMode={onToggleMode}
      onChangeParams={onChangeParams}
      onAddReference={onAddReference}
      referencePicking={referencePicking}
      onRemoveReference={onRemoveReference}
      onInsertReference={handleInsertReference}
      onStyle={onStyle}
      stylePicking={stylePicking}
      styleImageUrl={vm.styleImageUrl}
      onClearStyle={onClearStyle}
      styleSupported={vm.styleSupported}
      cameraSupported={vm.cameraSupported}
      onFocus={onFocus}
      focusPicking={focusPicking}
      pendingFocus={pendingFocus}
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
  return <CatalogGatedPanel {...props} nodeId={nodeId} />;
}

/**
 * Model-catalog failure gate (spec §9.3, user-ratified): a panel without a
 * catalog is a dead end (blank model pill, no ratio picker, execute
 * permanently disabled), so a failed fetch EXPLAINS itself with a toast and
 * the panel never opens — no silent fail. Mounted only while a panel is OPEN
 * (inside the nodeId gate), so the always-rendered container never touches
 * react-query — a closed panel needs no QueryClient. Same queryKey as the
 * body's query (one cache entry); remounting per open attempt re-fires the
 * effect, so re-trying the right-click keeps telling the user while the API
 * is down.
 * @param props - The container props + the open panel's node id.
 * @returns The floating panel, or null while the catalog is failed.
 */
function CatalogGatedPanel(
  props: GeneratePanelContainerProps & { nodeId: string },
): React.JSX.Element | null {
  const t = useTranslation();
  const closeGeneratePanel = useCanvasStore((s) => s.closeGeneratePanel);
  const { isError, data } = useQuery({
    queryKey: ['models'],
    queryFn: () => modelsApi.list(),
  });
  // Gate on "errored AND nothing cached": a BACKGROUND refetch failure keeps
  // the previously-fetched catalog in `data`, and the panel keeps working off
  // it — closing a fully-functional panel over a refresh hiccup would be
  // worse than the silent failure this gate fixes (round-2 adversarial).
  const catalogError = isError && data === undefined;
  React.useEffect(() => {
    if (catalogError) {
      // A fixed toast id de-duplicates the StrictMode double-effect and rapid
      // re-open attempts while the API stays down (sonner replaces in place).
      toast.error(t('canvas.generatePanel.catalogUnavailable'), {
        id: 'generate-catalog-unavailable',
      });
      closeGeneratePanel();
    }
  }, [catalogError, closeGeneratePanel, t]);
  if (catalogError) return null;
  return (
    <NodeToolbar nodeId={props.nodeId} isVisible position={Position.Bottom}>
      {/* key={nodeId} makes switching the panel to another node a full REMOUNT:
          promptText / promptTextRef / submittingRef all reset to the new node's
          fresh state, so a prompt typed for node A can never be submitted to
          node B (nor can the execute button show A's enabled state on B). */}
      <GeneratePanelBody {...props} key={props.nodeId} />
    </NodeToolbar>
  );
}
