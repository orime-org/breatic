import { axe } from 'vitest-axe';
import { expect } from 'vitest';

/**
 * Run axe-core against the given container and assert there are no
 * violations. Use this in a per-component test file to add a runtime
 * a11y invariant alongside the existing behavior tests.
 *
 * Layer B of the a11y CI plan — layer A (jsx-a11y ESLint plugin) catches
 * static issues at build time; this layer catches runtime issues (e.g.
 * Radix Missing Description, mis-wired aria-labelledby, etc.) once the
 * component is actually rendered.
 *
 * @param container — the root element returned by Testing Library's
 *   `render()` call. Pass the entire popup overlay element when the
 *   component renders into a portal outside `container` (e.g. dialog,
 *   popover, sheet) — use `document.body` instead.
 *
 * @example
 *   it('has no a11y violations', async () => {
 *     const { container } = render(<TopBar {...defaultProps} />);
 *     await expectNoA11yViolations(container);
 *   });
 */
/**
 * Per-call axe rule overrides. Use sparingly — only when a rule
 * triggers on a documented industry convention that is genuinely
 * accessible at runtime but trips axe's conservative static checks
 * (e.g. nested-interactive inside a tab close button — every major
 * browser tab bar does this).
 */
type RuleOverrides = Record<string, { enabled: boolean }>;

export async function expectNoA11yViolations(
  container: Element | string,
  extraRules: RuleOverrides = {},
): Promise<void> {
  const results = await axe(container, {
    rules: {
      // Component-isolation tests don't render full pages with landmarks
      // (`<main>`, `<nav>`, etc.), so the `region` rule reliably false-
      // positives ("all content must be inside a landmark"). Disable it
      // here — landmark coverage belongs to page-level integration or
      // e2e tests where the full page chrome is present.
      region: { enabled: false },
      ...extraRules,
    },
  });
  expect(results).toHaveNoViolations();
}
