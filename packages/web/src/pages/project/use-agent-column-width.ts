// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { useCallback, useRef, useState } from 'react';
import type { RefObject } from 'react';
import type { Layout, LayoutChangedMeta, PanelImperativeHandle } from 'react-resizable-panels';

import { STORAGE_KEYS } from '@web/lib/storage-keys';
import {
  AGENT_COLUMN_MIN_WIDTH,
  AGENT_PANEL_ID,
  RESIZE_HANDLE_WIDTH,
  parseStoredWidth,
  resolveWidth,
  shouldRestore,
} from '@web/pages/project/agent-column-width';

/** What the Group and the Agent column's Panel need from this hook. */
export interface AgentColumnWidthControls {
  /** The Panel's `defaultSize`, in pixels. */
  defaultSize: string;
  /** Attach to the Group as `elementRef`. */
  groupRef: RefObject<HTMLDivElement | null>;
  /** Attach to the Agent column's Panel as `panelRef`. */
  panelRef: RefObject<PanelImperativeHandle | null>;
  /** Attach to the Group as `onLayoutChanged`. */
  onLayoutChanged: (layout: Layout, meta: LayoutChangedMeta) => void;
}

/**
 * Holds the width the user dragged the Agent column to, and puts the column
 * back on it whenever the library moves it for its own reasons.
 *
 * The two branches of `onLayoutChanged` are the two facts of §5 of the design.
 * A user gesture is the only thing that writes the set width; everything else
 * (window resize, constraint recompute, mount) is the library arriving at a
 * width of its own, which we either accept — when it already matches what the
 * window allows — or resize away from.
 *
 * Both branches read the width out of the layout they are handed. The library
 * reports a layout change synchronously, before React has re-rendered, so the
 * panel's own `getSize()` is a step behind: a keyboard resize would store the
 * width from the previous keypress. Only the container width comes from the
 * DOM, read off the Group, whose size is an input to the layout rather than a
 * result of it.
 * @returns The four props the Group and the Agent Panel need.
 */
export function useAgentColumnWidth(): AgentColumnWidthControls {
  const [initialWidth] = useState(() => {
    try {
      return parseStoredWidth(
        window.localStorage.getItem(STORAGE_KEYS.agentColumnWidth),
      );
    } catch {
      // Reading throws outright where the browser keeps nothing — Safari's
      // private mode, site data switched off. This runs during render, so
      // letting it out takes the whole project page down for a width.
      return null;
    }
  });
  const setWidthRef = useRef<number | null>(initialWidth);
  const panelRef = useRef<PanelImperativeHandle | null>(null);
  const groupRef = useRef<HTMLDivElement | null>(null);

  const onLayoutChanged = useCallback((layout: Layout, meta: LayoutChangedMeta): void => {
    const panel = panelRef.current;
    const group = groupRef.current;
    if (!panel || !group) return;

    // Absent from the layout means the column is collapsed or the reader is a
    // viewer: no width to keep, nothing to restore.
    const share = layout[AGENT_PANEL_ID];
    if (share === undefined) return;

    // The handle is a flex item of the Group but not a panel, so the width the
    // two columns divide is the Group minus the handle. Zero means the Group
    // has not been measured yet.
    const panelsWidth = group.clientWidth - RESIZE_HANDLE_WIDTH;
    if (panelsWidth <= 0) return;
    const width = (share / 100) * panelsWidth;

    if (meta.isUserInteraction) {
      // The user moved the handle to here, so this is the width they want —
      // including when a narrow window is what stopped them.
      setWidthRef.current = width;
      try {
        window.localStorage.setItem(
          STORAGE_KEYS.agentColumnWidth,
          String(Math.round(width)),
        );
      } catch {
        // A full quota or a browser told to store nothing costs the width its
        // place in the next session; it is already held for this one above.
      }
      return;
    }

    const target = resolveWidth(setWidthRef.current, panelsWidth);
    if (shouldRestore(width, target)) panel.resize(target);
  }, []);

  return {
    defaultSize: `${initialWidth ?? AGENT_COLUMN_MIN_WIDTH}px`,
    groupRef,
    panelRef,
    onLayoutChanged,
  };
}
