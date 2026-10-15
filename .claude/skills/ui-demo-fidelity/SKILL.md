---
name: ui-demo-fidelity
description: Use when building an HTML demo or mock for a packages/web UI change, when implementing UI from an approved demo, and when verifying an implementation against its demo in a real browser before the change is finished.
---

# From demo to implementation (packages/web)

The package rule is in `packages/web/AGENTS.md`: the demo decides function and geometric structure, concrete values come from our existing tokens, and a change with a demo is checked against it in the real app. This skill is how.

## Building a demo

- **Build a demo made for approval before implementation with shadcn components on Radix and Tailwind, React 19 loaded from esm.sh; never Headless UI or hand-written vanilla CSS.** The demo then uses the same building blocks as `components/ui/`, so its structure carries over. Every control in it must actually work.
- **In the importmap, `react`, `react/jsx-runtime`, `react-dom` and `react-dom/client` must resolve to exactly the URLs the Radix imports pin with `?deps=react@X.Y.Z,react-dom@X.Y.Z`.** Any difference in query string (`?dev`, a different version) makes esm.sh serve a second React, and the first Radix provider fails with `Cannot read properties of null (reading 'useState')`.
- **Refer to places in a demo by class name or section title, never by line number.** Any edit to the HTML shifts every line, and a stale line reference still looks precise.
  Check: am I about to write a demo line number?

## Implementing from a demo

- **Size things from the content users actually need to see.** Count the real data first (longest and typical length of that field); where it cannot be counted, say what is missing, pick a justified starting value and settle it in the real browser. Look at similar components in the repo to learn the scale of type, radius and spacing, not to cap yourself at values already used.
  Check: how much content does the user actually need to see in this element?
- **Demo pixels were typed in while drawing and never calibrated against the token system.** Copying them imports a second, uncalibrated set of values next to the one similar controls use; when a demo number looks wrong next to its real neighbours, fix the number in code.
- **A demo can say that an animation exists, when it starts and which state it ends in; it cannot fix speed, easing, delay, the feel of repeated use, or interruption and re-entry.** Those are settled in the running app: use it the way a reader would, tune until it feels right, and start from already-calibrated similar effects in the repo.

## Checking against the demo

- **List the decisions the demo makes and check each one in the real app: which elements share a row, which cell stays empty, how many states there are and what each looks like, which controls are usable in each state, and what a click does.** Measure positions and alignment with `getBoundingClientRect` and read applied styles (radius, borders) with `getComputedStyle`; use screenshots to see states. Concrete values are not on this list; they are checked against tokens.
- **"The class is in the code" does not count; measure the rendered result.** A table under `border-collapse` ignores cell `border-radius`, so the class is present and nothing is drawn (fix and other measuring traps: invoke `/web-layout-measure`, [SKILL.md](../web-layout-measure/SKILL.md#flex-truncation-and-text)).
- **Animations are walked through, not measured: open, stop, click repeatedly, switch away mid-way and come back, and judge whether it feels right.**
