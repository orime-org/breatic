// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

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

import { modelsApi } from '@web/data/api/models';
import type { CanvasNodeView } from '@web/data/yjs/canvas-space';
import { useTranslation } from '@web/i18n/use-translation';
import { toast } from '@web/lib/toast';
import { useCanvasStore } from '@web/stores';

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

interface CatalogGatedFrameProps {
  /** The node the panel is anchored to. */
  nodeId: string;
  /** The panel body, mounted only once a catalog is available. */
  children: React.ReactNode;
}

/**
 * Model-catalog failure gate plus the node-anchored float.
 *
 * A panel without a catalog is a dead end (blank model pill, no params,
 * execute permanently disabled), so a failed fetch EXPLAINS itself with a
 * toast and the panel never opens — no silent fail. Mounted only while a panel
 * is open, so the always-rendered container never touches react-query: a closed
 * panel needs no QueryClient, and never asking for one keeps the catalog's
 * single fetch tied to a panel actually being on screen.
 *
 * The gate fires on "errored AND nothing cached": a BACKGROUND refetch failure
 * keeps the previously-fetched catalog, and the panel keeps working off it —
 * closing a working panel over a refresh hiccup would be worse than the silent
 * failure this gate fixes.
 * @param root0 - Component props.
 * @param root0.nodeId - The node the panel anchors to.
 * @param root0.children - The panel body.
 * @returns The floating panel, or null while the catalog is failed.
 */
export function CatalogGatedFrame({
  nodeId,
  children,
}: CatalogGatedFrameProps): React.JSX.Element | null {
  const t = useTranslation();
  const closeActivePanel = useCanvasStore((s) => s.closeActivePanel);
  const { isError, data } = useQuery({
    queryKey: ['models'],
    queryFn: () => modelsApi.list(),
  });
  const catalogError = isError && data === undefined;
  React.useEffect(() => {
    if (catalogError) {
      // A fixed toast id de-duplicates the StrictMode double-effect and rapid
      // re-open attempts while the API stays down (sonner replaces in place).
      toast.error(t('canvas.generatePanel.catalogUnavailable'), {
        id: 'generate-catalog-unavailable',
      });
      closeActivePanel();
    }
  }, [catalogError, closeActivePanel, t]);
  if (catalogError) return null;
  return (
    <NodeToolbar nodeId={nodeId} isVisible position={Position.Bottom}>
      {children}
    </NodeToolbar>
  );
}
