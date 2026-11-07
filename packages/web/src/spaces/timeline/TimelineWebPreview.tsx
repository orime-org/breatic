// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import * as React from 'react';
import { createPortal } from 'react-dom';
import type { TimelineExecutionStatus, TimelineRate, TimelineWebAnimationClip } from '@breatic/shared';

import { Button } from '@web/components/ui/button';
import { useTranslation } from '@web/i18n/use-translation';
import { timelineExecutionUnfinished } from '@web/spaces/timeline/use-timeline-executions';
import type { WebAnimationPlayerElement, WebInstanceState } from '@web/spaces/timeline/web-animation-host';
import { useWebAnimationPreviewUrl } from '@web/spaces/timeline/use-web-animation-preview-url';

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

/**
 * Whether `<hyperframes-player>` is defined, loading it on first need. A platform whose iframes cannot be sandboxed
 * cannot isolate the page, so the player is never loaded there and its elements stay inert.
 * @param needed - Whether a web copy is visible.
 * @returns True once the element is defined.
 * @throws {never} Never.
 */
export function usePlayerDefined(needed: boolean): boolean {
  const [defined, setDefined] = React.useState(() => customElements.get(PLAYER_TAG) !== undefined);
  React.useEffect(() => {
    if (defined || !needed || !('sandbox' in HTMLIFrameElement.prototype)) return;
    let live = true;
    playerModule ??= import('@hyperframes/player');
    playerModule.then(() => { if (live) setDefined(true); }, () => {
      // A failed load leaves no player; the copy's instance never answers and its preview note offers a retry.
      playerModule = null;
    });
    return () => { live = false; };
  }, [defined, needed]);
  return defined;
}

/** One visible web copy: the instance showing it, or the status a placeholder notes. */
export interface TimelineWebEntry {
  clip: TimelineWebAnimationClip;
  /** Its track's name. */
  track: string;
  /** Its stacking position, bottom 1. */
  z: number;
  /** The instance showing it, keyed by source version and its ordinal among visible copies of that source. */
  instance: { key: string; sourceVersionId: string; fps: TimelineRate } | null;
  /** What a copy without a picture waits for, when known. */
  status: TimelineExecutionStatus | null;
}

/** One instance's player and its note. */
interface WebInstanceProps {
  projectId: string;
  entry: TimelineWebEntry & { instance: NonNullable<TimelineWebEntry['instance']> };
  state: WebInstanceState | undefined;
  defined: boolean;
  notes: HTMLElement | null;
  onPlayer: (key: string, player: WebAnimationPlayerElement | null) => void;
  onRetry: (key: string) => void;
}

/**
 * A preview note: a copy without a picture, by track.
 * @param props - The note.
 * @param props.clipId - The copy.
 * @param props.z - Its stacking position, so notes read top-down by track.
 * @param props.text - What it says.
 * @param props.children - A retry, when there is one.
 * @returns The note.
 * @throws {never} Never.
 */
function WebNote({ clipId, z, text, children }: { clipId: string; z: number; text: string; children?: React.ReactNode }): React.JSX.Element {
  const style = React.useMemo(() => ({ order: -z }), [z]);
  return <div data-testid={`timeline-web-note-${clipId}`} style={style} className='flex items-center gap-2 rounded-chrome border border-border bg-background px-2 py-1 text-xs text-foreground'>
    <span>{text}</span>{children}
  </div>;
}

/**
 * One sandboxed player that only the Timeline clock drives: no controls, no autoplay, no clicks. Its address is
 * fetched once per mount; a player that fails is given one fresh address on its own, and after that the note's retry
 * fetches one.
 * @param props - The instance.
 * @param props.projectId - The Project the address is read through.
 * @param props.entry - The copy it shows now.
 * @param props.state - Its bridge state.
 * @param props.defined - Whether the player element is defined; until then the element is inert and not driven.
 * @param props.notes - Where its note goes.
 * @param props.onPlayer - Hands its element to the playback.
 * @param props.onRetry - Loads it again.
 * @returns The player and, when it is unavailable, its note.
 * @throws {never} Never.
 */
