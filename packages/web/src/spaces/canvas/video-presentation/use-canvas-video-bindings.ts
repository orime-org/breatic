// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import * as React from 'react';
import { classifyVideoSourceLedgerFailure, type VideoPresentationResponse } from '@breatic/shared';
import { shownVersionOf, type VideoPresentationSource } from '@web/spaces/canvas/video-presentation/types';
import type { VideoToolPresentation } from '@web/spaces/canvas/mini-tool/video/VideoToolPanelContainer';
import type { MediaPlayerVideoSnapshot } from '@web/spaces/canvas/nodes/_shared/MediaPlayer';
import type { PresentedMediaFrame } from '@web/spaces/canvas/video-presentation/types';
import { playSourceRange } from '@web/spaces/canvas/video-presentation/play-source-range';
import { gridDuration } from '@web/spaces/canvas/video-presentation/frame-grid-time';

/** A panel is a projection of current source authority, never a second copy of P (frames-split §7.12). */
export type VideoToolPanelState = 'waiting-presentation' | 'usable' | 'retryable' | 'unsupported';
/** Current response, the shown resource and user press facts. */
export interface VideoToolPanelStateInput {
  sourceURL: string;
  presentationStatus: 'loading' | 'ready' | 'failed';
  response: VideoPresentationResponse | undefined;
  /** The version the surface currently shows, null without a ready resource (§7.12 step 3). */
  resourceVersionId: string | null;
  /** The toolInputId of the binding the surface plays, null when unknown (§7.12 step 4). */
  toolInputId: string | null;
  retrying: boolean;
}
/** Current authorized source facts passed by the Canvas query owner. */
export interface CanvasVideoSourceFacts {
  response: VideoPresentationResponse | undefined;
  retrying: boolean;
  onRetry: () => void;
  previewSource: VideoPresentationSource | null;
}

/**
 * A failure code's display state by the shared classification (§10.6): content is unsupported, everything else retryable.
 * @param code - The candidate's failure code.
 * @returns The state.
 * @throws {never} Never.
 */
function failedState(code: string): VideoToolPanelState {
  return classifyVideoSourceLedgerFailure(code) === 'content' ? 'unsupported' : 'retryable';
}

/**
 * Derive the panel's four states from current source authority, taking the first of design §7.12 steps 1–4 that holds: the
 * response for this source, the selected version P or the target candidate, the version the surface shows and the binding's
 * toolInputId. There is no frame table: P carries its grid.
 * @param input - Current node, response and press facts.
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
  // Step 4: the binding names P's tool input; a target preparation beside P changes nothing.
  return input.toolInputId === selected.toolInputId ? 'usable' : 'waiting-presentation';
}

/** One input's derived state, for a panel over several inputs. */
export interface RankedVideoToolPanelState { state: VideoToolPanelState }
const WORST_FIRST: readonly VideoToolPanelState[] = ['unsupported', 'retryable', 'waiting-presentation', 'usable'];

/**
 * The state of a multi-input panel (§7.12, last paragraph): each input is derived on its own and the worst, in the order
 * unsupported, retryable, waiting-presentation, usable, is shown with whatever the caller keeps beside it.
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
 * @param facts - The current authorized presentation read and retry operation.
 * @returns Current node ownership and direct, epoch-checked Current frame access.
 * @throws {never} Never.
 */
export function useCanvasVideoBindings(hostId: string | null, canonicalURL: string | null, facts?: CanvasVideoSourceFacts): CanvasVideoBindings {
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
      const selected = facts?.response?.sourceBinding.canonicalURL === canonicalURL ? facts.response.presentation : null;
      const panelState = facts === undefined ? undefined : deriveVideoToolPanelState({ sourceURL: canonicalURL, presentationStatus: snapshot?.status === 'failed' ? 'failed' : 'ready', response: facts.response, resourceVersionId,
        toolInputId: resourceVersionId !== null && resourceVersionId === selected?.versionId ? selected.toolInputId : null, retrying: facts.retrying });
      presentations.set(hostId, { status: snapshot?.status === 'failed' ? 'failed' : 'ready', sourceURL: canonicalURL, sourceEpoch: binding.sourceEpoch, seekEpoch: binding.getSeekEpoch(), presentedTime: frame?.mediaTime ?? null, grid: selected !== null && panelState === 'usable' ? { fps: selected.display.fps, frameCount: selected.display.frameCount } : null, getPresentedFrame: actualFrame, onSeek: binding.seek, onPlayRange: (start, end) => playSourceRange(live, start, end),
        ...(facts === undefined ? {} : { panelState, failure: facts.response?.presentation === null ? facts.response.preparation?.failure ?? null : null, retrying: facts.retrying, onRetry: facts.onRetry, previewSource: facts.previewSource }),
        ...(selected ? { presentationRef: { source: { toolInputId: selected.toolInputId, planSha256: selected.planSha256 } },
          display: { width: selected.display.width, height: selected.display.height, duration: gridDuration(selected.display) } } : {}),
      });
    } else if (hostId !== null && canonicalURL !== null && facts !== undefined) {
      // No surface shows a selected version yet (the node plays the original for display, §7.8): the panel still shows
      // why it waits, or the candidate's failure and its Retry (§7.12 steps 1–3).
      const panelState = deriveVideoToolPanelState({ sourceURL: canonicalURL, presentationStatus: 'ready', response: facts.response, resourceVersionId: null, toolInputId: null, retrying: facts.retrying });
      presentations.set(hostId, { status: 'loading', sourceURL: canonicalURL, sourceEpoch: 0, seekEpoch: 0, presentedTime: null, grid: null, getPresentedFrame: () => null,
        panelState, failure: facts.response?.presentation === null ? facts.response.preparation?.failure ?? null : null, retrying: facts.retrying, onRetry: facts.onRetry, previewSource: facts.previewSource });
    }
    return { bindings, presentations, onVideoBinding, onVideoFrame };
  }, [hostId, canonicalURL, snapshot, binding, facts, onVideoBinding, onVideoFrame, revision]);
}
