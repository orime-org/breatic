---
name: tiptap-prosemirror
description: Use before changing a TipTap / ProseMirror editor in packages/web — the canvas prompt editor and chat composer (reference chips, `@` suggestions, chip caret and deletion), the BlockNote document body and its CSS, input-method (IME) handling, drag and drop inside an editor, y-prosemirror / y-tiptap collaboration (remote carets, undo selection, positions across transactions), or tests that drive editor keys and focus.
---

# TipTap, ProseMirror and BlockNote traps

Each entry says when it breaks and what to do instead. Paths are relative to `packages/web/src/`. Versions referred to: `@tiptap/core` 3.29.2, `@blocknote/core` 0.54.0 (see `pnpm-workspace.yaml`).

## Reference chips and mention suggestions

### Chips are live projections of their source

**Everything a reference chip shows or sends (body, hover preview, backend serialisation, surviving a paste into another node) is a projection of the source node's current pool row, for every modality.** How a field stays in sync depends on its cost, not on the modality: a small stable value (URL, name) is stored as an attribute and synced by an effect; a large single-truth value (a text body) is read live when viewed and never frozen into an attribute, or Yjs syncs it redundantly and the two copies drift. A new modality then needs no per-field patch.

### Chip whitespace and the cursor model

**Every chip has a real U+0020 space on each side, and the cursor only rests on the side of an owned space away from its chip.** A caret next to an inline atom with no adjacent text node loses caret affinity at soft wraps, has no IME host, and the pointer mis-hits the gap; a real space fixes all three, where an `img` or zero-width-space anchor cannot. `features/reference-mention/reference-mention-whitespace.ts` holds the pure planners (`planWhitespaceInsertions` only adds, idempotently; neighbours share one space), and `reference-mention-caret.ts` wires them: arrows cross a chip and its spaces in one press (`findNextStoppable`, `isStoppable`; a shared space stops on the left only), `handleClick` snaps to the nearest stoppable position, and `normalizeSelection` catches programmatic landings.

**Deletion follows the direction of the key and takes a chip with its owned spaces as one unit (`resolveDeletionUnit`).** With two chips sharing spaces, one shared space is absorbed and the cascade is judged on the merged run's ends, or a double space reaches the backend prompt. The node-selection delete branch runs before the modifier-key gate. Test any rule that depends on a neighbour being a chip with runs of two or more and with separated groups.

A space at the start of a soft-wrapped line before a chip is dropped by the browser: the line-break opportunity around an `inline-flex` atom ignores NBSP, an inline decoration across [space, chip] is split into two wrappers, and `display: inline` loses chip truncation. This is a CSS limit and is accepted; do not try again.

### Dragging past a trailing chip

Chrome and WebKit refuse to extend a native selection past a non-editable inline element at the end of a line (a browser bug acknowledged upstream by ProseMirror; it reproduces in a bare contenteditable). The trailing chip space above prevents that position, which is why the earlier separator `img` anchors and the custom mouse-drag takeover were removed. **Do not reintroduce separator anchors or a mousedown selection takeover.** `handleClick` and the arrow handling are part of the cursor model, not of that takeover, and stay.

### Soft-wrap caret affinity is a browser limit

A model position at a soft-wrap boundary has two visual places (end of the line, start of the next), and the browser chooses which one a real click lands on; the caret may draw one line off while typing and the model stay correct. It happens with plain text too, synthetic events cannot reproduce it, and the only mitigation (forcing upstream in `selectionchange`) flickers and risks a loop with `selectionToDOM`. **It is accepted; do not chase it as a chip bug.**

### Suggestion items with outside state

