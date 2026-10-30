// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Which bar the document shows, one at a time (inner#1127).
 *
 * Three kinds of bar float over the body: a media block's toolbar, the link
 * toolbar and the selection bubble bar. Each decides on its own whether it has
 * something to show. Media requests and active controls share one owner so
 * late input and lifecycle events can be checked against their host. The
 * media interaction owner, link toolbar and selection bar read this state.
 *
 * Some controls stand aside for a bar on screen rather than for the selection
 * behind it, which stays in the editor while the body does not hold the
 * focus and is then not drawn (inner#1127, `document-body-focus.ts`): the
 * row handles, the table handles and the link toolbar the pointer raises
 * stand aside while the bubble bar is up.
 */

import * as React from 'react';

import { keyedStore } from '@web/lib/keyed-store';

/** What the bars read. */
export interface DocumentBars {
  /** The container of the media block the pointer is on, or null. */
  readonly hoveredMedia: HTMLElement | null;
  /** Whether the link toolbar is up. */
  readonly linkToolbarUp: boolean;
  /** Whether the selection bubble bar is up, standing aside for a panel of its own included. */
  readonly bubbleBarUp: boolean;
  /** The media request, active controls and pending caption handoff. */
  readonly media: MediaInteraction;
}

/** An explicit media panel request. */
interface MediaRequest {
  host: HTMLElement;
  origin: 'pointer' | 'keyboard';
}

/** The one host currently using media controls. */
type MediaActivity = { host: HTMLElement; kind: 'focused' } | { host: HTMLElement; kind: 'seeking'; release: () => void };

/** Media interaction facts belonging to one editor. */
export interface MediaInteraction {
  request: MediaRequest | null;
  pending: MediaRequest | null;
  activity: MediaActivity | null;
  intent: { host: HTMLElement; epoch: number } | null;
  close: { host: HTMLElement; reason: 'escape' | 'caption' | 'outside' | 'release' | 'pointer'; epoch: number } | null;
  epoch: number;
}

/** Events accepted by the editor's media interaction owner. */
export type MediaEvent =
  | { type: 'hover'; host: HTMLElement; on: boolean }
  | { type: 'leave'; host: HTMLElement }
  | { type: 'open'; host: HTMLElement; origin: 'pointer' | 'keyboard' }
  | { type: 'focus'; host: HTMLElement; focused: boolean }
  | { type: 'seek-start'; host: HTMLElement; release: () => void }
  | { type: 'seek-end'; host: HTMLElement; focused: boolean }
  | { type: 'complete-caption'; host: HTMLElement; epoch: number }
  | { type: 'caption' | 'escape' | 'outside' | 'release'; host: HTMLElement };

const NO_MEDIA: MediaInteraction = { request: null, pending: null, activity: null, intent: null, close: null, epoch: 0 };
const NONE: DocumentBars = { hoveredMedia: null, linkToolbarUp: false, bubbleBarUp: false, media: NO_MEDIA };

/** Keyed by editor, so an editor that is dropped takes its state with it. */
const store = keyedStore<object, DocumentBars>(
  () => NONE,
  (a, b) =>
    a.hoveredMedia === b.hoveredMedia &&
    a.linkToolbarUp === b.linkToolbarUp &&
    a.bubbleBarUp === b.bubbleBarUp &&
    a.media === b.media,
);

/**
 * The state as it is now; the same object until it changes.
 * @param editor - The editor.
 * @returns The state.
 */
export function documentBarsOf(editor: object): DocumentBars {
  return store.get(editor);
}

/**
 * Records the pointer arriving on, or leaving, a media block.
 *
 * A leave only counts for the block that holds the hover: moving from one
 * block straight onto the next, the second one's arrival can come first.
 * @param editor - The editor.
 * @param host - The media block's container.
 * @param on - True on arrival, false on leaving.
 */
export function setHoveredMedia(editor: object, host: HTMLElement, on: boolean): void {
  mediaEvent(editor, { type: 'hover', host, on });
}

/**
 * Updates the editor's media interaction facts in one transaction.
 * @param editor - The editor.
 * @param event - The input or lifecycle event.
 */
export function mediaEvent(editor: object, event: MediaEvent): void {
  const bars = store.get(editor);
  const old = bars.media;
  const host = event.host;
  let media = old;
  let hoveredMedia = bars.hoveredMedia;
  if (event.type === 'hover' || event.type === 'leave') {
    const on = event.type === 'hover' && event.on;
    hoveredMedia = on ? host : hoveredMedia === host ? null : hoveredMedia;
    if (on && old.request?.origin !== 'keyboard' && old.activity?.kind !== 'seeking' && old.intent?.host !== host) {
      media = { ...old, request: { host, origin: 'pointer' }, close: null };
    } else if (event.type === 'hover' && !event.on && old.request?.host === host && old.request.origin === 'pointer' && old.activity?.host !== host) {
      media = { ...old, request: null, close: { host, reason: 'pointer', epoch: old.epoch } };
    }
  } else if (event.type === 'open') {
    const request: MediaRequest = { host, origin: event.origin };
    media = old.activity?.kind === 'seeking' && old.activity.host !== host
      ? { ...old, pending: request }
      : { ...old, request, pending: null, activity: old.activity?.host === host ? old.activity : null, intent: null, close: null, epoch: old.epoch + 1 };
  } else if (event.type === 'focus') {
    if (old.intent?.host === host || old.activity?.kind === 'seeking') return;
    const dismiss = !event.focused && old.request?.host === host && old.request.origin === 'pointer' && hoveredMedia !== host;
    media = { ...old, activity: event.focused ? { host, kind: 'focused' } : old.activity?.host === host ? null : old.activity,
      request: event.focused && old.request?.host !== host ? null : dismiss ? null : old.request,
      pending: event.focused ? null : old.pending,
      intent: event.focused ? null : old.intent,
      close: event.focused ? null : dismiss ? { host, reason: 'pointer', epoch: old.epoch } : old.close,
    };
  } else if (event.type === 'seek-start') {
    if (old.activity?.kind === 'seeking' && old.activity.host !== host) old.activity.release();
    media = { ...old, activity: { host, kind: 'seeking', release: event.release }, intent: null, close: null };
  } else if (event.type === 'seek-end') {
    if (old.activity?.host !== host || old.activity.kind !== 'seeking') return;
    media = { ...old, request: old.pending ?? old.request, pending: null, activity: old.pending !== null ? null : event.focused ? { host, kind: 'focused' } : null };
  } else if (event.type === 'complete-caption') {
    if (old.intent?.host !== host || old.intent.epoch !== event.epoch) return;
    media = { ...old, intent: null };
  } else {
    const owns = old.request?.host === host || old.activity?.host === host || old.intent?.host === host ||
      (old.close?.host === host && old.request === null && old.activity === null && old.intent === null);
    if (!owns && event.type !== 'caption') {
      if (event.type === 'release' && hoveredMedia === host) store.set(editor, { ...bars, hoveredMedia: null });
      return;
    }
    if (old.activity?.host === host && old.activity.kind === 'seeking') old.activity.release();
    const epoch = old.epoch + 1;
    media = { ...old, request: null, pending: null, activity: null, epoch,
      intent: event.type === 'caption' ? { host, epoch } : null,
      close: { host, reason: event.type, epoch },
    };
    if (event.type === 'release' || event.type === 'outside' || event.type === 'caption' || event.type === 'escape') hoveredMedia = hoveredMedia === host ? null : hoveredMedia;
  }
  store.set(editor, { ...bars, hoveredMedia, media });
}

/**
 * Whether the host has a request or active controls keeping its panel open.
 * @param bars - The current bar facts.
 * @param host - The media host.
 * @returns True when the host owns a panel.
 */
export function mediaPanelShown(bars: DocumentBars, host: HTMLElement): boolean {
  return mediaBarShown(bars, host, false) && (bars.media.request?.host === host || bars.media.activity?.host === host);
}

/**
 * Records the link toolbar coming up or going down.
 * @param editor - The editor.
 * @param up - Whether it is up.
 */
export function setLinkToolbarUp(editor: object, up: boolean): void {
  store.set(editor, { ...store.get(editor), linkToolbarUp: up });
}

/**
 * Records the bubble bar coming up or going down.
 * @param editor - The editor.
 * @param up - Whether it is up.
 */
export function setBubbleBarUp(editor: object, up: boolean): void {
  store.set(editor, { ...store.get(editor), bubbleBarUp: up });
}

/**
 * Whether a media block's toolbar is the bar on screen.
 *
 * One host owns the bar, in this order: a seek in progress, a keyboard
 * request, the pointer, controls holding focus, a pointer request. With none
 * of them, the node-selected block shows its bar.
 * @param bars - The state.
 * @param host - The block's container.
 * @param selected - Whether the block is node-selected.
 * @returns True when its toolbar shows.
 */
export function mediaBarShown(bars: DocumentBars, host: HTMLElement, selected: boolean): boolean {
  const activity = bars.media.activity;
  const owner = activity?.kind === 'seeking' ? activity.host
    : bars.media.request?.origin === 'keyboard' ? bars.media.request.host
      : bars.hoveredMedia ?? activity?.host ?? bars.media.request?.host;
  if (owner !== null && owner !== undefined) return owner === host;
  return selected && !bars.linkToolbarUp;
}

/**
 * Whether the link toolbar and the selection bubble bar step aside, which they
 * do while a media block is under the pointer, has its panel asked for (by
 * the pointer or the keyboard), or has controls holding the focus or seeking.
 * @param bars - The state.
 * @returns True when they do.
 */
export function textBarsStandAside(bars: DocumentBars): boolean {
  return bars.hoveredMedia !== null || bars.media.request !== null || bars.media.activity !== null;
}

/**
 * The state, kept current in a component.
 * @param editor - The editor.
 * @returns The state.
 */
export function useDocumentBars(editor: object): DocumentBars {
  const subscribe = React.useCallback(
    (listener: () => void) => store.subscribe(editor, listener),
    [editor],
  );
  return React.useSyncExternalStore(subscribe, () => documentBarsOf(editor));
}
