// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';
import { createPortal } from 'react-dom';

/** The video control surface requested by a document host. */
export interface VideoControlsTarget {
  destination: HTMLElement | 'inline' | null;
  surface: 'video' | 'popover';
  preserveFocus?: boolean;
  onFocusChange?: (focused: boolean, relatedTarget: EventTarget | null) => void;
  onSeekingChange?: (active: boolean, release: () => void) => void;
}

/** An active pointer which survives moving the controls mount. */
export interface MediaPointer {
  root: HTMLElement;
  pointerId: number;
  release: () => void;
}

/** The pointer handlers and shared migration facts for one control row. */
interface SeekPointer {
  capture: React.RefObject<MediaPointer | null>;
  migrating: React.RefObject<boolean>;
  onPointerDown: React.PointerEventHandler<HTMLElement>;
  onPointerMove: React.PointerEventHandler<HTMLElement>;
  onPointerUp: React.PointerEventHandler<HTMLElement>;
  onPointerCancel: React.PointerEventHandler<HTMLElement>;
  onLostPointerCapture: React.PointerEventHandler<HTMLElement>;
}

/**
 * Adapts a single Radix seek value to the root's current pointer geometry.
 * @param seek - Writes a fraction through the media controller.
 * @param target - Current external control surface configuration.
 * @returns Pointer handlers and capture facts.
 */
export function useSeekPointer(seek: (fraction: number) => void, target: VideoControlsTarget | undefined): SeekPointer {
  const capture = React.useRef<MediaPointer | null>(null);
  const migrating = React.useRef(false);
  const latest = React.useRef({ seek, target });
  latest.current = { seek, target };
  /** Ends the current pointer and publishes the interaction change. */
  const release = React.useCallback((): void => {
    const held = capture.current;
    if (held === null) return;
    capture.current = null;
    if (held.root.hasPointerCapture?.(held.pointerId)) held.root.releasePointerCapture(held.pointerId);
    latest.current.target?.onSeekingChange?.(false, release);
  }, []);
  /** Writes the value at this pointer's current position. */
  const apply = React.useCallback((event: React.PointerEvent<HTMLElement>): void => {
    const held = capture.current;
    if (held === null || held.pointerId !== event.pointerId) return;
    const box = held.root.getBoundingClientRect();
    if (box.width <= 0) return;
    const rtl = getComputedStyle(held.root).direction === 'rtl';
    const fraction = (event.clientX - box.left) / box.width;
    const percent = Math.round(Math.min(1, Math.max(0, rtl ? 1 - fraction : fraction)) * 1000) / 10;
    latest.current.seek(percent / 100);
  }, []);
  const onPointerDown = React.useCallback((event: React.PointerEvent<HTMLElement>): void => {
    if (latest.current.target === undefined || event.button !== 0 || capture.current !== null) return;
    event.preventDefault();
    const root = event.currentTarget;
    capture.current = { root, pointerId: event.pointerId, release };
    root.setPointerCapture?.(event.pointerId);
    root.querySelector<HTMLElement>('[role="slider"]')?.focus({ preventScroll: true });
    latest.current.target.onSeekingChange?.(true, release);
    apply(event);
  }, [apply, release]);
  const onPointerMove = React.useCallback((event: React.PointerEvent<HTMLElement>): void => {
    if (capture.current?.pointerId !== event.pointerId) return;
    event.preventDefault();
    apply(event);
  }, [apply]);
  const onPointerUp = React.useCallback((event: React.PointerEvent<HTMLElement>): void => {
    if (capture.current?.pointerId !== event.pointerId) return;
    event.preventDefault();
    apply(event);
    release();
  }, [apply, release]);
  const onPointerCancel = React.useCallback((event: React.PointerEvent<HTMLElement>): void => {
    if (capture.current?.pointerId === event.pointerId) release();
  }, [release]);
  const onLostPointerCapture = React.useCallback((event: React.PointerEvent<HTMLElement>): void => {
    const held = capture.current;
    if (held?.pointerId !== event.pointerId || migrating.current || held.root.hasPointerCapture?.(held.pointerId)) return;
    release();
  }, [release]);
  React.useEffect(() => release, [release]);
  return { capture, migrating, onPointerDown, onPointerMove, onPointerUp, onPointerCancel, onLostPointerCapture };
}

/**
 * Keeps the React portal destination stable while moving its DOM mount.
 * @param props - Control children and their current physical destination.
 * @param props.destination - The visible destination, or null to park.
 * @param props.capture - The current seek pointer, for controls that seek.
 * @param props.migrating - Whether a physical transfer is in progress.
 * @param props.preserveFocus - Retains focus across an intermediate parked layout transfer.
 * @param props.children - The one control row.
 * @returns The stable portal and an inert parking destination.
 */
export function MediaControlsPortal({ destination, capture, migrating, preserveFocus = false, children }: {
  destination: HTMLElement | null;
  capture?: React.RefObject<MediaPointer | null>;
  migrating: React.RefObject<boolean>;
  preserveFocus?: boolean;
  children: React.ReactNode;
}): React.JSX.Element {
  const [mount] = React.useState(() => {
    const element = document.createElement('div');
    element.style.display = 'contents';
    element.dataset['mediaControlsMount'] = '';
    return element;
  });
  const park = React.useRef<HTMLDivElement>(null);
  const heldFocus = React.useRef<HTMLElement | null>(null);
  React.useLayoutEffect(() => {
    const parent = destination ?? park.current;
    if (parent === null || mount.parentNode === parent) return;
    const active = mount.contains(document.activeElement) ? document.activeElement as HTMLElement : preserveFocus ? heldFocus.current : null;
    heldFocus.current = preserveFocus ? active : null;
    const held = capture?.current ?? null;
    migrating.current = true;
    parent.appendChild(mount);
    if (active?.isConnected && destination !== null) active.focus({ preventScroll: true });
    if (held !== null && held.root.isConnected) held.root.setPointerCapture?.(held.pointerId);
    migrating.current = false;
  }, [destination, mount, capture, migrating, preserveFocus]);
  React.useLayoutEffect(() => () => {
    capture?.current?.release();
    mount.remove();
  }, [capture, mount]);
  return <><div ref={park} hidden inert data-media-controls-park='' />{createPortal(children, mount)}</>;
}
