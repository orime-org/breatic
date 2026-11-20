// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * inner#1306 test plan §97 D27-1: one side-effect-free builder, `buildPlannedVideoRequest(tool, draft, panelFacts,
 * outputNodeIds)` beside `preparePlannedVideoRun`, makes the planned request body the quote and the Run both send. It keeps
 * the draft as it is, names the given output node ids in order, passes shared `miniToolPlannedRequestSchema`, and writes
 * nothing (no Yjs write, no request).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as RequestModule from '@web/data/api/request';

vi.mock('@web/data/api/request', async (original) => ({ ...(await original<typeof RequestModule>()), apiGet: vi.fn(), apiPost: vi.fn() }));

import { miniToolPlannedRequestSchema, type MiniToolPlannedRequest, type VideoToolAnalysisRef, type VideoToolDraft, type VideoToolDraftById, type VideoToolId } from '@breatic/shared/mini-tools';
import * as start from '../start-planned-video-run';
import { apiGet, apiPost } from '@web/data/api/request';
import { docName, getDoc } from '@web/data/yjs/manager';

interface PanelFacts { projectId: string; spaceId: string; presentationRef: MiniToolPlannedRequest['presentation_ref']; analysisRefs: readonly VideoToolAnalysisRef[]; grid: { fps: { numerator: number; denominator: number }; frameCount: number } }
type Builder = (tool: VideoToolId, draft: VideoToolDraft, facts: PanelFacts, outputNodeIds: readonly string[]) => MiniToolPlannedRequest | Promise<MiniToolPlannedRequest>;

const PROJECT = '10000000-0000-4000-8000-000000000001';
const SPACE = '20000000-0000-4000-8000-000000000001';
const HOST = '30000000-0000-4000-8000-000000000001';
const OUTPUT = '40000000-0000-4000-8000-000000000001';
const SECOND = '40000000-0000-4000-8000-000000000002';
const RUN = '90000000-0000-4000-8000-000000000001';
const media = { width: 960, height: 540, duration: 5, mimeType: 'video/mp4' };
const source = { nodeId: HOST, canonicalURL: 'https://assets.example.test/current.mp4', mediaInfo: media };
const ref = (letter: string): { toolInputId: string; planSha256: string } => ({ toolInputId: letter.repeat(64), planSha256: 'd'.repeat(64) });

const SPLIT: VideoToolDraftById['video.split'] = { version: 1, draftId: '60000000-0000-4000-8000-000000000003', revision: '70000000-0000-4000-8000-000000000003', source, inputs: [], params: { cuts: [50] } };
const SCENE_REF: VideoToolAnalysisRef = { version: 1, toolId: 'video.split', kind: 'scene_cuts', draftId: SPLIT.draftId, analysisRunId: RUN, inputFingerprint: 'e'.repeat(64) };
const GRID = { fps: { numerator: 25, denominator: 1 }, frameCount: 125 };

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
  const body = await builder()(tool, held, facts, [OUTPUT, SECOND]);
  expect(miniToolPlannedRequestSchema.safeParse(body).success).toBe(true);
  expect(body).toMatchObject({ tool, project_id: PROJECT, space_id: SPACE, draft, presentation_ref: facts.presentationRef });
  expect(body.run_id).toMatch(/^[0-9a-f-]{36}$/);
  // The draft is used as it is and left as it was.
  expect(held).toEqual(draft);
  return body;
}

beforeEach(() => { vi.clearAllMocks(); });

describe('buildPlannedVideoRequest makes the body the quote and the Run share (§97 D27-1)', () => {
  it('builds a split request with its scene ref and one given output node per segment', async () => {
    const body = await built('video.split', SPLIT, { projectId: PROJECT, spaceId: SPACE, presentationRef: { source: ref('a') }, analysisRefs: [SCENE_REF], grid: GRID });
    expect(body.analysis_refs).toEqual([SCENE_REF]);
    expect(body.outputs).toEqual([
      { outputIndex: 0, nodeId: OUTPUT, recipe: { kind: 'segment', range: { start: 0, end: 50 } } },
      { outputIndex: 1, nodeId: SECOND, recipe: { kind: 'segment', range: { start: 50, end: 125 } } },
    ]);
  });

  it('writes nothing: no canvas node, no edge, no request', async () => {
    const doc = getDoc(docName.canvasSpace(PROJECT, SPACE));
    const before = JSON.stringify(doc.toJSON());
    await builder()('video.split', structuredClone(SPLIT), { projectId: PROJECT, spaceId: SPACE, presentationRef: { source: ref('a') }, analysisRefs: [SCENE_REF], grid: GRID }, [OUTPUT, SECOND]);
    expect(JSON.stringify(doc.toJSON())).toBe(before);
    expect(apiGet).not.toHaveBeenCalled();
    expect(apiPost).not.toHaveBeenCalled();
  });
});