**A list whose rows depend on state outside the prompt document (the node's mode, its reference pool) is recomputed from live getters on every show path.** `@tiptap/suggestion` re-runs `items()` only when the query or range changes, so a mode toggle never refreshes an open or re-shown list. `spaces/canvas/generate/reference-mention-suggestion.tsx` reads `getPool` and `getUsabilityContext` on every call, and the shared list in `features/reference-mention/mention-suggestion.tsx` re-resolves through `resolveList` on re-show and through `refreshRef` when outside inputs change. Do not dispatch an empty transaction to force a re-run: the plugin bails, and `{ exit: true }` marks the range dismissed so clicking back never reopens it.

### Hide the popup, do not exit the suggestion

**To close the `@` list temporarily (click outside, focus elsewhere), hide its element; call `exitSuggestion` only to end the suggestion for good.** `exitSuggestion(view)` marks the current `@` range permanently exited, so further typing there never reopens the list until the editor remounts. Breaking the match (a space, deleting the `@`, leaving the range) exits on its own.

### Popup visibility follows local input only

**Whether the `@` list shows is driven only by the local user's own input, recognised positively per transaction.** `features/reference-mention/reference-mention-local-input.ts` judges each transaction in plugin `apply`: appended follow-ups keep the root's verdict, a machine edit is never input, a doc change or a selection change (a caret placement counts) is input unless it carries the `ySyncPluginKey` meta or is a history transaction. Re-showing waits for the transaction to settle (`editor.on('transaction')`) and a click shows the list only when `posAtCoords` agrees with the selection; a focus handler with a timer runs before the click's selection lands and flashes.

### Machine edits go through dispatchMachineEdit

**Every edit the user did not type (syncing a chip thumbnail, removing chips after an edge is deleted, caret normalisation, drop restoration) is dispatched with `dispatchMachineEdit(view, tr)`.** It sets `addToHistory: false`, without which Cmd+Z undoes the machine change instead of the user's edit (and an effect gated on a non-document input never heals it), and it tags `MACHINE_EDIT_META` so the change can never re-open a dismissed popup. The canvas undo stack excludes machine edits through `trackedOrigins`; the prompt editor relies on this function.

### Chip cursor is explicit

**Inline atoms set `cursor: default` on themselves and their descendants.** `cursor` inherits, and `contentEditable=false` only affects how `cursor: auto` resolves, so the editor's `cursor: text` shows an I-beam over the chip and its thumbnail.

### NodeView props that read outside state

**A NodeView value that depends on state that is not its own attribute is read from a live getter when it opens, not at render.** A ReactNodeView re-renders only when its attributes change, so a value computed in its body (a hover preview's dimmed state that follows the node's mode) stays at its value from insertion. Pass the getter down and read it in `onOpenChange(true)`.

### Node decorations land on the outer wrapper

**`Decoration.node(..., { class })` puts the class on the NodeView's outer wrapper (`.react-renderer.node-<name>`), so CSS reaches the inner element with a descendant selector.** Write `.reference-mention--range-selected .reference-mention`, not `.reference-mention.reference-mention--range-selected`; an opaque inner pill otherwise hides the highlight. A unit test of the decoration's range cannot see where the class lands.

### Floating mention list on the canvas

**The `@` list is positioned with floating-ui directly and its middleware is `[offset(6)]` only.** `flip()` and `shift()` move the list away from the caret to stay on screen, so near a viewport edge it detaches from its `@`; on the canvas the list should stay anchored and clip. It follows the canvas through `autoUpdate({ animationFrame: true })` (`features/reference-mention/mention-suggestion.tsx`). To verify, measure `popup.x - caret.x` and `dy` in at least three positions (centred, caret past the bottom edge, caret past the left edge) with a long list; they must all match.

## ProseMirror mechanics

### preventDefault skips ProseMirror's own handlers

**Calling `preventDefault` in a `handleDOMEvents` handler makes ProseMirror treat the event as handled, even if the handler returns false.** `runCustomHandler` returns `handler(view, event) || event.defaultPrevented`, so the built-in mousedown tracking and click selection never run. To suppress the browser default while keeping ProseMirror's logic, record and restore instead (as the caret plugin's mousedown does).

### appendTransaction later rounds see only new transactions

**Several structural fixes that react to the same original transaction are combined into one appended transaction.** After a plugin appends, its next `appendTransaction` call receives only the transactions added since, not the original with its `uiEvent` meta, so a chain of passes over one original stops after the first. Apply the steps in descending position order so they do not interfere.

### Esc consumption is layered

**Only one handler owns an Esc press: whoever calls `preventDefault`.** `defaultPrevented` is one bit shared by the tooltip capture layer, the `@` suggestion and inline rename editors, so a window-level handler cannot tell which one consumed it; skipping it when a tooltip is present, or tagging events from one consumer, lets one key press do two things. With a tooltip open, the user presses Esc once more.

