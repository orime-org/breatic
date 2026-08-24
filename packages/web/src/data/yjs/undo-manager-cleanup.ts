// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Builds a `Y.UndoManager` that actually detaches from its document.
 *
 * `Y.UndoManager`'s constructor registers a `doc.on('destroy', …)` listener
 * that its own `destroy()` never removes — the manager's other listener is
 * cleaned up, this one is not. Left behind, the manager stays reachable from a
 * live Y.Doc with its undo and redo stacks, and — because `keepItem` is set on
 * the structs those stacks can still restore — the deleted content of every
 * edit that session.
 *
 * Harmless while the document dies with the manager. Not harmless when the
 * document OUTLIVES it, which is exactly what our caches produce: a Space tab
 * closed and reopened before the deferred provider release fires keeps the
 * Y.Doc while the editor and its manager have already been evicted.
 *
 * y-tiptap works around this too, but only for a manager its own plugin builds
 * — and neither of ours is. So it lives here, once, rather than in whichever
 * module happened to notice: the canvas manager and the document manager have
 * the identical problem, and it was fixed in one of them first.
 */

import * as Y from 'yjs';

/**
 * The doc's current `destroy` observers.
 *
 * Reaches a private field, the same one y-tiptap's own workaround reads, and
 * for the same reason: yjs offers no public way to ask what is subscribed, and
 * removing a listener requires the exact function reference.
 * @param doc - The Y.Doc to inspect.
 * @returns The registered destroy listeners, or an empty list if yjs has changed shape.
 */
function destroyObservers(doc: Y.Doc): Array<() => void> {
  const observers = (
    doc as unknown as { _observers?: Map<string, Set<() => void>> }
  )._observers;
  return Array.from(observers?.get('destroy') ?? []);
}

/**
 * Run `build`, then make the resulting manager's `destroy()` also detach the
 * doc listener yjs leaks.
 *
 * The manager is built by the caller because each of ours needs different
 * scopes and options; all this adds is the cleanup.
 * @param doc - The Y.Doc the manager will be built against.
 * @param build - Builds the manager. Called exactly once, between the two observations.
 * @returns The manager `build` produced, with `destroy` wrapped.
 * @throws {unknown} Anything `build` throws, unchanged.
 */
export function withDestroyListenerCleanup<T extends Y.UndoManager>(
  doc: Y.Doc,
  build: () => T,
): T {
  const before = new Set(destroyObservers(doc));
  const manager = build();
  const attached = destroyObservers(doc).filter(
    (listener) => !before.has(listener),
  );

  const destroy = manager.destroy.bind(manager);
  manager.destroy = (): void => {
    destroy();
    attached.forEach((listener) => doc.off('destroy', listener));
    attached.length = 0;
  };
  return manager;
}
