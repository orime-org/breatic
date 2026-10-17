# packages/web

`@breatic/web` is the React front end and runs in the browser. These rules cover everything under `packages/web`; repo-wide rules are in the [root AGENTS.md](../../AGENTS.md). Read [docs/ARCHITECTURE.md#frontend](../../docs/ARCHITECTURE.md#frontend) when you need the implementation detail behind a rule here (node model, token bridge, scroll and overlay contracts).

## Package boundary
**Imports flow one way: `app → pages → spaces → features → stores → data → ui`, and `components`, `theme`, `i18n`, `lib` form one bottom group whose members may import each other.** The `web-layer-*` rules of `lint:dependency-cruiser` fail CI on an upward import; read [docs/ARCHITECTURE.md#layered-architecture](../../docs/ARCHITECTURE.md#layered-architecture) before moving code between layers.

**The only workspace package web source imports is `@breatic/shared`; inside the package every import uses the `@web/*` alias.** Core, server, worker and collab are Node code and cannot run in a browser.

**Configuration comes from `import.meta.env` (typed by `src/vite-env.d.ts`).** There is no `process.env` in the browser.

**`components/ui/` holds the shadcn vendor files; our own shared components live in the root of `components/` (e.g. `loading-screen.tsx`).** Vendor files carry no Orime header and `no-cjk` skips them. Components are PascalCase, hooks `useFooBar`, every other file and directory kebab-case; tests sit in a sibling `__tests__/`. Read [docs/ARCHITECTURE.md#naming-conventions](../../docs/ARCHITECTURE.md#naming-conventions) when you create a file.

**A Space is a type (a template), not a route: one Project page hosts many Space instances.** Spaces open inside `/project/:projectId/*`; a Space type never gets a route of its own.

**The agent chat panel is per-user and never bound to Yjs; only a GenerativeNode's prompt is collaborative.** Chat history belongs to one reader.

## Production standards
**Critical paths and invariants (StrictMode-safe resource hooks, Yjs collaboration, optimistic-update races) have 100% tests; markup is semantic, focus is visible and every action is keyboard-reachable; all copy is ICU in the five locales, never hard-coded; colours come from semantic tokens.** Raw brand colours are for the logo only; repo-lint `no-brand-usage` scans `src` `.ts/.tsx/.css` with comments stripped.

**A web change is done only after a real-browser pass in light and dark themes (plus collaboration and the auth flow when touched), the main flow walked by keyboard, and no bundle regression (`pnpm build && pnpm --filter @breatic/web verify:chunks`).** Unit tests do not see themes, focus order or chunk splits.

## Memoize what children receive
**`React.memo`, `useMemo` and `useCallback` are applied wherever a value or callback built during render reaches a child prop or a dependency array, even where no speed-up is measurable.** Every prop of a memoized component must be stable or the memo never bails, which is a defect; in high-frequency lists (canvas nodes) reuse the previous object for unchanged items. Check: is it rebuilt every render and passed down or into deps?

## Accessibility scope
**Screen-reader support is out of scope and keyboard, focus, contrast, errors and semantic HTML are in scope, as [the root rules](../../AGENTS.md#product-scope) define.** Answer screen-reader findings with that policy.

## Never render user HTML
**No user-controlled content reaches the DOM as markup; rendering user HTML needs an agreed protection design first.** Nothing on the chat path sanitizes, so markup would be live XSS. Check, both questions: am I putting user content in via `dangerouslySetInnerHTML`/`innerHTML`/`insertAdjacentHTML`/`document.write`? Am I handing it to a renderer that renders embedded HTML (e.g. `react-markdown` with `rehype-raw`)? `MarkdownMessage.tsx` is safe only while `rehype-raw` is in no `package.json`.

## Reuse components ui first
**Before writing any UI, of any kind (overlays, form controls, skeletons, badges, separators, avatars, empty states), grep `src/components/ui/` and use what is there.** Reuse the component itself, not its class names: copying `skeleton-shimmer` forks `Skeleton`'s implementation. When nothing exists, build it with the sizes, spacing, radii and colours the repo's siblings already use; count them first. Never hand-write an overlay or a `fixed inset-0` backdrop (inside the ReactFlow transform it positions against the transformed ancestor). Ask before adding a new shared primitive to `components/ui/`; one-off feature components need no approval.

## Vendor primitives
**When a vendor primitive's default styling conflicts with the design mock, change the vendor file in `components/ui/`; token naming follows ADR 14.** Do not run `shadcn init`: `components.json` and the token bridge are hand-written and `shadcn init` would overwrite them. Invoke `/radix-shadcn` ([skill](../../.claude/skills/radix-shadcn/SKILL.md)) before changing a primitive or an overlay.

**A third-party UI library is a candidate only if every visible part of it can take our styles and it composes with Radix and shadcn.** A library whose look we cannot fully replace does not enter the comparison at all.

## No native rendered controls
**Any interactive control whose look the browser or OS paints is forbidden; draw it ourselves.** Engines draw the same native control differently, and pixel consistency across engines is a product requirement. Check: does the browser or OS paint how this looks? Yes → self-draw.

| Native (forbidden) | Use |
|---|---|
| `<input type=color>` | react-colorful in a Radix Popover (`EmptyImageColorPicker`) |
| `<input type=range>` | `Slider` (`components/ui/slider`) |
| `<input type=date/time/…>` | a self-drawn picker, built in `components/ui/` first |
| bare `<select>` | `Select` (`components/ui/select`) |
| `<audio>`/`<video controls>` | `MediaPlayer` (`spaces/canvas/nodes/_shared/MediaPlayer.tsx`) |
| native scrollbar | `ScrollArea` (see the next rule) |
| browser autofill history dropdown | `autoComplete` on every text `<input>`/`<Input>`: `off`, or the matching token (`email`, `current-password`) |

ESLint `breatic/no-native-rendered-ui` enforces the JSX-detectable subset; a justified exception carries `native-ui:allow` plus the reason on the same line. `title=` used as a tooltip and native form-validation bubbles are also forbidden but have no guard.

## Every scroller is a ScrollArea
**Every visible scroll container, vertical or horizontal, is `components/ui/scroll-area.tsx` (`scrollbars` picks the axes); bare `overflow-auto/-scroll` scrollers and per-component scrollbar styles are forbidden.** The scroll behaviour contract is built into that component; ESLint `breatic/no-inline-scrollbar` enforces it. A scroller with a hidden bar uses `[scrollbar-width:none]`. Layout traps (centering inside the viewport, `flex-1` under `max-height`) are in `/web-layout-measure` ([skill](../../.claude/skills/web-layout-measure/SKILL.md)).

**Dialog height has two layers: the `dialog.tsx`/`alert-dialog.tsx` overlay scrolls and sets no `max-height`; a dialog whose length follows data pins its own height and scrolls inside a `ScrollArea`.** That keeps every dialog reachable in any viewport while headers and footers stay on screen. Check: does this dialog grow with data? Yes → own height plus inner scroller; no → set nothing.

**To scroll a container, compute against that container and call `scroller.scrollTo` (see `scrollTabToEdge` in `SpaceTabBar.tsx`); never call DOM `scrollIntoView`.** `scrollIntoView` moves every scrolling ancestor up to the document. Get the scroller from `ScrollArea`'s `viewportRef`. Check: which scroller am I moving? The details and the one exemption are in `/web-layout-measure`.

## Overlays
**An element carries at most one hover overlay; a tooltip and a `HoverPreview` never share a trigger.** Alternating them remounts the trigger or strands Radix state; put the empty-state text in `HoverPreview`'s `emptyHint`. Check: does this element already have a hover overlay? Yes → merge the content into it.

**A dropdown, popover or tooltip leaves a fixed visible gap from the surface it opens from, measured from the visible edge.** `sideOffset` measures from the trigger, so add any wrapping padding and border, or make a short trigger as tall as its row. Read the overlay-gap entry in [docs/ARCHITECTURE.md#key-conventions](../../docs/ARCHITECTURE.md#key-conventions) when setting an offset.

## Disabled controls
**Pick the disabled form by what a click should say.** Truly unavailable: HTML `disabled` with `cursor-not-allowed`, never mixed with `pointer-events:none`. Exists but a condition is unmet: `aria-disabled`, dimmed, normal cursor, and a click shows a toast saying why (HTML `disabled` fires no click or hover). Not built yet: `aria-disabled`, dimmed, `cursor-not-allowed`, no click handler, reason in a tooltip and the accessible name. Check: does a click have something to say? Is it "not now, because…" or "not built yet"?

## Every button is Button
**No hand-written `<button>` or `createElement('button')` in `packages/web`; use `Button` from `components/ui/button`.** One spelling lets every check see every button. `Button` passes through all button attributes, and `asChild` hands the element to the primitive that owns the trigger.

**Converting a raw `<button>` changes its spelling, not its look: keep `className` byte for byte and pass `variant={null} size={null}`.** cva applies defaults only for `undefined`. A button that already is a `Button` and whose look equals an existing variant uses that variant. Check: am I converting (→ `null`) or choosing a variant for a `Button` (→ the variant)? How to prove "equals" is in `/radix-shadcn`.

**`Button` hover styles use `hover-enabled:` (defined in `index.css`), in variants and at call sites.** It skips `:disabled` and `aria-disabled="true"`, so loading and disabled buttons do not react; `components/ui/__tests__/button.test.tsx` pins it.

ESLint `breatic/no-raw-button` scans `src/**/*.{ts,tsx}` and exempts only `components/ui/button.tsx`, `pages/_dev/` and tests. `components/ui/` as a whole is not exempt; `password-input` there is ours.

## Waiting buttons show loading
**A button whose press waits for the server uses the `loading` prop of `Button` (or `AlertDialogAction`) from press until the result is on screen; give its icon to `icon`.** A press with no visible wait invites a second press. Set the flag before the request and clear it on success and failure; wait only for the read that shows the result (see `absorb` in `use-studio-settings.ts`, `invalidateProjectListings` in `data/api/projects.ts`); track several buttons in one list per object (`mutationKey` + `useMutationState`, `lib/use-pending-keys.ts`); a confirm dialog stays open while waiting, closes on success, stays on failure. Check: does this press wait for the server? Yes → `loading`.

**Presses that create something or spend money (generate, understand, mini-tool run, new conversation, membership checkout or tier change, new project, credit checkout) run once: the wait lives in `runOnce` (`stores/task-actions-in-flight.ts`), the request carries an `Idempotency-Key` reused on resend, and the button reads `useRunning(intentId)`.** Reopening a panel must not allow a second run.

## Button borders
**A standalone text button gets `variant='outline'`, including a dialog's Cancel; when the surrounding menu row, card or tab strip already draws the frame, it draws none.** A borderless word does not read as a button. This is judged on screen and has no lint rule, because the container lives in another file. Check: standalone text? → `outline`; unsure → `outline`.

## Lines are one pixel
**Every border and focus ring is 1px and `ring-offset` is never used.** Thicker lines make the chrome noisy. A 2px line needs explicit approval for that one place; having a reason is not approval. ESLint `breatic/one-px-border` enforces it. Check: am I writing a border or ring wider than 1px? Then it is wrong.

## Neutral active borders
**A neutral (black/white/grey) border that marks selected, focused or active state is always `border-active-border` (`--color-active-border`), tab underlines included.** One token keeps every active state identical. Coloured semantic borders (`border-status-*`, palette colours) and the vendor files are outside this rule. ESLint `breatic/active-border` catches static class combinations; runtime-built ones rely on this rule. Check: is a neutral border saying "this is selected"? → `border-active-border`.

## Links in content
**A link inside content uses `color: var(--color-content-link)` plus an underline.** Rich text also has an underline mark, so colour separates links from text and the underline keeps colour from being the only signal. `src/theme/__tests__/content-link-contrast.test.ts` measures its contrast. Chrome links (navigation, breadcrumbs, button-like links) stay neutral. Check: is this link inside running text and must it read as clickable? → content-link plus underline.

## Locked colours and motion
**`--color-palette-red` and every `--color-status-error*` token are locked.** Only this red is locked; every other colour may be tuned. It measures 4.00:1 (light) and 3.87:1 (dark) on menu surfaces, below AA, because raising it to 4.5:1 turns the dark-theme red pink. A review that reports its contrast lists the finding in the review table and cites this rule.

**No component adds a `prefers-reduced-motion` fallback.** Motion is part of the product; keyboard, semantics and contrast still apply.

## Scope rules sit in a layer
**Every scope rule in `index.css` (`.scope el { … }`) is inside an `@layer`.** Unlayered rules beat every layered rule, including all Tailwind utilities, so utilities on elements inside the scope silently stop working. A property both the scope and its elements' utilities set belongs on the element. `chat-markdown-css.test.ts` guards only `.chat-markdown` and `document-body-layer-css.test.ts` only `.doc-body`'s layering; any other scope is unguarded. Check: is it in `@layer`? Does any property overlap with element utilities?

## Sizes follow content
**Widths and heights follow their content (`whitespace-nowrap` items in a content-sized container); a fixed value is used only when it is a product spec, such as the 288px canvas node.** A size fixed at the widest locale leaves gaps in the others. Verify in all five locales and both themes.

## Demo decides structure, tokens decide values
**An approved demo decides function and geometry; every concrete value comes from our existing tokens.**

| Decided by the demo | Decided by the product |
|---|---|
| logic, structure, which element sits on which row, which cell is empty, which states exist and how each looks | colours, semantic tokens, type steps, spacing scale, radii, control sizes |

Invoke `/ui-demo-fidelity` ([skill](../../.claude/skills/ui-demo-fidelity/SKILL.md)) when implementing from a demo and when checking a change against its demo in the real app.

## UI copy informs
**Interface text tells the user the current situation, briefly, with a clear action; it does not explain why.** "Currently unavailable" is short enough; reasons go in code comments, never in locale files. Existing long strings do not comply, so never copy them as a template. Check: does this sentence state what is happening, or explain why? Explaining → delete.

## Product terms are never translated
**The product nouns, role names and `Slug` stay English in every locale, inline in other languages too.** One name per thing across the product.

| Kind | Words |
|---|---|
| Entities / types | `Studio` `Project` `Collection` `Space` `Work` `Canvas` `Document` `Timeline` |
| Roles | `Owner` `Editor` `Viewer` `Admin` `Maintainer` `Guest` |
| Field | `Slug` (capitalised as a label; slug values stay lowercase because they are URL parts) |

ICU placeholders (`{studio}`) and URLs never change. repo-lint `no-translated-product-noun` and `src/i18n/__tests__/frozen-product-terms.test.ts` enforce it. Plural form, common-word homonyms and other copy detail: invoke `/web-i18n` ([skill](../../.claude/skills/web-i18n/SKILL.md)) before writing copy.

**Generation-panel control names (what is being set) are translated through locale keys; value names (what was chosen) are English only, in the model yaml's `value_labels` or `camera_commands[].name`.** Value names follow the model, and translating them would mean five translations per model. Check: does this word name the setting or the chosen value? Value → `value_labels`, English.

## Keyboard shortcuts on both platforms
**Every shortcut works on macOS (`Cmd`) and Windows (`Ctrl`): match `event.metaKey || event.ctrlKey` and test both paths.** Platform habits differ: redo is `Cmd+Shift+Z` on macOS and `Ctrl+Y` plus `Ctrl+Shift+Z` on Windows. References: `spaces/canvas/format-shortcut.ts` for labels, `matchDuplicateShortcut` for matching.

## Toasts have one entry
**Every toast comes from `import { toast } from '@web/lib/toast'`; never import from `sonner`.** The wrapper exposes only `error`, `warning`, `success`, `info` (plus `loading`, `promise`, `dismiss`, `custom`), so every toast has a type that the Toaster colours by `data-type`, and it de-duplicates by `type:message`; pass `opts.id` for a fixed id (node-gate toasts use `warnNodeGate`). A real failure is `error`; a guard blocking an action is `warning`. ESLint `breatic/single-toast-entry` enforces it outside `lib/toast.ts`, `components/ui/sonner.tsx`, `pages/_dev/` and tests.

## One TooltipProvider
**The only `TooltipProvider` is the one in `App.tsx` (`delayDuration={100}`); use `Tooltip`/`TooltipTrigger`/`TooltipContent` directly.** A nested provider changes timing for its subtree and splits Radix skip-delay grouping. TipTap NodeViews render through a portal and inherit it. ESLint `breatic/single-tooltip-provider` enforces it.

## Canvas overlays follow the viewport
**Any Radix overlay anchored to a canvas node (picker, tooltip, dropdown in generation or mini-tool panels) follows pan and zoom with `useFollowCanvasViewport(open)` (`spaces/canvas/generate/use-follow-canvas-viewport.ts`) plus `avoidCollisions={false}`; caret-anchored `@` overlays use floating-ui `autoUpdate({ animationFrame: true })`.** Radix repositions on scroll and resize but not on ancestor transforms, and ReactFlow pans by transform. References: `RatioResolutionPicker`, `ModelPicker`, `ImageModeToggle`, `HoverPreview` (`followCanvas`). Check: does this overlay open on the canvas anchored to a node or caret?

## Writes that must land skip frame scheduling
**Withdrawals, cleanup and leave notices are written immediately (`awareness.setLocalState`, `sendBeacon`, `fetch` with `keepalive`), never through `requestAnimationFrame`.** Hidden documents get no frames, and a throttler's "already scheduled" gate then swallows every later write. `spaces/canvas/use-publish-presence.ts` writes directly on `blur` and unmount, and `publish-throttle.ts` carries only droppable writes; `blur` alone covers app, window and tab switches. Check: must this write arrive? → write it now.

## Node state gating
**Every mutation entry of a canvas node (delete, upload, generate, edit content, move, rename) goes through `evaluateNodeGate` in `spaces/canvas/node-gate.ts`, keyed on state, never on node type.** A new modality inherits the gate by routing its entries through it.

| Operation | Node locked (`data.locked`) | Task in flight |
|---|---|---|
| move, rename, edit, upload, generate | blocked | allowed |
| delete | blocked | blocked |

**A blocked command entry (keyboard or menu delete, upload picker, panel run, double-click to edit, dragging a locked node or group) shows `toast.warning` through `NODE_GATE_TOAST_KEY`; it never silently does nothing.** The generation panel still opens on a locked node and only the run is blocked. A node with a task in flight cannot be a focus-crop source (`isFocusCandidate`). Check: does this change a node's content, position or existence? → `evaluateNodeGate`. Canvas details are in `/canvas-reactflow` ([skill](../../.claude/skills/canvas-reactflow/SKILL.md)).

## Group lock scope
**A Group lock freezes only geometry, structure (reparent-in, paste-into, ungroup, member removal) and the group's own identity; member content follows each member's own `data.locked`, and edges are never lock-gated.** The source of truth is the TSDoc at the top of `spaces/canvas/group-membership.ts`.

## Selection is the range
**In the document space a command acts on exactly the selected range: no trimming, no word expansion; spaces are content and vote on whether a mark is present; typing at the end of a formatted region continues it.** Toggle commands: all marked → shows on → click removes all; partly marked → shows off → click adds all. Cross-block selection is handled separately. Check: am I deciding the range from content? Early signals: `trim()`, `/^\s*/`, "all whitespace so it doesn't count" branches.

## Inputs send what they show
**What an input box displays is exactly what is sent; the program never performs an invisible action the reader did not ask for.** The reader cannot see the difference.

## Lists render from data
**Lists always render from data and show an empty state when empty; never hide a section because it is empty today.** Later data then needs no display change. Check: is this branch a special case for "no data today"? → delete it.

**The collab connection state is always visible (`ConnectionBanner`), and loading, error state, banner and toast stay four distinct notification forms.** Each tells the user something different.

**Refresh is the fallback for client/server version drift: show a prompt to reload and keep working; build no auto-refresh or recovery machinery.** The user can always refresh.

## Product guide follows the UI
**A change to how users operate the canvas, document space, project page or chat panel updates `packages/domain/src/agent/tools/product-guide.ts` in the same PR.** The Agent answers "how do I…" from that guide alone. Check: which sentence in the guide becomes false? Is each quoted name shown on screen as text? Invoke `/product-guide-sync` ([skill](../../.claude/skills/product-guide-sync/SKILL.md)) for what the guide may quote and which tests cover it.

## Tests and smoke
**`test:smoke` and `test:visual` exist only in `packages/web`: run `pnpm --filter @breatic/web test:smoke` (or `test:visual`).** From the repo root either fails with exit code 254 ("command not found"), which is not a test failure.

**E2E specs import from `playwright/test` (no `@`).** `@playwright/test` is not installed and fails with `Cannot find module`.

## Skills
| Invoke | Before |
|---|---|
| [`/tailwind-tokens`](../../.claude/skills/tailwind-tokens/SKILL.md) | writing Tailwind classes, tokens, colours, shadows, radii or `index.css`/`tokens.css` rules |
| [`/radix-shadcn`](../../.claude/skills/radix-shadcn/SKILL.md) | building or changing Radix/shadcn overlays, tooltips, popovers, dropdowns, sonner toasts or focus behaviour |
| [`/canvas-reactflow`](../../.claude/skills/canvas-reactflow/SKILL.md) | changing canvas nodes, handles and edges, canvas Yjs data, gating and locks, or panels on the canvas |
| [`/tiptap-prosemirror`](../../.claude/skills/tiptap-prosemirror/SKILL.md) | changing the prompt editor, reference chips, `@` suggestions, the document body, IME handling or y-prosemirror |
| [`/react-state-traps`](../../.claude/skills/react-state-traps/SKILL.md) | writing hooks, memoized values, React Query gates or mutations, Zustand stores, WS/SSE hooks or API helpers |
| [`/web-layout-measure`](../../.claude/skills/web-layout-measure/SKILL.md) | writing flex, truncation or scroll layouts, measuring geometry, or scrolling programmatically |
| [`/smoke-e2e`](../../.claude/skills/smoke-e2e/SKILL.md) | writing or running smoke/E2E specs or browser probes |
| [`/web-unit-testing`](../../.claude/skills/web-unit-testing/SKILL.md) | writing vitest/jsdom tests, a11y assertions or DOM and storage stubs |
| [`/web-i18n`](../../.claude/skills/web-i18n/SKILL.md) | adding or changing UI copy, locale keys, product nouns or generation-panel labels |
| [`/ui-demo-fidelity`](../../.claude/skills/ui-demo-fidelity/SKILL.md) | implementing UI from an approved demo or checking it against one |
| [`/product-guide-sync`](../../.claude/skills/product-guide-sync/SKILL.md) | changing how users operate the canvas, document space, project page or chat panel |