### Input-method Enter is claimed by queue order

**The Enter that confirms an input-method candidate is claimed by marking `compositionend` and releasing the mark with `setTimeout(0)`, never with a time window.** Chrome sends `compositionend` and then the key twice (keyCode 229, then 13); without a claim the second one splits the block. Keydowns from the same keystroke are already queued ahead of the release, a press the user makes later is queued behind it. Use `lib/composition-end.ts` (`compositionEnd`, `keyBelongsToInputMethod`); do not clear the mark inside the Enter handler, which lets the second keydown through.

## Collaboration

### Positions across transactions use Y.RelativePosition

**Plugin state that must keep a position across transactions stores a `Y.RelativePosition`, not an absolute position mapped through `tr.mapping`.** y-prosemirror applies every Yjs-origin change (remote edits, yUndo / redo) as one whole-document `ReplaceStep`, which collapses every mapped position to the edges. Test with two real `Y.Doc`s exchanging updates; a local `insertText` standing in for a remote edit maps exactly and passes falsely.

### Undo restores the selection

y-prosemirror hands the pre-edit selection over on `stack-item-popped`, which yjs emits after the undo transaction has run, so undo leaves the caret at the undo-time position. **Selection restore goes through `CollabUndoSelection` (`features/collab-editor/collab-undo-selection.ts`, canvas prompt and text nodes) and `spaces/document/document-undo-selection.ts` (document body).** They read `undoManager.currStackItem` on `beforeObserverCalls` and clear the late write afterwards.

### Plugin keys by identity, not by name

**Code that reads y-sync or y-undo plugin state or meta imports the keys from `features/collab-editor/collab-plugin-keys.ts`.** The bundle loads both `@tiptap/y-tiptap` (prompt, text nodes) and `y-prosemirror` (document body via BlockNote); both ask for `y-sync` and `y-undo`, the second gets a `$1` suffix, and a lookup by name silently misses. `__tests__/single-y-tiptap-copy` keeps the imported key the same object the extensions register.

### Remote selection over chips

**The collaboration selection renderer (`renderCollabSelection` in `features/collab-editor/caret-render.ts`) only sets the `--collab-selection-bg` variable; CSS paints it.** The remote-selection class lands on the chip's square outer wrapper, so a direct background draws a box over the rounded pill. `index.css` paints plain-text selection with `:not(:has(.reference-mention))` and gives the pill its own rule; custom properties inherit through any NodeView depth.

### Remote caret at document start

**A remote caret that is a direct child of `.ProseMirror` is taken out of flow (`.ProseMirror > .collaboration-carets__caret { position: absolute }` in `index.css`).** At the very start of the document the caret widget sits before the first block, and an inline element there creates an anonymous line box that pushes everything down by an empty line. The child combinator leaves carets inside paragraphs alone.

## Drag and drop

### Draggable atoms need a drag handle

**A draggable atom node has `draggable: true` in its spec and `data-drag-handle` on the whole NodeView wrapper.** TipTap's `NodeView.stopEvent` kills every drag event for a non-draggable spec, and for a draggable one still requires the mousedown to land inside `[data-drag-handle]` (`spaces/canvas/generate/reference-mention.tsx`). With the spec draggable, a drag that starts inside the selection drags the whole selection; a child with `draggable=false` (the thumbnail) does not block the ancestor drag source. A drop's slice also passes through `transformPasted`, so a paste transform applies to drops too.

### Drag events across browsers

**Normalise a pointer or drag event's target to an element before checking it.** Chrome fires `dragstart` on the Text node under the pointer, so an `instanceof Element` guard silently skips the handler (`reference-mention-caret.ts` maps Text to its parent). Safari moves the real document selection to the drop caret while hovering, so ProseMirror's move-delete deletes nothing and a move becomes a copy; record the source at `dragstart` (as a relative position) and restore it in `handleDrop` before ProseMirror's own drop logic.

### Drag preview styling

