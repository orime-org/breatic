// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * How a tool use is shown once the turn it belonged to is over.
 *
 * Two endings leave a tool with no result and they are not the same thing.
 * The tool can fail, or the user can stop the turn while it is still running,
 * and then nothing went wrong — it simply never finished. Storage keeps both
 * as `error`, because there is no third terminal state; which one it was
 * comes over as its own field.
 *
 * What the card shows is a translated line, never the reason itself. The
 * reason names hosts, statuses and, for a refused fetch, addresses inside the
 * network, and it does not leave the backend — the user learns what happened
 * from the assistant's reply, in its own words.
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

/** A call the tool itself failed. */
const failed = {
  status: 'error',
  failureKind: 'tool_failed',
  failureKey: 'chat.tool.failure.unreachable',
} as const;

/** A call the user stopped mid-flight. */
const stopped = {
  status: 'error',
  failureKind: 'user_aborted',
  failureKey: 'chat.tool.unfinished',
} as const;

describe('ToolCallCard', () => {
  it('says a tool failed, in the reader’s own language', () => {
    render(<ToolCallCard toolCall={call(failed)} />);

    const shown = screen.getByTestId('tool-call-error').textContent ?? '';
    expect(shown.length).toBeGreaterThan(0);
    // Translated, not the key itself: an untranslated key would render as
    // `chat.tool.failure.unreachable` and read as a bug to whoever saw it.
    expect(shown).not.toContain('chat.tool');
  });

  it('does not call a tool the user stopped a failure', () => {
    // Showing this as a failure tells the user something broke when they are
    // the one who stopped it.
    render(<ToolCallCard toolCall={call(stopped)} />);

    expect(screen.queryByTestId('tool-call-error')).toBeNull();
    expect(screen.getByTestId('tool-call-unfinished')).toBeInTheDocument();
  });

  it('does not draw a stopped call with the failure icon either', () => {
    // The caption and the icon are two ways of saying the same thing. Fixing
    // only the words leaves the louder one still calling it a failure.
    const { container } = render(<ToolCallCard toolCall={call(stopped)} />);

    expect(screen.getByTestId('tool-call-card').getAttribute('data-status')).toBe('unfinished');
    expect(container.querySelector('.text-status-error')).toBeNull();
  });

  it('does draw a real failure with the failure icon', () => {
    const { container } = render(<ToolCallCard toolCall={call(failed)} />);

    expect(screen.getByTestId('tool-call-card').getAttribute('data-status')).toBe('error');
    expect(container.querySelector('.text-status-error')).not.toBeNull();
  });

  it('still calls it a failure when the ending came over without a line', () => {
    // A record written before this field existed, or one whose failure the
    // turn could not describe. `error` on its own is a failure — reading the
    // absence of a line as "the user stopped it" is what the old rule did,
    // and it turned every failure into somebody else's doing.
    render(<ToolCallCard toolCall={call({ status: 'error' })} />);

    expect(screen.getByTestId('tool-call-card').getAttribute('data-status')).toBe('error');
  });

  it('still says something when no line came with the failure', () => {
    // What a turn still streaming looks like: the SDK's client assembled the
    // part and has no line of ours to put on it. A blank row under a failure
    // icon reads as a rendering bug, so the coarse line stands in.
    render(<ToolCallCard toolCall={call({ status: 'error' })} />);

    const shown = screen.getByTestId('tool-call-error').textContent ?? '';
    expect(shown.length).toBeGreaterThan(0);
    expect(shown).not.toContain('chat.tool');
  });

  it('shows nothing extra for a tool that came back normally', () => {
    render(<ToolCallCard toolCall={call({ status: 'success', result: 'two links' })} />);

    expect(screen.queryByTestId('tool-call-error')).toBeNull();
    expect(screen.queryByTestId('tool-call-unfinished')).toBeNull();
  });
});
