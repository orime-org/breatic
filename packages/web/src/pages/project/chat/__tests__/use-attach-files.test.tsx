// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { setLocale } from '@breatic/shared';
import { useAttachFiles } from '@web/pages/project/chat/use-attach-files';
import { chatAttachments } from '@web/stores/chat-attachments';

afterEach(() => {
  act(() => {
    chatAttachments.say('c1', null);
    setLocale('en');
  });
});

describe('the attach notice', () => {
  it('follows the interface language while it is showing', () => {
    act(() => chatAttachments.say('c1', { key: 'full', limit: 10 }));
    const { result } = renderHook(() => useAttachFiles('p1', 'c1'));
    const english = result.current.notice;

    act(() => setLocale('zh-CN'));

    expect(result.current.notice).not.toBe(english);
    expect(result.current.notice).toContain('10');
  });
});
