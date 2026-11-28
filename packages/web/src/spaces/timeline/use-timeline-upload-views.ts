// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * What an upload placeholder shows (inner#1709): one row of the display table, in the order the
 * Document's pending blocks decide it (`spaces/document/document-pending-status.ts`): what collab wrote onto the
 * placeholder first, then this page's record of the upload, then what other pages claim in awareness.
 */

import * as React from 'react';
import type { PendingFailureReason, TimelineClip, TimelineUploadClip } from '@breatic/shared';

import { FAILURE_MESSAGE, FILE_FAILURE_REASON } from '@web/data/upload/upload-failure-text';
import type { useTranslation } from '@web/i18n/use-translation';
import { useDocProvider } from '@web/data/yjs/collab-socket';
import { claimIn, type UploadClaim } from '@web/lib/upload-claims';
import type { TimelineUploadEntry, TimelineUploads } from '@web/spaces/timeline/timeline-uploads';

/** What a placeholder shows: its `data-state`, this page's progress, the failure reason, and whether this page can retry it. */
export interface TimelineUploadView {
  state: 'uploading' | 'processing' | 'failed' | 'unfinished';
  /** The share sent, 0 to 1, when this page runs the upload and knows it. */
  progress: number | null;
  /** Why it failed, when collab wrote it or this page's upload failed; null for a failure only claimed by another page. */
  reason: PendingFailureReason | null;
  retryable: boolean;
}

/** What {@link timelineUploadView} decides from. */
export interface TimelineUploadFacts {
  /** This page's record of the upload, if it ran it. */
  entry: TimelineUploadEntry | undefined;
  /** What other pages claim about it. */
  claim: UploadClaim | null;
  /** The placeholder's `upload` field, with what collab wrote onto it. */
  upload: TimelineUploadClip['upload'];
}

/**
 * The row of the display table a placeholder is in.
 * @param facts - See {@link TimelineUploadFacts}.
 * @param facts.entry - This page's record of the upload, if it ran it.
 * @param facts.claim - What other pages claim about it.
 * @param facts.upload - The placeholder's `upload` field, with what collab wrote onto it.
 * @returns What it shows.
 * @throws {never} Never.
 */
export function timelineUploadView({ entry, claim, upload }: TimelineUploadFacts): TimelineUploadView {
  const none = { progress: null, reason: null, retryable: false };
  if (upload.state === 'failed') {
    // A Retry is offered only where this page holds the file and would run it, as the Document's `canRetry` decides.
    const here = entry?.phase === 'handedOff' || (entry?.phase === 'failed' && entry.retryable);
    return { state: 'failed', progress: null, reason: upload.failure ?? 'failed', retryable: here && (upload.retryable ?? true) };
  }
  if (upload.state === 'processing') return { state: 'processing', ...none };
  if (entry?.phase === 'uploading') return { state: 'uploading', ...none, progress: entry.progress };
  if (entry?.phase === 'handedOff') return { state: 'processing', ...none };
  if (entry?.phase === 'failed') return { state: 'failed', progress: null, reason: FILE_FAILURE_REASON[entry.reason], retryable: entry.retryable };
  if (claim === 'uploading') return { state: 'uploading', ...none };
  return { state: claim === 'failed' ? 'failed' : 'unfinished', ...none };
}

/**
 * The status line a placeholder shows in its properties, and on its track unless it failed (the track then reads the short failure).
 * @param t - The translator.
 * @param view - What it shows.
 * @param _name - The placeholder's file name; the shared failure messages do not name it.
 * @returns The text.
 * @throws {never} Never.
 */
export function timelineUploadText(t: ReturnType<typeof useTranslation>, view: TimelineUploadView, _name: string): string {
  if (view.state === 'uploading') return view.progress === null ? t('timeline.upload.uploading') : t('timeline.upload.progress', { progress: Math.round(view.progress * 100) });
  if (view.state === 'failed') return view.reason === null ? t('timeline.upload.failed') : t(FAILURE_MESSAGE[view.reason]);
  return t(`timeline.upload.${view.state}`);
}

/**
 * What every upload placeholder of an open Timeline shows, by clip id, following this page's uploads, what collab wrote
 * onto the placeholders and the claims in awareness. The snapshot is computed from those facts, so a body shown again
 * after its tab was hidden reads what changed meanwhile, as the Document's pending blocks do (`document-pending-uploads.tsx`).
 * @param name - The document name.
 * @param uploads - The document's upload controller.
 * @param clips - The readable clips.
 * @returns The views of the upload clips.
 * @throws {never} Never.
 */
export function useTimelineUploadViews(name: string, uploads: TimelineUploads, clips: readonly TimelineClip[]): ReadonlyMap<string, TimelineUploadView> {
  const provider = useDocProvider(name);
  const subscribe = React.useCallback((listener: () => void): (() => void) => {
    const stop = uploads.subscribe(listener);
    provider?.awareness?.on('change', listener);
    return () => {
      stop();
      provider?.awareness?.off('change', listener);
    };
  }, [uploads, provider]);
  const read = React.useCallback((): string => {
    const states = provider?.awareness?.getStates() as ReadonlyMap<number, Record<string, unknown>> | undefined;
    return JSON.stringify(clips.flatMap((clip) => clip.kind !== 'upload' ? [] : [[clip.id, timelineUploadView({
      entry: uploads.entry(clip.upload.uploadId),
      claim: states === undefined ? null : claimIn(states, clip.upload.uploadId),
      upload: clip.upload,
    })]]));
  }, [provider, uploads, clips]);
  const key = React.useSyncExternalStore(subscribe, read);
  return React.useMemo(() => new Map(JSON.parse(key) as Array<[string, TimelineUploadView]>), [key]);
}
