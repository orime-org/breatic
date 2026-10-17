---
name: canvas-reactflow
description: Use before changing anything on the canvas in packages/web/src/spaces/canvas — custom nodes, handles and edges (xyflow / ReactFlow), panels that float over the canvas, the canvas Yjs data model and node fields such as coverUrl, mini-tool output, or the details of node lock and task gating (lock scopes, concurrent tasks, the text node edit gate).
---

# Canvas and ReactFlow traps

Each entry says when it breaks and what to do instead. Paths are relative to `packages/web/src/` unless they start with `packages/`.

## Panels on the canvas

### Panels on the canvas need nowheel and nodrag

**The root element of every panel floating over the canvas carries `nowheel nodrag`.** ReactFlow captures the wheel for zoom and pointer drags for node moves, so without it the panel's list does not scroll (only dragging its scrollbar works) and dragging the panel moves the node. ReactFlow checks the ancestor chain, so the root covers the whole panel; `spaces/canvas/_shared/CanvasPanel.tsx` does this.

Check: does this UI float on the canvas and contain anything that scrolls? Then `nowheel nodrag` goes on its root.

Playwright cannot send a hardware wheel and a synthetic `WheelEvent` does not scroll natively, so verify the parts instead: the viewport's ancestor has `.nowheel` (`vp.closest('.nowheel')`), `clientHeight < scrollHeight`, and setting `scrollTop` takes effect.

### Editable attributes only while editing

**A node body carries `contenteditable` or `tabIndex` only while it is being edited.** ReactFlow's `isInputDOMNode` reads the attribute's presence, and React renders `contentEditable={false}` as `contenteditable="false"`, so a non-editing node counts as an input and swallows Delete: nodes with content cannot be deleted while empty ones can, which looks like a data bug. `spaces/canvas/nodes/TextNode.tsx` gates these attributes on edit mode.

## Connections (xyflow)

### Click-to-connect needs its own state

**Click-to-connect (tap, then tap) records its own state.** `onClickConnectEnd` receives the drag connection store, which a tap-tap gesture never fills, so a drag handler wired there never fires. Record the armed handle in a ref from `onClickConnectStart` and resolve the second tap from `event.target.closest('.react-flow__node')`, as `CanvasSpace.tsx` does.

### Key-code props stay constant

**Never flip `selectionKeyCode`, `multiSelectionKeyCode` or any other key-code prop at runtime.** xyflow's `useKeyPress` removes its listeners without resetting `keyPressed`, so a flip while the key is held latches it true for good: every drag becomes a marquee with no way back. Keep the prop fixed and gate the behaviour in rendering (pick mode hides the selection rectangle through the `canvas-picking` class).

### Forward all three connectable flags

**A custom node passes `isConnectable`, `isConnectableStart` and `isConnectableEnd` to every `<Handle>`.** Flags it does not forward default to true, and the gesture gates are Start and End while `isConnectable` only sets a class, so forwarding one leaves a read-only canvas connectable. `spaces/canvas/nodes/_shared/MagneticHandle.tsx` forwards all three.

### Resolve the release target with elementFromPoint

**`onConnectEnd` finds what is under the release point with `document.elementFromPoint(x, y)`, never `event.target`.** A touchend's target is where the touch started (the handle), and a mouse release often lands on invisible hit layers such as the edge interaction stroke or the NodesSelection rectangle. xyflow's own `isValidHandle` works the same way.

### Large handle hit areas hijack nearby targets

**During a connection drag, turn off `pointer-events` on the handle's enlarged `::before` hit area.** `isValidHandle` takes the topmost handle under `elementFromPoint`, so a large hit area claims the space around it and a nearby node can be connected to the wrong handle without any error; with it off, the target falls back to the small anchor plus `connectionRadius`.

### Drag-time styles apply synchronously

**A style that must change what `elementFromPoint` sees during a connection drag is added with `classList.add` inside `onConnectStart`.** xyflow starts the connection and calls `isValidHandle` in the same pointermove tick, so a React class driven by `connection.inProgress` commits one frame late and the first frame slips through. The canvas adds `canvas-connecting` this way (`CanvasSpace.tsx`, the `.canvas-connecting .react-flow__handle::before` rule in `index.css`) and removes it in `onConnectEnd`.

### Edges attach to the handle's outer edge

**To make an edge touch the node border, move the handle inward by half its width.** `getHandlePosition` attaches the edge at the handle's outer edge (`x + width` for Right, `x` for Left), not its centre, so a handle centred on the border leaves a gap of half its width. `MagneticHandle.tsx` uses `!right-1` / `!left-1` for the 8px handle and shifts its `::before` by the same 4px. Measure with `path.getPointAtLength(0)` mapped through `getScreenCTM()` against the node's `getBoundingClientRect()`.

