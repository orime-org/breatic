// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

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
 * How much this rule covers at all is a separate matter, and it is less than
 * it looks. `aria-hidden-focus` includes a `focusable-modal-open` check, and
 * axe-core 4.11's `focusableModalOpenEvaluate` returns `undefined` — not a
 * failure — once `isModalOpen()` is true: with a modal up, focusable content
 * behind it is unreachable anyway, so axe declines to judge. An `undefined`
 * check lands the result in `incomplete`, and `toHaveNoViolations` reads only
 * `violations`. So whenever axe sees an open modal, this rule cannot fail a
 * test here, silently. Measured on one of these dialog suites run alone: a
 * planted `aria-hidden` violation came back `violations=0 incomplete=1`.
 *
 * Note that axe looks for that modal — `dialog, [role=dialog],
 * [aria-modal=true]`, visible on screen — across the whole document, not
 * inside the container passed here: `axe._tree` is built from
 * `ownerDocument.documentElement` regardless of include/exclude. A dialog left
 * in the body by an earlier file therefore counts.
 *
 * Which leaves one thing measured but unexplained. Run alone, these assertions
 * see zero violations even with the rule on, so axe is finding the dialog. In
 * a full package run, with exactly one `[role=dialog]` in the document and its
 * display, visibility and opacity identical, axe reports the guards — which it
 * can only do having stopped counting that dialog as an open modal. Some input
 * to axe's visibility walk differs between the two runs and has not been
 * found; ruled out are leftover DOM, the guards' attributes and computed
 * style, the guard nodes surviving across files (they do not — each file gets
 * fresh ones), style-sheet count (equal counts still fail), `@xyflow/react`'s
 * stylesheet (injecting it into a lone run changes nothing), and axe-core's
 * cache and teardown (resetting both changes nothing).
 *
 * So: excluding the guards is what keeps the full run — the one CI does —
 * reporting our own markup instead of Radix's. It does not make the rule
 * enforced in a single-file run; nothing here does.
 *
 * Flat, not nested. axe reads a nested array as a frame selector chain
 * ("this selector, inside that frame"), so `[['a', 'b']]` would quietly mean
 * "b inside frame a" rather than "a and b".
 */
const EXCLUDE_RADIX_FOCUS_GUARDS = ['[data-radix-focus-guard]'];

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
