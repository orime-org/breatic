// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Which stored assets a canvas deletion leaves unused, for the asset-delete
 * report (ADR 2026-07-04 project-activity-feed). Shared so the browser's
 * delete and an external agent's (breatic#1488) report the same entries.
 */

import { validFocusImages } from '@shared/canvas/model/focus-images.js';
import { allSlotSpecs, readSlotPicks } from '@shared/canvas/model/slots.js';

/** A minimal canvas node shape for asset-delete accounting (pure). */
export interface AssetNodeLike {
  id: string;
  type?: string;
  data?: {
    content?: unknown;
    coverUrl?: unknown;
    focusImages?: unknown;
  };
}

/**
 * Every asset URL a node holds in a source slot, on either generative panel.
 *
 * Both halves of the delete accounting read this: the set of URLs a surviving
 * node keeps alive, and the question "does any node still hold this URL".
 * Deriving them from the slot registry is what keeps the two in step with each
 * other and with the slots themselves.
 *
 * A slot's poster counts too — it is a second uploaded asset, copied into the
 * slot at pick time on the same terms as the asset it stands for.
 * @param data - A node's data map, whatever shape it is in.
 * @returns Every URL this node's slots hold.
 */
function slotUrls(data: unknown): string[] {
  const bag = data as Record<string, unknown> | undefined;
  const urls: string[] = [];
  for (const spec of allSlotSpecs()) {
    for (const pick of readSlotPicks(spec, bag?.[spec.field])) {
      urls.push(pick.url);
      if (pick.thumbnail && pick.thumbnail !== pick.url) urls.push(pick.thumbnail);
    }
  }
  return urls;
}

/** One asset-delete report entry (activity feed). */
export interface DeletedAssetEntry {
  fileUrl: string;
  kind: string;
  nodeId: string;
  spaceId: string;
}

/**
 * Whether an asset URL is safe to put in a delete-side ledger report — a
 * parse-level check mirroring the server's `z.string().url()` (round-3: the
 * old prefix regex accepted strings like `https://a b` that the server
 * rejects with a whole-batch 400, so ONE malformed remote crop URL poisoned
 * every other entry in a multi-node delete report).
 * @param url - The candidate asset URL.
 * @returns True for a parseable http(s) URL.
 */
export function isReportableAssetUrl(url: string): boolean {
  // Mirrors the FULL server field contract (`z.string().url().max(2048)`,
  // routes/assets.ts) — a parseable-but-overlong URL still 400s the whole
  // batch (adversarial round-4).
  if (url.length > 2048) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Compute the asset-delete report entries for a set of deleted nodes
 * (ADR 2026-07-04 project-activity-feed).
 *
 * For each deleted media node (image / video / audio) it reports BOTH
 * the primary asset (`data.content`) AND the cover (`data.coverUrl`) —
 * each is a stored object the node owned. It SKIPS any URL still
 * referenced by a SURVIVING node (a URL in `allNodes` minus the deleted
 * set): pasted copies share a content URL, so deleting one copy leaves
 * the asset in use and it must not be reported deleted (which would
 * mislead the audit feed + a future GC).
 * @param deletedNodes - The nodes being removed.
 * @param allNodes - The current node set (still includes the deleted
 *   ones — Yjs removal propagates async; the deleted set is excluded here).
 * @param spaceId - The space the nodes live in.
 * @returns The report entries (content + cover, unreferenced only).
 */
export function computeDeletedAssetEntries(
  deletedNodes: ReadonlyArray<AssetNodeLike>,
  allNodes: ReadonlyArray<AssetNodeLike>,
  spaceId: string,
): DeletedAssetEntry[] {
  const deletedIds = new Set(deletedNodes.map((n) => n.id));
  const survivingUrls = new Set<string>();
  for (const n of allNodes) {
    if (deletedIds.has(n.id)) continue;
    if (typeof n.data?.content === 'string') survivingUrls.add(n.data.content);
    if (typeof n.data?.coverUrl === 'string') survivingUrls.add(n.data.coverUrl);
    // Every source slot on either generative panel (#1896 onward) holds a
    // copied URL — dedup can make it equal a crop's asset URL, so it keeps
    // the asset alive too. Read off the registries
    // rather than listed here: the first two were added one PR at a time, and
    // a slot left out of a hand-kept list reports an asset the node is still
    // generating from — silently, until someone deletes the node it was
    // picked from (#1918).
    for (const url of slotUrls(n.data)) survivingUrls.add(url);
    // Focus crops (#1782) are uploaded assets too — a crop URL held by a
    // surviving node keeps the asset alive (adversarial round-2).
    for (const crop of validFocusImages(n.data?.focusImages)) {
      survivingUrls.add(crop.url);
    }
  }
  const mediaTypes = new Set(['image', 'video', 'audio']);
  return deletedNodes.flatMap((node) => {
    const out: DeletedAssetEntry[] = [];
    if (node.type !== undefined && mediaTypes.has(node.type)) {
      for (const url of [node.data?.content, node.data?.coverUrl]) {
        if (
          typeof url === 'string' &&
          isReportableAssetUrl(url) &&
          !survivingUrls.has(url)
        ) {
          out.push({ fileUrl: url, kind: node.type, nodeId: node.id, spaceId });
        }
      }
    }
    // A deleted node takes its focus crops with it — report each crop asset
    // unless the same URL survives elsewhere (dedup can share URLs). Crops
    // are always images regardless of the holding node's type.
    for (const crop of validFocusImages(node.data?.focusImages)) {
      if (isReportableAssetUrl(crop.url) && !survivingUrls.has(crop.url)) {
        out.push({ fileUrl: crop.url, kind: 'image', nodeId: node.id, spaceId });
      }
    }
    return out;
  });
}

/**
 * Whether an asset URL is still referenced by any node — content, cover,
 * focus crop (#1782), or anything held in a
 * source slot on either generative panel (#1896 onward, read off the
 * registries rather than listed here). The rail's crop ✕ reports the asset deleted only when this is
 * false; call it AFTER the removal write so the removed instance is
 * naturally excluded (adversarial round-2).
 * @param url - The asset URL to check.
 * @param nodes - The current canvas nodes (post-removal).
 * @returns True when any node still references the URL.
 */
export function assetUrlSurvives(
  url: string,
  // `data?: object` (not the field shape): the all-optional field object is
  // a WEAK TYPE, and view variants with none of the fields (GroupNodeView)
  // would fail assignability even though reading them is safe.
  nodes: ReadonlyArray<{ data?: object }>,
): boolean {
  for (const n of nodes) {
    const data = n.data as AssetNodeLike['data'];
    if (data?.content === url || data?.coverUrl === url) {
      return true;
    }
    // Same registry, same reason as the surviving-set above: the two lists
    // are each other's other half, and a slot missing from either one lets
    // its asset be reported as unused.
    if (slotUrls(data).includes(url)) {
      return true;
    }
    if (validFocusImages(data?.focusImages).some((c) => c.url === url)) {
      return true;
    }
  }
  return false;
}
