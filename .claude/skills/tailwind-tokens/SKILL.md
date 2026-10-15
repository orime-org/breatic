---
name: tailwind-tokens
description: Use before writing Tailwind classes, adding or changing design tokens (colours, shadows, radius), editing `packages/web/src/theme/tokens.css` or scoped rules in `packages/web/src/index.css`, or judging colour contrast in packages/web. Covers which classes Tailwind 4 actually generates in this repo, how `cn()` merges them, and what each token family means.
---

# Tailwind and design tokens (packages/web)

Tokens live in `packages/web/src/theme/tokens.css`. `:root` holds the neutral ramp and the seven-colour palette; `@theme` holds everything Tailwind turns into utilities. Read that file's header comment before adding a token.

## Utilities exist only for theme variables

- **A colour utility, including any `/N` alpha modifier, exists only when its variable is a `--color-*` inside `@theme`.** For any other variable Tailwind 4 generates no rule and reports nothing, so the element silently falls back.
- **`--color-palette-*` lives in `:root`, not `@theme`, so `border-palette-blue` or `bg-palette-red/20` compile to nothing.** It is worse than a no-op: `cn()` still treats it as the later class of the same group and drops the real one, so `cn('border border-border', 'border-palette-blue')` leaves the border at `currentColor` (text colour). Use the `@theme` status aliases instead (`border-status-selected`, as `spaces/canvas/nodes/_shared/NodeShell.tsx` does), or an inline `style` with the palette variable.
  Check: is the variable behind this class declared inside `@theme`?
- **There is no bare `--radius-content`, so `rounded-content` silently does nothing.** The radius tokens are `--radius-content-{xs,sm,md,lg,xl}`, `--radius-chrome` (6px), `--radius-chrome-sm` (4px) and `--radius-overlay`. Grep `@theme` for `--radius-<name>` before writing `rounded-<name>`; for 6px use `rounded-content-sm` or `rounded-overlay`, never `rounded-[6px]`.
- **Stock `shadow`, `shadow-sm` and `shadow-md` are redefined with `@utility` near the end of `tokens.css`, because Tailwind 4's built-ins ignore `@theme --shadow-*`.** A new shadow token needs its own `@utility` block or the class keeps Tailwind's hard-coded value.
- **A bare `border` has no token colour in Tailwind 4; always pair it with `border-border` or another border token.** Without it the border is drawn in `currentColor`.

## How `cn()` merges classes

- **`cn()` (`src/lib/utils.ts`) dedupes a custom token class only if it is registered in its `extendTailwindMerge` config.** An unregistered one is not recognised as part of its group, both classes ship, and CSS source order decides (this is how `rounded-md` once beat `rounded-chrome`). Register every new radius or colour key there.
- **twMerge overrides only within one group, and every modifier forms its own group.** A custom `bg-*` on a `Button` replaces the variant's `bg-*` but not its `hover-enabled:bg-*`, so restate the hover too, written as `hover-enabled:` (a `hover:` class is a different group and loses to the variant).
- **Nested hover groups need names, because v4 `group-hover:` matches any ancestor with `group`.** Name the inner one (`group/asset` with `group-hover/asset:`; `pages/project/chat/CodeBlock.tsx` uses `group/code`). A unit test that reads class strings cannot see this; assert there is no unnamed `group`/`group-hover:`, or hover the outer ancestor in a real browser.
  Check: does an ancestor of the element I just gave `group` already have `group`?

## Choosing a token

- **Foreground on a coloured fill never uses `--neutral-*`, which flips with the theme.** Use a mode-independent foreground such as `--brand-fg` or the palette identity itself.
- **Form-control borders use `border-border`; `--color-input` is the Switch's off fill (`components/ui/switch.tsx`), not a border colour.** Fix the component, not the token value, because changing the value breaks the Switch.
- **Borders separate things within one plane, surface brightness says which layer, and shadow says elevation.** Shadows go only on real overlays (dialogs, menus, popovers), the switch thumb and a node being dragged; resting cards, sidebars, list rows, inputs, buttons and tooltips get none. A resting card with both a border and `shadow-sm` shows unequal top and bottom edges (`NodeShell.test.tsx` pins the absence). In the dark theme, lift with a brighter surface and a stronger ring rather than a shadow.
- **Name shadow and scrim "ink" tokens after the `--shadow-*` family (e.g. `--overflow-shade`), never `--color-*`.** repo-lint `token-values` treats every `--color-*` outside `palette|status|note|selection|comment|content-link` as a neutral surface (equal channels, between `#121212` and `#f5f5f5`) so a shadow's black-with-alpha fails as "darker than #121212". Only `pnpm lint:repo` and repo-lint's `token-values.test.ts` ("passes the real token file") report it, not typecheck or web tests, so run `pnpm lint:repo` after adding a token.
- **Browser autofill is already neutralised by the `input:-webkit-autofill` reset in `tokens.css`.** Autofill injects an `!important` box-shadow that covers the dark-theme surface; extend that reset for a new surface colour instead of patching single inputs.

## What contrast rules apply to

- **The 3:1 non-text contrast rule (WCAG 1.4.11) applies to input boundaries, focus indicators and selected states, not to decorative container, card or panel hairlines.** Do not darken or thicken container borders to reach 3:1; hairlines around 1.1–1.5:1 are intended.
- **Contrast math applies only to semantic colours that carry text; identity colours (group backgrounds, tags) are hand-tuned per theme with no formula.** The text-carrying values are already fixed, so do not recompute them. The locked error red is a package rule in `packages/web/AGENTS.md`.

## Scoped rules in index.css

- **Once a scope rule sits in `@layer`, any property that both the scope and its elements' utilities set belongs on the element.** A utility always beats the layered scope for that property: `.chat-markdown` keeps its line height in `MarkdownMessage`'s `SIZE_CLASS` (`chat-markdown text-sm leading-[1.65]`) because `text-sm` carries a line height of its own. The rule that scope rules must be layered at all is in `packages/web/AGENTS.md`.
