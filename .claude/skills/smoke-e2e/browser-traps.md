# Browser driving traps

Read before writing a smoke spec, a visual spec or a one-off probe that drives the canvas, clicks overlapping nodes, measures geometry, screenshots after a click, asserts that something stays hidden, reads module state from the page, or fakes an agent stream.

## Driving the canvas

**Drag a connection with a `MouseEvent` sequence, not pointer events.** xyflow's `Handle` binds its connect gesture to `onMouseDown` / `onTouchStart`, so a synthetic `PointerEvent` never starts it. Dispatch `mousedown` on the handle, `mousemove` on `document`, then `mouseup` on the target.

**Pin pane-click behaviour with a jsdom unit test.** A synthetic pointer has no active pointer id, so xyflow's pane `setPointerCapture` throws `NotFoundError` and `onPaneClick` is never reached in a real browser, while jsdom takes the real React path.

**d3 drag, box select, multi-select and wheel zoom on the canvas cannot be driven by automation.** d3 ignores synthetic events, and a CDP drag moves one node at most. Cover those gestures with a unit-level reproduction and say in the report that the browser run could not drive them.

**Before clicking a canvas node, confirm the click lands on it.** Nodes placed together overlap by a fixed offset, so the centre of the lower one can sit inside the upper one.

```js
const hit = document.elementFromPoint(x, y)?.closest('.react-flow__node')?.getAttribute('data-id');
// hit !== intended id → pick a point on the uncovered strip instead
```

Then assert that the value filled in belongs to that node, not merely that a slot was filled.

Check: is the node under this point the one I mean to click?

**Seed canvas content through the Space's Yjs document, not through the UI.** The node library, context menu and empty-image panel live in overlays that follow the viewport and must each become stable first. Create the Space with `createSpace` (`tests/helpers/space.ts`), then call `addNode` from the page's own copy of `data/yjs/canvas-space.ts`, with a data-URI PNG as content so nothing is fetched.

**Import app modules inside the page only through `liveModuleUrl` (`tests/helpers/live-module.ts`).** Vite serves each module under a versioned URL, and importing the bare path evaluates a second copy whose maps and singletons are empty. After importing, read one value you know is non-empty (such as the document's Space count); an empty answer means you opened the wrong copy and every reading is void.

## Focus and visibility

**Under automation a background tab keeps focus and visibility.** With CDP, switching tabs leaves `document.hasFocus()` true and `visibilityState` `visible`; in headless Chromium every page is visible and `bringToFront` sends no `blur`. To test leave-the-tab behaviour, dispatch it yourself:

```js
window.dispatchEvent(new Event('blur'));
```

**Playwright's Chromium never restores a page from the back-forward cache.** `page.goBack()` reloads (`pageshow` has `persisted: false`), so a smoke "back" asserts the reloaded state; logic that depends on a `persisted` `pageshow` is pinned by a unit test that dispatches the event.

**Headless Chromium never triggers `loading='lazy'`.** Agent-column thumbnails (`AssetRow`) stay grey; run probes that need real images, such as visual-review screenshots, with `--headed`. Geometry and style probes can stay headless.

## Timing

**`page.mouse.wheel` waits for the page between events, so a busy page leaves gaps over 100 ms inside one gesture.** Logic that ends a gesture after a quiet period then sees two gestures. To send one gesture, dispatch the events synchronously inside the page:

```js
await locator.evaluate((el) => {
  for (let i = 0; i < 20; i += 1) el.dispatchEvent(new WheelEvent('wheel', { deltaY: 40, bubbles: true, cancelable: true }));
});
```

**"waiting for element to be visible, enabled and stable" lists the checks that have not passed yet, not a property that is changing.** Read the element's `disabled`, its `getBoundingClientRect()` and `elementFromPoint` at its centre once each before guessing which one failed.

**A screenshot taken right after a click captures a colour transition mid-way.** Wait with a retrying assertion such as `await expect(row).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')`, and decide which row is open from `aria-expanded`, never from the picture.

**An assertion that something stays hidden passes at the start of a transition.** An element fading in still reads `opacity: 0` at the first frame. Wait at least one transition length before asserting the hidden value.

**Measure overlay geometry only after its open animation has settled.** `components/ui/popover` and the other `animate-in` overlays (dropdown, dialog, tooltip, sheet) zoom from 95 %, and `getBoundingClientRect` measures the transformed box, so every size reads about 1 % small. Computed font sizes and paddings are unaffected.

```js
await page.waitForFunction((sel) => {
  const el = document.querySelector(sel);
  return el && getComputedStyle(el).transform === 'matrix(1, 0, 0, 1, 0, 0)';
}, selector);
```

Check: was the element still moving when I took this number?

## Fake data

**A faked agent stream must open exactly like the server's.** The real stream opens with a transient heartbeat, then the non-transient `data-conversation-titled` frame, then a `start` with an id; the SDK pushes the reply message on the title frame. Build the opening with `turnOpens()` from `packages/web/src/test-utils/chat-wire.ts`, in unit tests and smoke alike.

Check: are the first frames of my fake stream the ones the server sends?

**A held request from a run-once press (new project, generate, checkout) is answered with a 4xx, and its route stays in place until the case ends.** `runOnce` (`stores/task-actions-in-flight.ts`) resends the same request after a 5xx without `Idempotency-Status` or no answer at all, and `page.unroute` lets requests still held go on to the server, so the resend creates the real thing on the slot's account.

Check: if this held press is sent again, where does the resend go?

## Signing in

**Do not sign in from inside a case.** Pages open signed in as the slot's first account through the `test` exported by `tests/helpers/slot.ts`, and every sign-in counts against the `login` limit in `config/rate-limits.yaml`, which the whole suite shares. Only a case whose subject is switching accounts signs in itself.
