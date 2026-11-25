// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * One clip name by kind (inner#1709 design §6.4): a text clip is named by the first line of its body, a web copy by
 * its title, a video, picture or sound by its asset's name, and by its kind when that name is empty (`timeline.video`
 * read by kind, §6.7). The track, the magnet insert hint and the properties all read this one function.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setLocale, t, type TimelineClip } from '@breatic/shared';

import { timelineClipName } from '@web/spaces/timeline/timeline-clip-name';

const PLACEMENT = {
  trackId: 'v2', startFrame: 0, sourceInFrame: 0, durationFrames: 24, rate: { num: 1, den: 1 }, gain: 1, mute: false,
  transform: { frameX: 0, frameY: 0, scaleX: 1, scaleY: 1, rotation: 0 },
};

/**
 * A clip of one kind, cast because the shared types may not name the new kinds yet.
 * @param kind - Its kind.
 * @param fields - Kind-specific fields.
 * @returns The clip.
 * @throws {never} Never.
 */
function clipOf(kind: string, fields: Record<string, unknown> = {}): TimelineClip {
  return { id: '30000000-0000-4000-8000-000000000001', kind, ...PLACEMENT, ...fields } as unknown as TimelineClip;
}

beforeEach(() => { setLocale('zh-CN'); });
afterEach(() => { setLocale('en'); });

describe('timelineClipName (design §6.4)', () => {
  it('names a text clip by the first line of its body', () => {
    const text = clipOf('text', { text: { body: '镜头 1：开场\n第二行不出现', size: 0.06 } });
    expect(timelineClipName(text, { assetName: null, webTitle: null }, t)).toBe('镜头 1：开场');
  });

  it.each(['video', 'image', 'audio'])('names a %s clip by its asset name', (kind) => {
    const clip = clipOf(kind, { sourceId: '10000000-0000-4000-8000-000000000001' });
    expect(timelineClipName(clip, { assetName: '配乐-轻快.mp3', webTitle: null }, t)).toBe('配乐-轻快.mp3');
  });

  it.each([['video', '视频'], ['image', '图片'], ['audio', '音频']] as const)('names a %s clip whose asset name is empty by its kind, %s', (kind, expected) => {
    const clip = clipOf(kind, { sourceId: '10000000-0000-4000-8000-000000000001' });
    expect(timelineClipName(clip, { assetName: '', webTitle: null }, t)).toBe(expected);
    expect(timelineClipName(clip, { assetName: null, webTitle: null }, t)).toBe(expected);
  });

  it('names a web copy by its title, and by the copy noun before its title is known', () => {
    const web = clipOf('web-animation', { contentBinding: { operationId: null, sourceVersionId: null } });
    expect(timelineClipName(web, { assetName: null, webTitle: '产品发布开场' }, t)).toBe('产品发布开场');
    expect(timelineClipName(web, { assetName: null, webTitle: null }, t)).toBe('网页动画副本');
  });

  it('names an upload placeholder by its file name', () => {
    const upload = clipOf('upload', { upload: { uploadId: 'b0000000-0000-4000-8000-000000000001', name: '镜头1-分镜图.png', kind: 'image', durationSeconds: null } });
    expect(timelineClipName(upload, { assetName: null, webTitle: null }, t)).toBe('镜头1-分镜图.png');
  });
});