### Gate the drag path only

**The hit-area gate above applies to drag connections only, never to click-connect.** Click-connect uses discrete handle clicks with no `connectionRadius`, so the second tap needs the hit area; disabling it there breaks click-connect, and an abandoned second tap leaves the gate class stuck.

## Canvas data

### Yjs is the canvas data

**Canvas state is written to Yjs first and the view follows from observers.** Each project document holds `nodesMap` and `edgesMap`, each entry a nested `Y.Map` of fields (`packages/shared/src/types/canvas-node.ts`), and `data/yjs/canvas-space.ts` updates the view incrementally with `observeDeep`. A parallel React copy treated as the source drifts from what collaborators see.

### Wire fields and view fields

**A helper over the render buffer (`flowNodes`) reads view fields; a helper over raw Yjs reads wire fields.** `toNodeView` in `data/yjs/node-view.ts` is the only bridge, and the shapes differ on purpose (view `handling` is derived from wire `taskCounts`, `content` is unified, an annotation's `createdAt` is a number). Reading the other shape's field gives undefined and dead code, and a test fixture in the wrong shape makes that dead code pass.

Check: is this helper handed raw Yjs data or the render buffer? Build its fixtures in that shape.

### Only video nodes carry coverUrl

**Write `data.coverUrl` on video nodes only; image and audio get null.** Asset GC (`survivingUrls` in `spaces/canvas/canvas-upload.ts`) treats every node's `content` and `coverUrl` as live whatever the node type, so a cover URL on an image pins the old file and it is never collected. `spaces/canvas/history/restore-node-content.ts` and `writeNodeMedia` follow this.

Check: does this node type carry a cover at runtime (only video does)? A comment saying a field "equals content" is not evidence that anything writes it.

### Releasing a document's resources

Memory-only state tied to a canvas document (its `Y.UndoManager`, for example) is cached with `createDocScopedCache`; before adding one, invoke `/react-state-traps` ([Bind memory-only state to its document](../react-state-traps/SKILL.md#bind-memory-only-state-to-its-document)).

### Mini-tool runs create new nodes

**A mini-tool Run writes its result as new nodes connected to the source by edges; it never writes back into the source node.** `spaces/canvas/mini-tool/start-mini-tool-run.ts` writes the result nodes and edges before it calls the server, so the reader's content exists at once, and what the run does next lands on those nodes' task rows.

## Gating details

The gate itself (`evaluateNodeGate` in `spaces/canvas/node-gate.ts`, the locked / running-task matrix, toasts for blocked actions) is in the web package rules. These are the details behind it.

### Concurrent tasks on one node

**A running task freezes only deletion.** A node can carry several tasks at once and each result needs somewhere to land, so a second upload, a second generation and the user's own edits are all allowed; the later write wins and every task's output stays in the node's task list for the user to pick. Whether a task has run out of time is judged by the server, which harvests rows past `started_at + budget_ms` when someone reads the node's task list (`packages/domain/src/node-task/node-task.service.ts`), so the frontend needs no clock for it.

### Text node edit gate

**`TextNode` works out `canEdit` once (`!readOnly && evaluateNodeGate({ locked }) === null`) and both the way into editing and the way out read it.** Two hand-written conditions drift; a lock or role change that lands mid-edit closes the editor and keeps what was typed. A running or failed task does not block editing. A new writability premise goes into that one condition; a new way into edit mode goes through `startEdit`.

### Lock scopes

**A node's own lock and a group's lock freeze different things.**

| Scope | Freezes | Does not freeze |
|---|---|---|
| Node's own lock (`node.data.locked`) | Everything on that node: content, name, inline edit, upload, generation, move, delete | — |
| Group lock (`group.data.locked`) | Geometry (moving or dragging members), structure (adding or removing members: reparent-in, paste-into, ungroup, deleting a member; moving or deleting the group) and the group's identity (name, position, size) | Each member's content, name, inline edit, generation, upload and edges, which follow that member's own `data.locked` |

The group-aware set (`lockedNodeIds` in `spaces/canvas/group-membership.ts`) is wired only into the move freeze (`draggable`) and the node side of the delete guard; content gates read the node's own `data.locked` fresh. The TSDoc at the top of `group-membership.ts` is the source of truth.

### Edges are never lock-gated

**Neither a node lock nor a group lock blocks creating or deleting an edge.** Edges are relations, not content: `onConnect` has no lock gate and deleting an edge is allowed the same way; an edge is removed implicitly only when one of its endpoints is actually deleted, so nothing dangles.

Check: does this gate protect geometry, structure or group identity (use the group-aware set), or a member's content, name or relations (use the node's own `data.locked`)? Do not make a content gate group-aware.
