// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Video focus crop, the press side (frames-split design §5.5 "受理", "计划形状", "登记", "测试"; test plan §68.1).
 * A confirmed video marquee is no longer exported in the browser: it becomes one planned `video.focus-crop` request whose
 * only output is the panel node, framed in the selected version's display geometry (`P.display`).
 *
 * The names this file calls that do not exist yet are read through a cast of the real module, so the file typechecks
 * while the behaviour is missing and the failure names the missing function.
 */

import { describe, expect, it } from 'vitest';
import { MAX_FOCUS_NAME } from '@web/data/focus-images';
import { toNaturalCrop, type CropRect } from '@web/lib/crop-math';
import * as cropSource from '@web/spaces/canvas/focus/crop-source';
import * as runFocusCrop from '@web/spaces/canvas/focus/run-focus-crop';
import * as taskRowKindModule from '@web/spaces/canvas/tasks/task-row-kind';
import * as sharedMiniTools from '@breatic/shared/mini-tools';
import {
  MINI_TOOL_RETRY_TOOLS,
  VIDEO_TOOL_IDS,
  miniToolPlannedRequestSchema,
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

/** What one confirmed video marquee hands the press (proposed `VideoFocusCropPress`). */
interface VideoFocusCropPress {
  projectId: string;
  spaceId: string;
  panelNodeId: string;
  source: VideoToolSourceRef;
  sourceName: string;
  presentationRef: MiniToolPresentationRef;
  frameIndex: number;
  crop: CropRect;
}

/** The proposed request builder in `run-focus-crop.ts`. */
const press = runFocusCrop as unknown as {
  videoFocusCropRequest?: (press: VideoFocusCropPress, runId: string) => MiniToolPlannedRequest;
};
/** The proposed shared task-type rule (`miniToolTaskType` in `tools.ts`, design §5.5 "计划形状"). */
const shared = sharedMiniTools as unknown as { miniToolTaskType?: (tool: string) => 'image' | 'video' };
/** `intrinsicSize` taking the selected version's display size (design §10.12 crop-source row). */
const crop = cropSource as unknown as {
  intrinsicSize: (el: HTMLVideoElement, display?: { width: number; height: number }) => { width: number; height: number };
};
/** `taskRowKind` reading the frozen source name a focus-crop row carries (design §10.12 task-row-kind row). */
const rowKind = taskRowKindModule as unknown as {
  taskRowKind: (
    entry: { action: 'mini_tool'; label: string; sourceName?: string | null },
    t: (key: string) => string,
    displayNameOf: (id: string) => string | null,
  ) => { label: string; detail: string | null };
};

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
 * Build the request through the proposed builder.
 * @param over - Fields to change.
 * @returns The request.
 * @throws {Error} When the builder does not exist yet.
 */
function requestOf(over: Partial<VideoFocusCropPress> = {}): MiniToolPlannedRequest {
  if (typeof press.videoFocusCropRequest !== 'function') throw new Error('run-focus-crop exports no videoFocusCropRequest');
  return press.videoFocusCropRequest(pressOf(over), RUN);
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
    const space = crop.intrinsicSize(el, display);
    expect(space).toEqual(display);
    // The same on-screen marquee (a quarter in from each edge of a 400x225 box) lands on the same source pixels.
    expect(toNaturalCrop({ x: 100, y: 56.25, width: 200, height: 112.5 }, { width: 400, height: 225 }, space)).toEqual(CROP);
  });

  it('F03: a focus-crop task row reads as the action and the frozen source name, not the raw tool id', () => {
    const t = (key: string): string => `«${key}»`;
    const kind = rowKind.taskRowKind({ action: 'mini_tool', label: 'video.focus-crop', sourceName: 'Clip 7' }, t, () => null);
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
    expect(typeof shared.miniToolTaskType).toBe('function');
    expect(shared.miniToolTaskType!('video.focus-crop')).toBe('image');
    expect(shared.miniToolTaskType!('video.extract-frames')).toBe('image');
    for (const tool of VIDEO_TOOL_IDS.filter((id) => id !== 'video.extract-frames')) expect(shared.miniToolTaskType!(tool)).toBe('video');
  });

  it('F06: the video submenu and VIDEO_TOOL_IDS keep the seven panel tools and never list video.focus-crop', () => {
    expect(VIDEO_TOOL_IDS).toHaveLength(7);
    expect(VIDEO_TOOL_IDS).not.toContain('video.focus-crop');
    const submenu = miniToolsFor('video').map((tool) => tool.id);
    expect(submenu).not.toContain('video.focus-crop');
    for (const id of VIDEO_TOOL_IDS) expect(submenu).toContain(id);
  });

  it('F11: a focus crop has no failed-output retry', () => {
    expect(MINI_TOOL_RETRY_TOOLS).not.toContain('video.focus-crop');
  });
});
