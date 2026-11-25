// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import type { t as translate, TimelineClip } from '@breatic/shared';

/** What a clip's name is read from besides the clip itself. */
export interface TimelineClipNameFacts {
  /** The registered asset's name of a video, picture or sound, once read. */
  assetName: string | null;
  /** A web copy's title, once its origin is known. */
  webTitle: string | null;
}

/**
 * The kind a clip's media is named by: an upload placeholder by the kind it becomes.
 * @param clip - The clip.
 * @returns `video`, `image`, `audio`, `text` or `web-animation`.
 * @throws {never} Never.
 */
export function timelineClipKind(clip: TimelineClip): 'video' | 'image' | 'audio' | 'text' | 'web-animation' {
  return clip.kind === 'upload' ? clip.upload.kind : clip.kind;
}

/**
 * One clip's name by kind (inner#1709): a text by the first line of its body, a web copy by its title, a
 * video, picture or sound by its asset's name and by its kind while that name is empty, a placeholder by its file.
 * The track, the magnet insert hint and the properties all read it.
 * @param clip - The clip.
 * @param facts - The asset name and web title read for it.
 * @param t - The translator.
 * @returns The name.
 * @throws {never} Never.
 */
export function timelineClipName(clip: TimelineClip, facts: TimelineClipNameFacts, t: typeof translate): string {
  switch (clip.kind) {
    case 'text': return clip.text.body.split('\n')[0] ?? '';
    case 'web-animation': return facts.webTitle || t('timeline.webAnimation.copy');
    case 'upload': return clip.upload.name;
    default: return facts.assetName || t('timeline.video', { kind: clip.kind });
  }
}
