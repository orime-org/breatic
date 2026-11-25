// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Video focus crop, the press side (frames-split design §5.5 "受理", "计划形状", "登记", "测试"; test plan §68.1).
 * A confirmed video marquee is no longer exported in the browser: it becomes one planned `video.focus-crop` request whose
 * only output is the panel node, framed in the selected version's display geometry (`P.display`).
 */

import { describe, expect, it } from 'vitest';
import { MAX_FOCUS_NAME } from '@web/data/focus-images';
import { toNaturalCrop, type CropRect } from '@web/lib/crop-math';
import { intrinsicSize } from '@web/spaces/canvas/focus/crop-source';
import { videoFocusCropRequest, type VideoFocusCropPress } from '@web/spaces/canvas/focus/run-focus-crop';
import { taskRowKind } from '@web/spaces/canvas/tasks/task-row-kind';
import {
  VIDEO_TOOL_IDS,
  miniToolPlannedRequestSchema,
  miniToolTaskType,
  miniToolsFor,
  type MiniToolPlannedRequest,
  type MiniToolPresentationRef,
  type VideoToolSourceRef,
} from '@breatic/shared/mini-tools';

const PROJECT = '10000000-0000-4000-8000-000000000001';
const SPACE = '10000000-0000-4000-8000-000000000002';
const PANEL = '10000000-0000-4000-8000-000000000003';
const SOURCE_NODE = '10000000-0000-4000-8000-000000000004';
const RUN = '10000000-0000-4000-8000-000000000005';
const SOURCE: VideoToolSourceRef = {
  nodeId: SOURCE_NODE,
  canonicalURL: 'https://assets.example.test/video/clip.mp4',
  mediaInfo: { width: 1920, height: 1080, duration: 4, mimeType: 'video/mp4' },
};
const PRESENTATION_REF: MiniToolPresentationRef = { source: { toolInputId: 'd'.repeat(64), planSha256: 'f'.repeat(64) } };
const CROP: CropRect = { x: 480, y: 270, width: 960, height: 540 };

/**
 * The press for one marquee.
 * @param over - Fields to change.
 * @returns The press.
 */
function pressOf(over: Partial<VideoFocusCropPress> = {}): VideoFocusCropPress {
  return { projectId: PROJECT, spaceId: SPACE, panelNodeId: PANEL, source: SOURCE, sourceName: 'Clip 7', presentationRef: PRESENTATION_REF,
    frameIndex: 42, crop: CROP, ...over };
}

/**
 * Build the request for one marquee.
 * @param over - Fields to change.
 * @returns The request.
 */
function requestOf(over: Partial<VideoFocusCropPress> = {}): MiniToolPlannedRequest {
  return videoFocusCropRequest(pressOf(over), RUN);
}

/**
 * A jsdom video whose played file is smaller than the source.
 * @param width - The played file's width.
 * @param height - The played file's height.
 * @returns The element.
 */
function playedVideo(width: number, height: number): HTMLVideoElement {
  const el = document.createElement('video');
  Object.defineProperty(el, 'videoWidth', { configurable: true, value: width });
  Object.defineProperty(el, 'videoHeight', { configurable: true, value: height });
  return el;
}

describe('video focus crop press (design §5.5)', () => {
  it('F01: a marquee drawn over a smaller played file maps into P.display pixels, not the played file\'s', () => {
    // The played file is 640x360; the selected version displays the tool source at 1920x1080 (design §5.5 "用户操作").
    const el = playedVideo(640, 360);
    const display = { width: 1920, height: 1080 };
    const space = intrinsicSize(el, display);
    expect(space).toEqual(display);
    // The same on-screen marquee (a quarter in from each edge of a 400x225 box) lands on the same source pixels.
    expect(toNaturalCrop({ x: 100, y: 56.25, width: 200, height: 112.5 }, { width: 400, height: 225 }, space)).toEqual(CROP);
  });

  it('F03: a focus-crop task row reads as the action and the frozen source name, not the raw tool id', () => {
    const t = (key: string): string => `«${key}»`;
    const kind = taskRowKind({ action: 'mini_tool', label: 'video.focus-crop', sourceName: 'Clip 7' }, t, () => null);
    expect(kind.label).not.toBe('video.focus-crop');
    expect(kind.label).toMatch(/^«canvas\..+»$/);
    expect(kind.detail).toBe('Clip 7');
  });

  it('F03: the source name is cut to MAX_FOCUS_NAME before it is frozen into the request', () => {
    const long = 'n'.repeat(MAX_FOCUS_NAME + 1);
    const body = requestOf({ sourceName: long });
    expect((body.draft.params as unknown as { sourceName: string }).sourceName).toBe(long.slice(0, MAX_FOCUS_NAME));
  });

  it('F05: the request is a planned video.focus-crop with the panel node as its only output and the video node as draft.source', () => {
    const body = requestOf();
    expect(body).toMatchObject({
      tool: 'video.focus-crop', project_id: PROJECT, space_id: SPACE, run_id: RUN, analysis_refs: [], presentation_ref: PRESENTATION_REF,
      draft: { version: 1, source: SOURCE, inputs: [], params: { frameIndex: 42, crop: CROP, sourceName: 'Clip 7' } },
      outputs: [{ outputIndex: 0, nodeId: PANEL, recipe: { kind: 'frame', frameIndex: 42, crop: CROP } }],
    });
    expect(body.outputs).toHaveLength(1);
    expect(body.outputs[0]!.nodeId).not.toBe(body.draft.source.nodeId);
    expect(miniToolPlannedRequestSchema.safeParse(body).success).toBe(true);
  });

  it('F05: miniToolTaskType gives image for the two frame tools and video for every other planned tool', () => {
    expect(miniToolTaskType('video.focus-crop')).toBe('image');
    expect(miniToolTaskType('video.extract-frames')).toBe('image');
    for (const tool of VIDEO_TOOL_IDS.filter((id) => id !== 'video.extract-frames')) expect(miniToolTaskType(tool)).toBe('video');
  });

  it('F06: the video submenu and VIDEO_TOOL_IDS keep the panel tools and never list video.focus-crop', () => {
    expect(VIDEO_TOOL_IDS).toHaveLength(2);
    expect(VIDEO_TOOL_IDS).not.toContain('video.focus-crop');
    const submenu = miniToolsFor('video').map((tool) => tool.id);
    expect(submenu).not.toContain('video.focus-crop');
    for (const id of VIDEO_TOOL_IDS) expect(submenu).toContain(id);
  });
});
