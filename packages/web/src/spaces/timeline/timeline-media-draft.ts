// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import type * as Y from 'yjs';
import type { QueryClient } from '@tanstack/react-query';
import { newId, type ProjectRegisteredAsset, type TimelineEditCommand } from '@breatic/shared';
import { applyTimelineEdit } from '@breatic/shared/space-content';

import { timelineApi } from '@web/data/api/timeline';
import { uploadMedia } from '@web/data/upload/media-upload';
import { createDocScopedCache } from '@web/data/yjs/doc-scoped-cache';
import { estimateNodeBytes, reserveSpaceRoom, writeSpaceDoc, type SpaceRefusal } from '@web/data/yjs/space-write';
import { prepareTimelineMediaPlacement } from '@web/spaces/timeline/prepare-media-placement';
import { useSpaceOperationsStore } from '@web/stores/space-operations';

/** The current material form and upload facts held by an open document. */
export interface TimelineMediaDraftSnapshot {
  open: boolean;
  mode: 'project' | 'local';
  selected: ProjectRegisteredAsset | null;
  file: File | null;
  registeredAssetId: string | null;
  startFrame: string;
  busy: boolean;
  progress: number | null;
  errorKey: string | null;
  /** Why the Space's size refused the placement; shown when there is no `errorKey`. */
  refusal: SpaceRefusal | null;
}

/** The Project resource context fixed for this document's material workflow. */
interface TimelineMediaDraftInputs { projectId: string; spaceId: string; queryClient: QueryClient }

/** The one writer of material selection, upload and acceptance state. */
export interface TimelineMediaDraft {
  getSnapshot: () => TimelineMediaDraftSnapshot;
  subscribe: (notify: () => void) => () => void;
  open: (startFrame: number) => void;
  close: () => void;
  setCanWrite: (canWrite: boolean) => void;
  setMode: (mode: 'project' | 'local') => void;
  select: (asset: ProjectRegisteredAsset) => void;
  setFile: (file: File | null) => void;
  setStartFrame: (frame: string) => void;
  confirm: () => Promise<void>;
  dispose: () => void;
}

/**
 * Construct an empty material draft for a document.
 * @returns The closed initial state with no retained file.
 * @throws {never} Never.
 */
function initialSnapshot(): TimelineMediaDraftSnapshot {
  return { open: false, mode: 'project', selected: null, file: null, registeredAssetId: null, startFrame: '0', busy: false, progress: null, errorKey: null, refusal: null };
}

/**
 * What adding one video can grow the Timeline by: its source and clip records.
 * @param parameters - The two records as they are written.
 * @param parameters.source - The source record.
 * @param parameters.clip - The clip record.
 * @returns Bytes.
 * @throws {never} Never.
 */
function placementBytes(parameters: { source: unknown; clip: unknown }): number {
  return estimateNodeBytes(parameters.source) + estimateNodeBytes(parameters.clip);
}

/**
 * The estimate reserved before the asset is known: the records' shape with
 * the widest values a registered or decoded video gives them.
 * @param clipId - The new clip's id.
 * @param sourceId - The new source's id.
 * @returns Bytes.
 * @throws {never} Never.
 */
function reservedPlacementBytes(clipId: string, sourceId: string): number {
  const frames = Number.MAX_SAFE_INTEGER;
  return placementBytes({
    source: { id: sourceId, kind: 'video', assetId: sourceId, timebase: { num: frames, den: frames }, extentFrames: frames, durationSeconds: String(Number.MAX_VALUE), durationOrigin: 'registered' },
    clip: {
      id: clipId, kind: 'video', trackId: 'visual-1', sourceId, startFrame: frames, sourceInFrame: 0, durationFrames: frames,
      rate: { num: 1, den: 1 }, gain: 1, mute: false, transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 },
    },
  });
}

/**
 * The records an `add_video` command writes.
 * @param command - The prepared command.
 * @returns Its estimate in bytes.
 * @throws {never} Never.
 */
function commandBytes(command: TimelineEditCommand): number {
  return command.operation === 'add_video' ? placementBytes(command.parameters) : 0;
}

/**
 * Read a missing registered duration from the current authorized video.
 * @param fileUrl - The registered media URL to decode.
 * @param signal - The material attempt's cancellation.
 * @returns The finite positive duration reported by loadedmetadata.
 * @throws {Error} When the media cannot report a usable duration.
 * @throws {DOMException} When the material attempt is canceled.
 */
