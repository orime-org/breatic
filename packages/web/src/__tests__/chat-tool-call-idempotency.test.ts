/**
 * Chat tool call idempotency invariant (critical path).
 *
 * `CanvasActionButton` (chat panel agent response) `applied` flag
 * is persistent (lives in MessageData.tool_calls[i].result). Re-apply
 * after the apply already ran must be a no-op (idempotent).
 *
 * M0 SCAFFOLD — fill in M2 (chat panel rewrite milestone) when
 * AgentCanvasActionButton component exists. Verifies tool_call
 * result schema (Y.Map or REST POST?) + applied-state persistence.
 */

import { describe, it } from 'vitest';

describe.skip('Chat tool call idempotency (M2)', () => {
  it('CanvasActionButton apply marks tool_call.result.applied = true', () => {
    // TODO M2: render button, click apply, assert message tool_call
    //         result.applied is true after the action.
  });

  it('second apply is a no-op (button disabled or click suppressed)', () => {
    // TODO M2: apply twice, assert canvas mutation hook called once.
  });

  it('applied state survives page reload (persisted in MessageData)', () => {
    // TODO M2: apply, reload conversation from server, assert applied=true.
  });
});
