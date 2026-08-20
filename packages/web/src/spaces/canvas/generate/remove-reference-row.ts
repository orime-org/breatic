// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * What a rail row's ✕ does — the one answer both Generate panels give.
 *
 * A rail has two row sources and the ✕ means a different thing on each: an
 * edge row is a connection to cut, a crop row is a stored copy to delete plus
 * a delete-side ledger entry. The rule was the image panel's alone until
 * #1978 gave the video panel crops and all 27 lines were copied over
 * verbatim; it lives here now so the next panel inherits it instead of
 * copying it a third time.
 */

import { assetsApi } from '@web/data/api/assets';
import {
  readCanvasGraph,
  removeEdge,
  removeNodeFocusImage,
} from '@web/data/yjs/canvas-space';
import {
  assetUrlSurvives,
  isReportableAssetUrl,
} from '@web/spaces/canvas/canvas-upload';
import {
  focusIdOfRefId,
  type ReferenceRailItem,
} from '@web/spaces/canvas/generate/derive-references';

/**
 * Removes one rail row on behalf of its ✕.
 *
 * Routed by the ROW's identity, never by parsing the id string: edge ids are
 * untrusted collaborative data, and a crafted edge id starting with `focus:`
 * must not misroute the ✕ (image panel's adversarial round-2). Only a real
 * crop row carries `focus: true` — it is built locally from sanitized crops —
 * so its refId is trusted to parse.
 * @param input - The row plus where it lives.
 * @param input.item - The rail row whose ✕ was clicked.
 * @param input.projectId - Owning project.
 * @param input.spaceId - Owning space.
 * @param input.nodeId - The panel's host node, which stores the crops.
 */
export function removeReferenceRow(input: {
  item: ReferenceRailItem;
  projectId: string;
  spaceId: string;
  nodeId: string;
}): void {
  const { item, projectId, spaceId, nodeId } = input;
  if (item.focus !== true) {
    removeEdge(projectId, spaceId, item.refId);
    return;
  }
  const focusId = focusIdOfRefId(item.refId);
  if (focusId === null) return;
  // Gate everything below on the ACTUAL removal: a double-click (or a ✕ after
  // the remote removal already synced in) hits a no-op here, and reporting it
  // anyway would append a duplicate asset:deleted activity row (image panel's
  // round-3). TRULY concurrent cross-client ✕ (both inside the sync-latency
  // window) still double-reports — accepted residual, audit-feed row only; a
  // real fix needs a server-side idempotency key (round-5).
  const removed = removeNodeFocusImage(projectId, spaceId, nodeId, focusId);
  if (!removed) return;
  // Delete-side ledger report: a crop is an uploaded asset, so mirror the
  // node-delete accounting. The survivor check reads the FRESH post-removal
  // graph, so the removed instance is naturally excluded; a URL still alive
  // elsewhere (dedup) is not reported. Silent catch: the removal already
  // succeeded, and a toast would read as a failed remove (reportDeletedAssets
  // parity).
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
}
