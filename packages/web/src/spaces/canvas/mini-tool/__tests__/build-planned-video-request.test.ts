// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * inner#1306 test plan §97 D27-1: one side-effect-free builder, `buildPlannedVideoRequest(tool, draft, panelFacts,
 * outputNodeIds)` beside `preparePlannedVideoRun`, makes the planned request body the quote and the Run both send, for
 * `video.remove-bg`, `video.lip-sync`, `video.transitions`, `video.erase` and `video.expand`. It keeps the draft as it is, names the given output node ids
 * in order, passes shared `miniToolPlannedRequestSchema`, and writes nothing (no Yjs write, no request).
 *
 * `panelFacts` is a shape this test chose from what `preparePlannedVideoRun` reads today plus what the lip-sync and
 * transitions requests need: `{ projectId, spaceId, presentationRef, analysisRefs }`, where `presentationRef` is the
 * request's `presentation_ref` as the panel holds it (`{ source }` for one input, input id → ref for transitions) and
 * `analysisRefs` the analysis refs the draft's selected analyses are recorded under (canvas node data). Request shapes follow
 * `planned-transition-request-schema.test.ts` and the lip-sync body of `planned-lipsync-admission.integration.test.ts`.
 * The builder is read by name so this file compiles before it exists.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as RequestModule from '@web/data/api/request';

vi.mock('@web/data/api/request', async (original) => ({ ...(await original<typeof RequestModule>()), apiGet: vi.fn(), apiPost: vi.fn() }));

import { miniToolPlannedRequestSchema, type MiniToolPlannedRequest, type VideoToolAnalysisRef, type VideoToolDraft, type VideoToolDraftById, type VideoToolId } from '@breatic/shared/mini-tools';
import * as start from '../start-planned-video-run';
import { apiGet, apiPost } from '@web/data/api/request';
import { docName, getDoc } from '@web/data/yjs/manager';

interface PanelFacts { projectId: string; spaceId: string; presentationRef: MiniToolPlannedRequest['presentation_ref']; analysisRefs: readonly VideoToolAnalysisRef[] }
type Builder = (tool: VideoToolId, draft: VideoToolDraft, facts: PanelFacts, outputNodeIds: readonly string[]) => MiniToolPlannedRequest | Promise<MiniToolPlannedRequest>;

const PROJECT = '10000000-0000-4000-8000-000000000001';
const SPACE = '20000000-0000-4000-8000-000000000001';
const HOST = '30000000-0000-4000-8000-000000000001';
const PICKED_NODE = '30000000-0000-4000-8000-000000000002';
const OUTPUT = '40000000-0000-4000-8000-000000000001';
const CURRENT = '80000000-0000-4000-8000-000000000001';
const PICKED = '80000000-0000-4000-8000-000000000002';
const AUDIO = '80000000-0000-4000-8000-000000000003';
const RUN = '90000000-0000-4000-8000-000000000001';
const media = { width: 960, height: 540, duration: 5, mimeType: 'video/mp4' };
const source = { nodeId: HOST, canonicalURL: 'https://assets.example.test/current.mp4', mediaInfo: media };
const ref = (letter: string): { toolInputId: string; planSha256: string } => ({ toolInputId: letter.repeat(64), planSha256: 'd'.repeat(64) });

const LIP_SYNC: VideoToolDraftById['video.lip-sync'] = {
  version: 1, draftId: '60000000-0000-4000-8000-000000000001', revision: '70000000-0000-4000-8000-000000000001', source,
  inputs: [{ inputId: AUDIO, url: 'https://assets.example.test/voice.m4a', mediaInfo: { duration: 3, mimeType: 'audio/mp4' } }],
  params: { anchor: { frameIndex: 0, pts: 0 }, syncMode: 'cut_off', modelId: 'sync-lipsync-3',
    dialogues: [{ dialogueId: '50000000-0000-4000-8000-000000000001', personId: 'person-a', analysisRunId: RUN, audioInputId: AUDIO, startTime: 0 }] },
};
const PEOPLE_REF: VideoToolAnalysisRef = { version: 1, toolId: 'video.lip-sync', kind: 'people', draftId: LIP_SYNC.draftId, analysisRunId: RUN, inputFingerprint: 'e'.repeat(64) };
const TRANSITIONS: VideoToolDraftById['video.transitions'] = {
  version: 1, draftId: '60000000-0000-4000-8000-000000000002', revision: '70000000-0000-4000-8000-000000000002', source,
  inputs: [
    { inputId: CURRENT, url: source.canonicalURL, mediaInfo: media, sourceNodeId: HOST },
    { inputId: PICKED, url: 'https://assets.example.test/picked.mp4', mediaInfo: media, sourceNodeId: PICKED_NODE },
  ],
  params: { clips: [
    { clipId: '90000000-0000-4000-8000-000000000011', inputId: CURRENT, in: 0, out: 4, transition: { kind: 'fade', duration: 0.5 } },
    { clipId: '90000000-0000-4000-8000-000000000012', inputId: PICKED, in: 0, out: 4, transition: { kind: 'cut', duration: 0 } },
  ] },
} as VideoToolDraftById['video.transitions'];
const REMOVE_BG: VideoToolDraftById['video.remove-bg'] = { version: 1, draftId: '60000000-0000-4000-8000-000000000003', revision: '70000000-0000-4000-8000-000000000003', source, inputs: [], params: {} };
const ERASE: VideoToolDraftById['video.erase'] = {
  version: 1, draftId: '60000000-0000-4000-8000-000000000004', revision: '70000000-0000-4000-8000-000000000004', source, inputs: [],
  params: { range: { start: 0, end: 3 }, anchor: { frameIndex: 0, pts: 0 }, region: { box: { x: 0.3, y: 0.2, width: 0.3, height: 0.6 }, points: [] }, trackingPrompt: '' },
};
const TRACKED_REF: VideoToolAnalysisRef = { version: 1, toolId: 'video.erase', kind: 'tracked_mask', draftId: ERASE.draftId, analysisRunId: RUN, inputFingerprint: 'e'.repeat(64) };
const EXPAND: VideoToolDraftById['video.expand'] = {
  version: 1, draftId: '60000000-0000-4000-8000-000000000005', revision: '70000000-0000-4000-8000-000000000005', source, inputs: [],
  params: { frame: { x: -0.25, y: 0, width: 1.5, height: 1 }, ratio: '16:9', prompt: '' },
};

/**
 * The builder under test, or a failure naming it when it does not exist yet.
 * @returns The builder.
 */
function builder(): Builder {
  const found = (start as unknown as { buildPlannedVideoRequest?: Builder }).buildPlannedVideoRequest;
  expect(found, 'start-planned-video-run exports buildPlannedVideoRequest').toBeTypeOf('function');
  return found!;
}

/**
 * Builds a body and checks the parts every tool shares.
 * @param tool - The tool.
 * @param draft - The draft.
 * @param facts - The panel facts.
 * @returns The body.
 */
async function built(tool: VideoToolId, draft: VideoToolDraft, facts: PanelFacts): Promise<MiniToolPlannedRequest> {
  const held = structuredClone(draft);
  const body = await builder()(tool, held, facts, [OUTPUT]);
  expect(miniToolPlannedRequestSchema.safeParse(body).success).toBe(true);
  expect(body).toMatchObject({ tool, project_id: PROJECT, space_id: SPACE, draft, presentation_ref: facts.presentationRef });
  expect(body.run_id).toMatch(/^[0-9a-f-]{36}$/);
  // The draft is used as it is and left as it was.
  expect(held).toEqual(draft);
  return body;
}

beforeEach(() => { vi.clearAllMocks(); });

describe('buildPlannedVideoRequest makes the body the quote and the Run share (§97 D27-1)', () => {
  it('builds a lip-sync request with its people ref, its model and the given output node', async () => {
    const body = await built('video.lip-sync', LIP_SYNC, { projectId: PROJECT, spaceId: SPACE, presentationRef: { source: ref('a') }, analysisRefs: [PEOPLE_REF] });
    expect(body.analysis_refs).toEqual([PEOPLE_REF]);
    expect(body.outputs).toEqual([{ outputIndex: 0, nodeId: OUTPUT, recipe: { kind: 'lip-sync' } }]);
  });

  it('builds a transitions request with one tool input ref per clip input and the given output node', async () => {
    const presentationRef = { [CURRENT]: ref('a'), [PICKED]: ref('b') };
    const body = await built('video.transitions', TRANSITIONS, { projectId: PROJECT, spaceId: SPACE, presentationRef, analysisRefs: [] });
    expect(body.analysis_refs).toEqual([]);
    expect(body.outputs).toEqual([{ outputIndex: 0, nodeId: OUTPUT, recipe: { kind: 'transitions' } }]);
  });

  it('builds a remove-bg request with the given output node', async () => {
    const body = await built('video.remove-bg', REMOVE_BG, { projectId: PROJECT, spaceId: SPACE, presentationRef: { source: ref('a') }, analysisRefs: [] });
    expect(body.outputs).toEqual([{ outputIndex: 0, nodeId: OUTPUT, recipe: { kind: 'remove-bg' } }]);
  });

  it('builds an erase request with its tracking ref and the given output node', async () => {
    const body = await built('video.erase', ERASE, { projectId: PROJECT, spaceId: SPACE, presentationRef: { source: ref('a') }, analysisRefs: [TRACKED_REF] });
    expect(body.analysis_refs).toEqual([TRACKED_REF]);
    expect(body.outputs).toEqual([{ outputIndex: 0, nodeId: OUTPUT, recipe: { kind: 'erase' } }]);
  });

  it('builds an expand request with the given output node', async () => {
    const body = await built('video.expand', EXPAND, { projectId: PROJECT, spaceId: SPACE, presentationRef: { source: ref('a') }, analysisRefs: [] });
    expect(body.outputs).toEqual([{ outputIndex: 0, nodeId: OUTPUT, recipe: { kind: 'expand' } }]);
  });

  it('writes nothing: no canvas node, no edge, no request', async () => {
    const doc = getDoc(docName.canvasSpace(PROJECT, SPACE));
    const before = JSON.stringify(doc.toJSON());
    await builder()('video.lip-sync', structuredClone(LIP_SYNC), { projectId: PROJECT, spaceId: SPACE, presentationRef: { source: ref('a') }, analysisRefs: [PEOPLE_REF] }, [OUTPUT]);
    expect(JSON.stringify(doc.toJSON())).toBe(before);
    expect(apiGet).not.toHaveBeenCalled();
    expect(apiPost).not.toHaveBeenCalled();
  });
});
