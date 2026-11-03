// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import * as React from 'react';
import { classifyVideoSourceLedgerFailure, type VideoPresentationResponse } from '@breatic/shared';
import type { VideoPresentationSource } from '@web/spaces/canvas/video-presentation/types';
import type { VideoPresentationTable } from '@breatic/shared/mini-tools';
import type { VideoToolPresentation } from '@web/spaces/canvas/mini-tool/video/VideoToolPanelContainer';
import type { MediaPlayerVideoSnapshot } from '@web/spaces/canvas/nodes/_shared/MediaPlayer';
import type { PresentedMediaFrame } from '@web/spaces/canvas/video-presentation/types';

/** Optional authoritative table supplied by the source-frame owner. */
export interface CanonicalVideoFrameTable { sourceKey: string; table: VideoPresentationTable }
/** A panel is a projection of current source authority, never a second ledger. */
export type VideoToolPanelState = 'waiting-presentation' | 'waiting-table' | 'usable' | 'retryable' | 'unsupported';
/** Current response, bounded read and user press facts. */
export interface VideoToolPanelStateInput {
  sourceURL: string;
  presentationStatus: 'loading' | 'ready' | 'failed';
  response: VideoPresentationResponse | undefined;
  table: CanonicalVideoFrameTable | null;
  tableStatus: 'pending' | 'success' | 'error';
  retrying: boolean;
}
/** Current authorized source facts passed by the Canvas query owner. */
export interface CanvasVideoSourceFacts {
  response: VideoPresentationResponse | undefined;
  tableStatus: VideoToolPanelStateInput['tableStatus'];
  retrying: boolean;
  onRetry: () => void;
  previewSource: VideoPresentationSource | null;
}

/**
 * Derive the panel's five states solely from current source authority.
 * @param input - Current node, response, validated table and press facts.
 * @returns The one display state for this source.
 * @throws {never} Never.
 */
export function deriveVideoToolPanelState(input: VideoToolPanelStateInput): VideoToolPanelState {
  const binding = input.response?.sourceBinding;
  const descriptor = input.response?.presentation;
  if (input.presentationStatus !== 'ready' || binding?.canonicalURL !== input.sourceURL ||
    descriptor?.sourceFingerprint !== binding.contentHash || (descriptor.state !== 'native' && descriptor.state !== 'alpha_ready')) return 'waiting-presentation';
  if (input.retrying) return 'waiting-table';
  const ledger = input.response?.sourceLedger;
  if (ledger?.state === 'failed' && ledger.sourceFingerprint === binding.contentHash) return classifyVideoSourceLedgerFailure(ledger.errorCode) === 'content' ? 'unsupported' : 'retryable';
  if (ledger?.state !== 'ready' || ledger.receipt.schemaVersion !== 2 || ledger.receipt.sourceFingerprint !== binding.contentHash) return 'waiting-table';
  if (input.tableStatus === 'error') return 'retryable';
  return input.tableStatus === 'success' && input.table?.sourceKey === JSON.stringify([binding.canonicalURL, binding.contentHash]) ? 'usable' : 'waiting-table';
}

/** Existing node notifications and the active tool's current runtime attachment. */
export interface CanvasVideoBindings {
  bindings: ReadonlyMap<string, MediaPlayerVideoSnapshot>;
  presentations: ReadonlyMap<string, VideoToolPresentation>;
  onVideoBinding: (nodeId: string, canonicalURL: string, snapshot: MediaPlayerVideoSnapshot) => void;
  onVideoFrame: (nodeId: string, canonicalURL: string, frame: PresentedMediaFrame) => void;
}

/**
 * Shares actual node attachments with the current panel without another cache or provider.
 * @param hostId - The current mini-tool host, if any.
 * @param canonicalURL - Its persisted canonical content URL.
 * @param frameTable - The independently resolved authoritative source table, otherwise null.
 * @param facts - The current authorized compact query and retry operation.
 * @returns Current node ownership and direct, epoch-checked Current frame access.
 * @throws {never} Never.
 */
