// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/** Keys that move a Radix Slider by themselves. */
const STEP_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown']);

/**
 * Take a key on a Slider: a step key is one press of its own, started now and ended once the key's change, if any,
 * has run (Radix reports no change and no commit at a bound).
 * @param event - The key event.
 * @param begin - Starts the press.
 * @param commit - Ends the press and writes it.
 * @throws {never} Never.
 */
export function takeStepKey(event: Pick<KeyboardEvent, 'key'>, begin: () => void, commit: () => void): void {
  if (!STEP_KEYS.has(event.key)) return;
  begin();
  // Radix applies the step in the same keydown, after this handler: the press ends once that has run.
  queueMicrotask(commit);
}
