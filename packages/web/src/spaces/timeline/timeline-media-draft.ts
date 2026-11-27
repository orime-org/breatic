// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import type * as Y from 'yjs';
import type { QueryClient } from '@tanstack/react-query';
import { durationToFrames, newId, TIMELINE_MAIN_TRACK_ID, type ProjectRegisteredAsset, type TimelineUploadClip } from '@breatic/shared';
import { TIMELINE_DEFAULT_PLACEMENT, type TimelineEditCommand, type TimelineEditPlacement, type TimelineEditPlan } from '@web/data/yjs/timeline-edit';

import { timelineApi } from '@web/data/api/timeline';
import { createDocScopedCache } from '@web/data/yjs/doc-scoped-cache';
import { docName } from '@web/data/yjs/manager';
import { checkAdd } from '@web/data/yjs/space-write';
import { readTimelineDocument } from '@web/data/yjs/timeline-document';
import type { TimelineEditOptions } from '@web/data/yjs/timeline-edit-session';
import { parseTimelineFrame } from '@web/data/yjs/timeline-time';
import { prepareTimelineMediaPlacement, timelineSourceName } from '@web/spaces/timeline/prepare-media-placement';
import type { TimelineUploadKind } from '@web/spaces/timeline/timeline-uploads';
import { useSpaceOperationsStore } from '@web/stores/space-operations';
import { gridDuration } from '@web/spaces/canvas/video-presentation/frame-grid-time';
import { videoPresentationQuery } from '@web/spaces/canvas/video-presentation/video-presentation-query';

/** The current material form held by an open document. */
export interface TimelineMediaDraftSnapshot {
  open: boolean;
  /** The kind of material being chosen: a video, a picture or a sound. */
  kind: TimelineUploadKind;
  mode: 'project' | 'local';
  selected: ProjectRegisteredAsset | null;
  file: File | null;
  startFrame: string;
  /** The captured target track, or 'new' for a track created with the clip. */
  trackId: string;
  busy: boolean;
  errorKey: string | null;
}

/** The Project resource context fixed for this document's material workflow. */
interface TimelineMediaDraftInputs {
  projectId: string;
  spaceId: string;
  /** The account query client: the Timeline limits a new picture's length comes from (inner#1709), and the presentation read that gives a selected video version's length. */
  queryClient: QueryClient;
  edit: (command: TimelineEditCommand, options?: TimelineEditOptions) => TimelineEditPlan;
  /** Hands a placed local file to the document's background uploads. */
  startUpload: (uploadId: string, file: File) => void;
}

/** The one writer of material selection and placement state. */
export interface TimelineMediaDraft {
  getSnapshot: () => TimelineMediaDraftSnapshot;
  subscribe: (notify: () => void) => () => void;
  open: (startFrame: number, trackId: string) => void;
  close: () => void;
  setCanWrite: (canWrite: boolean) => void;
  setKind: (kind: TimelineUploadKind) => void;
  setMode: (mode: 'project' | 'local') => void;
  select: (asset: ProjectRegisteredAsset) => void;
  setFile: (file: File | null) => void;
  setStartFrame: (frame: string) => void;
  setTrack: (trackId: string) => void;
  confirm: (placement: TimelineEditPlacement) => Promise<void>;
  dispose: () => void;
}

/**
 * Construct an empty material draft for a document.
 * @returns The closed initial state with no retained file.
 * @throws {never} Never.
 */
function initialSnapshot(): TimelineMediaDraftSnapshot {
  return { open: false, kind: 'video', mode: 'project', selected: null, file: null, startFrame: '0', trackId: TIMELINE_MAIN_TRACK_ID, busy: false, errorKey: null };
}

/**
 * Read a video's or sound's duration from its metadata: a registered one's missing duration, or a local file's.
 * @param fileUrl - The registered media URL, or a local file's object URL, to decode.
 * @param kind - Whether it is a video or a sound.
 * @param signal - The material attempt's cancellation.
 * @returns The finite positive duration reported by loadedmetadata.
 * @throws {Error} When the media cannot report a usable duration.
 * @throws {DOMException} When the material attempt is canceled.
 */
