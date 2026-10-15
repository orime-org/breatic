---
name: react-state-traps
description: Use before writing or changing React hooks, memoized values or callbacks, React Query queries and mutations, Zustand stores, WebSocket / EventSource hooks, caches of in-memory state such as undo managers, or API response types and helpers in packages/web.
---

# React, state and data-layer traps

Each entry says when it breaks and what to do instead. Paths are relative to `packages/web/src/`.

## Hooks and memoization

### Memo on translated strings depends on the string

**A memo or callback that reads `t('…')` lists the translated string in its dependencies, not `t`.** `useTranslation` (`i18n/use-translation.ts`) re-renders on a locale change but always returns the same `t`, so `useMemo(() => <X placeholder={t('k')} />, [t])` keeps the old language until remount. `react-hooks/exhaustive-deps` does not catch the inline form, because `t` is used and listed.

```tsx
const el = useMemo(() => <X placeholder={t('k')} />, [t]); // wrong: stuck on the old locale
const ph = t('k'); const el = useMemo(() => <X placeholder={ph} />, [ph]); // right
```

The same holds for any stable function whose return value follows outside state (`getLocale`, a theme getter): depend on the value, not the function.

### Resource hooks create and clean up in one effect

**A hook that opens a WebSocket, EventSource or similar creates it and closes it in the same `useEffect`, never in `useMemo`.** StrictMode mounts, unmounts and mounts again; a resource created in a memo is not recreated after the cleanup closed it, so the component holds a dead connection.

### Socket hooks wait for the user

**A WebSocket or SSE hook that connects on mount is gated on the signed-in user being known.** Dialled before `/auth/me` resolves, the connection fails auth and the failure sticks. `data/yjs/use-socket.ts` waits for `useCollabSocketContext().ready` and stays `connecting` until then.

### Bind memory-only state to its document

**State that lives only in memory and belongs to a document (a `Y.UndoManager` stack, a cached editor) is cached per document with `createDocScopedCache` (`data/yjs/doc-scoped-cache.ts`), never created and destroyed in a component effect.** A component that remounts while the document stays open (a tab switch under `key={activeSpace.id}`, StrictMode) would throw the undo stack away. The cache evicts on `destroyDoc` through `onDocDestroyed` and heals a value built for a since-recreated doc; eviction happens on explicit actions such as closing a tab (`onCloseTab`), not on unmount. See `getCanvasUndoManager` in `data/yjs/canvas-space.ts` and `document-editor-cache.ts`.

**When releasing anything keyed by a document name, every module-level cache with that key must be evicted.** A hand-written `Map` keyed by doc name keeps the destroyed `Y.Doc` alive and the leak only moves from one cache to another; build new caches with `createDocScopedCache` so they subscribe to destroy. `_resetForTests` in `data/yjs/manager.ts` keeps destroy listeners, because they are registered once at module load.

### Global single-slot release reads the store

**The release branch of a global single-slot store (`features/exclusive-overlay/use-exclusive-overlay.ts`) compares against `getState()`, not a value captured in the render closure.** When one handler claims the slot for a new overlay and releases it for the old one with no re-render in between, the old closure still thinks it owns the slot and clears the new claim, closing both.

## React Query

### Optimistic updates and local drafts

**A child that edits a value optimistically keeps a local draft instead of rendering straight from the query cache.** `onMutate` must `await cancelQueries` before `setQueryData`, which pushes the cache write to a microtask; for one render the child receives the stale prop and the input flickers back.

### Gate on isPending, not isLoading

**"Render only once there is data" is gated on `isPending`.** In React Query v5 `isLoading` is `isPending && isFetching`; offline, the first fetch is `paused`, so `isLoading` is false with no data and no error and the component renders a false empty state. Test it with `onlineManager.setOnline(false)`.

### Queries under a canvas without a provider

**A component mounted permanently inside the ReactFlow tree does not call React Query hooks in its own body.** The ReactFlow root has no `QueryClientProvider`, so it throws `No QueryClient set` on mount. Split it: the outer component reads the store and returns null when closed; an inner component that mounts only when open calls the query (`spaces/canvas/history/NodeHistoryPanelContainer.tsx` and `OpenNodeHistoryPanel`). Do not paper over it with a dummy client or extra providers.

## Stores

### Do not mirror engine state in Zustand

**State owned by an engine (the i18n locale, for example) is changed through the engine and read from it, not copied into a Zustand store.** A switcher that writes only the store copy changes nothing on screen; `features/preferences/LangSwitcher.tsx` goes through `useLocaleSwitch` (`features/preferences/supported-langs.ts`), which changes the engine's locale and keeps no store copy.

## Errors and API data

### Toast before throw

**An async operation that can fail shows its toast at the source, on every throw path, before it throws; callers' `catch` blocks only reset their own state.** A toast added in one caller's catch is missed by every other caller and by paths that rethrow, so the failure is silent somewhere.

### Response types drift from the server

**When you change a type that describes a server response, grep its call sites and check the field against a real response.** Typecheck and mocked unit tests both pass with a field name the server never sends (a type that says `name` where the server sends `username` renders undefined), and only a real fetch shows it.

### apiGet already unwraps data

**`apiGet` and its siblings in `data/api/request.ts` return `res.data.data`, so a module declares `Promise<X>` and callers read the value directly.** Declaring `Promise<{ data: X }>` or reading `.data?.data` gives undefined, and a unit test that mocks `{ data: … }` in the wrong shape hides it; only a real browser run catches it.
