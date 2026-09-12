// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { expect } from 'vitest';

/**
 * A row is one thing, so it is drawn as one: its own rounded fill rather than
 * a band reaching both walls of the panel, and no rule between it and the next
 * — the gap is what separates them (user 2026-09-12; the conversation list has
 * drawn its rows this way since #123).
 *
 * A rule between rows and a rounded block under one of them say the same thing
 * twice, and the rule wins wherever the block stops short of the wall.
 * @param el - The element carrying the row's own background and padding.
 * @throws {Error} When the row still draws a rule, or has no shape of its own.
 */
export function expectStandaloneRow(el: Element): void {
  expect(el.className).not.toMatch(/(^|\s)border-b(\s|$)/);
  expect(el.className).toMatch(/(^|\s)rounded-chrome(\s|$)/);
}

/**
 * The list holds its rows apart with a gap and keeps them off the panel's
 * walls, which is what lets each row read as its own block.
 * @param el - The list element the rows sit in.
 * @throws {Error} When the rows would touch each other or the walls.
 */
export function expectGappedList(el: Element): void {
  expect(el.className).toMatch(/(^|\s)gap-0\.5(\s|$)/);
  expect(el.className).toMatch(/(^|\s)px-2(\s|$)/);
}

/**
 * A row nothing happens to under the pointer takes no fill: the whole row is
 * not a target, and a fill would say it is (user 2026-09-12, on the activity
 * feed — it has no notion of chosen or current, and the only thing that can be
 * pressed is the button at its end).
 * @param el - The element carrying the row's own background.
 * @throws {Error} When the row lights up under the pointer.
 */
export function expectInertRow(el: Element): void {
  expect(el.className).not.toMatch(/hover:bg-/);
}
