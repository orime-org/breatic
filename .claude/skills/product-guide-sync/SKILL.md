---
name: product-guide-sync
description: Use when a change alters how users operate the canvas, the document space, the project page (top bar, tab bar, Space drawer, activity panel, left menu, viewport toolbar, sticky notes) or the chat panel — menu items, button placement or shape, gestures, shortcuts, panel contents, what a placement proposal looks like — so the Agent's product guide in packages/domain/src/agent/tools/product-guide.ts is updated in the same PR.
---

# Keeping the Agent's product guide true

The Agent answers "how do I do this" only from `packages/domain/src/agent/tools/product-guide.ts` (the `get_product_guide` tool, which reads it a section at a time: each `## ` heading is a section, and a call names sections from the index its description carries). It cannot see the user's screen, so whatever the guide says is what the user is told. Read the guide, find every sentence your change makes false, and fix it in the same PR.

## How the guide is split

**The guide is read one section at a time, so every section must make sense alone.** Adding, renaming or splitting a `## ` heading changes `INDEX` in `product-guide.ts` in the same edit (its group and a line saying when to read it); a new Space type also gets its sections in `SPACE_SECTIONS` in `__tests__/product-guide-sections.test.ts`. A sentence that points at other guide text names that section (`see the Node menus section`), never `above`, `below` or `next section`, since that section may not have been read. Each section stays within 24,000 characters in every locale; one call is capped by `product_guide_max_chars_per_call` in `config/agent.yaml`.

## What the guide may quote

**A quoted name in the guide is text the user sees on screen (a menu row, the words on a button, a tooltip that appears on hover), read from the catalog with `t("…")`.** A name that exists only in an `aria-label` or screen-reader-only text is invisible to the user (screen readers are out of scope); describe such a control by how it looks and where it is. A `title` shows on hover, so it counts as visible.

## What follows automatically

Only three kinds of change reach the guide without editing it:

| Change | Why it follows |
|---|---|
| The text of a catalog key the guide quotes | The guide renders that key |
| `canGenerate` / `canConnect` in `@breatic/shared` | The guide reads them at runtime |
| `CHAT_MESSAGE_MAX_CHARS` (`packages/shared/src/schemas/api.ts`) and `attachment_max_items` in `config/agent.yaml` | Read at runtime as well |

## What the tests catch

| Test | Catches |
|---|---|
| `packages/domain/src/agent/tools/__tests__/product-guide-covers-the-screen.test.ts` | Omissions. Every message id that appears in web files reachable by import from `src/index.tsx` and `pages/project/ProjectPage.tsx` (the route table `app/route-imports.ts` excluded, since it pulls in every page), in `@breatic/shared`, the agent tools, and the server, domain and core sources (the project page shows server sentences as they are) must either be rendered by the guide through `t("…")` or be listed in `NOT_QUOTED` in `__tests__/product-guide-coverage.ts` with how the guide describes it or why it is left out. A new on-screen string with no decision fails it. |
| `packages/domain/src/agent/tools/__tests__/product-guide.test.ts` | Facts it reads from web source and compares with the guide: the creatable node types (`node-factory.ts`), the rows and order of the node, group and multi-select menus and the block menu (every menu id written in source must be read), the viewport toolbar order, the file types the left upload picker accepts, which panels show the "no prompt needed" notice, and other source fragments it pins. Change one of them and the test fails until the guide changes too. |
| `packages/domain/src/agent/tools/__tests__/product-guide-sections.test.ts` | The section layout: every heading is in the index and reads back by its name, every Space type has sections, no section passes 24,000 characters in any locale, and every pointer between sections names a section the guide has, never a position. |
| `packages/web/tests/smoke/agent-product-guide.spec.ts` | The running check: asks the Agent real questions and compares the control names it gives with what the screen shows. |

**Everything else depends on you.** Text moved into an `aria-label`, a changed gesture, position, icon-only control, shortcut, or a behaviour change with the same text: no check reports any of these.
