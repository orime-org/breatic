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
  wsUrl?: string;
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
 * Resolve the WebSocket URL. No runtime fallback — supports distributed
 * deployment where frontend and Collab may be on different domains.
 *
 * Priority:
 *   1. Explicit `wsUrl` from config (tests / advanced setups).
 *   2. `VITE_WS_URL` env (baked at build time via .env).
 *   3. Throw — if neither is provided, misconfiguration must fail loudly.
 */
function resolveWsUrl(explicit?: string): string {
  const url = explicit ?? import.meta.env.VITE_WS_URL;
  if (!url) {
    throw new Error(
      'VITE_WS_URL is not configured. Set it in .env (copy from .env.dev or .env.docker).',
    );
  }
  return url;
}

export const createYjsManager = (config: YjsManagerConfig): YjsManager => {
  const { docId } = config;
  const wsUrl = resolveWsUrl(config.wsUrl);

  const doc = new Y.Doc();

  const provider = new HocuspocusProvider({
    url: wsUrl,
    name: docId,
    document: doc,
    token: 'dev',
    timeout: 10000,
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
        token: 'dev',
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
