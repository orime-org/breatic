// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { describe, expect, it } from 'vitest';

import { ApiException } from '@web/data/api/types';
import { StreamRefusedError } from '@web/data/stream/sse';
import { spendCapMessage } from '@web/lib/spend-cap-message';
import { ourSentence, refusalSentence } from '@web/data/api/server-message';

const CAP = { reason: 'spend_cap_reached', scope: 'member', limit: '10', resetsAt: '2026-12-01T00:00:00.000Z' } as const;

describe('refusalSentence (inner#1968 H-31, H-36)', () => {
  it('says the limit and the reset day for a request refused at a spend limit', () => {
    const err = new ApiException({ status: 402, message: 'cap reached', fromServer: true, reason: CAP.reason, details: CAP });
    expect(refusalSentence(err)).toBe(spendCapMessage('member', '10', CAP.resetsAt));
  });

  it('says the same for a stream refused at a spend limit before it opened', () => {
    const err = new StreamRefusedError(402, 'cap reached', true, CAP.reason, { code: 402, message: 'cap reached', ...CAP });
    expect(refusalSentence(err)).toBe(spendCapMessage('member', '10', CAP.resetsAt));
  });

  it('falls back to the server\'s sentence when a person\'s own limit comes without its amount', () => {
    const { limit: _limit, ...noLimit } = CAP;
    const err = new ApiException({ status: 402, message: 'cap reached', fromServer: true, reason: CAP.reason, details: noLimit });
    expect(refusalSentence(err)).toBe('cap reached');
  });

  it('has nothing to say for any other refusal', () => {
    expect(refusalSentence(new StreamRefusedError(403, 'no', true, undefined, { code: 403, message: 'no' }))).toBeNull();
    expect(refusalSentence(new ApiException({ status: 402, message: 'no credits', fromServer: true }))).toBeNull();
  });
});

// Every entry that starts work (text tools, understanding, mini-tools, chat)
// tells the user the same thing for a refusal: the spend limit first, then a
// sentence our server wrote, otherwise nothing of ours.
describe('ourSentence (inner#1968 H-37)', () => {
  it('names the spend limit and its local reset day', () => {
    const err = new StreamRefusedError(402, 'cap reached', true, CAP.reason, { code: 402, message: 'cap reached', ...CAP });
    expect(ourSentence(err)).toBe(spendCapMessage('member', '10', CAP.resetsAt));
  });

  it('says the server sentence for any other refusal our server wrote, on a stream or a request', () => {
    expect(ourSentence(new StreamRefusedError(402, 'Not enough credits', true))).toBe('Not enough credits');
    expect(ourSentence(new ApiException({ status: 402, message: 'Not enough credits', fromServer: true }))).toBe('Not enough credits');
  });

  it('has no sentence when our server wrote none', () => {
    expect(ourSentence(new StreamRefusedError(502, 'fallback', false))).toBeNull();
    expect(ourSentence(new ApiException({ status: 502, message: 'Bad gateway', fromServer: false }))).toBeNull();
    expect(ourSentence(new Error('boom'))).toBeNull();
  });
});
