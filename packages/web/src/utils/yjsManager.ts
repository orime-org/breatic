/**
 * Base Yjs manager: Y.Doc + @hocuspocus/provider for server sync.
 *
 * No IndexedDB — this product requires network for AIGC generation,
 * so offline editing is not supported. Single data source (server)
 * eliminates cache/sync race conditions entirely.
 */

import * as Y from 'yjs';
import { HocuspocusProvider } from '@hocuspocus/provider';

export interface YjsManagerConfig {
  docId: string;
  /**
   * Session token used by Hocuspocus `onAuthenticate` to verify the
   * user and enforce project ownership. Must be a real session token
   * from the auth store — previously hardcoded to `'dev'`, which
   * caused production reconnect loops (server rejected `dev`).
   *
   * Empty string means "unauthenticated"; callers should avoid
   * constructing a manager in that case. If passed anyway, the
   * auth failure handler will clear session + redirect to login.
   */
  token: string;
  wsUrl?: string;
  /**
   * Called when the server rejects the token (expired / invalid).
   * Should clear client session state and redirect to /login.
   * Without this, the provider would reconnect forever.
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
  getSubdoc: (subdocId: string) => Y.Doc;
  getSubdocAwareness: (subdocId: string) => HocuspocusProvider['awareness'] | undefined;
  createSnapshot: () => Uint8Array;
  destroy: () => void;
}

/**
 * Resolve the WebSocket URL.
 *
 * Default: same-origin as the page, path `/ws` — nginx (docker) or the Vite
 * dev proxy reverse-proxies `/ws` to the Collab server. This means one built
 * bundle works on any host without a rebuild.
 *
 * Tests can inject an explicit `wsUrl`; production never needs to.
 */
function resolveWsUrl(explicit?: string): string {
  if (explicit) return explicit;
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${window.location.host}/ws`;
}

export const createYjsManager = (config: YjsManagerConfig): YjsManager => {
  const { docId, token, onAuthFailed } = config;
  const wsUrl = resolveWsUrl(config.wsUrl);

  const doc = new Y.Doc();

  const provider = new HocuspocusProvider({
    url: wsUrl,
    name: docId,
    document: doc,
    token,
    timeout: 10000,
    onAuthenticationFailed: ({ reason }) => {
      // Stop the infinite reconnect loop — the client cannot recover
      // from an invalid token without new credentials.
      provider.disconnect();
      onAuthFailed?.(reason);
    },
  });

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
    return () => { syncCallbacks.delete(cb); };
  };

  // Subdoc providers
  const subdocProviders = new Map<string, HocuspocusProvider>();

  const getSubdoc = (subdocId: string): Y.Doc => {
    let subdoc = doc.getMap<Y.Doc>('subdocs').get(subdocId) as Y.Doc | undefined;
    if (!subdoc) {
      const guid = `${docId}-${subdocId}`;
      subdoc = new Y.Doc({ guid, autoLoad: true });
      doc.getMap<Y.Doc>('subdocs').set(subdocId, subdoc);
    }
    if (!subdoc.isLoaded) subdoc.load();
    if (!subdocProviders.has(subdoc.guid)) {
      subdocProviders.set(subdoc.guid, new HocuspocusProvider({
        url: wsUrl,
        name: subdoc.guid,
        document: subdoc,
        token,
        onAuthenticationFailed: ({ reason }) => {
          subdocProviders.get(subdoc.guid)?.disconnect();
          onAuthFailed?.(reason);
        },
      }));
    }
    return subdoc;
  };

  const getSubdocAwareness = (subdocId: string): HocuspocusProvider['awareness'] | undefined => {
    const subdoc = getSubdoc(subdocId);
    return subdocProviders.get(subdoc.guid)?.awareness ?? undefined;
  };

  const createSnapshot = (): Uint8Array => Y.encodeStateAsUpdate(doc);

  const destroy = () => {
    subdocProviders.forEach((p) => p.destroy());
    subdocProviders.clear();
    provider.off('synced', checkSynced);
    provider.destroy();
    doc.destroy();
  };

  return {
    doc,
    provider,
    awareness,
    get synced() { return synced; },
    onSynced,
    getSubdoc,
    getSubdocAwareness,
    createSnapshot,
    destroy,
  };
};