function decodeDuration(fileUrl: string, kind: 'video' | 'audio', signal: AbortSignal): Promise<number> {
  return new Promise((resolve, reject) => {
    const media = document.createElement(kind);
    /** Release this metadata request and its listeners together. */
    const clear = (): void => {
      media.removeEventListener('loadedmetadata', loaded);
      media.removeEventListener('error', failed);
      signal.removeEventListener('abort', canceled);
      media.removeAttribute('src');
      media.load();
    };
    /** Accept only the measured finite positive media duration. */
    const loaded = (): void => {
      const duration = media.duration;
      clear();
      if (Number.isFinite(duration) && duration > 0) resolve(duration);
      else reject(new Error('Media metadata has no usable duration'));
    };
    /** Settle the observer when this media request fails. */
    const failed = (): void => { clear(); reject(new Error('Media metadata is unavailable')); };
    /** End the metadata observer for a canceled material attempt. */
    const canceled = (): void => { clear(); reject(new DOMException('Material selection canceled', 'AbortError')); };
    media.addEventListener('loadedmetadata', loaded);
    media.addEventListener('error', failed);
    signal.addEventListener('abort', canceled, { once: true });
    if (signal.aborted) { canceled(); return; }
    media.preload = 'metadata';
    media.src = fileUrl;
    media.load();
  });
}

/**
 * A registered video's length as every surface plays it: the selected version's grid length (frames-split §7.8, §7.14 Tv),
 * which takes precedence over any registered duration.
 * @param queryClient - The account query client holding the presentation read.
 * @param projectId - The Project.
 * @param fileUrl - The registered original.
 * @param signal - The material attempt's cancellation.
 * @returns The grid length in seconds, or undefined while nothing is selected.
 * @throws {DOMException} When the material attempt is canceled.
 */
async function selectedGridDuration(queryClient: QueryClient, projectId: string, fileUrl: string, signal: AbortSignal): Promise<number | undefined> {
  // A read that failed leaves the registered or decoded original as the only length there is.
  const read = await queryClient.ensureQueryData(videoPresentationQuery({ projectId, canonicalURL: fileUrl, active: true })).catch(() => undefined);
  signal.throwIfAborted();
  const selected = read?.presentation ?? null;
  return selected === null ? undefined : gridDuration(selected.display);
}

/**
 * Bind material work to the existing document lifetime, including hidden views.
 * @param doc - The manager-owned Timeline content document.
 * @param inputs - Its fixed Project context and the hand-off to background uploads.
 * @returns Its single observable material state and explicit actions.
 * @throws {never} Never.
 */
