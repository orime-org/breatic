/**
 * Base Yjs manager — Y.Doc + a single Hocuspocus provider.
 *
 * v10 refactor:
 *   - Drops the pre-v6 sub-doc concept (`getSubdoc` /
 *     `imageEditorMap`) — the v10 multi-doc layout uses one
 *     top-level Hocuspocus doc per Space (`project-{pid}/canvas-{sid}`,
 *     `project-{pid}/meta`, etc.). No nested subdocs anywhere.
 *   - Accepts an optional shared `HocuspocusProviderWebsocket` so all
 *     of a project's docs can share a single TCP connection
 *     (spec §5.3.3). Falls back to a per-provider socket when not
 *     supplied (used by tests / standalone calls).
 *
 * No IndexedDB — this product requires network for AIGC generation,
 * so offline editing is not supported. Single data source (server)
 * eliminates cache/sync race conditions entirely.
 */

import * as Y from 'yjs';
import {
  HocuspocusProvider,
  type HocuspocusProviderWebsocket,
} from '@hocuspocus/provider';

export interface YjsManagerConfig {
  /**
   * Full Yjs document name as understood by Hocuspocus. Use the
   * helpers from `@breatic/shared/yjs-doc-names` to build it
   * (`projectMetaDocName(pid)` / `canvasSpaceDocName(pid, sid)` etc.)
   * — never assemble by string concatenation here.
   */
  docName: string;
  /**
   * Session token used by Hocuspocus `onAuthenticate` to verify the
   * user and enforce project membership. Empty string means
   * "unauthenticated"; callers should avoid constructing a manager
   * in that case.
   */
  token: string;
  /**
   * Optional shared websocket (from `useHocuspocusSocket`). When
   * provided, all of a project's docs share one TCP connection
   * (spec §5.3.3). When omitted, the provider creates its own socket
   * to `wsUrl`.
   */
  websocketProvider?: HocuspocusProviderWebsocket;
  /**
   * Direct WebSocket URL — only consulted when `websocketProvider`
   * is not supplied. Defaults to same-origin `/ws` (proxied to
   * Collab by nginx in prod and Vite in dev).
   */
  wsUrl?: string;
  /**
   * Called when the server rejects the token (expired / invalid).
   * Should clear client session state and redirect to /login.
   */
  onAuthFailed?: (reason: string) => void;
}

export interface YjsManager {
  doc: Y.Doc;
  provider: HocuspocusProvider;
  awareness: HocuspocusProvider['awareness'];
  /** True after the initial WebSocket sync with the server completes. */
  synced: boolean;
  /** Register a callback for when initial sync completes. Returns unsubscribe function. */
  onSynced: (cb: () => void) => () => void;
  destroy: () => void;
}

/**
 * Resolve the WebSocket URL when no shared websocket is provided.
 *
 * Default: same-origin as the page, path `/ws` — nginx (docker) or the
 * Vite dev proxy reverse-proxies `/ws` to the Collab server. This means
 * one built bundle works on any host without a rebuild.
 */
function resolveWsUrl(explicit?: string): string {
  if (explicit) return explicit;
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${window.location.host}/ws`;
}

/**
 * Build a Yjs manager for a single Hocuspocus document.
 *
 * Most callers should not invoke this directly — use the kind-specific
 * managers (`createCanvasSpaceManager` / `createProjectMetaManager`)
 * which know the doc-name + content shape. This generic factory exists
 * so future kinds (document, timeline) can plug in without rewriting
 * the provider plumbing.
 */
export const createYjsManager = (config: YjsManagerConfig): YjsManager => {
  const { docName, token, websocketProvider, onAuthFailed } = config;

  const doc = new Y.Doc();

  // Two construction paths: shared socket or per-provider socket.
  // Hocuspocus's HocuspocusProvider accepts EITHER `websocketProvider`
  // OR `url` — never both. Branch here so the type narrowing stays
  // correct on the call.
  //
  // Important — auto-attach behaviour (@hocuspocus/provider 3.4.4):
  //   The constructor calls `attach()` ONLY when it had to build its
  //   own websocket (`manageSocket = true`). When the caller passes a
  //   shared `websocketProvider`, the provider is constructed but
  //   never attached — so it never sends the Auth/Subscribe messages
  //   for this doc, and the server never sees a "Client connected"
  //   for this `name`. We must call `provider.attach()` explicitly in
  //   that branch.
  const provider = websocketProvider
    ? new HocuspocusProvider({
        websocketProvider,
        name: docName,
        document: doc,
        token,
        onAuthenticationFailed: ({ reason }) => {
          // Stop the infinite reconnect loop on this doc's own
          // provider; the shared socket may still be up for siblings.
          provider.detach();
          onAuthFailed?.(reason);
        },
      })
    : new HocuspocusProvider({
        url: resolveWsUrl(config.wsUrl),
        name: docName,
        document: doc,
        token,
        onAuthenticationFailed: ({ reason }) => {
          provider.disconnect();
          onAuthFailed?.(reason);
        },
      });

  // Shared-socket branch: explicit attach. Per-socket branch:
  // constructor already attached.
  if (websocketProvider) {
    provider.attach();
  }

  const awareness = provider.awareness!;

  // Sync tracking
  let synced = false;
  const syncCallbacks = new Set<() => void>();

  const checkSynced = () => {
    if (synced) return;
    synced = true;
    syncCallbacks.forEach((cb) => cb());
    syncCallbacks.clear();
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

  const destroy = () => {
    provider.off('synced', checkSynced);
    // `provider.destroy()` internally calls `detach()` (when shared
    // ws) or disposes its own websocket (when manageSocket). We
    // don't need to detach manually here; just listen for sync and
    // tear everything down.
    provider.destroy();
    doc.destroy();
  };

  return {
    doc,
    provider,
    awareness,
    get synced() {
      return synced;
    },
    onSynced,
    destroy,
  };
};
