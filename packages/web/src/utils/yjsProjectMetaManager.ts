/**
 * Yjs manager for the project meta doc (v10 §5.3.1).
 *
 *   project-{projectId}/meta
 *     ├── projectMeta: Y.Map  { name, description, ... }
 *     ├── spaces:      Y.Map<spaceId, Y.Map>   ← Tab Bar source
 *     └── userStates:  Y.Map<userId, Y.Map>    ← per-user tab state
 *
 *   + Project-level awareness (Hocuspocus awareness protocol)
 *   + Stateless message channel (broadcastStateless from Collab —
 *     used for permission `members:changed` invalidate signals,
 *     v10 §7.2.5)
 *
 * The hook layer subscribes to the Y.Maps and the `stateless` event
 * directly through the provider; this manager exposes the raw
 * primitives without further wrapping.
 */

import * as Y from 'yjs';
import { projectMetaDocName } from '@breatic/shared';
import {
  createYjsManager,
  type YjsManager as BaseYjsManager,
  type YjsManagerConfig,
} from './yjsManager';

export interface ProjectMetaManagerConfig
  extends Omit<YjsManagerConfig, 'docName'> {
  projectId: string;
  /** Called once after the server sync completes. */
  onSynced?: () => void;
}

export interface ProjectMetaManager {
  doc: Y.Doc;
  /** Top-level project metadata (name / description / ...). */
  projectMeta: Y.Map<unknown>;
  /** `spaces` Y.Map — keyed by spaceId; each value is a Y.Map row. */
  spaces: Y.Map<unknown>;
  /** `userStates` Y.Map — keyed by userId; each value is a Y.Map. */
  userStates: Y.Map<unknown>;
  awareness: BaseYjsManager['awareness'];
  /**
   * Underlying provider. Hooks attach `stateless` listeners directly
   * (`provider.on('stateless', ...)`) for cross-process invalidation
   * signals (v10 §7.2.5).
   */
  provider: BaseYjsManager['provider'];
  /** True after server sync. */
  synced: boolean;
  /** Register a callback for when sync completes. */
  onSynced: (cb: () => void) => () => void;
  destroy: () => void;
}

/**
 * Build a manager bound to one project's meta doc.
 */
export const createProjectMetaManager = (
  config: ProjectMetaManagerConfig,
): ProjectMetaManager => {
  const { projectId } = config;

  const base = createYjsManager({
    docName: projectMetaDocName(projectId),
    token: config.token,
    websocketProvider: config.websocketProvider,
    wsUrl: config.wsUrl,
    onAuthFailed: config.onAuthFailed,
  });

  const { doc } = base;

  // Top-level Y.Maps. getMap is idempotent and creates on first call,
  // so these references are stable for the lifetime of the manager.
  const projectMeta = doc.getMap('projectMeta') as Y.Map<unknown>;
  const spaces = doc.getMap('spaces') as Y.Map<unknown>;
  const userStates = doc.getMap('userStates') as Y.Map<unknown>;

  let synced = false;
  const syncCallbacks = new Set<() => void>();

  base.onSynced(() => {
    synced = true;
    syncCallbacks.forEach((cb) => cb());
    syncCallbacks.clear();
    config.onSynced?.();
  });

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
    base.destroy();
    synced = false;
  };

  return {
    doc,
    projectMeta,
    spaces,
    userStates,
    awareness: base.awareness,
    provider: base.provider,
    get synced() {
      return synced;
    },
    onSynced,
    destroy,
  };
};
