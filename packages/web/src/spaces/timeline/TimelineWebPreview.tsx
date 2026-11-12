// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import * as React from 'react';
import { createPortal } from 'react-dom';
import type { TimelineExecutionStatus, TimelineRate, TimelineWebAnimationClip } from '@breatic/shared';
import { timelineExecutionFailed } from '@breatic/shared/space-content';

import { Button } from '@web/components/ui/button';
import { useTranslation } from '@web/i18n/use-translation';
import { cn } from '@web/lib/utils';
import type { WebAnimationPlayerElement, WebInstanceState } from '@web/spaces/timeline/web-animation-host';
import { useWebAnimationPreviewUrl, type WebAnimationPreviewSharing } from '@web/spaces/timeline/use-web-animation-preview-url';
import type { WebInstanceRole } from '@web/spaces/timeline/web-instance-pool';

declare module 'react' {
  // eslint-disable-next-line @typescript-eslint/no-namespace -- React declares intrinsic elements in this namespace.
  namespace JSX {
    interface IntrinsicElements {
      'hyperframes-player': React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement> & {
        src?: string;
        'sandbox-origin'?: string;
        'disable-click-to-play'?: string;
      };
    }
  }
}

const PLAYER_TAG = 'hyperframes-player';

// The player is loaded the first time a web copy is shown, so the Timeline itself does not carry it.
let playerModule: Promise<unknown> | null = null;

/** Whether `<hyperframes-player>` is defined, whether loading it failed, and a retry of that load. */
export interface PlayerModule { defined: boolean; failed: boolean; retry: () => void }

/**
 * Whether `<hyperframes-player>` is defined, loading it on first need. A platform whose iframes cannot be sandboxed
 * cannot isolate the page, so the player is never loaded there and its elements stay inert.
 * @param needed - Whether a web copy is visible.
 * @returns Whether the element is defined, whether its module failed to load, and a retry that loads it again.
 * @throws {never} Never.
 */
export function usePlayerDefined(needed: boolean): PlayerModule {
  const [defined, setDefined] = React.useState(() => customElements.get(PLAYER_TAG) !== undefined);
  const [failed, setFailed] = React.useState(false);
  React.useEffect(() => {
    if (defined || failed || !needed || !('sandbox' in HTMLIFrameElement.prototype)) return;
    let live = true;
    playerModule ??= import('@hyperframes/player');
    playerModule.then(() => { if (live) setDefined(true); }, () => {
      // A failed load leaves no player until the retry the preview offers loads it again.
      playerModule = null;
      if (live) setFailed(true);
    });
    return () => { live = false; };
  }, [defined, failed, needed]);
  const retry = React.useCallback((): void => setFailed(false), []);
  return React.useMemo(() => ({ defined, failed, retry }), [defined, failed, retry]);
}

/**
 * Whether an instance has a picture to draw: it answered a position since it last (re)loaded. Until then it has no
 * picture of this copy to show; a later seek keeps the last picture while it waits.
 * @param state - The instance's current state.
 * @returns Whether to draw it.
 * @throws {never} Never.
 */
export function useWebInstanceDrawn(state: WebInstanceState | undefined): boolean {
  const [drawn, setDrawn] = React.useState(state === 'ready');
  if (state === 'ready' && !drawn) setDrawn(true);
  if ((state === undefined || state === 'loading') && drawn) setDrawn(false);
  return drawn;
}

/** The style of a player that has no picture yet: it keeps loading and stays in the layout, unseen. */
export const UNDRAWN_PLAYER = { opacity: 0 } as const;

/**
 * One web copy the preview serves: a visible one with the instance showing it or the status a placeholder notes, or
 * a copy whose instance is premounted ahead of it or idle after it (inner#1711 design §7.4).
 */
export interface TimelineWebEntry {
  clip: TimelineWebAnimationClip;
  /** Its track's name. */
  track: string;
  /** Its stacking position, bottom 1. */
  z: number;
  /**
   * The instance serving it, keyed by source version and its pool ordinal, with its pool role;
   * an idle instance's entry carries the copy it last showed.
   */
  instance: { key: string; sourceVersionId: string; fps: TimelineRate; role: WebInstanceRole; targetFrame?: number } | null;
  /** What a copy without a picture waits for, when known. */
  status: TimelineExecutionStatus | null;
  /** Where its layer is drawn in the preview, in display pixels (#1410 design §2); absent, it fills the frame. */
  box?: React.CSSProperties;
}