function createTimelineMediaDraft(doc: Y.Doc, inputs: TimelineMediaDraftInputs): TimelineMediaDraft {
  let snapshot = initialSnapshot();
  let canWrite = false;
  let disposed = false;
  let active: { controller: AbortController; release: () => void; canApply: boolean } | null = null;
  const listeners = new Set<() => void>();
  /**
   * Publish one stable snapshot to the currently visible subscribers.
   * @param patch - The material facts changed by this action.
   * @throws {never} Never.
   */
  const publish = (patch: Partial<TimelineMediaDraftSnapshot>): void => {
    snapshot = { ...snapshot, ...patch };
    listeners.forEach((notify) => notify());
  };
  /** Cancel this document's current automatic placement and release its operation. */
  const cancel = (): void => {
    const held = active;
    active = null;
    held?.controller.abort();
    held?.release();
  };
  /** Close the current material form through an explicit user action. */
  const close = (): void => {
    cancel();
    publish(initialSnapshot());
  };
  return {
    /**
     * Read the immutable current snapshot for React's external-store contract.
     * @returns The current material form.
     * @throws {never} Never.
     */
    getSnapshot(): TimelineMediaDraftSnapshot { return snapshot; },
    /**
     * Subscribe only the UI; hidden views detach without ending material work.
     * @param notify - React's current snapshot-change listener.
     * @returns The UI subscription's release function.
     * @throws {never} Never.
     */
    subscribe(notify: () => void): () => void { listeners.add(notify); return () => listeners.delete(notify); },
    /**
     * Capture a new explicit material placement within this document.
     * @param startFrame - The fixed initial placement frame.
     * @param trackId - The fixed initial target track.
     * @throws {never} Never.
     */
    open(startFrame: number, trackId: string): void {
      if (disposed || !canWrite) return;
      cancel();
      publish({ ...initialSnapshot(), open: true, startFrame: String(startFrame), trackId });
    },
    close,
    /**
     * Read the same current role gate used by the existing Space body.
     * @param value - Whether the current Project role may edit.
     * @throws {never} Never.
     */
    setCanWrite(value: boolean): void {
      canWrite = value;
      if (!value && active !== null) active.canApply = false;
    },
    /**
     * Change the kind of material being chosen while no operation is running; what was chosen for another kind is dropped.
     * @param kind - A video, a picture or a sound.
     * @throws {never} Never.
     */
    setKind(kind: TimelineUploadKind): void { if (!snapshot.busy && kind !== snapshot.kind) publish({ kind, selected: null, file: null, errorKey: null }); },
    /**
     * Change the form's explicit material entry while no operation is running.
     * @param mode - The selected Project-material or local-upload entry.
     * @throws {never} Never.
     */
    setMode(mode: 'project' | 'local'): void { if (!snapshot.busy) publish({ mode, errorKey: null }); },
    /**
     * Retain the Project material selected for explicit confirmation.
     * @param selected - Its currently displayed registered metadata.
     * @throws {never} Never.
     */
    select(selected: ProjectRegisteredAsset): void { if (!snapshot.busy) publish({ selected, errorKey: null }); },
    /**
     * Retain the chosen File until it is confirmed.
     * @param file - The selected local file, or null to clear it.
     * @throws {never} Never.
     */
    setFile(file: File | null): void { if (!snapshot.busy) publish({ file, errorKey: null }); },
    /**
     * Change the next confirmed placement's integer-frame target.
     * @param startFrame - The current frame input, validated on confirmation.
     * @throws {never} Never.
     */
    setStartFrame(startFrame: string): void { if (!snapshot.busy) publish({ startFrame, errorKey: null }); },
    /**
     * Change the next confirmed placement's target track.
     * @param trackId - A track id, or 'new' for a new track.
     * @throws {never} Never.
     */
    setTrack(trackId: string): void { if (!snapshot.busy) publish({ trackId, errorKey: null }); },
    /**
     * Confirm the current fixed target: place Project material atomically, or place a local file as an upload
     * placeholder of its kind and hand it to the background uploads (inner#1709).
     * @param placement - The editing user's magnet and linkage switches at confirmation.
     * @returns Once the attempt settles.
     */
    async confirm(placement: TimelineEditPlacement): Promise<void> {
      if (disposed || !snapshot.open || active !== null) return;
      if (!canWrite) { publish({ errorKey: 'readonly' }); return; }
      const captured = snapshot;
      const startFrame = parseTimelineFrame(captured.startFrame);
      if (!Number.isSafeInteger(startFrame)) { publish({ errorKey: 'invalid_range' }); return; }
      if ((captured.mode === 'project' && captured.selected === null) || (captured.mode === 'local' && captured.file === null)) { publish({ errorKey: 'source_unavailable' }); return; }
      // The material is written into the Space only after the server answers, so a full Space asks nothing and the
      // dialog says why (inner#1790); a Space being rebuilt says nothing, its own toast did.
      const room = checkAdd(docName.timelineSpace(inputs.projectId, inputs.spaceId), { notify: false });
      if (!room.ok) { publish({ errorKey: room.reason === 'resyncing' ? null : room.reason }); return; }
      const operationId = newId();
      const operations = useSpaceOperationsStore.getState();
      let released = false;
      /** Release precisely this registration after cancellation or settlement. */
      const release = (): void => { if (!released) { released = true; operations.unregister(inputs.spaceId, operationId); } };
      const controller = new AbortController();
      const attempt = { controller, release, canApply: true };
      active = attempt;
      operations.register(inputs.spaceId, operationId);
      publish({ busy: true, errorKey: null });
      const clipId = newId();
      const target = captured.trackId === 'new' ? { trackId: TIMELINE_MAIN_TRACK_ID, newTrackId: newId() } : { trackId: captured.trackId };
      let failure = 'source_unavailable';
      try {
        // A new picture's length is configured (inner#1709), read through the page's limits query.
        const imageDurationSeconds = captured.kind === 'image'
          ? (await inputs.queryClient.fetchQuery({ queryKey: ['timeline-limits', inputs.projectId], queryFn: ({ signal }) => timelineApi.limits(inputs.projectId, signal), staleTime: Infinity })).media.imageDurationSeconds
          : undefined;
        if (active !== attempt) return;
        // What the confirmed material is: a local file with the duration its metadata reports (none for a picture),
        // or Project material.
        let material: { kind: 'local'; file: File; durationSeconds: number | null }
          | { kind: 'project'; asset: ProjectRegisteredAsset; presentedDurationSeconds: number | undefined; decodedDurationSeconds: number | undefined };
        if (captured.mode === 'local' && captured.file !== null) {
          const file = captured.file;
          failure = 'metadata_unavailable';
          const kind = captured.kind;
          if (kind === 'image') {
            material = { kind: 'local', file, durationSeconds: null };
          } else {
            const url = URL.createObjectURL(file);
            try {
              material = { kind: 'local', file, durationSeconds: await decodeDuration(url, kind, controller.signal) };
            } finally {
              URL.revokeObjectURL(url);
            }
          }
        } else {
          // The picked list item already carries the address and media facts the source stores (inner#2171 design §4).
          const asset = captured.selected;
          if (asset === null) { publish({ errorKey: 'source_unavailable' }); return; }
          failure = 'metadata_unavailable';
          const timed = asset.kind === 'video' || asset.kind === 'audio' ? asset.kind : null;
          // A video's selected version's grid length first; the registered duration, then decoding, only while nothing is selected.
          const presentedDurationSeconds = asset.kind === 'video' ? await selectedGridDuration(inputs.queryClient, inputs.projectId, asset.fileUrl, controller.signal) : undefined;
          const decodedDurationSeconds = presentedDurationSeconds === undefined && asset.durationSeconds === null && timed !== null
            ? await decodeDuration(asset.fileUrl, timed, controller.signal) : undefined;
          material = { kind: 'project', asset, presentedDurationSeconds, decodedDurationSeconds };
        }
        if (active !== attempt || controller.signal.aborted) return;
        if (!attempt.canApply) { publish({ errorKey: 'permission_changed' }); return; }
        failure = 'target_missing';
        if (doc.isDestroyed) { publish({ errorKey: failure }); return; }
        let command: TimelineEditCommand;
        let upload: { uploadId: string; file: File } | null = null;
        if (material.kind === 'local') {
          // A local file is placed at once and uploads in the background (#1434 design §3.2); a picture placeholder
          // has no duration and lasts the configured picture length.
          failure = 'invalid_range';
          const { file, durationSeconds } = material;
          upload = { uploadId: newId(), file };
          const kind = captured.kind;
          const clip: TimelineUploadClip = {
            id: clipId, kind: 'upload', trackId: target.trackId, upload: { uploadId: upload.uploadId, name: timelineSourceName(file.name, kind), kind, durationSeconds },
            startFrame, sourceInFrame: 0, durationFrames: durationToFrames(durationSeconds ?? imageDurationSeconds ?? 0, readTimelineDocument(doc).settings.fps),
            ...TIMELINE_DEFAULT_PLACEMENT,
          };
          command = { operation: 'add_upload', parameters: { clip, ...(target.newTrackId === undefined ? {} : { newTrackId: target.newTrackId }) }, placement };
        } else {
          const { asset, presentedDurationSeconds, decodedDurationSeconds } = material;
          const prepared = prepareTimelineMediaPlacement(doc, {
            asset, startFrame, clipId, sourceId: newId(), canWrite, placement, ...target,
            ...(presentedDurationSeconds === undefined ? {} : { presentedDurationSeconds }),
            ...(decodedDurationSeconds === undefined ? {} : { decodedDurationSeconds }),
            ...(imageDurationSeconds === undefined ? {} : { imageDurationSeconds }),
          });
          if (!prepared.ok) { publish({ errorKey: prepared.reason }); return; }
          command = prepared.command;
        }
        // The dialog shows a size refusal itself.
        const applied = inputs.edit(command, { notify: false });
        if (!applied.ok) { publish({ errorKey: applied.reason === 'resyncing' ? null : applied.reason }); return; }
        if (upload !== null) inputs.startUpload(upload.uploadId, upload.file);
        close();
      } catch {
        if (active === attempt && !controller.signal.aborted) publish({ errorKey: failure });
      } finally {
        release();
        if (active === attempt) { active = null; publish({ busy: false }); }
      }
    },
    /** Cancel the current attempt and drop the retained File when the document ends. */
    dispose(): void {
      if (disposed) return;
      disposed = true;
      cancel();
      publish(initialSnapshot());
      listeners.clear();
    },
  };
}

const cache = createDocScopedCache<TimelineMediaDraft, TimelineMediaDraftInputs>(createTimelineMediaDraft, (draft) => draft.dispose());

/**
 * Retrieve material state for the same document held by the existing Space tab.
 * @param doc - The actual manager-owned content document.
 * @param name - Its existing Space document name.
 * @param inputs - Its fixed resource and Project context.
 * @returns The document's memory-only material workflow.
 * @throws {never} Never.
 */
export function getTimelineMediaDraft(doc: Y.Doc, name: string, inputs: TimelineMediaDraftInputs): TimelineMediaDraft {
  return cache.get(doc, name, inputs);
}
