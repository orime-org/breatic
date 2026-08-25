// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The mounting rules every node-anchored generate panel obeys, whichever
 * modality it serves: which node has it open, closing it when that node goes
 * away, refusing to open without a model catalog, and floating below the node.
 *
 * One implementation rather than one per panel: each of these is a decision
 * that took a round of adversarial review to get right, and two copies would
 * be two chances to lose one of them.
 */

import { NodeToolbar, Position } from '@xyflow/react';
import { useQuery } from '@tanstack/react-query';
import * as React from 'react';

import type { CanvasNodeView } from '@web/data/yjs/canvas-space';
import { useTranslation } from '@web/i18n/use-translation';
import { toast } from '@web/lib/toast';
import { useCanvasStore } from '@web/stores';
import { IMAGE_MODE_OPTIONS } from '@web/spaces/canvas/generate/image-mode-selection';
import { filterAvailableModes } from '@web/spaces/canvas/generate/mode-selection';
import { modelCatalogQuery } from '@web/spaces/canvas/generate/model-catalog-query';
import { VIDEO_MODE_OPTIONS } from '@web/spaces/canvas/generate/video-mode-options';

/** The panel kinds this frame serves — the node-anchored generate panels. */
type GeneratePanelKind = 'generate' | 'generateVideo';

/**
 * The node whose panel of this kind is open, or null.
 *
 * Also closes the panel when the target node disappears (a collaborator
 * deletes it) so a stale panel is never rendered and no pick session is left
 * pointing at a node that no longer exists.
 * @param kind - Which panel is asking; the kinds share `panelHostId`.
 * @param nodes - Live canvas nodes, read to notice the target vanishing.
 * @returns The open panel's node id, or null when this panel is not open.
 */
export function useOpenPanelNode(
  kind: GeneratePanelKind,
  nodes: ReadonlyArray<Pick<CanvasNodeView, 'id'>>,
): string | null {
  const host = useCanvasStore((s) => s.panelHostId);
  const openKind = useCanvasStore((s) => s.panelKind);
  const closeActivePanel = useCanvasStore((s) => s.closeActivePanel);
  const nodeId = openKind === kind ? host : null;
  const nodeGone = nodeId != null && !nodes.some((n) => n.id === nodeId);
  React.useEffect(() => {
    if (nodeGone) closeActivePanel();
  }, [nodeGone, closeActivePanel]);
  return nodeGone ? null : nodeId;
}

/** The modalities that have a node-anchored generate panel. */
type GenerateModality = 'image' | 'video';

/**
 * The modes each panel offers, before availability narrows them (#1951).
 *
 * The gate asks the same question the picker will ask — "does this
 * deployment serve any of these" — so it reads the same lists the picker
 * reads rather than a second copy that could drift.
 */
const MODE_OPTIONS_BY_MODALITY: Record<
  GenerateModality,
  ReadonlyArray<{ value: string }>
> = {
  image: IMAGE_MODE_OPTIONS,
  video: VIDEO_MODE_OPTIONS,
};

interface CatalogGatedFrameProps {
  /** The node the panel is anchored to. */
  nodeId: string;
  /** Which modality this panel serves — decides which catalog bucket to read. */
  modality: GenerateModality;
  /** The panel body, mounted only once a catalog is available. */
  children: React.ReactNode;
}

