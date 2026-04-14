/**
 * Module-level reference to the active Yjs project manager.
 *
 * Set by `useYjsProjectStore` on init, cleared on cleanup. Read by
 * `useProjectStore` to perform direct Yjs writes (addNode,
 * updateNode, deleteNode, etc.) without requiring the hook to accept
 * the manager as a parameter — which would change the API surface
 * for every consumer.
 */

import type { YjsProjectManager } from './yjsProjectManager';

let _manager: YjsProjectManager | null = null;

export function setCanvasYjsManager(manager: YjsProjectManager | null): void {
  _manager = manager;
}

export function getCanvasYjsManager(): YjsProjectManager | null {
  return _manager;
}
