// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import { newId } from '@breatic/shared';
import {
  VIDEO_TOOL_IDS,
  readVideoToolDraft,
  videoToolAnalysisRefs,
  videoToolDraftAssetUrls,
} from '@breatic/shared/mini-tools';

/**
 * Reads copied media references from raw data or the node-view projection.
 * @param data - A raw scalar bag or a projected node's data.
 * @returns Unique registered media addresses in encounter order.
 * @throws {never} Never.
 */
export function videoToolNodeAssetUrls(data: object | undefined): string[] {
  if (data === undefined) return [];
  const bag = data as Record<string, unknown>;
  const urls: string[] = [];
  if (Array.isArray(bag.miniToolAssetUrls)) {
    for (const url of bag.miniToolAssetUrls) if (typeof url === 'string') urls.push(url);
  }
  for (const toolId of VIDEO_TOOL_IDS) {
    const reading = readVideoToolDraft(toolId, bag[`miniToolDraft:${toolId}`]);
    if (reading.state === 'supported') urls.push(...videoToolDraftAssetUrls(reading.draft));
  }
  return [...new Set(urls)];
}

/**
 * Assigns copied drafts their own identities and scopes accepted analyses.
 * @param data - The deep-cloned node data being prepared for paste.
 * @param idMap - Copied node identities, including the host and copied inputs.
 * @param sameProject - Whether accepted runs remain accessible in the destination.
 * @returns The same data bag with supported drafts and analysis references rebound.
 * @throws {never} Never.
 */
export function rebindVideoToolDrafts(data: Record<string, unknown>, idMap: ReadonlyMap<string, string>, sameProject: boolean): Record<string, unknown> {
  const draftIds = new Map<string, string>();
  for (const toolId of VIDEO_TOOL_IDS) {
    const key = `miniToolDraft:${toolId}`;
    const reading = readVideoToolDraft(toolId, data[key]);
    if (reading.state !== 'supported') continue;
    const draft = reading.draft;
    const draftId = newId();
    draftIds.set(draft.draftId, draftId);
    data[key] = {
      ...draft, draftId, revision: newId(),
      source: { ...draft.source, nodeId: idMap.get(draft.source.nodeId) ?? draft.source.nodeId },
      inputs: draft.inputs.map((input) => input.sourceNodeId === undefined ? input : { ...input, sourceNodeId: idMap.get(input.sourceNodeId) ?? input.sourceNodeId }),
    };
  }
  if (!sameProject) {
    for (const key of Object.keys(data)) if (key.startsWith('miniToolAnalysis:')) delete data[key];
  } else {
    for (const reference of videoToolAnalysisRefs(data)) {
      const draftId = draftIds.get(reference.draftId);
      if (draftId !== undefined) data[`miniToolAnalysis:${reference.analysisRunId}`] = { ...reference, draftId };
    }
  }
  return data;
}
