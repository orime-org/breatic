/**
 * `useHocuspocusSocket(projectId, token, opts)` — shared websocket
 * for every Hocuspocus doc opened by a single project (v10 §5.3.3).
 *
 * One Hocuspocus `HocuspocusProviderWebsocket` is constructed per
 * `(projectId, token, wsUrl)` tuple. All of the project's docs
 * (`/meta`, `/canvas-{sid}`, future `/document-{sid}`,
 * `/timeline-{sid}`) share that single TCP connection. The browser's
 * ws ceiling stays untouched even when the LRU pool keeps several
 * Space docs open at once.
 *
 * Why `useMemo`, not `useState` + `useEffect`:
 *   The pre-fix version constructed the websocket inside an effect,
 *   which meant the FIRST render returned `null`. Sibling hooks
 *   (`useProjectMeta`, `useSpaceManagerPool`) would then build their
 *   per-doc providers without a shared socket, fall back to the
 *   per-provider socket path, and never share TCP — defeating the
 *   spec. Worse, when the websocket arrived a render later, those
 *   providers would not be rebuilt (stale closure), so the canvas
 *   doc's provider would attach to a useless promise of a future
 *   socket. Constructing in `useMemo` resolves both issues: the
 *   socket exists from the first render, and the deps array makes
 *   the lifecycle explicit.
 *
 *   The constructor itself is synchronous; the TCP/WS handshake is
 *   async but the object is immediately attachable — providers can
 *   register listeners and they'll fire when the handshake completes.
 *
 * The cleanup in `useEffect` runs on unmount / dep change. The
 * `useMemo` value rotates atomically with the deps so React always
 * sees a fresh socket reference for the new `(projectId, token)`.
 */

import { useEffect, useMemo } from 'react';
import { HocuspocusProviderWebsocket } from '@hocuspocus/provider';

export interface UseHocuspocusSocketOptions {
  /** Opt out — useful when waiting for auth / project to load. */
  enabled?: boolean;
  /** Override the resolved ws URL (tests / explicit prod overrides). */
  wsUrl?: string;
}

function resolveWsUrl(explicit?: string): string {
  if (explicit) return explicit;
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${window.location.host}/ws`;
}

/**
 * @returns the shared websocket — `null` only when the hook is
 *   disabled or the project / token isn't ready yet.
 */
export function useHocuspocusSocket(
  projectId: string | null,
  token: string,
  options: UseHocuspocusSocketOptions = {},
): HocuspocusProviderWebsocket | null {
  const { enabled = true, wsUrl } = options;

  const socket = useMemo<HocuspocusProviderWebsocket | null>(() => {
    if (!enabled || !projectId || !token) return null;
    return new HocuspocusProviderWebsocket({
      url: resolveWsUrl(wsUrl),
    });
  }, [enabled, projectId, token, wsUrl]);

  useEffect(() => {
    if (!socket) return;
    return () => {
      // The websocket has no `destroy()` in 3.4.4 — `disconnect()` +
      // GC is the documented teardown. Sibling HocuspocusProvider
      // instances that still hold a reference will receive a
      // `disconnected` event and stop reconnecting until they
      // re-attach to a fresh socket from the next render.
      socket.disconnect();
    };
  }, [socket]);

  return socket;
}
