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
 * The hook owns the lifecycle: when `projectId` / `token` / `wsUrl`
 * change, the previous socket is disconnected before a new one is
 * created.
 */

import { useEffect, useRef, useState } from 'react';
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
 * @returns the shared websocket — `null` while the hook is disabled
 *   or before the first connection is established.
 */
export function useHocuspocusSocket(
  projectId: string | null,
  token: string,
  options: UseHocuspocusSocketOptions = {},
): HocuspocusProviderWebsocket | null {
  const { enabled = true, wsUrl } = options;
  const [socket, setSocket] = useState<HocuspocusProviderWebsocket | null>(null);
  const socketRef = useRef<HocuspocusProviderWebsocket | null>(null);

  useEffect(() => {
    if (!enabled || !projectId || !token) {
      socketRef.current = null;
      setSocket(null);
      return;
    }

    const ws = new HocuspocusProviderWebsocket({
      url: resolveWsUrl(wsUrl),
    });
    socketRef.current = ws;
    setSocket(ws);

    return () => {
      // Disconnect the shared socket. Sibling HocuspocusProvider
      // instances that hold a reference will receive a 'disconnected'
      // event and stop reconnecting until they re-attach to a new
      // socket from the next render.
      ws.disconnect();
      // The websocket object exposes no destroy(); GC handles the rest.
      if (socketRef.current === ws) {
        socketRef.current = null;
        setSocket(null);
      }
    };
  }, [projectId, token, wsUrl, enabled]);

  return socket;
}
