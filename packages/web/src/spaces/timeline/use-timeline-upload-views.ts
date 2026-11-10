// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * What an upload placeholder shows (#1434 design §4.1): one row of the display table, from what this page knows about
 * the upload and what other clients claim in awareness, as the Document's pending blocks decide it
 * (`spaces/document/document-pending-status.ts`).
 */

import * as React from 'react';
import { uploadableFormatList, type TimelineClip } from '@breatic/shared';

import type { UploadFailureReason } from '@web/data/upload/media-upload';
import type { useTranslation } from '@web/i18n/use-translation';
import { useDocProvider, type WriteAccess } from '@web/data/yjs/collab-socket';
import { claimIn, type UploadClaim } from '@web/lib/upload-claims';
import { uploadFailureMessageKey } from '@web/spaces/canvas/upload-failure';
import { timelineUploadWriteAccess, type TimelineUploadEntry, type TimelineUploads } from '@web/spaces/timeline/timeline-uploads';

/** What a placeholder shows: its `data-state`, this page's progress and failure, and whether this page can retry it. */
export interface TimelineUploadView {
  state: 'uploading' | 'failed' | 'waiting' | 'unfinished';
  /** The share sent, 0 to 1, when this page runs the upload and knows it. */
  progress: number | null;
  /** Why this page's upload failed; null for a collaborator's. */
  reason: UploadFailureReason | null;
  retryable: boolean;
}

/**
 * The row of the display table a placeholder is in.
 * @param entry - This page's record of the upload, if it ran it.
 * @param access - This page's write access to the document.
 * @param claim - What other clients claim about it.
 * @returns What it shows.
 * @throws {never} Never.
 */
export function timelineUploadView(entry: TimelineUploadEntry | undefined, access: WriteAccess, claim: UploadClaim | null): TimelineUploadView {
  const none = { progress: null, reason: null, retryable: false };
  if (entry?.phase === 'failed') return { state: 'failed', progress: null, reason: entry.reason, retryable: entry.retryable };
  if (entry?.phase === 'done' && access !== 'granted') return { state: 'waiting', ...none };
  if (entry !== undefined) return { state: 'uploading', ...none, progress: entry.phase === 'uploading' ? entry.progress : null };
  if (claim === 'uploading') return { state: 'uploading', ...none };
  return { state: claim === 'failed' ? 'failed' : 'unfinished', ...none };
}

/**
 * The second line a placeholder shows on its track and in its properties.
 * @param t - The translator.
 * @param view - What it shows.
 * @param name - The placeholder's file name, which a failure reason names.
 * @returns The text.
 * @throws {never} Never.
 */
export function timelineUploadText(t: ReturnType<typeof useTranslation>, view: TimelineUploadView, name: string): string {
  if (view.state === 'uploading') return view.progress === null ? t('timeline.upload.uploading') : t('timeline.upload.progress', { progress: Math.round(view.progress * 100) });
  if (view.state === 'failed') {
    // The same parameters the Canvas and Document refusals pass (canvas-upload.ts, document-uploads.ts).
    return view.reason === null ? t('timeline.upload.failed') : t(uploadFailureMessageKey(view.reason), { filename: name, kind: 'video', formats: uploadableFormatList('video') });
  }
  return t(`timeline.upload.${view.state}`);
}

/**
 * What every upload placeholder of an open Timeline shows, by clip id, following this page's uploads, its write access
 * and the claims in awareness. The snapshot is computed from those facts, so a body shown again after its tab was
 * hidden reads what changed meanwhile, as the Document's pending blocks do (`document-pending-uploads.tsx`).
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
    provider?.on('authenticated', listener);
    provider?.on('authenticationFailed', listener);
    return () => {
      stop();
      provider?.awareness?.off('change', listener);
      provider?.off('authenticated', listener);
      provider?.off('authenticationFailed', listener);
    };
  }, [uploads, provider]);
  const read = React.useCallback((): string => {
    const access = timelineUploadWriteAccess(name);
    const states = provider?.awareness?.getStates() as ReadonlyMap<number, Record<string, unknown>> | undefined;
    return JSON.stringify(clips.flatMap((clip) => clip.kind !== 'upload' ? [] : [[clip.id, timelineUploadView(uploads.entry(clip.upload.uploadId), access,
      states === undefined ? null : claimIn(states, clip.upload.uploadId))]]));
  }, [name, provider, uploads, clips]);
  const key = React.useSyncExternalStore(subscribe, read);
  return React.useMemo(() => new Map(JSON.parse(key) as Array<[string, TimelineUploadView]>), [key]);
}
