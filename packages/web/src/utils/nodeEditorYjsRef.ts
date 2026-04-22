/**
 * Module-level registry for active node editor Yjs managers.
 *
 * Why a registry instead of a single-slot ref like {@link canvasYjsRef}:
 * canvas has exactly one Y.Doc per project, but node editors are
 * per-node — and more than one editor can be mounted concurrently
 * (mixed editor panel in the right sidebar + a text node's content
 * preview sync in the left chat area, for example). Keying by the main
 * canvas node id lets non-React code (Yjs action helpers, the Apply
 * button's write-back path) look up the correct manager without
 * threading the value through props.
 *
 * Scope: one entry per `mainCanvasNodeId`. `useYjsNodeEditor` writes on
 * mount, clears on unmount. If the same node is remounted (e.g. the
 * user closes then reopens its editor) the entry is replaced with the
 * new manager — there is no reference counting, because the hook owns
 * the lifecycle.
 */

import type { YjsNodeEditorManager } from './yjsNodeEditorManager';

const registry = new Map<string, YjsNodeEditorManager>();

/**
 * Associate a node editor manager with its main canvas node id.
 *
 * Passing `null` clears the entry. Called by `useYjsNodeEditor`'s effect
 * cleanup; callers should not invoke this directly.
 */
export function setNodeEditorYjsManager(
  mainCanvasNodeId: string,
  manager: YjsNodeEditorManager | null,
): void {
  if (manager === null) {
    registry.delete(mainCanvasNodeId);
    return;
  }
  registry.set(mainCanvasNodeId, manager);
}

/**
 * Fetch the manager for a given main canvas node, or null if no editor
 * is currently open for that node.
 *
 * Intended for non-React call sites — React components should prefer
 * the return value of `useYjsNodeEditor`, which is reactive to sync
 * state.
 */
export function getNodeEditorYjsManager(
  mainCanvasNodeId: string,
): YjsNodeEditorManager | null {
  return registry.get(mainCanvasNodeId) ?? null;
}
