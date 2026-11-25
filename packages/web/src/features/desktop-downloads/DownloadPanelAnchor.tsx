// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import * as React from 'react';

import { cn } from '@web/lib/utils';

/** The left edge the page's anchor reports, in window coordinates; null while no page shows one. */
let anchorLeft: number | null = null;
const listeners = new Set<() => void>();

/**
 * Record the anchor's left edge and tell the panel.
 * @param left - The new left edge, or null when the anchor is gone.
 */
function setAnchorLeft(left: number | null): void {
  if (left === anchorLeft) return;
  anchorLeft = left;
  for (const listener of listeners) listener();
}

/**
 * Hear the anchor move.
 * @param listener - Called on each change.
 * @returns The unsubscribe.
 */
function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * The left edge the desktop Downloads panel takes by default on this page.
 * @returns The anchor's left edge in window coordinates, or null when the page has no anchor.
 */
export function useDownloadPanelAnchorLeft(): number | null {
  return React.useSyncExternalStore(subscribe, () => anchorLeft);
}

/**
 * Marks where the desktop Downloads panel sits by default on a page (inner#2041,
 * design §7.3.1): the page places it in its layout, at the bottom of the area
 * the panel belongs to, and it reports its left edge whenever that area or the
 * window changes size (the Agent column dragged wider or collapsed, the Studio
 * rail hidden). Its parent must be positioned.
 * @param props - Where it sits in its area.
 * @param props.className - The left offset inside the area.
 * @returns The zero-size anchor.
 */
export function DownloadPanelAnchor({ className }: { className?: string }): React.JSX.Element {
  const ref = React.useRef<HTMLSpanElement>(null);
  React.useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    /**
     * Report where the anchor is now.
     * @returns Nothing.
     */
    const report = (): void => setAnchorLeft(element.getBoundingClientRect().left);
    report();
    const observer = new ResizeObserver(report);
    if (element.parentElement) observer.observe(element.parentElement);
    window.addEventListener('resize', report);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', report);
      setAnchorLeft(null);
    };
  }, []);
  return <span ref={ref} aria-hidden data-download-panel-anchor='' className={cn('pointer-events-none absolute bottom-0 left-[var(--space-6)] size-0', className)} />;
}
