/**
 * React hook for per-node Yjs editor managers.
 *
 * Wraps {@link createYjsNodeEditorManager} with the React lifecycle +
 * app-specific auth wiring:
 *
 *   - Pulls the session token from the Redux auth store (one source of
 *     truth — never reads `localStorage` directly; hydration happens in
 *     `userCenter`'s `loadInitialAuthInfo`).
 *   - Refuses to start when any of `{projectId, nodeId, token}` is
 *     missing. Starting without a token makes the server close the WS
 *     immediately and Hocuspocus reconnects forever — the guard is what
 *     prevents that.
 *   - On `onAuthFailed` clears local auth + navigates to `/login`. The
 *     provider has already called `disconnect()` by then (inside the
 *     manager) so there's no zombie socket.
 *   - Registers the manager in {@link nodeEditorYjsRef} so non-React
 *     code (write-back helpers, Apply action) can resolve it by main
 *     canvas node id.
 *   - Destroys the manager on unmount — callers that need caching across
 *     unmount/remount should hold their own reference.
 *
 * The hook stays intentionally thin: no schema initialization, no undo
 * manager, no reactive state beyond `loading`. Each editor (TextEditor,
 * MixedEditor) decides what Y.Map / Y.XmlFragment it needs and builds
 * its own bridge on top.
 */

import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useUserCenterStore } from '@/hooks/useUserCenterStore';
import { removeToken } from '@/utils/token';
import {
  createYjsNodeEditorManager,
  type YjsNodeEditorManager,
} from '@/utils/yjsNodeEditorManager';
import {
  setNodeEditorYjsManager,
  getNodeEditorYjsManager,
} from '@/utils/nodeEditorYjsRef';

export interface UseYjsNodeEditorOptions {
  /** Main canvas project UUID. */
  projectId: string | undefined;
  /** Main canvas node UUID this editor is bound to. */
  nodeId: string | undefined;
  /**
   * Escape hatch for parent components that want to defer connection
   * (e.g. while the right panel is closed). Defaults to `true`.
   */
  enabled?: boolean;
}

export interface UseYjsNodeEditorResult {
  /** The live manager, or `null` before start / after unmount / when guarded. */
  manager: YjsNodeEditorManager | null;
  /**
   * `true` between manager construction and the first `synced` event.
   * `false` when a manager is active and has sync'd, or when no manager
   * is active at all (guarded inputs). Consumers render a skeleton
   * while this is `true`.
   */
  loading: boolean;
}

export function useYjsNodeEditor(
  options: UseYjsNodeEditorOptions,
): UseYjsNodeEditorResult {
  const { projectId, nodeId, enabled = true } = options;

  const { authInfo } = useUserCenterStore();
  const token = authInfo?.state?.token ?? '';
  const navigate = useNavigate();

  // Keep navigate reachable from the static `onAuthFailed` closure
  // without forcing the effect to re-run on every router change.
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;

  const [manager, setManager] = useState<YjsNodeEditorManager | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!enabled || !projectId || !nodeId || !token) {
      setManager(null);
      setLoading(false);
      return;
    }

    setLoading(true);

    const mgr = createYjsNodeEditorManager({
      projectId,
      nodeId,
      token,
      onAuthFailed: () => {
        // Provider has already disconnected (inside the manager) — this
        // callback handles the client-side cleanup + route change.
        removeToken();
        navigateRef.current('/login', { replace: true });
      },
    });

    setNodeEditorYjsManager(nodeId, mgr);
    setManager(mgr);

    const unsubSynced = mgr.onSynced(() => {
      setLoading(false);
    });

    return () => {
      unsubSynced();
      // Only clear the registry slot if this effect owned it; remount
      // for the same nodeId may have already overwritten it with a new
      // manager, and we must not nuke that one.
      if (getNodeEditorYjsManager(nodeId) === mgr) {
        setNodeEditorYjsManager(nodeId, null);
      }
      mgr.destroy();
      setManager(null);
      setLoading(false);
    };
  }, [projectId, nodeId, token, enabled]);

  return { manager, loading };
}
