import { HocuspocusProvider } from '@hocuspocus/provider';
import * as React from 'react';
import * as Y from 'yjs';

import { useCurrentUserStore } from '@/stores';

interface UseSocketOptions {
  /** Document name (e.g. `project-abc/meta`). */
  name: string;
  /** The Y.Doc to bind to the provider. */
  doc: Y.Doc;
  /** WebSocket URL to the Hocuspocus server. */
  url?: string;
}

interface SocketState {
  /** The active provider (null until first connect). */
  provider: HocuspocusProvider | null;
  /** True once the provider has synced with the server at least once. */
  synced: boolean;
}

/**
 * StrictMode-safe Hocuspocus provider hook.
 *
 * CRITICAL: `new HocuspocusProvider()` opens a WebSocket. In React 18
 * StrictMode, every `useEffect` runs twice on mount in dev — so naive
 * `useMemo(() => new Provider(), [])` + separate cleanup leaks one
 * socket per mount. The cleanup runs against the FIRST instance, but
 * the second instance (created by the second mount) is never closed.
 *
 * The safe pattern: ALWAYS create the provider + register cleanup
 * inside the SAME `useEffect`. React guarantees cleanup runs before
 * the next effect, so the first socket is properly destroyed before
 * the second is created.
 *
 * (Lesson from PR #99 — see memory `feedback_strictmode_resource_hook`.)
 */
export function useSocket({
  name,
  doc,
  url = '/ws',
}: UseSocketOptions): SocketState {
  const [synced, setSynced] = React.useState(false);
  const providerRef = React.useRef<HocuspocusProvider | null>(null);
  const token = useCurrentUserStore((s) => s.token);

  React.useEffect(() => {
    const fullUrl = url.startsWith('ws')
      ? url
      : `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}${url}`;

    const provider = new HocuspocusProvider({
      url: fullUrl,
      name,
      document: doc,
      token: token ?? undefined,
      onSynced: () => setSynced(true),
    });
    providerRef.current = provider;

    return () => {
      provider.destroy();
      providerRef.current = null;
      setSynced(false);
    };
    // Token change triggers a fresh provider (re-auth). Doc / name change
    // implies new document binding so also re-create.
  }, [name, doc, url, token]);

  return {
    provider: providerRef.current,
    synced,
  };
}
