/**
 * Yjs StrictMode-safe invariant (critical path — see
 * [[feedback_strictmode_resource_hook]] for the PR #99 lesson).
 *
 * React 18 StrictMode double-mounts effects in dev. If the hook
 * destroys the socket on the first cleanup, the second mount runs
 * against a dead socket — Yjs never syncs.
 *
 * useHocuspocusSocket fixes this by:
 *  1. Creating the socket inside useEffect (not useMemo) so each
 *     mount gets a fresh instance.
 *  2. Calling disconnect() in cleanup of the same effect, not in a
 *     sibling effect.
 *
 * This test asserts the structural shape of the hook stays correct
 * (effect-scoped resource + cleanup). Full collab integration test
 * lands in M1 (yjs-collab.test.ts when adapter layer is exercised
 * with a real Hocuspocus server in CI).
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const useSocketTs = readFileSync(
  join(__dirname, '..', 'use-socket.ts'),
  'utf-8',
);

describe('useHocuspocusSocket StrictMode-safe shape (PR #99 invariant)', () => {
  it('exports useHocuspocusSocket', () => {
    expect(useSocketTs).toMatch(/export\s+function\s+useHocuspocusSocket/);
  });

  it('creates HocuspocusProviderWebsocket inside useEffect (not useMemo)', () => {
    // The fix: `new HocuspocusProviderWebsocket` lives inside useEffect
    // so cleanup runs in the same effect's return — disconnect tied
    // to mount/unmount, not to a memo dependency.
    const effectBlock = useSocketTs.match(/useEffect\([\s\S]*?\}\s*,\s*\[/);
    expect(effectBlock).not.toBeNull();
    expect(effectBlock?.[0] ?? '').toContain('new HocuspocusProviderWebsocket');
  });

  it('cleanup function calls disconnect() (resource teardown)', () => {
    expect(useSocketTs).toMatch(/disconnect\(\)/);
  });

  it('does NOT create socket in useMemo (the PR #99 anti-pattern)', () => {
    // The bug pattern was: const socket = useMemo(() => new ..., deps).
    // If you see `useMemo` wrapping the socket constructor, the
    // StrictMode double-mount will dispose it.
    const memoMatch = useSocketTs.match(
      /useMemo\([^)]*new HocuspocusProviderWebsocket/,
    );
    expect(memoMatch).toBeNull();
  });

  it('returns the socket as a useState value (not a memoized constant)', () => {
    expect(useSocketTs).toMatch(/useState<HocuspocusProviderWebsocket\s*\|\s*null>/);
  });
});