**A drag preview clone copies font longhands (`fontFamily`, `fontSize`, `fontWeight`, `lineHeight`, `color`), never `computed.font`, and puts translucency on an inner element.** Chrome often returns an empty `font` shorthand (assigning it is a no-op and the clone falls back to body text), and Chrome ignores opacity on the drag image's root (Safari honours it). The drag image is drawn by the OS, so only a person looking at it can verify it.

## BlockNote document body

### BlockNote pseudo-elements are taken

**Before drawing a pseudo-element on a BlockNote block, read every declaration `@blocknote/core/style.css` already puts on it.** `.bn-block-content::before` carries list bullets and heading numbers, so a decoration (a quote bar) goes on `::after`; and `::after` already carries the empty-block placeholder (`.bn-block-content:has(.ProseMirror-trailingBreak:only-child)::after { margin-inline: -2px }`), so your rule sets `margin-inline: 0` or it shifts by 2px next to empty blocks only.

### Safari IME and position relative

WebKit's contenteditable deletes an element that becomes empty during a composition when it has `position: relative`; BlockNote sets that on `.bn-block-group .bn-block-group > .bn-block-outer`, so only indented rows split into two while typing with an input method in Safari. Upstream does not fix it, and the document editor installs `prosemirror-safari-ime-span` once per editor through `spaces/document/document-safari-ime.ts`. Check: an IME oddity in Safari that affects only some rows? Look at which selector gives those elements `position: relative`.

### Moving a mounted editor moves its portal

**When a mounted BlockNote editor is moved to another container, `editor.portalElement` moves with its surface.** `BlockNoteEditor.mount()` appends the portal to the parent only once, so after a Space switch the side-menu handles render outside the page with no error. `adoptDocumentEditor` (`spaces/document/document-editor-cache.ts`) moves both; after the first mount the container's children are `[surface, portal]`.

### Hide a container, do not unmount it

**To make a container step aside while something else renders through it, make it invisible (`invisible pointer-events-none`); do not unmount it or let a plugin remove its element.** A `FloatingPortal` changes only DOM position, not React ownership, so unmounting the container takes every portal it hosts (a link panel, its buttons) out of the page as well. jsdom keeps the children and unit tests stay green; pin it with a browser test, plus a unit assertion on the class name. `spaces/document/SelectionBubbleBar.tsx` steps aside this way (`standingAside`).

### Document body CSS layer

**Every `.doc-body` rule in `index.css` lives in `@layer components`, except the four `::selection` rules and the gap-cursor colour (`.doc-body .ProseMirror-gapcursor::after`).** Those face the unlayered stylesheet `@tiptap/core` injects into `<head>`, and a layered rule never beats an unlayered one (the gap cursor would stay a black line in dark mode). Two rules without `.doc-body` must sit in the same layer as the body rules, because the body's overrides of them depend on in-layer specificity and order: the collaborator selection band (`.collaboration-carets__selection:not(:has(.reference-mention))`) and the link panel's selection stand-in (`[data-show-selection]`). `spaces/document/__tests__/document-body-layer-css.test.ts` enforces the layering with postcss; it does not check properties shared with utility classes.

## Tests and verification limits

### Drive keys through handleKeyDown

**A test of what a key press does dispatches through `view.someProp('handleKeyDown', ...)`, never `editor.commands.keyboardShortcut`.** `keyboardShortcut` captures the transaction, splits it into steps and re-applies each with `maybeStep`, which silently drops steps that no longer apply; a multi-step command such as `splitBlock` loses a block with no error.

```ts
const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
editor.view.someProp('handleKeyDown', (f) => f(editor.view, event));
```

### Focus from a chain lands a frame later

**After `chain().focus()`, a test waits one animation frame before focusing anything else.** TipTap focuses in the next `requestAnimationFrame`, which otherwise steals focus back and fails under a parallel full run. Wait with `await act(() => new Promise((r) => requestAnimationFrame(() => r())))`.

### Synthetic mouse events cannot drive drag selection

**ProseMirror's native drag selection cannot be reproduced with synthetic `MouseEvent` sequences**: both directions give an empty selection, so such a test cannot tell a selection bug from a working editor. Selection behaviour that native dragging produces is verified by hand in a real browser; IME and soft-wrap caret placement have the same limit.