export function useCanvasVideoBindings(hostId: string | null, canonicalURL: string | null, frameTable: CanonicalVideoFrameTable | null = null, facts?: CanvasVideoSourceFacts): CanvasVideoBindings {
  const records = React.useRef(new Map<string, { url: string; snapshot: MediaPlayerVideoSnapshot }>());
  const current = React.useRef({ hostId, canonicalURL });
  current.current = { hostId, canonicalURL };
  const published = React.useRef('');
  const [revision, setRevision] = React.useState(0);
  /**
   * Publishes an attachment edge or explicit native pause/seek fact, without a timer.
   * @throws {never} Never.
   */
  const refresh = React.useCallback((): void => setRevision((value) => value + 1), []);
  /**
   * Replaces or releases only this node's current canonical attachment.
   * @param nodeId - The node owner.
   * @param url - Its canonical content at this resource's creation.
   * @param snapshot - Effect-owned state and independent overlay target.
   * @throws {never} Never.
   */
  const onVideoBinding = React.useCallback((nodeId: string, url: string, snapshot: MediaPlayerVideoSnapshot): void => {
    if (snapshot.status === 'detached') {
      if (records.current.get(nodeId)?.url === url) records.current.delete(nodeId);
    } else records.current.set(nodeId, { url, snapshot });
    if (current.current.hostId === nodeId) { published.current = ''; refresh(); }
  }, [refresh]);
  /**
   * Consumes the actual draw clock synchronously and publishes only availability/epoch edges.
   * @param nodeId - The node that drew this frame.
   * @param url - Its canonical content.
   * @param frame - The just-committed actual frame, never inferred from native time.
   * @throws {never} Never.
   */
  const onVideoFrame = React.useCallback((nodeId: string, url: string, frame: PresentedMediaFrame): void => {
    if (current.current.hostId !== nodeId || current.current.canonicalURL !== url) return;
    const binding = records.current.get(nodeId)?.snapshot.binding;
    if (!binding || frame.sourceKey !== binding.sourceKey || frame.sourceEpoch !== binding.sourceEpoch || frame.seekEpoch !== binding.getSeekEpoch()) return;
    const key = JSON.stringify([nodeId, frame.sourceKey, frame.sourceEpoch, frame.seekEpoch, binding.element.paused ? frame.mediaTime : 'playing']);
    if (published.current !== key) { published.current = key; refresh(); }
  }, [refresh]);
  const active = hostId === null ? undefined : records.current.get(hostId);
  const snapshot = active?.url === canonicalURL ? active.snapshot : undefined;
  const binding = snapshot?.binding ?? null;
  React.useEffect(() => {
    if (!binding) return undefined;
    const events = ['pause', 'seeking'];
    for (const event of events) binding.element.addEventListener(event, refresh);
    return () => { for (const event of events) binding.element.removeEventListener(event, refresh); };
  }, [binding, refresh]);
  React.useEffect(() => {
    const owned = records.current;
    return () => { owned.clear(); published.current = ''; };
  }, []);
  return React.useMemo(() => {
    void revision;
    const bindings = new Map<string, MediaPlayerVideoSnapshot>();
    const presentations = new Map<string, VideoToolPresentation>();
    if (hostId !== null && snapshot) bindings.set(hostId, snapshot);
    if (hostId !== null && binding && canonicalURL !== null) {
      /**
       * Reads the actual current frame after every source or seek invalidation.
       * @returns A currently drawable frame or explicit unknown.
       * @throws {never} Never.
       */
      function actualFrame(): PresentedMediaFrame | null {
        const frame = binding!.getPresentedFrame();
        return frame && frame.sourceKey === binding!.sourceKey && frame.sourceEpoch === binding!.sourceEpoch && frame.seekEpoch === binding!.getSeekEpoch() ? frame : null;
      }
      const frame = actualFrame();
      const panelState = facts === undefined ? undefined : deriveVideoToolPanelState({ sourceURL: canonicalURL, presentationStatus: snapshot?.status === 'failed' ? 'failed' : 'ready', response: facts.response, table: frameTable?.sourceKey === binding.sourceKey ? frameTable : null, tableStatus: facts.tableStatus, retrying: facts.retrying });
      presentations.set(hostId, { status: snapshot?.status === 'failed' ? 'failed' : 'ready', sourceURL: canonicalURL, sourceEpoch: binding.sourceEpoch, seekEpoch: binding.getSeekEpoch(), presentedTime: frame?.mediaTime ?? null, frameTable: frameTable?.sourceKey === binding.sourceKey && (panelState === undefined || panelState === 'usable') ? frameTable.table : null, getPresentedFrame: actualFrame, onSeek: binding.seek,
        ...(facts === undefined ? {} : { panelState, retrying: facts.retrying, onRetry: facts.onRetry, previewSource: facts.previewSource }),
      });
    }
    return { bindings, presentations, onVideoBinding, onVideoFrame };
  }, [hostId, canonicalURL, snapshot, binding, frameTable, facts, onVideoBinding, onVideoFrame, revision]);
}
