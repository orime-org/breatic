// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/** Timeline key mapping on both platforms (inner#1708 E16, design §2.6). */

import { describe, expect, it } from 'vitest';
import type { TimelineRate } from '@breatic/shared';

import { timelineKeyAction } from '@web/spaces/timeline/timeline-keyboard';

type KeyEvent = Parameters<typeof timelineKeyAction>[0];

const FPS24: TimelineRate = { num: 24, den: 1 };
const NTSC: TimelineRate = { num: 30000, den: 1001 };

/**
 * A plain key press with every modifier off.
 * @param key - The key value.
 * @param fields - Modifiers and flags for this case.
 * @returns The event facts the mapper reads.
 * @throws {never} Never.
 */
function press(key: string, fields: Partial<KeyEvent> = {}): KeyEvent {
  return { key, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, repeat: false, defaultPrevented: false, isComposing: false, keyCode: 0, ...fields };
}

const PLATFORMS = [
  { name: 'Cmd', mod: { metaKey: true } },
  { name: 'Ctrl', mod: { ctrlKey: true } },
] as const;

describe.each(PLATFORMS)('timelineKeyAction with $name', ({ mod }) => {
  it('maps Z to undo', () => {
    expect(timelineKeyAction(press('z', mod), FPS24)).toEqual({ kind: 'undo' });
  });
  it('maps Shift+Z to redo', () => {
    expect(timelineKeyAction(press('Z', { ...mod, shiftKey: true }), FPS24)).toEqual({ kind: 'redo' });
    expect(timelineKeyAction(press('z', { ...mod, shiftKey: true }), FPS24)).toEqual({ kind: 'redo' });
  });
  it('maps Y to redo', () => {
    expect(timelineKeyAction(press('y', mod), FPS24)).toEqual({ kind: 'redo' });
  });
  it('maps D to duplicate and ignores Shift+D', () => {
    expect(timelineKeyAction(press('d', mod), FPS24)).toEqual({ kind: 'duplicate' });
    expect(timelineKeyAction(press('D', { ...mod, shiftKey: true }), FPS24)).toBe(null);
  });
  it('maps B to split and ignores Shift+B and Alt+B', () => {
    expect(timelineKeyAction(press('b', mod), FPS24)).toEqual({ kind: 'split' });
    expect(timelineKeyAction(press('B', { ...mod, shiftKey: true }), FPS24)).toBe(null);
    expect(timelineKeyAction(press('b', { ...mod, altKey: true }), FPS24)).toBe(null);
  });
  it.each(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'])('leaves %s with the modifier to others', (key) => {
    expect(timelineKeyAction(press(key, mod), FPS24)).toBe(null);
    expect(timelineKeyAction(press(key, { ...mod, shiftKey: true }), FPS24)).toBe(null);
    expect(timelineKeyAction(press(key, { ...mod, altKey: true }), FPS24)).toBe(null);
  });
  it.each(['Delete', 'Backspace', 'n', 'Escape'])('does not treat %s with the modifier as its plain action', (key) => {
    const action = timelineKeyAction(press(key, mod), FPS24);
    expect(action?.kind).not.toBe('delete');
    expect(action?.kind).not.toBe('toggle_snap');
  });
});

describe('timelineKeyAction without modifiers', () => {
  it.each(['Delete', 'Backspace'])('maps %s to delete', (key) => {
    expect(timelineKeyAction(press(key), FPS24)).toEqual({ kind: 'delete' });
  });
  it('maps N to toggle snapping', () => {
    expect(timelineKeyAction(press('n'), FPS24)).toEqual({ kind: 'toggle_snap' });
  });
  it('ignores Shift+N and Alt+N', () => {
    expect(timelineKeyAction(press('N', { shiftKey: true }), FPS24)).toBe(null);
    expect(timelineKeyAction(press('n', { altKey: true }), FPS24)).toBe(null);
  });
  it('leaves Escape to the drag library, which cancels an active drag itself', () => {
    expect(timelineKeyAction(press('Escape'), FPS24)).toBe(null);
  });
  it('maps N typed with Caps Lock on to toggle snapping', () => {
    expect(timelineKeyAction(press('N'), FPS24)).toEqual({ kind: 'toggle_snap' });
  });
  it('maps arrows to one-frame nudges, held or not (inner#1708 Q1)', () => {
    expect(timelineKeyAction(press('ArrowLeft'), FPS24)).toEqual({ kind: 'nudge', frames: -1 });
    expect(timelineKeyAction(press('ArrowRight'), FPS24)).toEqual({ kind: 'nudge', frames: 1 });
    expect(timelineKeyAction(press('ArrowRight', { repeat: true }), FPS24)).toEqual({ kind: 'nudge', frames: 1 });
  });
  it.each([
    { fps: FPS24, step: 24 },
    { fps: NTSC, step: 30 },
    { fps: { num: 25, den: 2 }, step: 13 },
  ])('maps Shift+arrows to one second of $step frames', ({ fps, step }) => {
    expect(timelineKeyAction(press('ArrowRight', { shiftKey: true }), fps)).toEqual({ kind: 'nudge', frames: step });
    expect(timelineKeyAction(press('ArrowLeft', { shiftKey: true, repeat: true }), fps)).toEqual({ kind: 'nudge', frames: -step });
  });
  it('maps Alt+Up and Alt+Down to a track change', () => {
    expect(timelineKeyAction(press('ArrowUp', { altKey: true }), FPS24)).toEqual({ kind: 'change_track', direction: 1, repeat: false });
    expect(timelineKeyAction(press('ArrowDown', { altKey: true }), FPS24)).toEqual({ kind: 'change_track', direction: -1, repeat: false });
  });
  it('carries a held Alt+arrow as a repeat (inner#1708 E4)', () => {
    expect(timelineKeyAction(press('ArrowUp', { altKey: true, repeat: true }), FPS24)).toEqual({ kind: 'change_track', direction: 1, repeat: true });
    expect(timelineKeyAction(press('ArrowDown', { altKey: true, repeat: true }), FPS24)).toEqual({ kind: 'change_track', direction: -1, repeat: true });
  });
  it('ignores a key that maps to nothing', () => {
    expect(timelineKeyAction(press('q'), FPS24)).toBe(null);
  });
});

describe('timelineKeyAction leaves consumed and composing keys alone', () => {
  const keys: KeyEvent[] = [
    press('ArrowLeft'), press('Delete'), press('n'), press('Escape'),
    press('z', { metaKey: true }), press('z', { ctrlKey: true }), press('b', { ctrlKey: true }), press('ArrowUp', { altKey: true }),
  ];
  it.each(keys)('returns null for a defaultPrevented $key', (event) => {
    expect(timelineKeyAction({ ...event, defaultPrevented: true }, FPS24)).toBe(null);
  });
  it.each(keys)('returns null for $key while composing', (event) => {
    expect(timelineKeyAction({ ...event, isComposing: true }, FPS24)).toBe(null);
  });
  it.each(keys)('returns null for $key with keyCode 229', (event) => {
    expect(timelineKeyAction({ ...event, keyCode: 229 }, FPS24)).toBe(null);
  });
});
