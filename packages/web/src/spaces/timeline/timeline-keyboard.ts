// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type { TimelineRate } from '@breatic/shared';
import { matchDuplicateShortcut } from '@web/spaces/canvas/canvas-duplicate-shortcut';
import { matchHistoryShortcut } from '@web/spaces/canvas/canvas-history-shortcut';

/** What one key press asks the Timeline editor to do. */
export type TimelineKeyAction =
  | { kind: 'undo' } | { kind: 'redo' } | { kind: 'duplicate' } | { kind: 'split' } | { kind: 'delete' }
  | { kind: 'toggle_snap' }
  | { kind: 'nudge'; frames: number }
  | { kind: 'change_track'; direction: 1 | -1; repeat: boolean };

/** The key event facts the mapper reads, testable without a DOM event. */
export interface TimelineKeyEvent {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  repeat: boolean;
  defaultPrevented: boolean;
  isComposing: boolean;
  keyCode: number;
}

/**
 * Map a key press to a Timeline editing action on both platforms (Cmd on macOS, Ctrl elsewhere).
 * @param event - The key press.
 * @param fps - The Timeline frame rate; Shift nudges one second rounded up to whole frames.
 * @returns The action, or null when a control already handled the key or nothing maps.
 * @throws {never} Never.
 */
export function timelineKeyAction(event: TimelineKeyEvent, fps: TimelineRate): TimelineKeyAction | null {
  if (event.defaultPrevented || event.isComposing || event.keyCode === 229) return null;
  const mod = event.metaKey || event.ctrlKey;
  if (mod) {
    const history = matchHistoryShortcut(event);
    if (history !== null) return { kind: history };
    if (matchDuplicateShortcut(event)) return { kind: 'duplicate' };
    if (event.key.toLowerCase() === 'b' && !event.shiftKey && !event.altKey) return { kind: 'split' };
    return null;
  }
  if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
    if (event.altKey) return null;
    const step = event.shiftKey ? Math.ceil(fps.num / fps.den) : 1;
    return { kind: 'nudge', frames: event.key === 'ArrowRight' ? step : -step };
  }
  if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
    return event.altKey && !event.shiftKey ? { kind: 'change_track', direction: event.key === 'ArrowUp' ? 1 : -1, repeat: event.repeat } : null;
  }
  if (event.shiftKey || event.altKey) return null;
  if (event.key === 'Delete' || event.key === 'Backspace') return { kind: 'delete' };
  if (event.key.toLowerCase() === 'n') return { kind: 'toggle_snap' };
  return null;
}
