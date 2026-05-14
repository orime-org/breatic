/**
 * Yjs cleanup invariant (critical path).
 *
 * On unmount / navigation away: socket.disconnect() must run, no
 * leaks, no zombie heartbeats, no Hocuspocus warnings on next mount.
 *
 * M0 SCAFFOLD — fill in M1 when ProjectCanvasContent reconnects the
 * adapter to UI. Needs render/unmount cycle via @testing-library/react
 * + a Hocuspocus stub server.
 */

import { describe, it } from 'vitest';

describe.skip('useHocuspocusSocket cleanup (M1)', () => {
  it('unmount triggers disconnect()', () => {
    // TODO M1: render <Provider><Consumer/></Provider> via RTL,
    //         unmount, assert disconnect was called.
  });

  it('rapid mount/unmount cycle leaves no zombie heartbeat', () => {
    // TODO M1: mount → unmount 5 times in tight loop, assert no
    //         leaked intervals (vi.useFakeTimers + tick assertion).
  });
});
