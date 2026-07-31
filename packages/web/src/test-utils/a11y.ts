// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import axe from 'axe-core';
import { expect } from 'vitest';

/**
 * Per-call axe rule overrides. Use sparingly — only when a rule
 * triggers on a documented industry convention that is genuinely
 * accessible at runtime but trips axe's conservative static checks
 * (e.g. nested-interactive inside a tab close button — every major
 * browser tab bar does this).
 */
type RuleOverrides = Record<string, { enabled: boolean }>;

/**
 * Radix's focus guards, kept out of every scan.
 *
 * `@radix-ui/react-focus-guards` appends two bare
 * `<span data-radix-focus-guard tabindex="0">` straight to `document.body`,
 * and Radix's aria-hidden manager then marks everything outside the open
 * overlay — the guards included — `aria-hidden="true"`. axe sees a focusable
 * element hidden from screen readers and reports `aria-hidden-focus`. At
 * runtime nobody lands on a guard: it exists so a Tab reaching the edge of the
 * trap is redirected back inside, which is how focus traps are built.
 *
 * The markup is not ours and no change on our side reaches it — it is created
 * inside the library and appended to the body — so the scan skips those two
 * nodes rather than the rule. Turning the rule off instead was tried and is
 * wrong: a mutation that put `aria-hidden="true"` on a real dialog footer
 * holding two buttons still passed, so the assertion had gone blind to our own
 * markup. Excluding the nodes keeps the rule live for everything we write.
 *
 * What is left unexplained is narrower than "the guards misbehave", and worth
 * writing down because it also decides how much this rule covers.
 * `aria-hidden-focus` runs its `focusable-modal-open` check first: while a
 * modal is open, focusable content behind it is unreachable anyway, so the
 * rule reports nothing. axe decides "a modal is open" by looking for a
 * `dialog, [role=dialog], [aria-modal=true]` in the scanned tree that it also
 * considers visible on screen (axe-core 4.11 `isModalOpen`), and in jsdom that
 * is the only path to true — the fallback probes `elementsFromPoint`, which
 * jsdom does not implement usefully.
 *
 * Measured: on its own, this assertion sees zero violations even with the rule
 * on, so axe is finding the dialog. In a full package run, with exactly one
 * `[role=dialog]` present and its display, visibility and opacity identical,
 * axe reports the guards — which it can only do if it stopped counting that
 * dialog as an open modal. So some input to axe's visibility walk differs, and
 * it is not: leftover DOM, the guards' attributes or computed style, the guard
 * nodes surviving across files (they do not — each file gets fresh ones),
 * style-sheet count (equal counts still fail), `@xyflow/react`'s stylesheet
 * (injecting it into an isolated run changes nothing), or axe-core's cache and
 * teardown (resetting both changes nothing).
 *
 * The practical consequence: inside an open dialog this rule covers our markup
 * in a full run and is inert in a single-file run. Excluding the guards is
 * what keeps the full run — the one CI does — honest.
 */
const EXCLUDE_RADIX_FOCUS_GUARDS = [['[data-radix-focus-guard]']];

/**
 * Run axe-core against `container` and assert there are no violations.
 *
 * Layer B of the a11y CI plan — layer A (the jsx-a11y ESLint plugin) catches
 * static issues at build time; this layer catches the ones that only exist
 * once the component is rendered (Radix's missing description, a mis-wired
 * `aria-labelledby`, and the like).
 *
 * Calls axe-core directly rather than through `vitest-axe`'s wrapper: the
 * wrapper passes the container as the whole axe context, leaving no way to
 * express the exclusion above. The `toHaveNoViolations` matcher is unaffected
 * — it reads the same result object either way.
 * @param container - The element returned by Testing Library's `render()`;
 *   pass `document.body` when the component portals outside it.
 * @param extraRules - Per-call axe rule overrides merged on top of the defaults.
 * @returns A promise that resolves once the assertion has run.
 * @throws {Error} If axe fails to analyse the container.
 * @example
 *   it('has no a11y violations', async () => {
 *     const { container } = render(<TopBar {...defaultProps} />);
 *     await expectNoA11yViolations(container);
 *   });
 */
export async function expectNoA11yViolations(
  container: Element,
  extraRules: RuleOverrides = {},
): Promise<void> {
  const results = await axe.run(
    { include: [container], exclude: EXCLUDE_RADIX_FOCUS_GUARDS },
    {
      rules: {
        // Component-isolation tests don't render full pages with landmarks
        // (`<main>`, `<nav>`, etc.), so the `region` rule reliably false-
        // positives ("all content must be inside a landmark"). Disable it
        // here — landmark coverage belongs to page-level integration or
        // e2e tests where the full page chrome is present.
        region: { enabled: false },
        ...extraRules,
      },
    },
  );
  expect(results).toHaveNoViolations();
}