function decodeDuration(fileUrl: string, signal: AbortSignal): Promise<number> {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video');
    /** Release this metadata request and its listeners together. */
    const clear = (): void => {
      video.removeEventListener('loadedmetadata', loaded);
      video.removeEventListener('error', failed);
      signal.removeEventListener('abort', canceled);
      video.removeAttribute('src');
      video.load();
    };
    /** Accept only the measured finite positive video duration. */
    const loaded = (): void => {
      const duration = video.duration;
      clear();
      if (Number.isFinite(duration) && duration > 0) resolve(duration);
      else reject(new Error('Video metadata has no usable duration'));
    };
    /** Settle the observer when this media request fails. */
    const failed = (): void => { clear(); reject(new Error('Video metadata is unavailable')); };
    /** End the metadata observer for a canceled material attempt. */
    const canceled = (): void => { clear(); reject(new DOMException('Material selection canceled', 'AbortError')); };
    video.addEventListener('loadedmetadata', loaded);
    video.addEventListener('error', failed);
    signal.addEventListener('abort', canceled, { once: true });
    if (signal.aborted) { canceled(); return; }
    video.preload = 'metadata';
    video.src = fileUrl;
    video.load();
  });
}

/**
 * Bind material work to the existing document lifetime, including hidden views.
 * @param doc - The manager-owned Timeline content document.
 * @param name - Its canonical document name, whose size gates the write.
 * @param inputs - Its fixed Project and upload context.
 * @returns Its single observable material state and explicit actions.
 * @throws {never} Never.
 */
