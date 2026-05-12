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
 * StrictMode safety:
 *   The socket is created inside `useEffect`, not `useMemo`. React 18
 *   StrictMode intentionally double-invokes effects in dev (mount →
 *   fake-unmount → mount). The pre-fix version put the construction
 *   in `useMemo`, so the *factory ran twice per render* and the
 *   cleanup ran in between, calling `socket.disconnect()` on the
 *   only socket the second mount would later try to use. Result:
 *   Yjs `onSynced` never fired, `spaces` stayed empty, the canvas
 *   wouldn't render. Moving creation+cleanup into the *same* effect
 *   means StrictMode's fake-unmount cleans up a real, paired socket,
 *   and the re-mount creates a fresh one. Production behaviour is
 *   unchanged (no double-invoke without StrictMode).
 *
 *   Trade-off: the very first render returns `null` because the
 *   effect runs after layout. Consumers (`useProjectMeta`,
 *   `useSpaceManagerPool`) already tolerate `null` and rebuild their
 *   provider once a non-null socket arrives — `websocketProvider` is
 *   in their effect deps, so a state change rotates the per-doc
 *   providers cleanly.
 */

import { useEffect, useState } from 'react';
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
 * @returns the shared websocket — `null` on the very first render and
 *   while the hook is disabled / waiting for project / token. Consumers
 *   must tolerate `null` and re-attach when a real socket arrives.
 */
export function useHocuspocusSocket(
  projectId: string | null,
  token: string,
  options: UseHocuspocusSocketOptions = {},
): HocuspocusProviderWebsocket | null {
  const { enabled = true, wsUrl } = options;

  const [socket, setSocket] = useState<HocuspocusProviderWebsocket | null>(null);

  useEffect(() => {
    if (!enabled || !projectId || !token) {
      setSocket(null);
      return;
    }
    const s = new HocuspocusProviderWebsocket({ url: resolveWsUrl(wsUrl) });
    setSocket(s);
    return () => {
      // The websocket has no `destroy()` in 3.4.4 — `disconnect()` +
      // GC is the documented teardown. Sibling HocuspocusProvider
      // instances that hold a reference receive a `disconnected`
      // event; the consumer's effect runs cleanup when the socket
      // state rotates so they don't try to use the dead instance.
      s.disconnect();
      setSocket((current) => (current === s ? null : current));
    };
  }, [enabled, projectId, token, wsUrl]);

  return socket;
}
