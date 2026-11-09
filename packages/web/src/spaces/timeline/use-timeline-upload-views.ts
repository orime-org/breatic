// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * What an upload placeholder shows (#1434 design §4.1): one row of the display table, from what this page knows about
 * the upload and what other clients claim in awareness, as the Document's pending blocks decide it
 * (`spaces/document/document-pending-status.ts`).
 */

import * as React from 'react';
import type { TimelineClip } from '@breatic/shared';

import type { UploadFailureReason } from '@web/data/upload/media-upload';
import type { useTranslation } from '@web/i18n/use-translation';
import { useDocProvider, type WriteAccess } from '@web/data/yjs/collab-socket';
import { uploadFailureMessageKey } from '@web/spaces/canvas/upload-failure';
import { claimIn } from '@web/spaces/document/document-pending-status';
import type { UploadClaim } from '@web/spaces/document/document-upload-controller';
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
 * @returns The text.
 * @throws {never} Never.
 */
export function timelineUploadText(t: ReturnType<typeof useTranslation>, view: TimelineUploadView): string {
  if (view.state === 'uploading') return view.progress === null ? t('timeline.upload.uploading') : t('timeline.upload.progress', { progress: Math.round(view.progress * 100) });
  if (view.state === 'failed') return view.reason === null ? t('timeline.upload.failed') : t(uploadFailureMessageKey(view.reason));
  return t(`timeline.upload.${view.state}`);
}

/**
 * What every upload placeholder of an open Timeline shows, by clip id, following this page's uploads, its write access
 * and the claims in awareness.
 * @param name - The document name.
 * @param uploads - The document's upload controller.
 * @param clips - The readable clips.
 * @returns The views of the upload clips.
 * @throws {never} Never.
 */
export function useTimelineUploadViews(name: string, uploads: TimelineUploads, clips: readonly TimelineClip[]): ReadonlyMap<string, TimelineUploadView> {
  const provider = useDocProvider(name);
  const version = React.useRef(0);
  const subscribe = React.useCallback((listener: () => void): (() => void) => {
    /** Count a change so the next read sees a new version, then tell React. */
    const changed = (): void => { version.current += 1; listener(); };
    const stop = uploads.subscribe(changed);
    provider?.awareness?.on('change', changed);
    provider?.on('authenticated', changed);
    provider?.on('authenticationFailed', changed);
    return () => {
      stop();
      provider?.awareness?.off('change', changed);
      provider?.off('authenticated', changed);
      provider?.off('authenticationFailed', changed);
    };
  }, [uploads, provider]);
  const read = React.useCallback((): number => version.current, []);
  const current = React.useSyncExternalStore(subscribe, read);
  return React.useMemo(() => {
    void current;
    const access = timelineUploadWriteAccess(name);
    const states = provider?.awareness?.getStates() as ReadonlyMap<number, Record<string, unknown>> | undefined;
    return new Map(clips.flatMap((clip) => clip.kind !== 'upload' ? [] : [[clip.id, timelineUploadView(uploads.entry(clip.upload.uploadId), access,
      states === undefined ? null : claimIn(states, clip.upload.uploadId))] as const]));
  }, [current, name, provider, uploads, clips]);
}
