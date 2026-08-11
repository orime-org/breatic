// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * How a tool use is shown once the turn it belonged to is over.
 *
 * Two endings leave a tool with no result and they are not the same thing.
 * The tool can fail, and then it says why. Or the user can stop the turn
 * while the tool is still running, and then nothing went wrong — it simply
 * never finished. Storage keeps both as `error`, because there is no third
 * terminal state; what separates them is whether a reason came with it.
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import { ToolCallCard } from '@web/pages/project/chat/ToolCallCard';
import type { ToolCall } from '@web/pages/project/chat/types';

/**
 * A tool call in the shape the panel receives it.
 * @param over - The fields under test
 * @returns The call
 */
function call(over: Partial<ToolCall>): ToolCall {
  return { id: 'tc-1', name: 'web_search', args: {}, status: 'success', ...over };
}

describe('ToolCallCard', () => {
  it('says why a tool failed, in the words the failure came with', () => {
    render(<ToolCallCard toolCall={call({ status: 'error', errorMessage: 'the site refused' })} />);
    expect(screen.getByTestId('tool-call-error').textContent).toBe('the site refused');
  });

  it('does not call a tool the user stopped a failure', () => {
    // Stored as `error` with no reason, because nothing went wrong: the turn
    // was stopped while it was still running. Showing this as a failure tells
    // the user something broke when they are the one who stopped it.
    render(<ToolCallCard toolCall={call({ status: 'error' })} />);
    expect(screen.queryByTestId('tool-call-error')).toBeNull();
    expect(screen.getByTestId('tool-call-unfinished')).toBeInTheDocument();
  });

  it('shows nothing extra for a tool that came back normally', () => {
    render(<ToolCallCard toolCall={call({ status: 'success', result: 'two links' })} />);
    expect(screen.queryByTestId('tool-call-error')).toBeNull();
    expect(screen.queryByTestId('tool-call-unfinished')).toBeNull();
  });
});
