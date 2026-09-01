// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { expect } from 'vitest';

/**
 * The fill a chosen item takes where hoverable siblings share the screen with
 * it: one step past hover in the same direction (light darker, dark lighter),
 * so the pointer landing on a neighbour never makes it look like the chosen
 * one (DESIGN.md §5.3, user 2026-08-31).
 */
const CHOSEN = /(^|\s)bg-accent-strong(\s|$)/;

/** The hover fill a sibling reaches for. */
const HOVER = 'hover:bg-accent';

/**
 * The plain accent fill. It is hover's own colour, so on a chosen item beside
 * hoverable siblings it says nothing the hover does not already say.
 */
const PLAIN = /(^|\s)bg-accent(\s|$)/;

/**
 * Asserts an element reads as the chosen one among hoverable siblings.
 * @param el - The element that is currently chosen.
 * @throws {Error} When it carries hover's own fill instead.
 */
export function expectChosenFill(el: Element): void {
  expect(el.className).toMatch(CHOSEN);
}

/**
 * Asserts an element reads as a sibling the pointer can still light up.
 * @param el - An element beside the chosen one.
 * @throws {Error} When it carries a chosen fill, or offers no hover at all.
 */
export function expectHoverableSiblingFill(el: Element): void {
  expect(el.className).toContain(HOVER);
  expect(el.className).not.toMatch(CHOSEN);
  expect(el.className).not.toMatch(PLAIN);
}

/**
 * Asserts a group whose choice is drawn by an attribute selector: every option
 * carries the same class list and `aria-current` is the only thing that tells
 * the chosen one apart, so the chosen fill has to sit inside the modifier
 * rather than beside it.
 * @param el - Any option of the group, chosen or not.
 * @throws {Error} When the modifier still draws hover's own fill.
 */
export function expectAriaCurrentChosenFill(el: Element): void {
  expect(el.className).toContain('aria-[current=true]:bg-accent-strong');
  expect(el.className).not.toMatch(/aria-\[current=true\]:bg-accent(\s|$)/);
  expect(el.className).toContain(HOVER);
}
