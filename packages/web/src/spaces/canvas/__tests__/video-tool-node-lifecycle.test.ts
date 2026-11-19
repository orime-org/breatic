// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import type { CanvasNodeFields } from '@breatic/shared';
import { snapshotNodeData, splitSnapshot } from '@web/data/yjs/node-data-snapshot';
import { toNodeView } from '@web/data/yjs/node-view';
import { assetUrlSurvives, computeDeletedAssetEntries } from '@web/spaces/canvas/canvas-upload';
import { cloneForPaste, type ClipboardPayload } from '@web/spaces/canvas/node-clipboard';
import { collectAddresses, replaceAddresses } from '@web/spaces/canvas/paste-addresses';

const projectId = '10000000-0000-4000-8000-000000000001';
const hostId = '20000000-0000-4000-8000-000000000001';
const audioId = '20000000-0000-4000-8000-000000000002';
const draftId = '30000000-0000-4000-8000-000000000001';
const revision = '30000000-0000-4000-8000-000000000002';
const runId = '40000000-0000-4000-8000-000000000001';
const inputId = '50000000-0000-4000-8000-000000000001';
const sourceURL = 'https://media.example.test/video/2026-10-24/1_20000000-0000-4000-8000-000000000001.mp4';
const audioURL = 'https://media.example.test/audio/2026-10-24/2_20000000-0000-4000-8000-000000000002.m4a';
const draftKey = 'miniToolDraft:video.split';
const analysisKey = `miniToolAnalysis:${runId}`;
const draft = {
  version: 1, draftId, revision,
  source: { nodeId: hostId, canonicalURL: sourceURL, mediaInfo: { width: 960, height: 540, duration: 5, mimeType: 'video/mp4' } },
  params: { cuts: [1, 2], sensitivity: 0.4 },
  inputs: [{ inputId, url: audioURL, sourceNodeId: audioId, mediaInfo: { duration: 5, mimeType: 'audio/mp4' } }],
};
const analysis = { version: 1, draftId, toolId: 'video.split', kind: 'scene_cuts', analysisRunId: runId, inputFingerprint: 'a'.repeat(64) };

/**
 * Builds a complete copy with the host and an input node.
 * @returns A payload whose identities and assets have distinct roles.
 */
function payload(): ClipboardPayload {
  return {
    version: 2, source: { projectId, spaceId: '60000000-0000-4000-8000-000000000001' }, picked: [hostId, audioId], edges: [],
    nodes: [
      { id: hostId, type: 'video', position: { x: 0, y: 0 }, data: { content: sourceURL, [draftKey]: structuredClone(draft), [analysisKey]: structuredClone(analysis) } },
      { id: audioId, type: 'audio', position: { x: 400, y: 0 }, data: { content: audioURL } },
    ],
  };
}

/**
 * Reads the clipboard snapshot after its future shared type has been applied.
 * @param data - A cloned node's plain data.
 * @returns Its complete video draft.
 */
function readDraft(data: Record<string, unknown>): typeof draft {
  return data[draftKey] as typeof draft;
}

/**
 * Projects stored node data through the actual wire/view bridge.
 * @param data - Fields stored alongside content.
 * @returns The media node view.
 */
function view(data: Record<string, unknown>): Extract<NonNullable<ReturnType<typeof toNodeView>>, { type: 'video' }> {
  const fields: CanvasNodeFields = {
    id: hostId, type: 'video', position: { x: 0, y: 0 },
    data: { name: 'Host', locked: false, createdAt: 1, createdBy: 'test', attachments: [], ...data },
  };
  const projected = toNodeView(fields);
  if (projected === null || projected.type !== 'video') throw new Error('Valid video node did not project');
  return projected;
}

describe('video-tool clipboard ownership and asset lifecycle', () => {
  it('creates fresh draft identities and rebinds copied node identities within the same Project', () => {
    const original = payload();
    const before = structuredClone(original);
    const copied = cloneForPaste(original, 'user', { dx: 24, dy: 24 }, { targetProjectId: projectId });
    const host = copied.nodes.find((node) => node.id === copied.idMap.get(hostId));
    if (host === undefined) throw new Error('Host clone is missing');
    const next = readDraft(host.data);
    expect(next.draftId).not.toBe(draftId);
    expect(next.revision).not.toBe(revision);
    expect(next.draftId).toMatch(/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i);
    expect(next.revision).toMatch(/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i);
    expect(next.source).toEqual({ ...draft.source, nodeId: host.id });
    expect(next.params).toEqual(draft.params);
    expect(next.inputs).toEqual([{ ...draft.inputs[0], sourceNodeId: copied.idMap.get(audioId) }]);
    expect(host.data[analysisKey]).toEqual({ ...analysis, draftId: next.draftId });
    expect(original).toEqual(before);
  });

  it('clears cross-Project analysis references before collecting and rewriting user assets', () => {
    const copied = cloneForPaste(payload(), 'user', { dx: 0, dy: 0 }, { targetProjectId: '10000000-0000-4000-8000-000000000002' });
    const host = copied.nodes.find((node) => node.id === copied.idMap.get(hostId));
    if (host === undefined) throw new Error('Host clone is missing');
    expect(Object.keys(host.data).filter((key) => key.startsWith('miniToolAnalysis:'))).toEqual([]);
    expect(readDraft(host.data).params).toEqual(draft.params);
    expect(collectAddresses(copied.nodes)).toEqual({ urls: [sourceURL, audioURL], pairs: [] });
    const winner = sourceURL.replace('/1_', '/8_');
    const rewritten = replaceAddresses(copied.nodes, new Map([[sourceURL, winner]]));
    const rewrittenHost = rewritten.find((node) => node.id === host.id);
    expect(rewrittenHost?.data.content).toBe(winner);
    expect(readDraft(rewrittenHost!.data).source.canonicalURL).toBe(winner);
    expect(readDraft(rewrittenHost!.data).inputs[0]?.url).toBe(audioURL);
  });

  it('round-trips complete scalar drafts and independent references through Yjs snapshots', () => {
    const doc = new Y.Doc();
    const data = doc.getMap<unknown>('data');
    data.set(draftKey, structuredClone(draft));
    data.set(analysisKey, structuredClone(analysis));
    expect(snapshotNodeData(data)).toEqual({ [draftKey]: draft, [analysisKey]: analysis });
    expect(splitSnapshot(snapshotNodeData(data))).toEqual({ plain: { [draftKey]: draft, [analysisKey]: analysis }, nested: {} });
    doc.destroy();
  });

  it.each([sourceURL, audioURL])('preserves an asset referenced by a surviving draft: %s', (url) => {
    const host = view({ content: sourceURL.replace('/1_', '/9_'), [draftKey]: structuredClone(draft) });
    expect(assetUrlSurvives(url, [host])).toBe(true);
    const removed = { id: 'removed', type: url === audioURL ? 'audio' : 'video', data: { content: url } };
    expect(computeDeletedAssetEntries([removed], [removed, { id: hostId, ...host }], 'space')).toEqual([]);
  });

  it('releases the source and input reference projection after the draft is cleared', () => {
    const cleared = view({ content: sourceURL.replace('/1_', '/9_') });
    expect(assetUrlSurvives(sourceURL, [cleared])).toBe(false);
    expect(assetUrlSurvives(audioURL, [cleared])).toBe(false);
    const removed = { id: audioId, type: 'audio', data: { content: audioURL } };
    expect(computeDeletedAssetEntries([removed], [removed, { id: hostId, ...cleared }], 'space')).toEqual([{ fileUrl: audioURL, kind: 'audio', nodeId: audioId, spaceId: 'space' }]);
  });
});
