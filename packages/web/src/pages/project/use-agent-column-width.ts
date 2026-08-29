// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { useCallback, useRef, useState } from 'react';
import type { RefObject } from 'react';
import type { Layout, LayoutChangedMeta, PanelImperativeHandle } from 'react-resizable-panels';

import { STORAGE_KEYS } from '@web/lib/storage-keys';
import {
  AGENT_COLUMN_MIN_WIDTH,
  parseStoredWidth,
  resolveWidth,
  shouldRestore,
} from '@web/pages/project/agent-column-width';

/** What the Agent column's Panel needs from this hook. */
export interface AgentColumnWidthControls {
  /** The Panel's `defaultSize`, in pixels. */
  defaultSize: string;
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
 * @returns The three props the Group and the Agent Panel need.
 */
export function useAgentColumnWidth(): AgentColumnWidthControls {
  const [initialWidth] = useState(() =>
    parseStoredWidth(window.localStorage.getItem(STORAGE_KEYS.agentColumnWidth)),
  );
  const setWidthRef = useRef<number | null>(initialWidth);
  const panelRef = useRef<PanelImperativeHandle | null>(null);

  const onLayoutChanged = useCallback((_layout: Layout, meta: LayoutChangedMeta): void => {
    const panel = panelRef.current;
    if (!panel) return;

    const { inPixels, asPercentage } = panel.getSize();

    if (meta.isUserInteraction) {
      // The user let go of the handle here, so this is the width they want —
      // including when a narrow window is what stopped them there.
      setWidthRef.current = inPixels;
      window.localStorage.setItem(STORAGE_KEYS.agentColumnWidth, String(inPixels));
      return;
    }

    // The library reports the panel's share of what the two panels divide, so
    // that share is also how we read the divisible width back out — no DOM
    // measuring, and the handle is already excluded the same way it is inside
    // the library. A zero share means the group has not been measured yet.
    if (asPercentage <= 0) return;
    const panelsWidth = (inPixels / asPercentage) * 100;

    const target = resolveWidth(setWidthRef.current, panelsWidth);
    if (shouldRestore(inPixels, target)) panel.resize(target);
  }, []);

  return {
    defaultSize: `${initialWidth ?? AGENT_COLUMN_MIN_WIDTH}px`,
    panelRef,
    onLayoutChanged,
  };
}
