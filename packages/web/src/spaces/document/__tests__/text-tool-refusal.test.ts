// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { describe, expect, it } from 'vitest';

import { StreamRefusedError } from '@web/data/stream/sse';
import { spendCapMessage } from '@web/lib/spend-cap-message';
import { textToolRefusal } from '@web/spaces/document/text-tool-refusal';

const RESETS = '2026-12-01T00:00:00.000Z';

describe('what a refused text-tool run says (inner#1968 H-37)', () => {
  it('names the spend limit and its local reset day', () => {
    const err = new StreamRefusedError(402, 'cap reached', true, 'spend_cap_reached', { code: 402, message: 'cap reached', reason: 'spend_cap_reached', scope: 'studio', limit: '50', resetsAt: RESETS });
    expect(textToolRefusal(err)).toBe(spendCapMessage('spend_cap_reached', 'studio', '50', RESETS));
  });

  it('says the server sentence for any other refusal our server wrote', () => {
    expect(textToolRefusal(new StreamRefusedError(402, 'Not enough credits', true))).toBe('Not enough credits');
  });

  it('has no sentence of its own when the server wrote none', () => {
    expect(textToolRefusal(new StreamRefusedError(502, 'fallback', false))).toBeNull();
    expect(textToolRefusal(new Error('boom'))).toBeNull();
  });
});
