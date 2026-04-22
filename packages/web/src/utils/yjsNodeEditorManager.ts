/**
 * Per-node Yjs editor manager.
 *
 * Each canvas node that exposes a "Launch Editor" UI (text node / image
 * / audio / video / 3d) backs that editor with a dedicated Y.Doc whose
 * name follows the {@link https://github.com/orime-org/breatic_ai/blob/main/docs/YJS.md | YJS.md § 11}
 * spec:
 *
 *     "project-{projectId}/node/{nodeId}"
 *
 * This is the authoritative identifier that the collab server's auth
 * hook ({@link packages/collab/src/auth.ts}) recognises. Sending any
 * other shape (for example the legacy `project-{nodeId}/canvas` that
 * older code produced by accident) makes the server look up a project
 * by the node's UUID, fail to find it, and respond with
 * `DocumentNotAuthorized` — which on the client triggers the Hocuspocus
 * reconnect loop and the `onAuthFailed` redirect to `/login`.
 *
 * Intentional non-responsibilities of this manager:
 *
 *   - **No schema init.** Callers own `doc.getMap('flow')` for mixed
 *     editors or `doc.getXmlFragment('body')` for text editors. Not
 *     every editor needs both, and preallocating would force an empty
 *     key into the Y.Doc that then replicates to every client forever.
 *   - **No UndoManager.** TipTap's Collaboration extension manages its
 *     own history on a Y.XmlFragment; mixed editors attach their own
 *     `Y.UndoManager` scoped to `flow`. Building a single shared
 *     UndoManager here would entangle the two.
 *   - **No subdocs.** Editors are themselves per-node; recursive
 *     sub-editors (editor inside editor) are explicitly out of scope
 *     (YJS.md § 11: "Sub-canvas nodes do not have their own Launch
 *     Editor — no recursion.").
 */

import * as Y from 'yjs';
import { HocuspocusProvider } from '@hocuspocus/provider';

export interface YjsNodeEditorManagerConfig {
  /** Main canvas project UUID — matches the `{projectId}` in the doc name. */
  projectId: string;
  /** Main canvas node UUID this editor is bound to — matches `{nodeId}`. */
  nodeId: string;
  /**
   * Session token forwarded to Hocuspocus `onAuthenticate`. Must be a
   * live token from the Redux auth store — `useYjsNodeEditor` refuses to
   * construct the manager when empty, so by the time we get here the
   * value is always non-empty.
   */
  token: string;
  /**
   * Optional WebSocket URL override for tests. Production leaves this
   * undefined and {@link resolveWsUrl} picks `wss://{host}/ws` (or `ws:`
   * on http pages) so one bundle serves every deployment.
   */
  wsUrl?: string;
  /**
   * Fired when the server rejects the token. The provider has already
   * called `disconnect()` by the time this runs (to stop the reconnect
   * loop) — the callback just owns the UX side, usually clearing auth
   * and navigating to `/login`.
   */
  onAuthFailed?: (reason: string) => void;
}

export interface YjsNodeEditorManager {
  /** Project UUID captured at construction — exposed for introspection. */
  readonly projectId: string;
  /** Node UUID captured at construction. */
  readonly nodeId: string;
  /** Resolved Hocuspocus document name (`project-{projectId}/node/{nodeId}`). */
  readonly docName: string;

  readonly doc: Y.Doc;
  readonly provider: HocuspocusProvider;
  readonly awareness: HocuspocusProvider['awareness'];

  /** True after the initial server sync round-trip completes. */
  readonly synced: boolean;
  /**
   * Register a callback for initial sync completion. If sync already
   * happened, the callback fires synchronously. Returns an unsubscribe
   * function so hooks can cancel pending callbacks on unmount.
   */
  onSynced: (cb: () => void) => () => void;

  /** Destroys the provider + doc. Idempotent — safe to call twice. */
  destroy: () => void;
}

/**
 * Resolve the WebSocket URL.
 *
 * Default: same-origin as the page, path `/ws` — nginx (docker) or the
 * Vite dev proxy reverse-proxies `/ws` to the Collab server. This keeps
 * one built bundle working on every host without a rebuild (staging,
 * prod, preview deployments, localhost).
 */
function resolveWsUrl(explicit?: string): string {
  if (explicit) return explicit;
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${window.location.host}/ws`;
}

/** Build the canonical document name. Kept private so the shape is a single source of truth. */
function buildDocName(projectId: string, nodeId: string): string {
  return `project-${projectId}/node/${nodeId}`;
}

export const createYjsNodeEditorManager = (
  config: YjsNodeEditorManagerConfig,
): YjsNodeEditorManager => {
  const { projectId, nodeId, token, onAuthFailed } = config;
  const docName = buildDocName(projectId, nodeId);
  const wsUrl = resolveWsUrl(config.wsUrl);

  const doc = new Y.Doc();

  const provider = new HocuspocusProvider({
    url: wsUrl,
    name: docName,
    document: doc,
    token,
    onAuthenticationFailed: ({ reason }) => {
      // Stop the infinite reconnect loop — the client cannot recover
      // from an invalid token without new credentials.
      provider.disconnect();
      onAuthFailed?.(reason);
    },
  });

  // Sync tracking. Hocuspocus fires `synced` exactly once after the
  // initial handshake; we latch it here so late onSynced subscribers
  // still fire synchronously.
  let synced = false;
  const syncCallbacks = new Set<() => void>();

  const checkSynced = () => {
    if (synced) return;
    synced = true;
    // Drain via forEach + clear (not spread) because the web package's
    // tsconfig targets ES5, where iterator protocol on Set is gated by
    // --downlevelIteration. forEach is the idiomatic pre-ES2015 form.
    const toRun: Array<() => void> = [];
    syncCallbacks.forEach((cb) => toRun.push(cb));
    syncCallbacks.clear();
    toRun.forEach((cb) => cb());
  };

  provider.on('synced', checkSynced);

  const onSynced = (cb: () => void): (() => void) => {
    if (synced) {
      cb();
      return () => {};
    }
    syncCallbacks.add(cb);
    return () => {
      syncCallbacks.delete(cb);
    };
  };

  let destroyed = false;
  const destroy = () => {
    if (destroyed) return;
    destroyed = true;
    syncCallbacks.clear();
    provider.off('synced', checkSynced);
    provider.destroy();
    doc.destroy();
  };

  return {
    projectId,
    nodeId,
    docName,
    doc,
    provider,
    awareness: provider.awareness!,
    get synced() {
      return synced;
    },
    onSynced,
    destroy,
  };
};
