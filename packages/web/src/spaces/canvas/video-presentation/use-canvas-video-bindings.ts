// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import * as React from 'react';
import { classifyVideoSourceLedgerFailure, type VideoPresentationResponse } from '@breatic/shared';
import { shownVersionOf, type VideoPresentationSource } from '@web/spaces/canvas/video-presentation/types';
import type { VideoPresentationTable } from '@breatic/shared/mini-tools';
import type { VideoToolPresentation } from '@web/spaces/canvas/mini-tool/video/VideoToolPanelContainer';
import type { MediaPlayerVideoSnapshot } from '@web/spaces/canvas/nodes/_shared/MediaPlayer';
import type { PresentedMediaFrame } from '@web/spaces/canvas/video-presentation/types';
import { playSourceRange } from '@web/spaces/canvas/video-presentation/play-source-range';

/** Optional authoritative table supplied by the source-frame owner. */
export interface CanonicalVideoFrameTable { sourceKey: string; table: VideoPresentationTable }
/** A panel is a projection of current source authority, never a second ledger. */
export type VideoToolPanelState = 'waiting-presentation' | 'waiting-table' | 'usable' | 'retryable' | 'unsupported';
/** Current response, bounded read and user press facts. */
export interface VideoToolPanelStateInput {
  sourceURL: string;
  presentationStatus: 'loading' | 'ready' | 'failed';
  response: VideoPresentationResponse | undefined;
  /** The version the surface currently shows, null without a ready resource (§7.12 step 3). */
  resourceVersionId: string | null;
  /** The compact table, keyed by the canonical URL and the toolInputId it was read for. */
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
 * A failure code's display state by the shared classification (§10.6): content is unsupported, everything else retryable.
 * @param code - The candidate's or the ledger's failure code.
 * @returns The state.
 * @throws {never} Never.
 */
function failedState(code: string): VideoToolPanelState {
  return classifyVideoSourceLedgerFailure(code) === 'content' ? 'unsupported' : 'retryable';
}

/**
 * Derive the panel's five states solely from current source authority, taking the first of design §7.12 steps 1–5
 * that holds: the response for this source, the selected version P or the target candidate, the version the surface
 * shows, P's ledger L and the compact table read for P's toolInputId.
 * @param input - Current node, response, validated table and press facts.
 * @returns The one display state for this source.
 * @throws {never} Never.
 */
export function deriveVideoToolPanelState(input: VideoToolPanelStateInput): VideoToolPanelState {
  const response = input.response;
  // Step 1: no current read for this source.
  if (input.presentationStatus !== 'ready' || response === undefined || response.sourceBinding.canonicalURL !== input.sourceURL) return 'waiting-presentation';
  const selected = response.presentation;
  // Step 2: nothing selected; the target candidate's failure decides, otherwise it is still being prepared.
  if (selected === null) {
    const failure = response.preparation?.failure ?? null;
    return failure === null || input.retrying ? 'waiting-presentation' : failedState(failure);
  }
  // Step 3: the surface does not show the selected version.
  if (input.resourceVersionId !== selected.versionId) return 'waiting-presentation';
  // Step 4: P's ledger, a retry press and the compact read.
  const ledger = response.ledger;
  if (input.retrying || ledger === null || ledger.state === 'pending') return 'waiting-table';
  if (ledger.state === 'failed') return failedState(ledger.failure);
  if (input.tableStatus === 'error') return 'retryable';
  // Step 5: the table read for P's toolInputId.
  return input.tableStatus === 'success' && input.table?.sourceKey === JSON.stringify([input.sourceURL, selected.toolInputId]) ? 'usable' : 'waiting-table';
}

/** One input's derived state, for a panel over several inputs. */
export interface RankedVideoToolPanelState { state: VideoToolPanelState }
const WORST_FIRST: readonly VideoToolPanelState[] = ['unsupported', 'retryable', 'waiting-presentation', 'waiting-table', 'usable'];

/**
 * The state of a multi-input panel (§7.12, last paragraph): each input is derived on its own and the worst, in the order
 * unsupported, retryable, waiting-presentation, waiting-table, usable, is shown with whatever the caller keeps beside it.
 * @param inputs - Each input's state, at least one, with whatever else the caller keeps beside it (its Retry).
 * @returns The worst input, the first of equally bad ones.
 * @throws {RangeError} When no input is given.
 */
export function worstVideoToolPanelState<T extends RankedVideoToolPanelState>(inputs: readonly T[]): T {
  if (inputs.length === 0) throw new RangeError('A panel has at least one input');
  return inputs.reduce((worst, input) => (WORST_FIRST.indexOf(input.state) < WORST_FIRST.indexOf(worst.state) ? input : worst));
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
      const live = binding;
      // The version the page shows is its runtime source key's third part (§3.3, §7.12 step 3).
      const resourceVersionId = snapshot?.status === 'ready' ? shownVersionOf(binding.sourceKey) : null;
      const panelState = facts === undefined ? undefined : deriveVideoToolPanelState({ sourceURL: canonicalURL, presentationStatus: snapshot?.status === 'failed' ? 'failed' : 'ready', response: facts.response, resourceVersionId, table: frameTable, tableStatus: facts.tableStatus, retrying: facts.retrying });
      presentations.set(hostId, { status: snapshot?.status === 'failed' ? 'failed' : 'ready', sourceURL: canonicalURL, sourceEpoch: binding.sourceEpoch, seekEpoch: binding.getSeekEpoch(), presentedTime: frame?.mediaTime ?? null, frameTable: frameTable !== null && panelState === 'usable' ? frameTable.table : null, getPresentedFrame: actualFrame, onSeek: binding.seek, onPlayRange: (start, end) => playSourceRange(live, start, end),
        ...(facts === undefined ? {} : { panelState, retrying: facts.retrying, onRetry: facts.onRetry, previewSource: facts.previewSource }),
        // A transparent source plays as an alpha-packed version (execution design §10.4 transparent source row).
        ...(facts?.response?.presentation ? { presentationRef: { source: { toolInputId: facts.response.presentation.toolInputId, planSha256: facts.response.presentation.planSha256 } },
          transparent: facts.response.presentation.playback.kind === 'alpha-packed',
          display: { width: facts.response.presentation.display.width, height: facts.response.presentation.display.height,
            duration: Number(facts.response.presentation.display.duration.numerator) / Number(facts.response.presentation.display.duration.denominator) } } : {}),
      });
    }
    return { bindings, presentations, onVideoBinding, onVideoFrame };
  }, [hostId, canonicalURL, snapshot, binding, frameTable, facts, onVideoBinding, onVideoFrame, revision]);
}
