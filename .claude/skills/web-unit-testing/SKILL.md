---
name: web-unit-testing
description: Use before writing or fixing vitest/jsdom unit tests for packages/web (components, primitives, a11y assertions, DOM or storage stubs), and whenever you need to know whether any test in the repo really protects the code it claims to — when a test disagrees with the code, when checking coverage by deliberately breaking code (mutation), or when writing mocks and anti-drift tests.
---

# Unit tests (packages/web) and checking that a test protects anything

## The packages/web test environment

Unit tests run in jsdom (`jsdom` 29, `vitest` 3), not a browser. Where jsdom differs from a browser, the failure looks like a bug in your code.

- **Shared setup lives in `packages/web/vitest.setup.ts`; extend it instead of polyfilling per file.** It registers the `vitest-axe` matcher by hand (its `extend-expect` entry is empty), and stubs `ResizeObserver`, `IntersectionObserver`, pointer capture, `scrollIntoView` and `scrollTo` on `Element`, plus rects on `Node` and `Range`, which Radix, cmdk and ProseMirror reach for.
- **`vitest.config.ts` runs the whole package in one forked process with `isolate` on and `unstubGlobals: true`.** Modules are isolated per file but the jsdom document is shared, so DOM left in `body` by one file (e.g. an open dialog) is visible to the next; `vi.stubGlobal` is undone before every test, so never stub in `beforeAll` and expect it to last.
- **Primitive tests in `components/ui/__tests__/` follow one pattern: render without throwing, the token classes, the key ARIA, `className` overriding a default through `cn()`, and the ref or the primitive's specific behaviour.** Copy a neighbour when adding a primitive.
- **To assert calls to `scrollTo`/`scrollIntoView`, save the prototype's property descriptor, replace it with `vi.fn()`, and in `afterEach` restore the descriptor (or `delete` it if there was none).** Assigning `undefined` back leaves an own property on the prototype, and `'scrollTo' in element` then answers differently in every later file. `SpaceTabBar.test.tsx` shows the pattern. Without a stub, every test in the file fails on the missing method, which also makes a mutation check meaningless.
- **`vi.spyOn(window.localStorage, ...)` never fires in jsdom; replace the whole object with `vi.stubGlobal('localStorage', { getItem, setItem, ... })`.** A spy on the instance is silently bypassed and the test passes while the behaviour it claims never happened (`use-agent-column-width.test.ts` uses the working form).
  Check: would this test go red if my implementation had no try/catch?
- **Do not stub out the component whose wiring is under test.** `generate-tools.test.tsx` stubs `HoverPreview` as a props-dumping div, which is right for "what does the slot declare" and blind to whether Radix's `asChild` cloning reaches the button; `slot-hover-wiring.test.tsx` mounts the real component for that single question.
  Check: is the stubbed component the very thing the code under test has to connect to? If yes, write a separate file with the real one.

## a11y assertions

- **`expectNoA11yViolations` (`src/test-utils/a11y.ts`) reads only axe's `violations`; results axe declines to judge land in `incomplete` and pass silently.** With any modal open, `aria-hidden-focus` cannot fail. axe looks for that modal across the whole document, not the container you pass, and a nested `exclude` array is a cross-frame selector chain, not a list. The helper's TSDoc has the details; read it before changing the helper or excluding anything.
  Check: does this assertion actually evaluate the rule I think it does? Plant a real violation and see it go red.

## Is this test really protecting the code?

When a test and the code disagree, decide which one is wrong before editing either. The test for that is cheap: break the line the test claims to protect and run it.

- **Break the protected line on purpose: red means the test works and the code is wrong; still green means the test protects nothing and the test is what needs fixing.** Four shapes come up: the test claims to check A but checks B (fix the test); there is no test (add one); the test is red because the agreed spec changed (fix the test); the test is red because the code is wrong (fix the code; editing the test here is cheating).
  Check: have I verified that the test I am about to edit really protects what it claims?
- **Confirm the mutation reached the code that runs.** Tests that import `@breatic/shared`, `@breatic/core` or `@breatic/domain` from another package run their built `dist`, so mutating their `src` changes nothing until you build (the cross-package rule is in `AGENTS.md#testing`). If no test at all goes red, suspect the mutation first, then the test.
- **Break one branch at a time.** Rewriting a whole function to return a constant only proves the function is used; every `if/else` arm and every step of a fallback chain needs its own mutation.
  Check: did this mutation break exactly the branch I meant to check?
- **Mutate once per assertion named in the test title.** A test called "shows and accepts the pointer" needs one mutation for showing and one for accepting the pointer.
- **A mock's return value must have the same shape as the real function's return type.** `mockResolvedValue` accepts anything and typecheck only complains when you destructure a missing field, so a wrong-shaped mock lets the test assert on a shape production never produces. Open the replaced function's signature as soon as you write the mock.
- **A test written to stop two places drifting apart must import the value it pins from the code under test.** A copy typed into the test pins only the copy. Better still, assert on the real call path; an early signal is that the file's imports do not include the thing it claims to protect.