const WebInstance = React.memo(function WebInstance({ projectId, entry, state, defined, notes, onPlayer, onRetry }: WebInstanceProps): React.JSX.Element {
  const t = useTranslation();
  const { key, sourceVersionId } = entry.instance;
  const preview = useWebAnimationPreviewUrl(projectId, sourceVersionId);
  const { refresh } = preview;
  const [element, setElement] = React.useState<HTMLElement | null>(null);
  // The playback drives the player only once it is defined and so exposes its iframe.
  React.useEffect(() => {
    if (!defined || element === null) return;
    onPlayer(key, element as WebAnimationPlayerElement);
    return () => onPlayer(key, null);
  }, [defined, element, key, onPlayer]);
  const style = React.useMemo(() => ({ zIndex: entry.z, pointerEvents: 'none' as const }), [entry.z]);
  const retry = React.useCallback((): void => { refresh(); onRetry(key); }, [refresh, onRetry, key]);
  // A page reloaded after its address expired never says it is ready; one fresh address is tried before giving up.
  const refreshedOnce = React.useRef(false);
  React.useEffect(() => {
    if (state !== 'failed' || refreshedOnce.current) return;
    refreshedOnce.current = true;
    refresh();
  }, [state, refresh]);
  const unavailable = preview.failed || (state === 'failed' && refreshedOnce.current);
  return <>
    {preview.url !== null && <hyperframes-player ref={setElement} src={preview.url} sandbox-origin='' disable-click-to-play=''
      data-instance-key={key} data-clip-id={entry.clip.id} className='absolute inset-0 size-full' style={style} />}
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
  onPlayer: (key: string, player: WebAnimationPlayerElement | null) => void;
  onRetry: (key: string) => void;
}

/**
 * The web layers of the preview (inner#1711 design §7.3): one player per visible copy with a picture, rendered in a
 * fixed order by instance key and stacked by z-index, so restacking never moves or reloads one; and, at the top right,
 * a note per copy that shows no picture, top track first.
 * @param props - The visible copies and the playback's instance states.
 * @param props.projectId - The Project.
 * @param props.entries - The visible web copies, bottom-up.
 * @param props.states - Each instance's state.
 * @param props.onPlayer - Hands a player element to the playback.
 * @param props.onRetry - Loads an instance again.
 * @returns The layers.
 * @throws {never} Never.
 */
export function TimelineWebPreview({ projectId, entries, states, onPlayer, onRetry }: TimelineWebPreviewProps): React.JSX.Element {
  const t = useTranslation();
  const instances = React.useMemo(() => entries.flatMap((entry) => entry.instance === null ? [] : [{ ...entry, instance: entry.instance }])
    .sort((a, b) => (a.instance.key < b.instance.key ? -1 : a.instance.key > b.instance.key ? 1 : 0)), [entries]);
  const defined = usePlayerDefined(instances.length > 0);
  const [notes, setNotes] = React.useState<HTMLDivElement | null>(null);
  const notesStyle = React.useMemo(() => ({ zIndex: entries.length + 1 }), [entries.length]);
  return <>
    {instances.map((entry) => <WebInstance key={entry.instance.key} projectId={projectId} entry={entry} state={states.get(entry.instance.key)} defined={defined}
      notes={notes} onPlayer={onPlayer} onRetry={onRetry} />)}
    <div ref={setNotes} className='absolute right-3 top-3 flex flex-col items-end gap-1.5' style={notesStyle}>
      {entries.filter((entry) => entry.instance === null).map((entry) => {
        const status = entry.status === null ? '' : t(`timeline.webAnimation.status.${entry.status}`);
        const ended = entry.status !== null && !timelineExecutionUnfinished(entry.status) && entry.status !== 'succeeded';
        return <WebNote key={entry.clip.id} clipId={entry.clip.id} z={entry.z}
          text={t(ended ? 'timeline.webAnimation.preview.failed' : 'timeline.webAnimation.preview.pending', { track: entry.track, status })} />;
      })}
    </div>
  </>;
}
