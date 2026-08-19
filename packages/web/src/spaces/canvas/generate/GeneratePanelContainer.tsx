// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { useQuery } from '@tanstack/react-query';
import * as React from 'react';
import { toast } from '@web/lib/toast';
import type * as Y from 'yjs';

import { assetsApi } from '@web/data/api/assets';
import { canvasApi } from '@web/data/api/canvas';
import { ApiException } from '@web/data/api/types';
import {
  clearNodeStyleImage,
  getPromptFragment,
  isNodeHandling,
  isNodeLocked,
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
import { useCanvasContext } from '@web/spaces/canvas/canvas-context';
import { useTextBodies } from '@web/data/yjs/use-text-body';
import { useTranslation } from '@web/i18n/use-translation';
import type { CameraValue } from '@web/spaces/canvas/generate/CameraPicker';
import { GeneratePanel } from '@web/spaces/canvas/generate/GeneratePanel';
import { executeErrorMessage } from '@web/spaces/canvas/generate/execute-error-message';
import {
  evaluateExecute,
  refusalToastKey,
} from '@web/spaces/canvas/generate/generate-guards';
import { referenceCapExceeded } from '@web/spaces/canvas/generate/reference-cap';
import {
  CatalogGatedFrame,
  useOpenPanelNode,
} from '@web/spaces/canvas/generate/generate-panel-frame';
import { evaluateNodeGate } from '@web/spaces/canvas/node-gate';
import { warnNodeGate } from '@web/spaces/canvas/node-gate-toast';
import type { ImageGenMode } from '@web/spaces/canvas/generate/image-mode-selection';
import {
  IMAGE_MODE_OPTIONS,
  resolveMode,
} from '@web/spaces/canvas/generate/image-mode-selection';
import type { ContentNodeView } from '@web/spaces/canvas/types/node-view';
import {
  resolveModelSwitch,
  resolveParamsEdit,
} from '@web/spaces/canvas/generate/model-params';
import {
  filterAvailableModes,
  resolveModeSwitch,
} from '@web/spaces/canvas/generate/mode-selection';
import {
  buildGeneratePanelViewModel,
  selectModeModels,
  type GeneratePanelViewModel,
} from '@web/spaces/canvas/generate/panel-view-model';
import {
  deriveReferences,
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
import { modelCatalogQuery } from '@web/spaces/canvas/generate/model-catalog-query';
import { PromptNotUsedNotice } from '@web/spaces/canvas/generate/PromptNotUsedNotice';

/**
 * For the two derivations below that deliberately want no body text. Shared so
 * neither allocates a map per call, and so "no text here" reads as one decision
 * rather than two look-alike literals. Not frozen — `ReadonlyMap` is a
 * compile-time view, and `Object.freeze` would not stop `.set()` on a Map
 * anyway; nothing downstream writes to it, and the type says they may not.
 */
const EMPTY_TEXT: ReadonlyMap<string, string> = new Map();

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
  const closeActivePanel = useCanvasStore((s) => s.closeActivePanel);
  const startReferencePick = useCanvasStore((s) => s.startReferencePick);
  const startStylePick = useCanvasStore((s) => s.startStylePick);

  // Collaborator carets (batch-2 item 14): the prompt fragment lives in the
  // canvas-space doc, so its provider's AWARENESS is the caret channel. The
  // canvas resolves that provider once and hands it down, so every editor on
  // the board publishes through the same one — a second acquire here would
  // work (useSocket reference-counts the shared provider) but would leave two
  // answers in the codebase to "whose caret is this".
  const { caretProvider } = useCanvasContext();

  const { data: catalog } = useQuery(modelCatalogQuery());
  // `?? []` is pure defence now: since #1966 this body mounts only inside
  // `CatalogGatedFrame`, which withholds it until the query has data, so
  // `catalog` is defined every time this line runs. Kept because the type still
  // admits undefined and a gate is a runtime promise, not a compile-time one.
  // Once resolved, modelsApi.list() has run the response through
  // sanitizeModelCatalog, so catalog.image is a guaranteed ModelEntry[] — no
  // per-field guarding needed here.
  const models = React.useMemo(() => catalog?.image ?? [], [catalog]);

  // Two mirrors of each execute-critical value. The ref is read SYNCHRONOUSLY
  // in onExecute so a rapid re-click or a collaborator's keystroke that React
  // has batched-but-not-flushed can't submit a stale prompt or double-fire.
  //
  // The state feeds the button's own `evaluateExecute` call, so both sides ask
  // the same question of their own inputs (#1949). What the button DRAWS is the
  // same either way — `prompt-missing` and `null` both leave it live and
  // arrow-shaped — but the two are different values, so `GeneratePanel` (a
  // default-shallow `React.memo`) does re-render on the transition. It is an
  // INPUT to a gate that must stay complete, not a line whose answer nothing
  // reads.
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

  // Resolve the prompt fragment in an effect, NOT during render. Reading is
  // pure since #1880, but the node id can change under a mounted panel and an
  // effect keeps that transition in one place. Null means the node predates
  // the seeding (see getPromptFragment) — the panel then renders without a
  // prompt editor rather than minting a fragment behind the user's back.
  const [fragment, setFragment] = React.useState<Y.XmlFragment | null>(null);
  React.useEffect(() => {
    setFragment(getPromptFragment(projectId, spaceId, nodeId));
  }, [projectId, spaceId, nodeId]);

  // The render-time view-model drives what the panel DISPLAYS (a frame of lag is
  // fine there). Every write-callback below instead re-derives from live Yjs via
  // freshVm() at click time — a render closure goes stale the moment a
  // collaborator edits the node, so building a task / param write off it would
  // submit deleted references or clobber a concurrent edit.
  // A referenced text node's body is a shared fragment the node view does not
  // carry (#1774), so the panel follows the ones it can reference. This
  // subscription is the only source of what a text reference says: the rail's
  // previews read it, and the editor's reference pool — which is what the
  // prompt serializer substitutes a text chip with at execute time — is built
  // from it. Without it every text chip would serialize to nothing.
  //
  // "The ones it can reference" is literal, BY CONSTRUCTION: the ids are read
  // off `deriveReferences` itself — the only consumer of the map this feeds —
  // so the two sets cannot drift (a first cut re-derived the set by hand and
  // promptly missed that function's focus-namespace guards, round-5).
  // Following every text node on the board instead would attach observers to
  // all of them and rebuild this view model on every keystroke anyone types
  // anywhere — the exact whole-board cost freshVm below refuses to pay.
  const textNodeIds = React.useMemo(
    () => [
      ...new Set(
        // Empty map on purpose: this call wants the ROWS (which sources, of
        // what type), and what they say is the very thing being subscribed to
        // below. Passing it is impossible here and unnecessary — but it has to
        // be said out loud, because the parameter is required precisely so
        // that omitting it can never be an accident.
        deriveReferences(nodeId, nodes, edges, EMPTY_TEXT)
          .filter((row) => row.sourceNodeType === 'text')
          .map((row) => row.sourceNodeId),
      ),
    ],
    [nodeId, nodes, edges],
  );
  const textById = useTextBodies(projectId, spaceId, textNodeIds);
  const vm: GeneratePanelViewModel = React.useMemo(
    () =>
      buildGeneratePanelViewModel({ nodeId, nodes, edges, models, textById }),
    [nodeId, nodes, edges, models, textById],
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
  // The modes this deployment can serve (#1951). Memoized on [models] alone
  // for the same reason as the line above: it flows down three React.memo
  // components — GeneratePanel, ImageModeToggle, ModeToggle — and a
  // freshly-filtered array would defeat all three on every frame of a node
  // drag. This is also why it is not a view-model FIELD: the view model
  // rebuilds on every canvas mutation. (It calls `filterAvailableModes` too,
  // to resolve which mode is current, but that result never leaves it.)
  const availableModes = React.useMemo(
    () => filterAvailableModes(IMAGE_MODE_OPTIONS, models),
    [models],
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
        // Empty on purpose. What a text reference SAYS never travels through
        // here: the prompt string is serialized by the editor from its own
        // reference pool, and this call site reads only the model, the params,
        // the node status and the reference URLs. Filling it in would read
        // every text body on the board on every click for a field nobody
        // downstream looks at. Stated rather than omitted — the parameter is
        // required so that leaving it out can never be an oversight.
        textById: EMPTY_TEXT,
      });
    },
    [projectId, spaceId, nodeId, models],
  );

  /**
   * The node's live content view, or undefined when the node is gone or is not
   * a content node. Read fresh at click time for the same reason freshVm is: a
   * collaborator may have changed the model or the per-model records since
   * this render.
   * @returns The node's content view, or undefined.
   */
  const freshContent = React.useCallback(():
    | ContentNodeView
    | undefined => {
    const graph = readCanvasGraph(projectId, spaceId);
    const data = graph.nodes.find((n) => n.id === nodeId)?.data;
    return data && 'status' in data ? data : undefined;
  }, [projectId, spaceId, nodeId]);

  const executeRefusal = evaluateExecute({
    promptText,
    model: vm.model,
    nodeStatus: vm.nodeStatus,
    isSubmitting,
    // The model states it (#1966). This was a literal `true` until the field
    // existed, because the only derivation available then read a `prompt`
    // entry under `params` that no image model writes.
    promptRequired: vm.promptRequired,
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
      // Record the pick under the ACTIVE mode so a later toggle back to this
      // mode restores it (modelByMode memory), and give the picked model its
      // OWN params rather than the outgoing model's (#1948). Both read the
      // node fresh from Yjs — a collaborator may have moved either since this
      // render.
      const content = freshContent();
      const { paramsByModel } = resolveModelSwitch(content, picked);
      setNodeModel(
        projectId,
        spaceId,
        nodeId,
        resolveMode(content?.mode, availableModes),
        modelId,
        paramsByModel,
      );
    },
    [models, availableModes, projectId, spaceId, nodeId, freshContent, t],
  );

  const onToggleMode = React.useCallback(
    (newMode: ImageGenMode) => {
      // Read the node fresh (a collaborator may have changed its modelByMode
      // or its records), resolve the model + records for the TARGET mode, and
      // write the switch in one Yjs transaction. resolveModeSwitch resolves
      // fresh for the target mode (the pick remembered for it, else the first
      // model it offers — the `recommended` tier is a badge, not a rule) — the
      // current model belongs to the old mode and is not carried over.
      const { model, paramsByModel } = resolveModeSwitch(
        freshContent(),
        newMode,
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
      setNodeMode(projectId, spaceId, nodeId, newMode, model, paramsByModel);
    },
    [models, projectId, spaceId, nodeId, freshContent],
  );

  const onChangeParams = React.useCallback(
    (partial: { aspect_ratio?: string; resolution?: string } & CameraValue) => {
      // The edit lands on the record of the model it was made on, so coming
      // back to that model finds it (#1948).
      // freshVm().model is the RESOLVED model — the one whose controls the
      // user just used. The node's stored model can be absent (a node created
      // moments ago) or no longer offered under this mode, and keying the
      // record on that would write the edit where the panel never reads it.
      const paramsByModel = resolveParamsEdit(
        freshContent(),
        partial,
        freshVm().model,
      );
      setNodeParams(projectId, spaceId, nodeId, paramsByModel);
    },
    [projectId, spaceId, nodeId, freshVm, freshContent],
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
    //   - isNodeLocked / isNodeHandling: fresh Yjs reads, so a node a collaborator
    //     locked or flipped to handling can't get a task submitted. Deletion is
    //     NOT one of theirs — both answer false for a node that is gone; the
    //     execute gate below is what refuses that, with `node-gone`.
    //   - promptTextRef: the prompt at click time (a collaborator's batched
    //     keystroke may not have flushed into promptText state yet).
    if (submittingRef.current) return;
    // No separate existence check: the execute gate below derives from a fresh
    // graph read, so a node a collaborator deleted has no status and
    // `evaluateExecute` answers `node-gone`. A line that can never change the
    // outcome reads to the next person as if it can (#1949, the video
    // container has said so at its own gate since #1899).
    //
    // Node-state gate (bug 2): a locked node — or one a task started writing
    // since the panel opened — can't submit. Fresh Yjs reads (never a captured
    // menu / render value). Toast the reason so a locked node's clickable
    // Execute is an actionable message, not a dead control (the button is
    // not greyed out for either — see `isExecuteButtonDisabled`). Editing the
    // prompt stays allowed; the gate
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
    // Re-derive model / params / references from LIVE Yjs — never the render
    // closure — so a collaborator's just-deleted reference or changed model
    // can't ride into the payload. The `@`-picked source ids are read
    // synchronously from the ref (the prompt's state at click time) so i2i sends
    // exactly the images the prompt @-mentions right now (design B).
    const fresh = freshVm(new Set(atMentionedRef.current));
    // Serialize the backend prompt AT CLICK TIME (spec §9.1): a text chip
    // substitutes its source node's CURRENT words, and that node may have been
    // edited since the last prompt keystroke — the ref would carry the stale
    // substitution. Falls back to the ref when the editor is gone (unmounting).
    //
    // A model that declares no `prompt` sends none, and that takes this
    // explicit branch (#1950, #1966): not mounting the editor only stops
    // someone typing HERE. The mirror still holds whatever was typed under the
    // previous model — `handlePromptChange` is the only writer and nothing
    // clears it, and the editor does not call back on unmount — so without this
    // line a task for a model that wants no prompt would carry the last one's
    // words. Same line, same reason, as `VideoGeneratePanelContainer.tsx`.
    const freshPrompt = fresh.promptRequired
      ? (promptEditorRef.current?.serializePrompt() ?? promptTextRef.current)
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
    const refusal = evaluateExecute({
      promptText: freshPrompt,
      model: fresh.model,
      nodeStatus: fresh.nodeStatus,
      isSubmitting: false,
      promptRequired: fresh.promptRequired,
    });
    if (refusal != null) {
      // WHICH refusal speaks is policy, and it lives in one place for the same
      // reason the disabled set does — both panels ask, neither spells it out.
      const key = refusalToastKey(refusal);
      if (key) toast.warning(t(key));
      return;
    }
    // #1675 execute gate: an i2i / edit model needs a source image. With no
    // @-picked reference the payload would carry no images, so the model would
    // fail (Nano Banana Edit requires images ≥ 1) or silently degrade. Reject
    // with a toast BEFORE the submitting latch — the button stays clickable (not
    // disabled), so the user gets an actionable message, not a dead control. The
    // server re-checks this before billing (defence in depth).
    if (fresh.requiresSource && fresh.referenceUrls.length === 0) {
      toast.warning(t('canvas.generatePanel.errorNoSourceImage'));
      return;
    }
    // #1735 count gate: too many @-picked reference images for this model. Toast
    // BEFORE the submitting latch (button stays clickable, actionable message).
    // The server re-checks before enqueue — otherwise the worker silently
    // truncates the extras (design decision A: toast, not a node error state).
    const overCap = referenceCapExceeded(
      fresh.referenceUrls.length,
      fresh.maxReferences,
    );
    if (overCap) {
      toast.warning(t('canvas.generatePanel.errorTooManyReferences', overCap));
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
        useCanvasStore.getState().panelHostId === nodeId &&
        useCanvasStore.getState().panelKind === 'generate'
      ) {
        closeActivePanel();
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
    closeActivePanel,
    t,
  ]);

  // Stabilize the prompt-editor element (#1783): `GeneratePanel` is `React.memo`,
  // so an inline element here would be a fresh object on every container render
  // and defeat the memo (the whole panel re-renders). Its inner props are all
  // already stable (useCallback / useMemo), so memoizing the element on those
  // deps lets the panel bail when nothing prompt-related changed.
  //
  // The localized strings MUST be depended on by VALUE, not via `t`: `t`
  // (useTranslation) is a stable module-level function whose identity never
  // changes on an in-session locale switch (locale updates re-render via
  // useSyncExternalStore), so depending on `t` alone would freeze the
  // placeholder / mention-empty label in the old language until the panel is
  // reopened. Compute them here (cheap) and depend on the strings, so a locale
  // switch re-creates the element and PromptEditor rebuilds with the new copy.
  const promptPlaceholder = t('canvas.generatePanel.promptPlaceholder');
  const mentionEmptyLabel = t('canvas.generatePanel.mentionEmpty');
  const mentionNoMatchLabel = t('canvas.generatePanel.mentionNoMatch');
  // Text-to-image generates from scratch and ignores source images, so an
  // image `@` chip contributes nothing and the editor greys it (§2.4 C).
  const imageRefsOff = vm.mode === 't2i';
  const promptSlot = React.useMemo(
    () =>
      !vm.promptRequired ? (
        <PromptNotUsedNotice />
      ) : fragment ? (
        <PromptEditor
          ref={promptEditorRef}
          fragment={fragment}
          placeholder={promptPlaceholder}
          onTextChange={handlePromptChange}
          onAtMentionsChange={handleAtMentionsChange}
          references={stableReferences}
          imageRefsDisabled={imageRefsOff}
          mentionEmptyLabel={mentionEmptyLabel}
          mentionNoMatchLabel={mentionNoMatchLabel}
          caretProvider={caretProvider}
        />
      ) : null,
    [
      vm.promptRequired,
      fragment,
      promptPlaceholder,
      mentionEmptyLabel,
      mentionNoMatchLabel,
      handlePromptChange,
      handleAtMentionsChange,
      stableReferences,
      imageRefsOff,
      caretProvider,
    ],
  );

  return (
    <GeneratePanel
      models={stableModels}
      model={vm.model}
      mode={vm.mode}
      modeOptions={availableModes}
      promptRequired={vm.promptRequired}
      params={stableParams}
      references={stableReferences}
      creditEstimate={vm.creditEstimate}
      executeRefusal={executeRefusal}
      promptSlot={promptSlot}
      onExit={closeActivePanel}
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
 * ReactFlow subtree; shows nothing until an image node's Generate panel is
 * opened, then floats {@link GeneratePanel} below that node.
 * @param props - Live nodes / edges and the project / space ids.
 * @returns The floating Generate panel, or null when none is open.
 */
export function GeneratePanelContainer(
  props: GeneratePanelContainerProps,
): React.JSX.Element | null {
  const nodeId = useOpenPanelNode('generate', props.nodes);
  if (nodeId == null) return null;
  return (
    <CatalogGatedFrame nodeId={nodeId} modality='image'>
      {/* key={nodeId} makes switching the panel to another node a full REMOUNT:
          promptText / promptTextRef / submittingRef all reset to the new node's
          fresh state, so a prompt typed for node A can never be submitted to
          node B (nor can the execute button show A's enabled state on B). */}
      <GeneratePanelBody {...props} nodeId={nodeId} key={nodeId} />
    </CatalogGatedFrame>
  );
}