/** One instance's player and its note. */
interface WebInstanceProps {
  projectId: string;
  entry: TimelineWebEntry & { instance: NonNullable<TimelineWebEntry['instance']> };
  state: WebInstanceState | undefined;
  defined: boolean;
  playerFailed: boolean;
  notes: HTMLElement | null;
  sharing: WebAnimationPreviewSharing | undefined;
  onPlayer: (key: string, player: WebAnimationPlayerElement | null) => void;
  onRetry: (key: string) => void;
  onPlayerRetry: () => void;
  onUnavailable?: (key: string, unavailable: boolean) => void;
}

/**
 * A preview note: a layer without a picture, by track; video layers' notes use it too (#1410 design §4.1).
 * @param props - The note.
 * @param props.clipId - The layer's clip.
 * @param props.z - Its stacking position, so notes read top-down by track.
 * @param props.text - What it says.
 * @param props.children - A retry, when there is one.
 * @returns The note.
 * @throws {never} Never.
 */
export function WebNote({ clipId, z, text, children }: { clipId: string; z: number; text: string; children?: React.ReactNode }): React.JSX.Element {
  const style = React.useMemo(() => ({ order: -z }), [z]);
  return <div data-testid={`timeline-web-note-${clipId}`} style={style} className='flex items-center gap-2 rounded-chrome border border-border bg-background px-2 py-1 text-xs text-foreground'>
    <span>{text}</span>{children}
  </div>;
}

/**
 * One sandboxed player that only the Timeline clock drives: no controls, no autoplay, no clicks. Its address is
 * fetched once per mount; a player that fails is given one fresh address on its own, and after that the note's retry
 * fetches one. A premounted or idle instance stays mounted, hidden and without a note, so its page is loaded when a
 * copy shows it; its role changes only its style.
 * @param props - The instance.
 * @param props.projectId - The Project the address is read through.
 * @param props.entry - The copy it shows now.
 * @param props.state - Its bridge state.
 * @param props.defined - Whether the player element is defined; until then the element is inert and not driven.
 * @param props.playerFailed - Whether the player module failed to load.
 * @param props.notes - Where its note goes.
 * @param props.sharing - How long one address may be shared, once the Timeline limits are read.
 * @param props.onPlayer - Hands its element to the playback.
 * @param props.onRetry - Loads it again.
 * @param props.onPlayerRetry - Loads the player module again.
 * @param props.onUnavailable - Says whether it can never register a player until a retry, so play does not wait for it.
 * @returns The player and, when it is unavailable, its note.
 * @throws {never} Never.
 */
const WebInstance = React.memo(function WebInstance({ projectId, entry, state, defined, playerFailed, notes, sharing, onPlayer, onRetry, onPlayerRetry, onUnavailable }: WebInstanceProps): React.JSX.Element {
  const t = useTranslation();
  const { key, sourceVersionId } = entry.instance;
  const shown = entry.instance.role === 'visible';
  const preview = useWebAnimationPreviewUrl(projectId, sourceVersionId, sharing);
  const { refresh } = preview;
  const [element, setElement] = React.useState<HTMLElement | null>(null);
  // The playback drives the player only once it is defined and so exposes its iframe.
  React.useEffect(() => {
    if (!defined || element === null) return;
    onPlayer(key, element as WebAnimationPlayerElement);
    return () => onPlayer(key, null);
  }, [defined, element, key, onPlayer]);
  const drawn = useWebInstanceDrawn(state);
  const style = React.useMemo(() => ({ ...entry.box, zIndex: entry.z, pointerEvents: 'none' as const, ...(drawn && shown ? {} : UNDRAWN_PLAYER) }), [entry.box, entry.z, drawn, shown]);
  const retry = React.useCallback((): void => {
    if (playerFailed) onPlayerRetry();
    if (!playerFailed || preview.failed) { refresh(); onRetry(key); }
  }, [playerFailed, preview.failed, onPlayerRetry, refresh, onRetry, key]);
  // Without an address or a player module no player registers, so the playback's barrier must not wait for one.
  const unregistrable = preview.failed || playerFailed;
  React.useEffect(() => {
    if (!unregistrable || onUnavailable === undefined) return;
    onUnavailable(key, true);
    return () => onUnavailable(key, false);
  }, [unregistrable, key, onUnavailable]);
  // A page reloaded after its address expired never says it is ready; one fresh address is tried before giving up.
  const refreshedOnce = React.useRef(false);
  React.useEffect(() => {
    if (state !== 'failed' || refreshedOnce.current) return;
    refreshedOnce.current = true;
    refresh();
  }, [state, refresh]);
  // Notes are for visible copies only.
  const unavailable = shown && (unregistrable || (state === 'failed' && refreshedOnce.current));
  const loading = shown && !drawn && !unavailable;
  return <>
    {preview.url !== null && <hyperframes-player ref={setElement} src={preview.url} sandbox-origin='' disable-click-to-play=''
      data-instance-key={key} data-clip-id={entry.clip.id} data-web-state={state ?? 'loading'} className={cn('absolute bg-transparent', entry.box === undefined && 'inset-0 size-full')} style={style} />}
    {loading && notes !== null && createPortal(<WebNote clipId={entry.clip.id} z={entry.z} text={t('timeline.webAnimation.preview.loading', { track: entry.track })} />, notes)}
    {unavailable && notes !== null && createPortal(<WebNote clipId={entry.clip.id} z={entry.z} text={t('timeline.webAnimation.preview.unavailable', { track: entry.track })}>
      <Button data-testid={`timeline-web-retry-${entry.clip.id}`} variant='outline' size='compact' onClick={retry}>{t('timeline.retry')}</Button>
    </WebNote>, notes)}
  </>;
});