/**
 * Model-catalog readiness gate plus the node-anchored float.
 *
 * Four ways there is no panel to build — the catalog failed, the browser is
 * offline, the catalog is not here yet, or it arrived and serves none of this
 * modality's modes — and all four withhold the panel. Three of them also say
 * so; the not-here-yet one is the ordinary wait, which the prefetch usually
 * makes invisible.
 *
 * A panel without a catalog is a dead end (blank model pill, no params,
 * execute permanently disabled), so a failed fetch EXPLAINS itself with a
 * toast and the panel never opens — no silent fail.
 *
 * This used to be the only place that asked for the catalog, deliberately: a
 * closed panel needed no QueryClient and the single fetch stayed tied to a
 * panel being on screen. #1964 gave that up on purpose. Holding the panel back
 * until the catalog lands turns every first open into a wait, so `CanvasSpace`
 * now prefetches on mount and this query usually reads a warm cache. The
 * prefetch does not subscribe, so the cache still ages out normally.
 *
 * The gate fires on "errored AND nothing cached": a BACKGROUND refetch failure
 * keeps the previously-fetched catalog, and the panel keeps working off it —
 * closing a working panel over a refresh hiccup would be worse than the silent
 * failure this gate fixes.
 *
 * It also holds while there is no catalog YET (#1964). Rendering first and
 * filling in afterwards meant every control changed once under the user: a
 * blank model pill, empty param pills, a dead execute button, and on failure
 * a panel that flashed into view before closing itself. Waiting costs nothing
 * in the common case because `CanvasSpace` prefetches the catalog when the
 * space mounts, so by the time anyone clicks Generate the answer is cached.
 *
 * Four outcomes, then, and offline is its own (#1966): a paused query is not
 * a slow one, it is one that will not move until the browser reconnects, so
 * holding for it would be a wait that cannot end. It gets the same treatment
 * as a failure — say why, close the panel — with its own sentence.
 * @param root0 - Component props.
 * @param root0.nodeId - The node the panel anchors to.
 * @param root0.modality - Which modality this panel serves.
 * @param root0.children - The panel body.
 * @returns The floating panel, or null while there is no panel to build —
 *   the catalog failed, is offline, is still on the wire, or serves none of
 *   this modality's modes.
 */
export function CatalogGatedFrame({
  nodeId,
  modality,
  children,
}: CatalogGatedFrameProps): React.JSX.Element | null {
  const t = useTranslation();
  const closeActivePanel = useCanvasStore((s) => s.closeActivePanel);
  const { isError, data, fetchStatus } = useQuery(modelCatalogQuery());
  const catalogError = isError && data === undefined;
  // Offline is its own outcome, not a slow one (#1966). react-query's default
  // `networkMode` PARKS a query while the browser is offline: `fetchStatus`
  // goes `paused`, the query function is never called, and the query neither
  // resolves nor rejects. Folding that into "still in flight" is what made
  // clicking Generate offline do nothing at all and say nothing either — a
  // wait that cannot end, on an entry point the user just commanded. So it
  // ends the same way a failure does, with its own sentence.
  const catalogOffline = !catalogError && data === undefined && fetchStatus === 'paused';
  // No data, no error, and the request really is on the wire. Nothing to build
  // a panel out of, and showing its shell first is the flicker #1964 is about.
  const catalogPending = !catalogError && !catalogOffline && data === undefined;
  // A catalog that arrived but serves none of this panel's modes (#1951).
  // Distinct from every outcome above: the request succeeded, so this is not
  // a failure and it says so with `warning` rather than `error` — but there
  // is still no panel to build. This is where a deployment that configured
  // no key for this modality ends up, and it used to open the panel anyway
  // on the three controls that decide what gets generated: the mode toggle
  // disabled, the model pill with nothing to show, execute refused — none of
  // them saying why. (The prompt editor and the reference rail stayed live;
  // they never read the catalog.)
  const noServableMode =
    data !== undefined &&
    filterAvailableModes(MODE_OPTIONS_BY_MODALITY[modality], data[modality])
      .length === 0;
  React.useEffect(() => {
    // A fixed toast id de-duplicates the StrictMode double-effect and rapid
    // re-open attempts while the condition holds (sonner replaces in place).
    if (catalogError) {
      toast.error(t('canvas.generatePanel.catalogUnavailable'), {
        id: 'generate-catalog-unavailable',
      });
      closeActivePanel();
      return;
    }
    if (catalogOffline) {
      // `warning`, not `error`: nothing failed, the request was held back.
      // Same shape as every other refusal the canvas hands back on a command.
      toast.warning(t('canvas.generatePanel.catalogOffline'), {
        id: 'generate-catalog-offline',
      });
      closeActivePanel();
      return;
    }
    if (noServableMode) {
      // `warning` for the same reason offline is: the request succeeded.
      // The sentence names the one thing that fixes it, because whoever sees
      // this is the person who deploys — a configured deployment never
      // reaches this state.
      toast.warning(t('canvas.generatePanel.catalogNoModels'), {
        id: 'generate-catalog-no-models',
      });
      closeActivePanel();
    }
  }, [catalogError, catalogOffline, noServableMode, closeActivePanel, t]);
  if (catalogError || catalogOffline || catalogPending || noServableMode) {
    return null;
  }
  return (
    <NodeToolbar nodeId={nodeId} isVisible position={Position.Bottom}>
      {children}
    </NodeToolbar>
  );
}