function createTimelineMediaDraft(doc: Y.Doc, name: string, inputs: TimelineMediaDraftInputs): TimelineMediaDraft {
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
    // A new error replaces a size refusal unless it is one.
    snapshot = { ...snapshot, ...('errorKey' in patch && !('refusal' in patch) && { refusal: null }), ...patch };
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
     * @returns The current material form and upload facts.
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
     * @throws {never} Never.
     */
    open(startFrame: number): void {
      if (disposed || !canWrite) return;
      cancel();
      publish({ ...initialSnapshot(), open: true, startFrame: String(startFrame) });
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
     * Change the form's explicit material entry while no operation is running.
     * @param mode - The selected Project-video or local-upload entry.
     * @throws {never} Never.
     */
    setMode(mode: 'project' | 'local'): void { if (!snapshot.busy) publish({ mode, errorKey: null }); },
    /**
     * Retain the Project video selected for explicit confirmation.
     * @param selected - Its currently displayed registered metadata.
     * @throws {never} Never.
     */
    select(selected: ProjectRegisteredAsset): void { if (!snapshot.busy) publish({ selected, errorKey: null }); },
    /**
     * Retain the chosen File for retries within this open document.
     * @param file - The selected local video, or null to clear it.
     * @throws {never} Never.
     */
    setFile(file: File | null): void { if (!snapshot.busy) publish({ file, registeredAssetId: null, errorKey: null }); },
    /**
     * Change the next confirmed placement's integer-frame target.
     * @param startFrame - The current frame input, validated on confirmation.
     * @throws {never} Never.
     */
    setStartFrame(startFrame: string): void { if (!snapshot.busy) publish({ startFrame, errorKey: null }); },
    /** Confirm the current fixed target and apply its registered video atomically. */
    async confirm(): Promise<void> {
      if (disposed || !snapshot.open || active !== null) return;
      if (!canWrite) { publish({ errorKey: 'readonly' }); return; }
      const captured = snapshot;
      const startFrame = Number(captured.startFrame);
      if (captured.startFrame.trim() === '' || !Number.isSafeInteger(startFrame) || startFrame < 0) { publish({ errorKey: 'invalid_range' }); return; }
      if ((captured.mode === 'project' && captured.selected === null) || (captured.mode === 'local' && captured.file === null)) { publish({ errorKey: 'source_unavailable' }); return; }
      const clipId = newId();
      const sourceId = newId();
      // Room is held before the upload or the asset lookup, and released on every way out but a write.
      const reserved = reserveSpaceRoom(name, reservedPlacementBytes(clipId, sourceId), { notify: false });
      if (!reserved.ok) { publish({ errorKey: null, refusal: reserved }); return; }
      const operationId = newId();
      const operations = useSpaceOperationsStore.getState();
      let released = false;
      /** Release precisely this registration after cancellation or settlement. */
      const release = (): void => { if (!released) { released = true; operations.unregister(inputs.spaceId, operationId); } };
      const controller = new AbortController();
      const attempt = { controller, release, canApply: true };
      active = attempt;
      operations.register(inputs.spaceId, operationId);
      publish({ busy: true, errorKey: null, refusal: null });
      let failure = 'source_unavailable';
      try {
        let assetId = captured.mode === 'project' ? captured.selected?.assetId : captured.registeredAssetId;
        if (captured.mode === 'local' && assetId === null && captured.file !== null) {
          failure = 'upload';
          const stored = await uploadMedia(captured.file, { projectId: inputs.projectId, spaceId: inputs.spaceId }, (fraction) => {
            if (active === attempt) publish({ progress: Math.round(fraction * 100) });
          });
          void inputs.queryClient.invalidateQueries({ queryKey: ['timeline-videos', inputs.projectId] });
          if (active !== attempt) return;
          assetId = stored.assetId;
          publish({ registeredAssetId: stored.assetId });
        }
        if (active !== attempt) return;
        if (assetId === null || assetId === undefined) { publish({ errorKey: 'source_unavailable' }); return; }
        failure = 'source_unavailable';
        const asset = await inputs.queryClient.fetchQuery({ queryKey: ['timeline-asset', inputs.projectId, assetId], queryFn: ({ signal }) => timelineApi.resolveAsset(inputs.projectId, assetId, signal), staleTime: 0 });
        if (active !== attempt) return;
        failure = 'metadata_unavailable';
        const decodedDurationSeconds = asset.durationSeconds === null ? await decodeDuration(asset.fileUrl, controller.signal) : undefined;
        if (active !== attempt || controller.signal.aborted) return;
        if (!attempt.canApply) { publish({ errorKey: 'permission_changed' }); return; }
        failure = 'target_missing';
        if (doc.isDestroyed) { publish({ errorKey: failure }); return; }
        const prepared = prepareTimelineMediaPlacement(doc, { asset, trackId: 'visual-1', startFrame, clipId, sourceId, canWrite, ...(decodedDurationSeconds === undefined ? {} : { decodedDurationSeconds }) });
        if (!prepared.ok) { publish({ errorKey: prepared.reason }); return; }
        if (!canWrite) { publish({ errorKey: 'readonly' }); return; }
        let applied = false;
        const written = writeSpaceDoc(name, { kind: 'add', estimate: commandBytes(prepared.command), reservation: reserved.reservation, notify: false }, () => {
          applied = applyTimelineEdit(doc, prepared.command);
        });
        if (!written.ok) { publish({ errorKey: null, refusal: written }); return; }
        if (!applied) { publish({ errorKey: 'target_missing' }); return; }
        close();
      } catch {
        if (active === attempt && !controller.signal.aborted) publish({ errorKey: failure });
      } finally {
        // No effect once the write carried it: the push that counts the write releases it.
        reserved.reservation.release();
        release();
        if (active === attempt) { active = null; publish({ busy: false, progress: null }); }
      }
    },
    /** Drop retained Files, observers and upload write-back when the document ends. */
    dispose(): void {
      if (disposed) return;
      disposed = true;
      cancel();
      publish(initialSnapshot());
      listeners.clear();
    },
  };
}

const cache = createDocScopedCache<TimelineMediaDraft, TimelineMediaDraftInputs & { name: string }>(
  (doc, { name, ...inputs }) => createTimelineMediaDraft(doc, name, inputs),
  (draft) => draft.dispose(),
);

/**
 * Retrieve material state for the same document held by the existing Space tab.
 * @param doc - The actual manager-owned content document.
 * @param name - Its existing Space document name.
 * @param inputs - Its fixed resource and Project context.
 * @returns The document's memory-only material workflow.
 * @throws {never} Never.
 */
export function getTimelineMediaDraft(doc: Y.Doc, name: string, inputs: TimelineMediaDraftInputs): TimelineMediaDraft {
  return cache.get(doc, name, { ...inputs, name });
}