/** The web copies visible at the playhead. */
interface TimelineWebPreviewProps {
  projectId: string;
  entries: readonly TimelineWebEntry[];
  states: ReadonlyMap<string, WebInstanceState>;
  /** How long one address may be shared; absent until the Timeline limits are read. */
  sharing?: WebAnimationPreviewSharing;
  onPlayer: (key: string, player: WebAnimationPlayerElement | null) => void;
  onRetry: (key: string) => void;
  onUnavailable?: (key: string, unavailable: boolean) => void;
  /** Notes for the visible upload placeholders, which draw no picture. */
  uploadNotes?: readonly TimelineUploadNote[];
  /** The preview's note layer, where every note goes. */
  notes: HTMLElement | null;
}

/** A visible upload placeholder's note. */
export interface TimelineUploadNote { clipId: string; z: number; text: string }

const NO_UPLOAD_NOTES: readonly TimelineUploadNote[] = [];

/**
 * The web layers of the preview (inner#1711 design §7.3, §7.4): one player per instance, visible, premounted or idle,
 * rendered in a fixed order by instance key and stacked by z-index, so restacking or a role change never moves or
 * reloads one; and, in the preview's note layer, a note per visible copy that shows no picture, top track first.
 * @param props - The copies and the playback's instance states.
 * @param props.projectId - The Project.
 * @param props.entries - The visible web copies bottom-up, then the premounted and idle instances' copies.
 * @param props.states - Each instance's state.
 * @param props.sharing - How long one address may be shared, once the Timeline limits are read.
 * @param props.onPlayer - Hands a player element to the playback.
 * @param props.onRetry - Loads an instance again.
 * @param props.onUnavailable - Says which instances can register no player until a retry.
 * @param props.uploadNotes - Notes for the visible upload placeholders, stacked with the copies' notes.
 * @param props.notes - The preview's note layer.
 * @returns The layers.
 * @throws {never} Never.
 */
export function TimelineWebPreview({ projectId, entries, states, sharing, onPlayer, onRetry, onUnavailable, uploadNotes = NO_UPLOAD_NOTES, notes }: TimelineWebPreviewProps): React.JSX.Element {
  const t = useTranslation();
  const instances = React.useMemo(() => entries.flatMap((entry) => entry.instance === null ? [] : [{ ...entry, instance: entry.instance }])
    .sort((a, b) => (a.instance.key < b.instance.key ? -1 : a.instance.key > b.instance.key ? 1 : 0)), [entries]);
  const player = usePlayerDefined(instances.length > 0);
  return <>
    {instances.map((entry) => <WebInstance key={entry.instance.key} projectId={projectId} entry={entry} state={states.get(entry.instance.key)} defined={player.defined}
      playerFailed={player.failed} notes={notes} sharing={sharing} onPlayer={onPlayer} onRetry={onRetry} onPlayerRetry={player.retry} onUnavailable={onUnavailable} />)}
    {notes !== null && createPortal(<>
      {entries.filter((entry) => entry.instance === null).map((entry) => {
        const status = entry.status ?? '';
        const ended = entry.status !== null && timelineExecutionFailed(entry.status);
        return <WebNote key={entry.clip.id} clipId={entry.clip.id} z={entry.z}
          text={t(ended ? 'timeline.webAnimation.preview.failed' : 'timeline.webAnimation.preview.pending', { track: entry.track, status })} />;
      })}
      {uploadNotes.map((note) => <WebNote key={note.clipId} clipId={note.clipId} z={note.z} text={note.text} />)}
    </>, notes)}
  </>;
}
