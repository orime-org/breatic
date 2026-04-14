import * as Y from 'yjs';
import { IndexeddbPersistence } from 'y-indexeddb';
import { HocuspocusProvider } from '@hocuspocus/provider';

export interface YjsManagerConfig {
  docId: string;
  wsUrl?: string;
}

export interface YjsManager {
  doc: Y.Doc;
  subdocsMap: Y.Map<Y.Doc>;
  awareness: HocuspocusProvider['awareness'];
  indexeddbProvider: IndexeddbPersistence;
  getSubdoc: (subdocId: string) => Y.Doc;
  getSubdocAwareness: (subdocId: string) => HocuspocusProvider['awareness'] | undefined;
  createSnapshot: () => Uint8Array;
  restoreSnapshot: (binary: Uint8Array) => void;
  destroy: () => void;
}

/**
 * Shared Yjs setup: root doc, IndexedDB persistence, Hocuspocus sync, nested subdocs.
 *
 * Uses @hocuspocus/provider (not y-websocket) for full compatibility
 * with the Hocuspocus server's auth and sync protocol.
 */
export const createYjsManager = (config: YjsManagerConfig): YjsManager => {
  const {
    docId,
    wsUrl = import.meta.env.VITE_WS_URL || 'ws://localhost:1234',
  } = config;

  const doc = new Y.Doc();
  const subdocsMap = doc.getMap<Y.Doc>('subdocs');

  const dbName = `yjs-${docId || 'local'}`;
  const indexeddbProvider = new IndexeddbPersistence(dbName, doc);

  const hocuspocusProvider = new HocuspocusProvider({
    url: wsUrl,
    name: docId,
    document: doc,
    token: 'dev',
  });

  const awareness = hocuspocusProvider.awareness!;

  const subdocProviders = new Map<string, HocuspocusProvider>();

  const getSubdoc = (subdocId: string): Y.Doc => {
    let subdoc = subdocsMap.get(subdocId) as Y.Doc | undefined;
    if (!subdoc) {
      const guid = `${docId}-${subdocId}`;
      subdoc = new Y.Doc({ guid, autoLoad: true });
      subdocsMap.set(subdocId, subdoc);
    }
    if (!subdoc.isLoaded) {
      subdoc.load();
    }
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
    const provider = subdocProviders.get(subdoc.guid);
    return provider?.awareness ?? undefined;
  };

  const createSnapshot = (): Uint8Array => {
    return Y.encodeStateAsUpdate(doc);
  };

  const restoreSnapshot = (binary: Uint8Array) => {
    const tempDoc = new Y.Doc();
    Y.applyUpdate(tempDoc, binary);
    tempDoc.destroy();
  };

  const destroy = () => {
    subdocProviders.forEach((provider) => {
      provider.destroy();
    });
    subdocProviders.clear();

    subdocsMap.forEach((subdoc) => {
      subdoc.destroy();
    });

    hocuspocusProvider.destroy();
    indexeddbProvider.destroy();
    doc.destroy();
  };

  return {
    doc,
    subdocsMap,
    awareness,
    indexeddbProvider,
    getSubdoc,
    getSubdocAwareness,
    createSnapshot,
    restoreSnapshot,
    destroy,
  };
};
